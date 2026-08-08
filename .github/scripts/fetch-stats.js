/**
 * .github/scripts/fetch-stats.js
 *
 * Fetches profile-level statistics for a GitHub user via the GitHub GraphQL
 * API and stores the result in github/stats.json. This includes:
 *
 *  - Contribution calendar (heatmap data) + current/longest streak
 *  - Pinned repositories
 *  - Aggregated language breakdown across owned public repositories
 *  - Total stars, forks, followers, following
 *
 * Env vars:
 *  - GH_TOKEN / GITHUB_TOKEN : token used to authenticate against the GitHub API
 *  - GH_USERNAME             : GitHub username to fetch stats for
 *                               (default: agoenks29D)
 */

const fs = require('fs');
const path = require('path');

const USERNAME = process.env.GH_USERNAME;
const TOKEN = process.env.GH_TOKEN;

const ROOT_DIR = process.cwd();
const STATS_FILE = path.join(ROOT_DIR, 'github', 'stats.json');

const GRAPHQL_URL = 'https://api.github.com/graphql';

const QUERY = /* GraphQL */ `
  query ($login: String!) {
    user(login: $login) {
      login
      name
      bio
      avatarUrl
      followers {
        totalCount
      }
      following {
        totalCount
      }
      contributionsCollection {
        totalCommitContributions
        totalPullRequestContributions
        totalIssueContributions
        totalRepositoryContributions
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              date
              contributionCount
              weekday
            }
          }
        }
      }
      pinnedItems(first: 6, types: [REPOSITORY]) {
        nodes {
          ... on Repository {
            name
            description
            url
            homepageUrl
            stargazerCount
            forkCount
            primaryLanguage {
              name
              color
            }
          }
        }
      }
      repositories(
        first: 100
        ownerAffiliations: OWNER
        isFork: false
        privacy: PUBLIC
      ) {
        totalCount
        nodes {
          stargazerCount
          forkCount
          languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
            edges {
              size
              node {
                name
                color
              }
            }
          }
        }
      }
    }
  }
`;

function log(...args) {
  console.log('[fetch-stats]', ...args);
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

async function fetchGraphQL(query, variables) {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': `${USERNAME}-stats-fetcher`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `GitHub GraphQL API error: ${res.status} ${res.statusText} ${body}`,
    );
  }

  const json = await res.json();

  if (json.errors && json.errors.length > 0) {
    throw new Error(
      `GitHub GraphQL API returned errors: ${JSON.stringify(json.errors)}`,
    );
  }

  return json.data;
}

/**
 * Flattens the contribution calendar into a single chronological array of
 * { date, count } and computes current streak + longest streak.
 */
function computeStreaks(contributionCalendar) {
  const days = contributionCalendar.weeks
    .flatMap((w) => w.contributionDays)
    .map((d) => ({ date: d.date, count: d.contributionCount }))
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  let longestStreak = 0;
  let runningStreak = 0;

  for (const day of days) {
    if (day.count > 0) {
      runningStreak += 1;
      longestStreak = Math.max(longestStreak, runningStreak);
    } else {
      runningStreak = 0;
    }
  }

  // Current streak: walk backwards from the most recent day. Today might not
  // have contributions yet, so we allow skipping the very last day if it's 0.
  let currentStreak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    const isLastDay = i === days.length - 1;
    if (days[i].count > 0) {
      currentStreak += 1;
    } else if (isLastDay) {
      // today has 0 contributions so far, don't break the streak yet
      continue;
    } else {
      break;
    }
  }

  return { currentStreak, longestStreak };
}

/**
 * Aggregates language byte sizes across all repositories and returns a
 * sorted list with percentage share.
 */
function computeLanguageBreakdown(repositories) {
  const totals = new Map(); // name -> { size, color }

  for (const repo of repositories) {
    for (const edge of repo.languages.edges) {
      const name = edge.node.name;
      const color = edge.node.color;
      const size = edge.size;

      if (!totals.has(name)) {
        totals.set(name, { size: 0, color });
      }
      totals.get(name).size += size;
    }
  }

  const totalSize = Array.from(totals.values()).reduce(
    (sum, v) => sum + v.size,
    0,
  );

  return Array.from(totals.entries())
    .map(([name, { size, color }]) => ({
      name,
      color,
      bytes: size,
      percentage:
        totalSize > 0 ? Number(((size / totalSize) * 100).toFixed(2)) : 0,
    }))
    .sort((a, b) => b.bytes - a.bytes);
}

async function main() {
  if (!TOKEN) {
    throw new Error(
      'GH_TOKEN / GITHUB_TOKEN is required for GraphQL requests.',
    );
  }

  log(`Fetching stats for user: ${USERNAME}`);

  const data = await fetchGraphQL(QUERY, { login: USERNAME });
  const user = data.user;

  if (!user) {
    throw new Error(`User "${USERNAME}" not found.`);
  }

  const { currentStreak, longestStreak } = computeStreaks(
    user.contributionsCollection.contributionCalendar,
  );

  const languages = computeLanguageBreakdown(user.repositories.nodes);

  const totalStars = user.repositories.nodes.reduce(
    (sum, r) => sum + r.stargazerCount,
    0,
  );
  const totalForks = user.repositories.nodes.reduce(
    (sum, r) => sum + r.forkCount,
    0,
  );

  const stats = {
    generatedAt: new Date().toISOString(),
    profile: {
      login: user.login,
      name: user.name,
      bio: user.bio,
      avatarUrl: user.avatarUrl,
      followers: user.followers.totalCount,
      following: user.following.totalCount,
    },
    contributions: {
      totalContributions:
        user.contributionsCollection.contributionCalendar.totalContributions,
      totalCommitContributions:
        user.contributionsCollection.totalCommitContributions,
      totalPullRequestContributions:
        user.contributionsCollection.totalPullRequestContributions,
      totalIssueContributions:
        user.contributionsCollection.totalIssueContributions,
      totalRepositoryContributions:
        user.contributionsCollection.totalRepositoryContributions,
      currentStreak,
      longestStreak,
      calendar: user.contributionsCollection.contributionCalendar.weeks,
    },
    pinnedRepositories: user.pinnedItems.nodes.map((repo) => ({
      name: repo.name,
      description: repo.description,
      url: repo.url,
      homepageUrl: repo.homepageUrl,
      stars: repo.stargazerCount,
      forks: repo.forkCount,
      primaryLanguage: repo.primaryLanguage,
    })),
    languages,
    totals: {
      publicRepositories: user.repositories.totalCount,
      stars: totalStars,
      forks: totalForks,
    },
  };

  writeJson(STATS_FILE, stats);
  log(`Saved stats to ${path.relative(ROOT_DIR, STATS_FILE)}`);
  log(
    `Current streak: ${currentStreak} day(s), longest streak: ${longestStreak} day(s)`,
  );
  log('Done.');
}

main().catch((err) => {
  console.error('[fetch-stats] Failed:', err);
  process.exit(1);
});
