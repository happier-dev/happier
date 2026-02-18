import { appendFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startFileWatcher } from './startFileWatcher';

async function waitFor(condition: () => boolean, opts?: { timeoutMs?: number; intervalMs?: number }): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 5_000;
  const intervalMs = opts?.intervalMs ?? 25;
  const start = Date.now();
  while (true) {
    if (condition()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe('startFileWatcher', () => {
  it('fires when a missing file is created and later modified', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happy-file-watcher-'));
    const file = join(dir, 'out.jsonl');

    let calls = 0;
    const stop = startFileWatcher(file, () => {
      calls += 1;
    });

    await writeFile(file, 'hello\n', 'utf8');
    await waitFor(() => calls >= 1);

    await appendFile(file, 'world\n', 'utf8');
    await waitFor(() => calls >= 2);

    stop();

    const callsBefore = calls;
    await appendFile(file, 'after-stop\n', 'utf8');
    await new Promise((r) => setTimeout(r, 150));
    expect(calls).toBe(callsBefore);
  });
});

