import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const watcher = fileURLToPath(new URL('./watchBoard.mjs', import.meta.url));
const heading = (name, type = 'ASK', subject = 'act') => `### 2026-11-02 12:00 UTC — Writer → ${name} — ${type} — ${subject}`;
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'board-watch-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'lanes'));
  const board = path.join(root, 'BOARD.md');
  const second = path.join(root, 'SECOND.md');
  const seen = path.join(root, 'seen.jsonl');
  await Promise.all([fs.writeFile(board, '# Board\n'), fs.writeFile(second, '# Second\n')]);
  return { root, board, second, seen };
}
function start(t, fixture, extra = [], heartbeat = 10000, wakeOnBacklog = true) {
  const child = spawn(process.execPath, [watcher, '--board', fixture.board, '--board', fixture.second,
    '--name', 'Programme', '--name', 'LANE', '--seen', fixture.seen, '--heartbeat-ms', String(heartbeat),
    ...(wakeOnBacklog ? ['--wake-on-backlog'] : []), ...extra],
  { cwd: fixture.root, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let stdout = '';
  let stderr = '';
  const listeners = new Set();
  child.stdout.on('data', (bytes) => { stdout += bytes; for (const notify of listeners) notify(); });
  child.stderr.on('data', (bytes) => { stderr += bytes; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve(stdout.trim().split('\n').filter(Boolean)) : reject(new Error(`exit ${code}: ${stderr}`)));
  });
  return { done, line: () => new Promise((resolve, reject) => {
    const notify = () => { if (stdout.includes('\n')) { listeners.delete(notify); resolve(); } };
    listeners.add(notify); notify(); done.catch(reject);
  }) };
}

test('ignores either caller name as sender, including broadcasts and regex matches', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.seen, JSON.stringify({ heading: 'previous heading' }) + '\n');
  const own = [heading('LANE'), heading('Programme', 'RULING'), heading('ALL leads', 'URGENT')]
    .map((line, i) => line.replace('Writer →', `${i === 1 ? 'Programme' : 'LANE'} →`));
  const other = heading('LANE', 'ASK', 'from someone else');
  await fs.writeFile(f.board, [...own, other].join('\n'));
  assert.deepEqual(await start(t, f, ['--wake-regex', 'act']).done, [other]);
});

test('deduplicates exact report line text across history and body-only edits', async (t) => {
  const f = await fixture(t);
  const report = path.join(f.root, 'lanes', 'lane.md');
  const terminal = 'STATUS: DONE — original evidence';
  await fs.writeFile(f.seen, [terminal, 'STATUS: IN_PROGRESS'].map((line) => JSON.stringify({ report, line })).join('\n') + '\n');
  await fs.writeFile(report, terminal + '\nchanged body\n');
  assert.deepEqual(await start(t, f, [], 80, false).done, ['HEARTBEAT']);
  await fs.writeFile(report, terminal + '\nanother body\n');
  assert.deepEqual(await start(t, f, [], 80, false).done, ['HEARTBEAT']);
  const changed = 'STATUS: DONE — new evidence';
  await fs.writeFile(report, changed + '\nbody\n');
  assert.deepEqual(await start(t, f).done, [`${report}: ${changed}`]);
  const otherReport = path.join(f.root, 'lanes', 'other.md');
  await fs.writeFile(otherReport, changed + '\n');
  assert.deepEqual(await start(t, f).done, [`${otherReport}: ${changed}`]);
});

test('empty seen history silently baselines every current item and later delivers new work', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.seen, '');
  const backlog = Array.from({ length: 100 }, (_, i) => heading('LANE', 'ASK', `backlog ${i}`));
  const report = path.join(f.root, 'lanes', 'lane.md');
  await fs.writeFile(report, 'STATUS: DONE\n');
  await fs.writeFile(f.board, backlog.join('\n'));
  assert.deepEqual(await start(t, f, [], 80, false).done, ['HEARTBEAT']);
  const recorded = (await fs.readFile(f.seen, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(recorded.filter((item) => item.heading).map((item) => item.heading), backlog);
  assert.deepEqual(recorded.filter((item) => item.report), [{ report, line: 'STATUS: DONE' }]);
  const added = heading('Programme', 'ASK', 'new work');
  await fs.appendFile(f.second, added + '\n');
  assert.deepEqual(await start(t, f).done, [added]);
});

