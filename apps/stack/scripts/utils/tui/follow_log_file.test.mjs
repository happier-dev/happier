import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { followLogFile } from './follow_log_file.mjs';

test('followLogFile streams existing and appended lines and survives truncation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-follow-log-'));
  const path = join(root, 'expo.log');
  const lines = [];
  let follower;
  try {
    await writeFile(path, 'existing\n', 'utf8');
    follower = followLogFile({
      path,
      intervalMs: 10,
      onLine: (line) => lines.push(line),
    });
    await appendFile(path, 'appended\n', 'utf8');
    const firstDeadline = Date.now() + 1_000;
    while (lines.length < 2 && Date.now() < firstDeadline) await delay(10);
    await writeFile(path, 'after-truncate\n', 'utf8');
    const secondDeadline = Date.now() + 1_000;
    while (!lines.includes('after-truncate') && Date.now() < secondDeadline) await delay(10);
    assert.deepEqual(lines, ['existing', 'appended', 'after-truncate']);
  } finally {
    follower?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('followLogFile replays only current-run timestamped remote lines while retaining local tails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-follow-log-current-run-'));
  const remotePath = join(root, 'remote-mac.log');
  const localPath = join(root, 'expo.log');
  const remoteLines = [];
  const localLines = [];
  let remoteFollower;
  let localFollower;
  try {
    await writeFile(
      remotePath,
      [
        '[remote:mac] [2026-09-16T09:00:00.000Z] stale Metro crash',
        '[remote:mac] [2026-09-20T08:00:01.000Z] current remote startup',
      ].join('\n') + '\n',
      'utf8',
    );
    await writeFile(localPath, '[expo] current local Metro startup\n', 'utf8');

    remoteFollower = followLogFile({
      path: remotePath,
      intervalMs: 10,
      initialSince: '2026-09-20T08:00:00.000Z',
      onLine: (line) => remoteLines.push(line),
    });
    localFollower = followLogFile({
      path: localPath,
      intervalMs: 10,
      onLine: (line) => localLines.push(line),
    });
    const deadline = Date.now() + 1_000;
    while ((remoteLines.length < 1 || localLines.length < 1) && Date.now() < deadline) await delay(10);
    await appendFile(remotePath, '[remote:mac] live remote progress\n', 'utf8');
    const appendDeadline = Date.now() + 1_000;
    while (remoteLines.length < 2 && Date.now() < appendDeadline) await delay(10);
    assert.deepEqual(remoteLines, [
      '[remote:mac] [2026-09-20T08:00:01.000Z] current remote startup',
      '[remote:mac] live remote progress',
    ]);
    assert.deepEqual(localLines, ['[expo] current local Metro startup']);
  } finally {
    remoteFollower?.close();
    localFollower?.close();
    await rm(root, { recursive: true, force: true });
  }
});
