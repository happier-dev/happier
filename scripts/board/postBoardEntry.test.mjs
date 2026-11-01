import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { postBoardEntry } from './postBoardEntry.mjs';

const writer = fileURLToPath(new URL('./postBoardEntry.mjs', import.meta.url));
const run = promisify(execFile);
const header = '# Coordination board\r\n\r\n';
const oldPost = '### 2026-10-30 12:00 UTC — old\r\nOlder café.\r\n';
const newPost = '### 2026-10-31 12:00 UTC — recent\r\nRecent body.\r\n';

async function fixture(t, contents = header + newPost + oldPost) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'board-writer-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const board = path.join(directory, 'HANDOFF.md');
  const entryFile = path.join(directory, 'entry.md');
  await fs.writeFile(board, contents);
  await fs.writeFile(entryFile, '### 2026-10-31 13:00 UTC — added\nNew body.\n\n');
  return { directory, board, entryFile };
}

test('refuses a short temporary write and preserves the current board', async (t) => {
  const { board, entryFile } = await fixture(t);
  const before = await fs.readFile(board);
  const writeFile = fs.writeFile.bind(fs);
  // The filesystem is the boundary: simulate a capped write, keeping all domain logic real.
  t.mock.method(fs, 'writeFile', (target, bytes, options) => writeFile(
    target, String(target).endsWith('.tmp') ? bytes.subarray(0, 10) : bytes, options,
  ));
  await assert.rejects(postBoardEntry(board, entryFile), /shrink/i);
  assert.deepEqual(await fs.readFile(board), before);
  assert.equal((await fs.readdir(path.dirname(board))).some((name) => name.endsWith('.tmp')), false);
});

function startWriter(board, entryFile) {
  const child = spawn(process.execPath, [writer, board, entryFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let notifyWait;
  let rejectWait;
  const waiting = new Promise((resolve, reject) => { notifyWait = resolve; rejectWait = reject; });
  waiting.catch(() => {});
  child.stderr.on('data', (bytes) => {
    output += bytes.toString();
    if (output.includes('Waiting for board lock')) notifyWait();
  });
  child.stdout.resume();
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      rejectWait(new Error('Writer exited without waiting for the held lock'));
      if (code === 0) resolve();
      else reject(new Error(`Writer exit ${code}: ${output}`));
    });
  });
  return { waiting, done, child };
}

test('two concurrent processes reread under the lock and both entries land', async (t) => {
  const { directory, board, entryFile } = await fixture(t);
  const before = await fs.readFile(board);
  const secondEntry = path.join(directory, 'second.md');
  await fs.writeFile(secondEntry, '### 2026-10-31 13:01 UTC — second\nSecond body.\n\n');
  const lock = `${board}.lock`;
  await fs.mkdir(lock);
  const holder = path.join(lock, 'test-holder.json');
  await fs.writeFile(holder, JSON.stringify({ pid: process.pid, hostname: hostname() }));
  const first = startWriter(board, entryFile);
  const second = startWriter(board, secondEntry);
  const holderPost = Buffer.from('### 2026-10-29 12:00 UTC — lock holder\nLatest locked write.\n');
  try {
    await Promise.all([first.waiting, second.waiting]);
    assert.deepEqual(await fs.readFile(board), before);
    await fs.appendFile(board, holderPost);
  } finally {
    await fs.rename(lock, `${lock}.released`);
    await Promise.all([first.done, second.done]);
  }
  const entries = [await fs.readFile(entryFile), await fs.readFile(secondEntry)];
  const actual = await fs.readFile(board);
  const originalPosts = before.subarray(Buffer.byteLength(header));
  const possibilities = [entries, entries.toReversed()].map(([a, b]) => Buffer.concat([
    Buffer.from(header), a, b, originalPosts, holderPost,
  ]));
  assert.ok(possibilities.some((expected) => actual.equals(expected)));
  assert.equal((await fs.readdir(directory)).includes(path.basename(lock)), false);
});

