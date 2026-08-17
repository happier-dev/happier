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
  try {
    await writeFile(path, 'existing\n', 'utf8');
    const follower = followLogFile({
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
    follower.close();

    assert.deepEqual(lines, ['existing', 'appended', 'after-truncate']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
