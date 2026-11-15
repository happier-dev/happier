import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { localWorkspaceSource } from './localWorkspaceSource';

// A member can plant a FIFO or a device link in a folder the daemon later reads
// for someone else. The read port must settle with a typed refusal, never block
// a daemon filesystem thread or stream an endless device into memory.
const roots: string[] = [];
const unblockers: (() => Promise<void>)[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'happier-local-source-'));
  roots.push(root);
  return root;
}

function makeFifo(path: string): void {
  execFileSync('/usr/bin/mkfifo', [path]);
  // In a RED run the blocked reader holds a pool thread; a writer that opens and
  // closes gives it EOF, so the worker can exit.
  unblockers.push(async () => {
    const writer = await open(
      path,
      constants.O_WRONLY | constants.O_NONBLOCK,
    ).catch(() => null);
    await writer?.close();
  });
}

async function settlesBeforeObserved<T>(
  operation: Promise<T>,
): Promise<'pending' | { ok: true; value: T } | { ok: false; error: unknown }> {
  const settled = operation.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const observed = new Promise<'pending'>((resolve) => {
    setTimeout(() => resolve('pending'), 1_000);
  });
  return await Promise.race([settled, observed]);
}

describe.skipIf(process.platform === 'win32')(
  'localWorkspaceSource regular-file reads',
  () => {
    afterEach(async () => {
      for (const unblock of unblockers.splice(0)) await unblock();
      await Promise.all(
        roots
          .splice(0)
          .map((root) => rm(root, { recursive: true, force: true })),
      );
    });

    it('refuses a FIFO without blocking, through readFile and open', async () => {
      const fifo = join(await makeRoot(), 'README.md');
      makeFifo(fifo);
      for (const read of [
        () => localWorkspaceSource.readFile(fifo),
        () => localWorkspaceSource.open(fifo),
      ]) {
        const outcome = await settlesBeforeObserved(read());
        expect(outcome).toMatchObject({
          ok: false,
          error: { code: 'workspace_file_not_regular' },
        });
      }
    });

    it('refuses a device handle reached through a planted link', async () => {
      const link = join(await makeRoot(), 'notes.txt');
      await symlink('/dev/zero', link);
      const outcome = await settlesBeforeObserved(
        localWorkspaceSource.open(link),
      );
      if (outcome !== 'pending' && outcome.ok) await outcome.value.close();
      expect(outcome).toMatchObject({
        ok: false,
        error: { code: 'workspace_file_not_regular' },
      });
    });

    it('refuses to stream a device through readFile', async () => {
      const link = join(await makeRoot(), 'notes.txt');
      await symlink('/dev/zero', link);
      await expect(localWorkspaceSource.readFile(link)).rejects.toMatchObject({
        code: 'workspace_file_not_regular',
      });
    });

    it('keeps reading regular files, and refuses a final link only when asked', async () => {
      const root = await makeRoot();
      const file = join(root, 'a.txt');
      const link = join(root, 'b.txt');
      await writeFile(file, 'regular bytes');
      await symlink(file, link);
      expect((await localWorkspaceSource.readFile(link)).toString()).toBe(
        'regular bytes',
      );
      const handle = await localWorkspaceSource.open(file, { noFollow: true });
      await handle.close();
      await expect(
        localWorkspaceSource.open(link, { noFollow: true }),
      ).rejects.toMatchObject({ code: 'ELOOP' });
    });
  },
);
