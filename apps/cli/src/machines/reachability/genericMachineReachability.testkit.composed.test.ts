// Install the genuine filesystem boundary before importing named filesystem APIs.
import { installGenericRootFileSystemBoundary } from './genericMachineReachability.composed.testkit';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// This owner supplies the Linux native reachability fixture's procfs/rootfs layout.
it.runIf(process.platform === 'linux')('appends confined log bytes, rejects sibling writes, and releases the next fixture root', async () => {
  const prefix = join(tmpdir(), 'happier-generic-composed-');
  const directory = await mkdtemp(prefix);
  const sibling = await mkdtemp(prefix);
  let filesystem: Awaited<ReturnType<typeof installGenericRootFileSystemBoundary>> | undefined;
  try {
    filesystem = await installGenericRootFileSystemBoundary(directory);
    await expect(appendFile(join(sibling, 'outside.log'), 'not-written'))
      .rejects.toMatchObject({ code: 'generic_fixture_os_refused' });

    const log = join(directory, 'session.log');
    await appendFile(log, 'first\n');
    await appendFile(log, 'second\n');
    expect(await readFile(log, 'utf8')).toBe('first\nsecond\n');

    filesystem.dispose();
    filesystem = undefined;
    const next = await mkdtemp(prefix);
    await rm(next, { recursive: true, force: true });
  } finally {
    filesystem?.dispose();
    await rm(directory, { recursive: true, force: true });
    await rm(sibling, { recursive: true, force: true });
  }
});
