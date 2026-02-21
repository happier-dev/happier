import { describe, expect, it, vi } from 'vitest';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JsonlFollower } from '../jsonlFollower';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(assertion: () => void, opts?: { timeoutMs?: number; intervalMs?: number }) {
  const timeoutMs = opts?.timeoutMs ?? 5000;
  const intervalMs = opts?.intervalMs ?? 10;
  const start = Date.now();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - start > timeoutMs) {
        throw error;
      }
      await delay(intervalMs);
    }
  }
}

describe('JsonlFollower', () => {
  it('starts only one polling interval when started concurrently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonl-follower-start-once-'));
    const filePath = join(root, 'rollout.jsonl');
    await writeFile(filePath, '');

    const follower = new JsonlFollower({
      filePath,
      pollIntervalMs: 5,
      startAtEnd: true,
      onJson: () => {},
    });

    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    try {
      await Promise.all([follower.start(), follower.start()]);
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    } finally {
      setIntervalSpy.mockRestore();
      await follower.stop().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not emit ENOENT errors while waiting for file creation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonl-follower-missing-'));
    const filePath = join(root, 'rollout.jsonl');

    const received: unknown[] = [];
    const errors: Array<NodeJS.ErrnoException | unknown> = [];
    const follower = new JsonlFollower({
      filePath,
      pollIntervalMs: 5,
      onJson: (value: unknown) => {
        received.push(value);
      },
      onError: (error: unknown) => errors.push(error),
    });
    await follower.start();

    try {
      await writeFile(filePath, '{"created":true}\n');
      await waitFor(() => {
        expect(received).toEqual([{ created: true }]);
      });
      expect(errors).toEqual([]);
    } finally {
      await follower.stop().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it('buffers partial last line until newline is written', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonl-follower-'));
    const filePath = join(root, 'rollout.jsonl');

    await writeFile(filePath, '');

    const received: unknown[] = [];
    const follower = new JsonlFollower({
      filePath,
      pollIntervalMs: 5,
      onJson: (value: unknown) => {
        received.push(value);
      },
    });
    await follower.start();

    try {
      await appendFile(filePath, '{"a":1}');
      await delay(30);
      expect(received).toEqual([]);

      await appendFile(filePath, '\n');
      await waitFor(() => {
        expect(received).toEqual([{ a: 1 }]);
      });
    } finally {
      await follower.stop().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it('can start at end and only emit newly appended lines', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonl-follower-end-'));
    const filePath = join(root, 'rollout.jsonl');

    await writeFile(filePath, '{"old":1}\n');

    const received: unknown[] = [];
    const follower = new JsonlFollower({
      filePath,
      pollIntervalMs: 5,
      startAtEnd: true,
      onJson: (value: unknown) => {
        received.push(value);
      },
    });
    await follower.start();

    try {
      await delay(30);
      expect(received).toEqual([]);

      await appendFile(filePath, '{"new":2}\n');
      await waitFor(() => {
        expect(received).toEqual([{ new: 2 }]);
      });
    } finally {
      await follower.stop().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves multi-byte UTF-8 characters that are split across reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jsonl-follower-utf8-'));
    const filePath = join(root, 'rollout.jsonl');

    await writeFile(filePath, '');

    const received: unknown[] = [];
    const errors: unknown[] = [];
    const follower = new JsonlFollower({
      filePath,
      pollIntervalMs: 5,
      onJson: (value: unknown) => {
        received.push(value);
      },
      onError: (error: unknown) => errors.push(error),
    });
    await follower.start();

    try {
      const prefix = Buffer.from('{"t":"', 'utf8');
      const emoji = Buffer.from('💩', 'utf8');
      const suffix = Buffer.from('"}\n', 'utf8');

      await appendFile(filePath, prefix);
      await appendFile(filePath, emoji.subarray(0, 2));
      await delay(30);

      await appendFile(filePath, emoji.subarray(2));
      await appendFile(filePath, suffix);

      await waitFor(() => {
        expect(received).toEqual([{ t: '💩' }]);
      }, { timeoutMs: 500 });
      expect(errors).toEqual([]);
    } finally {
      await follower.stop().catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });
});