for (const format of ['directory', 'legacy PID file']) {
  test(`two writers racing from the same base recover a dead ${format} holder and preserve both posts`, { timeout: 10000 }, async (t) => {
    const { directory, board, entryFile } = await fixture(t);
    const before = await fs.readFile(board);
    // Use the PID of an actually exited process rather than guessing an unused PID.
    const { stdout } = await run(process.execPath, ['-e', 'console.log(process.pid)']);
    const lock = `${board}.lock`;
    if (format === 'directory') {
      await fs.mkdir(lock);
      await fs.writeFile(path.join(lock, 'dead-holder.json'), JSON.stringify({ pid: Number(stdout.trim()), hostname: hostname() }));
    } else {
      await fs.writeFile(lock, stdout);
    }
    const secondEntry = path.join(directory, 'second.md');
    await fs.writeFile(secondEntry, '### 2026-10-31 13:01 UTC — second\nSecond body.\n\n');
    const writers = [startWriter(board, entryFile), startWriter(board, secondEntry)];
    t.after(() => { for (const { child } of writers) child.kill(); });
    await Promise.all(writers.map(({ done }) => done));
    const entries = [await fs.readFile(entryFile), await fs.readFile(secondEntry)];
    const actual = await fs.readFile(board);
    assert.ok([entries, entries.toReversed()].some(([a, b]) => actual.equals(Buffer.concat([
      Buffer.from(header), a, b, before.subarray(Buffer.byteLength(header)),
    ]))));
    assert.equal((await fs.readdir(directory)).includes(path.basename(lock)), false);
  });
}

test('an unidentified legacy lock refuses publication without deleting the lock or board', async (t) => {
  const { board, entryFile } = await fixture(t);
  const before = await fs.readFile(board);
  const lock = `${board}.lock`;
  await fs.writeFile(lock, '');
  await assert.rejects(postBoardEntry(board, entryFile), /no verifiable local holder/i);
  assert.deepEqual(await fs.readFile(board), before);
  assert.equal(await fs.readFile(lock, 'utf8'), '');
});

