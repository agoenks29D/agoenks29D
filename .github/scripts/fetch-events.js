/**
 * .github/scripts/fetch-events.js
 *
 * Fetch a GitHub user's public events and store the latest 100 (deduplicated)
 * entries in github/events.json.
 *
 * If an event already stored in events.json is no longer found in the
 * freshly fetched data (page 1), the script paginates further (page 2, 3, ...)
 * to verify whether the event is still available from the API. Events that
 * are truly gone (or overflow beyond 100 entries) are moved into an
 * incremental archive at github/archive/events-<n>.json, each file capped
 * at 100 entries.
 *
 * Env vars:
 *  - GH_TOKEN / GITHUB_TOKEN : token used to authenticate against the GitHub API
 *  - GH_USERNAME             : GitHub username whose events are fetched
 *                               (default: agoenks29D)
 */

const fs = require('fs');
const path = require('path');

const USERNAME = process.env.GH_USERNAME || 'agoenks29D';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

const MAX_EVENTS = 100;
const MAX_PAGES = 5; // safety limit; GitHub Events API caps at ~300 events (3 pages)
const ROOT_DIR = process.cwd();
const EVENTS_FILE = path.join(ROOT_DIR, 'github', 'events.json');
const ARCHIVE_DIR = path.join(ROOT_DIR, 'github', 'archive');

function log(...args) {
  console.log('[fetch-events]', ...args);
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    log(
      `Failed to read ${filePath}, falling back to default. Error:`,
      err.message,
    );
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function dedupeById(events) {
  const seen = new Map();
  for (const e of events) {
    if (e && e.id != null && !seen.has(e.id)) {
      seen.set(e.id, e);
    }
  }
  return Array.from(seen.values());
}

function sortByCreatedAtDesc(events) {
  return [...events].sort((a, b) => {
    const ta = new Date(a.created_at || 0).getTime();
    const tb = new Date(b.created_at || 0).getTime();
    return tb - ta;
  });
}

async function fetchPage(page) {
  const url = `https://api.github.com/users/${USERNAME}/events?per_page=100&page=${page}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': `${USERNAME}-events-fetcher`,
  };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

  const res = await fetch(url, { headers });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `GitHub API error on page ${page}: ${res.status} ${res.statusText} ${body}`,
    );
  }

  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

/**
 * Append events to the incremental archive at github/archive/events-<n>.json,
 * each file capped at MAX_EVENTS entries. Continues filling the last file if
 * there's room, then rolls over to a new file once it's full.
 */
function archiveEvents(events) {
  if (!events.length) return;

  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

  const existingNums = fs
    .readdirSync(ARCHIVE_DIR)
    .map((f) => f.match(/^events-(\d+)\.json$/))
    .filter(Boolean)
    .map((m) => parseInt(m[1], 10))
    .sort((a, b) => a - b);

  let currentNum = existingNums.length
    ? existingNums[existingNums.length - 1]
    : 1;
  let currentPath = path.join(ARCHIVE_DIR, `events-${currentNum}.json`);
  let currentData = readJsonSafe(currentPath, []);

  // process oldest-first so archives stay roughly chronological
  const queue = sortByCreatedAtDesc(events).reverse();

  while (queue.length > 0) {
    let space = MAX_EVENTS - currentData.length;

    if (space <= 0) {
      currentNum += 1;
      currentPath = path.join(ARCHIVE_DIR, `events-${currentNum}.json`);
      currentData = [];
      space = MAX_EVENTS;
    }

    const chunk = queue.splice(0, space);
    currentData = dedupeById([...currentData, ...chunk]);
    writeJson(currentPath, currentData);
    log(
      `Archived ${chunk.length} event(s) into ${path.relative(ROOT_DIR, currentPath)}`,
    );
  }
}

async function main() {
  if (!TOKEN) {
    log(
      'Warning: GH_TOKEN / GITHUB_TOKEN is not set, requests will be unauthenticated (lower rate limit).',
    );
  }

  const stored = readJsonSafe(EVENTS_FILE, []);
  log(`Currently stored events: ${stored.length}`);

  const fetchedIds = new Set();
  const allFetched = [];

  // Always fetch page 1
  let page = 1;
  let pageEvents = await fetchPage(page);
  allFetched.push(...pageEvents);
  pageEvents.forEach((e) => fetchedIds.add(e.id));
  log(`Page ${page}: ${pageEvents.length} event(s)`);

  const getMissingStored = () => stored.filter((e) => !fetchedIds.has(e.id));

  // Only paginate further if there are stored events not yet found
  let hasNextPage = pageEvents.length === 100; // GitHub returns exactly 100 when there's likely a next page
  while (getMissingStored().length > 0 && hasNextPage && page < MAX_PAGES) {
    page += 1;
    pageEvents = await fetchPage(page);
    log(
      `Page ${page}: ${pageEvents.length} event(s) (paginating because some stored events are still missing)`,
    );

    if (pageEvents.length === 0) {
      hasNextPage = false;
      break;
    }

    allFetched.push(...pageEvents);
    pageEvents.forEach((e) => fetchedIds.add(e.id));
    hasNextPage = pageEvents.length === 100;
  }

  const liveIds = fetchedIds;
  const storedIds = new Set(stored.map((e) => e.id));

  const keptStored = stored.filter((e) => liveIds.has(e.id));
  const goneStored = stored.filter((e) => !liveIds.has(e.id));
  const newEvents = allFetched.filter((e) => !storedIds.has(e.id));

  log(
    `New events: ${newEvents.length}, still-live stored events: ${keptStored.length}, no-longer-available stored events: ${goneStored.length}`,
  );

  let merged = dedupeById([...newEvents, ...keptStored]);
  merged = sortByCreatedAtDesc(merged);

  const finalEvents = merged.slice(0, MAX_EVENTS);
  const overflow = merged.slice(MAX_EVENTS);

  const toArchive = dedupeById([...goneStored, ...overflow]);

  writeJson(EVENTS_FILE, finalEvents);
  log(
    `Saved ${finalEvents.length} event(s) to ${path.relative(ROOT_DIR, EVENTS_FILE)}`,
  );

  if (toArchive.length > 0) {
    archiveEvents(toArchive);
  } else {
    log('No events need to be archived.');
  }

  log('Done.');
}

main().catch((err) => {
  console.error('[fetch-events] Failed:', err);
  process.exit(1);
});
