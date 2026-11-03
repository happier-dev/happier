import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const usage = 'Usage: node scripts/board/watchBoard.mjs --board <path> [--board <path>] --name <caller> [--name <watched-lane>] [--self-name <sender-alias>] --seen <caller.jsonl> --heartbeat-ms <ms> [--reports <directory-or-*.md>] [--wake-regex <regex>] [--wake-on-backlog]';

async function main() {
  const { values } = parseArgs({ options: {
    board: { type: 'string', multiple: true }, name: { type: 'string', multiple: true },
    'self-name': { type: 'string', multiple: true },
    seen: { type: 'string' }, reports: { type: 'string', multiple: true },
    'heartbeat-ms': { type: 'string' }, 'wake-regex': { type: 'string' },
    'wake-on-backlog': { type: 'boolean' },
  } });
  const heartbeat = Number(values['heartbeat-ms']);
  if (!values.board?.length || !values.name?.length || !values.seen || !Number.isSafeInteger(heartbeat) || heartbeat <= 0) throw new Error(usage);
  const boards = [...new Set(values.board.map((board) => path.resolve(board)))];
  const roots = [...new Set((values.reports ?? ['lanes/*.md']).map((root) => path.resolve(root.replace(/[\\/]\*\.md$/, ''))))];
  const names = new Set(values.name);
  // Recipient subscriptions include watched lanes; they are not caller identities.
  const selfNames = new Set([values.name[0], ...(values['self-name'] ?? [])]);
  const wakeRegex = values['wake-regex'] === undefined ? undefined : new RegExp(values['wake-regex']);
  const seenPath = path.resolve(values.seen);
  const seen = new Set();
  const reports = new Set();
  const reportKey = (file, line) => JSON.stringify([file, line]);
  let history = '';
  try { history = await fs.readFile(seenPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const line of history.split('\n').filter(Boolean)) {
    const item = JSON.parse(line);
    if (item.heading) seen.add(item.heading);
    else if (item.report) reports.add(reportKey(item.report, item.line));
  }
  const baseline = history.trim() === '' && !values['wake-on-backlog'];
  await fs.mkdir(path.dirname(seenPath), { recursive: true });
  const record = (item) => fs.appendFile(seenPath, JSON.stringify(item) + '\n');
  const watchers = new Map();
  const observedRoots = new Set();
  let changed = false;
  let notify;
  let watchError;
  const markChanged = () => { changed = true; notify?.(); };
  function observe(directory, relevant) {
    const existing = watchers.get(directory);
    if (existing) { existing.filters.push(relevant); return; }
    const filters = [relevant];
    const watcher = watch(directory, (_event, filename) => {
      if (filename === null || filters.some((filter) => filter(String(filename)))) markChanged();
    });
    watcher.on('error', (error) => { watchError = error; markChanged(); });
    watchers.set(directory, { watcher, filters });
  }
  const read = async (file) => {
    try { return await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
  };
  async function scan(initial) {
    let wake = false;
    const silent = initial && baseline;
    // Establish report baselines before emitting initial board headings. A caller
    // can act on delivered output immediately without racing report initialization.
    for (const root of roots) {
      let entries;
      try {
        if (!observedRoots.has(root)) {
          observe(root, (filename) => filename.endsWith('.md'));
          observedRoots.add(root);
        }
        entries = await fs.readdir(root, { withFileTypes: true });
      }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const file = path.join(root, entry.name);
        const line = (await read(file)).split(/\r?\n/, 1)[0];
        const key = reportKey(file, line);
        if (reports.has(key)) continue;
        reports.add(key);
        await record({ report: file, line });
        if (!silent && /^(?:STATUS:\s*)?(DONE|BLOCKED|IMPLEMENTED_NOT_VERIFIED)\b/.test(line)) {
          process.stdout.write(`${file}: ${line}\n`);
          wake = true;
        }
      }
    }
    for (const board of boards) {
      const headings = (await read(board)).match(/^### [^\r\n]*/gm) ?? [];
      for (const heading of headings) {
        const match = /^### .*? — (.+?) → (.+?) — ([^—]+?) — /.exec(heading);
        if (!match) continue;
        const addressees = match[2].split(',').map((name) => name.trim());
        const broadcast = addressees.some((name) => name.toLowerCase() === 'all leads') && ['URGENT', 'RULING', 'HOLD'].includes(match[3]);
        if (!broadcast && !addressees.some((name) => names.has(name))) continue;
        if (seen.has(heading)) continue;
        await record({ heading });
        seen.add(heading);
        if (silent) continue;
        process.stdout.write(heading + '\n');
        if (!selfNames.has(match[1].trim()) && (broadcast || ['ASK', 'URGENT', 'RULING'].includes(match[3]) || wakeRegex?.test(heading))) wake = true;
      }
    }
    // Persist initialization even when there were no current items to record.
    if (silent) await record({ baseline: true });
    return wake;
  }
  let expired = false;
  const timer = setTimeout(() => { expired = true; markChanged(); }, heartbeat);
  try {
    for (const board of boards) observe(path.dirname(board), (filename) => filename === path.basename(board));
    for (const root of roots) {
      // Watch the parent too so a not-yet-created default lanes directory can appear.
      try { observe(path.dirname(root), (filename) => filename === path.basename(root)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (await scan(true)) return;
    for (;;) {
      if (watchError) throw watchError;
      if (expired) { process.stdout.write('HEARTBEAT\n'); return; }
      if (!changed) await new Promise((resolve) => { notify = resolve; });
      notify = undefined;
      changed = false;
      if (await scan(false)) return;
    }
  } finally {
    clearTimeout(timer);
    for (const { watcher } of watchers.values()) watcher.close();
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