test('a waiting writer recovers when the live holder exits without releasing', { timeout: 10000 }, async (t) => {
  const { board, entryFile } = await fixture(t);
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs/promises';
    import { hostname } from 'node:os';
    const lock = process.argv[1] + '.lock';
    await fs.mkdir(lock);
    await fs.writeFile(lock + '/exiting-holder.json', JSON.stringify({pid: process.pid, hostname: hostname()}));
    process.stdin.resume();
    process.stdout.write('ready');
  `, board], { stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => holder.kill());
  await once(holder.stdout, 'data');
  const writer = startWriter(board, entryFile);
  t.after(() => writer.child.kill());
  await writer.waiting;
  const exited = once(holder, 'exit');
  holder.kill();
  await exited;
  await writer.done;
  assert.ok((await fs.readFile(board)).includes(await fs.readFile(entryFile)));
});

test('same-size temporary heading corruption cannot drop an existing post', async (t) => {
  const { board, entryFile } = await fixture(t);
  const before = await fs.readFile(board);
  const writeFile = fs.writeFile.bind(fs);
  t.mock.method(fs, 'writeFile', (target, bytes, options) => {
    if (!String(target).endsWith('.tmp')) return writeFile(target, bytes, options);
    const output = Buffer.from(bytes);
    output[output.indexOf(Buffer.from('### 2026-10-30'))] = 88;
    return writeFile(target, output, options);
  });
  await assert.rejects(postBoardEntry(board, entryFile), /heading|byte verification/i);
  assert.deepEqual(await fs.readFile(board), before);
});

test('a post arriving outside the lock before publication is preserved by refusing the stale write', async (t) => {
  const { board, entryFile } = await fixture(t);
  const arrival = Buffer.from('### 2026-11-01 07:25 UTC — outside writer\nKeep this post.\n');
  const before = await fs.readFile(board);
  const writeFile = fs.writeFile.bind(fs);
  t.mock.method(fs, 'writeFile', async (target, bytes, options) => {
    await writeFile(target, bytes, options);
    if (String(target).endsWith('.tmp')) await fs.appendFile(board, arrival);
  });
  await assert.rejects(postBoardEntry(board, entryFile), /heading|changed/i);
  assert.deepEqual(await fs.readFile(board), Buffer.concat([before, arrival]));
});

test('rotation archives the exact tail before trimming, preserving every byte', async (t) => {
  const { directory, board, entryFile } = await fixture(t);
  const entry = await fs.readFile(entryFile);
  await run(process.execPath, [writer, board, entryFile, '--rotate-before=2026-10-31']);
  const archive = path.join(directory, 'board-archive', 'HANDOFF-before-2026-10-31.md');
  assert.ok((await fs.readdir(directory)).includes('board-archive'), 'rotation must create the archive');
  const archived = await fs.readFile(archive);
  assert.deepEqual(archived, Buffer.from(oldPost));
  const retained = await fs.readFile(board);
  assert.deepEqual(retained, Buffer.concat([Buffer.from(header), entry, Buffer.from(newPost)]));
  assert.deepEqual(Buffer.concat([retained, archived]), Buffer.concat([
    Buffer.from(header), entry, Buffer.from(newPost + oldPost),
  ]));
});

test('an incomplete archive never trims the board and cannot be overwritten on retry', async (t) => {
  const { directory, board, entryFile } = await fixture(t);
  const before = await fs.readFile(board);
  const writeFile = fs.writeFile.bind(fs);
  // Simulate incomplete archive output at the real filesystem boundary.
  t.mock.method(fs, 'writeFile', (target, bytes, options) => writeFile(
    target, String(target).includes('board-archive') ? bytes.subarray(0, 5) : bytes, options,
  ));
  await assert.rejects(postBoardEntry(board, entryFile, { rotateBefore: '2026-10-31' }), /Archive size/);
  assert.deepEqual(await fs.readFile(board), before);
  const archive = path.join(directory, 'board-archive', 'HANDOFF-before-2026-10-31.md');
  const incomplete = await fs.readFile(archive);
  t.mock.restoreAll();
  await assert.rejects(postBoardEntry(board, entryFile, { rotateBefore: '2026-10-31' }), { code: 'EEXIST' });
  assert.deepEqual(await fs.readFile(archive), incomplete);
  assert.deepEqual(await fs.readFile(board), before);
});

test('UTC timestamp rotation selects individual old posts even when newer posts follow them', async (t) => {
  const boundary = '### 2026-10-31 12:30 UTC — boundary\nKeep exactly at cutoff.\n';
  const oldSameDay = '### 2026-10-31 12:29 UTC — old today\nArchive café.\n';
  const { directory, board, entryFile } = await fixture(t, header + oldSameDay + boundary + oldPost + newPost);
  await run(process.execPath, [writer, board, entryFile, '--rotate-before=2026-10-31T12:30:00Z']);
  const archives = await fs.readdir(path.join(directory, 'board-archive'));
  assert.equal(archives.length, 1);
  assert.deepEqual(await fs.readFile(path.join(directory, 'board-archive', archives[0])), Buffer.from(oldSameDay + oldPost + newPost));
  assert.deepEqual(await fs.readFile(board), Buffer.concat([
    Buffer.from(header), await fs.readFile(entryFile), Buffer.from(boundary),
  ]));
});

for (const corruption of ['heading', 'body']) {
  test(`same-size archive ${corruption} corruption refuses rotation without changing the board`, async (t) => {
    const { board, entryFile } = await fixture(t);
    const before = await fs.readFile(board);
    const writeFile = fs.writeFile.bind(fs);
    t.mock.method(fs, 'writeFile', (target, bytes, options) => {
      const output = Buffer.from(bytes);
      if (String(target).includes('board-archive')) output[corruption === 'heading' ? 0 : output.length - 3] = 88;
      return writeFile(target, output, options);
    });
    await assert.rejects(postBoardEntry(board, entryFile, { rotateBefore: '2026-10-31' }), /Archive .*verification/);
    assert.deepEqual(await fs.readFile(board), before);
  });
}