test('wake-on-backlog opts into current board and terminal-report delivery', async (t) => {
  const f = await fixture(t);
  const report = path.join(f.root, 'lanes', 'lane.md');
  await fs.writeFile(report, 'STATUS: DONE\n');
  await fs.writeFile(f.board, heading('LANE') + '\n');
  assert.deepEqual(await start(t, f, ['--wake-on-backlog']).done, [`${report}: STATUS: DONE`, heading('LANE')]);
});

test('an initially empty board baselines once and delivers work on re-arm', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await start(t, f, [], 80, false).done, ['HEARTBEAT']);
  await fs.writeFile(f.board, heading('LANE') + '\n');
  assert.deepEqual(await start(t, f, [], 10000, false).done, [heading('LANE')]);
});

test('filters before delivery, never truncates addressed headings, and persists only delivered items', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const mine = Array.from({ length: 100 }, (_, i) => heading('LANE', 'ASK', `mine ${i}`));
  await fs.writeFile(f.board, [...Array.from({ length: 120 }, (_, i) => heading('Other', 'ASK', `foreign ${i}`)), ...mine, heading('LANE', 'FYI', 'legacy addressed heading'), heading('LANE-OTHER'), heading('ALL leads', 'RESULT'), heading('ALL leads', 'HOLD')].join('\n'));
  const output = await start(t, f).done;
  assert.deepEqual(output, [...mine, heading('LANE', 'FYI', 'legacy addressed heading'), heading('ALL leads', 'HOLD')]);
  assert.equal((await fs.readFile(f.seen, 'utf8')).includes('foreign'), false);
  const before = await fs.readFile(f.seen, 'utf8');
  assert.deepEqual(await start(t, f, [], 50).done, ['HEARTBEAT']);
  assert.equal(await fs.readFile(f.seen, 'utf8'), before);
});

test('watches all named boards through atomic replacement and wakes immediately on addressed RULING', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.board, heading('Programme', 'CLAIM') + '\n');
  const run = start(t, f);
  await run.line();
  const next = f.second + '.tmp';
  await fs.writeFile(next, heading('Programme', 'RULING') + '\n');
  await fs.rename(next, f.second);
  assert.deepEqual(await run.done, [heading('Programme', 'CLAIM'), heading('Programme', 'RULING')]);
});

for (const status of ['DONE', 'BLOCKED', 'IMPLEMENTED_NOT_VERIFIED']) {
  test(`default lane reports wake on line-1 change to ${status}`, { timeout: 15000 }, async (t) => {
    const f = await fixture(t);
    const report = path.join(f.root, 'lanes', 'lane.md');
    await fs.writeFile(report, 'STATUS: IN_PROGRESS\nbody\n');
    await fs.writeFile(f.board, heading('Programme', 'CLAIM') + '\n');
    const run = start(t, f);
    await run.line();
    await fs.writeFile(report, `STATUS: ${status} — evidence\nbody\n`);
    assert.deepEqual(await run.done, [heading('Programme', 'CLAIM'), `${report}: STATUS: ${status} — evidence`]);
    assert.deepEqual(await start(t, f, [], 50).done, ['HEARTBEAT']);
  });
}

test('optional wake regex wakes on RESULT', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const reports = path.join(f.root, 'custom');
  await fs.mkdir(reports);
  await fs.writeFile(f.board, heading('Programme', 'CLAIM') + '\n');
  const run = start(t, f, ['--reports', reports, '--wake-regex', 'producer ready']);
  await run.line();
  await fs.appendFile(f.second, heading('LANE', 'RESULT', 'producer ready') + '\n');
  assert.deepEqual(await run.done, [heading('Programme', 'CLAIM'), heading('LANE', 'RESULT', 'producer ready')]);
});

test('explicit report roots wake on newly created terminal reports', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const reports = path.join(f.root, 'custom');
  await fs.mkdir(reports);
  await fs.writeFile(f.board, heading('Programme', 'CLAIM') + '\n');
  const run = start(t, f, ['--reports', reports]);
  await run.line();
  const report = path.join(reports, 'new.md');
  await fs.writeFile(report, 'STATUS: DONE\n');
  assert.deepEqual(await run.done, [heading('Programme', 'CLAIM'), `${report}: STATUS: DONE`]);
});

test('a report root sharing a board directory still observes new report files before heartbeat', { timeout: 2000 }, async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.board, heading('Programme', 'CLAIM') + '\n');
  const run = start(t, f, ['--reports', f.root], 10000);
  await run.line();
  const report = path.join(f.root, 'new-report.md');
  await fs.writeFile(report, 'STATUS: BLOCKED\n');
  assert.deepEqual(await run.done, [heading('Programme', 'CLAIM'), `${report}: STATUS: BLOCKED`]);
});
