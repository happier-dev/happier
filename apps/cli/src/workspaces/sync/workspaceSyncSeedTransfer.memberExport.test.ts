import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, mkdtemp, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { readTransferPayloadChunk } from '@/machines/transfer/transferPayloadSource';
import { removeTempDir } from '@/testkit/fs/tempDir';
import { createScmBackendRegistry } from '@/scm/registry';
import {
  createMemberWorkspaceSyncSeedExport,
  createWorkspaceSyncSeedExport,
  resolveWorkspaceSyncSeedTransfer,
} from './workspaceSyncSeedTransfer';

// OS boundary only: an identity scope stands in for the member's UID (the kernel refuses
// the member a daemon-private file). Every module's filesystem calls go through it.
const os = vi.hoisted(() => ({
  identity: undefined as unknown as import('node:async_hooks').AsyncLocalStorage<'member'>,
  watched: '',
  secret: '',
  daemonOpens: [] as string[],
}));
os.identity = new AsyncLocalStorage<'member'>();
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const guard = async (path: unknown) => {
    const name = typeof path === 'string' ? path : '';
    if (!os.watched || !name.startsWith(os.watched)) return;
    if (os.identity.getStore() !== 'member') {
      os.daemonOpens.push(name);
      return;
    }
    const real = await actual.realpath(name).catch(() => name);
    if (os.secret && real.startsWith(os.secret))
      throw Object.assign(new Error('Member cannot read a daemon-private file'), { code: 'EACCES' });
  };
  const wrap = <T extends (...args: never[]) => Promise<unknown>>(fn: T) =>
    (async (...args: Parameters<T>) => { await guard(args[0]); return fn(...args); }) as T;
  const patched = { ...actual, open: wrap(actual.open), readFile: wrap(actual.readFile), stat: wrap(actual.stat), lstat: wrap(actual.lstat) };
  return { ...patched, default: patched };
});

const policy = resolveWorkspaceSyncSeedTransfer({
  selection: 'all_files',
  extraIncludePatterns: [],
  extraIgnorePatterns: [],
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'happier-member-seed-'));
  onTestFinished(() => {
    os.watched = '';
    os.secret = '';
    os.daemonOpens.length = 0;
    return removeTempDir(directory);
  });
  const source = join(directory, 'member-folder', 'project');
  await mkdir(join(source, 'dir'), { recursive: true });
  await writeFile(join(source, 'dir', 'file.txt'), 'member bytes');
  os.secret = join(directory, 'daemon-private');
  await mkdir(os.secret);
  await writeFile(join(os.secret, 'file.txt'), 'DAEMON-ONLY');
  os.watched = directory;
  // The member builds its own seed (in its Sync process).
  const built = await os.identity.run('member', () =>
    createWorkspaceSyncSeedExport({
      operationId: 'seed-op',
      activeServerDir: join(directory, 'member-state'),
      sourcePath: source,
      workspaceTransfer: policy,
        // No SCM backend: a plain folder takes the scan path.
        registry: createScmBackendRegistry([]),
    }),
  );
  const [blobTransferId] = built.blobTransferIds;
  if (!blobTransferId) throw new Error('The seed names no blob');
  // A timed directory swap after the scan: the blob's path now leads to a daemon-private file.
  await rename(join(source, 'dir'), join(source, 'dir-old'));
  await symlink(os.secret, join(source, 'dir'));
  os.daemonOpens.length = 0;
  return { built, blobTransferId };
}

const readAll = async (
  source: Parameters<typeof readTransferPayloadChunk>[0]['source'],
) =>
  (
    await readTransferPayloadChunk({ source, offset: 0, length: 1024 })
  ).toString('utf8');

// MEMBER-PATH-READS-1115 row 3 / MEMBER-CHILD-READS-1115 (A).
describe.skipIf(process.platform === 'win32')(
  'member SOURCE seed export',
  () => {
    it('serves a daemon-held seed only through the member, so a directory swap discloses nothing', async () => {
      const { built, blobTransferId } = await fixture();
      const served = createMemberWorkspaceSyncSeedExport({
        operationId: 'seed-op',
        envelope: built.payloadSource.payload,
        readBlob: (request) =>
          os.identity.run('member', async () =>
            readTransferPayloadChunk({
              source: await built.onDemandScope.resolvePayloadSourceOnOpen({
                transferId: request.transferId,
                requestBody: undefined,
              }),
              offset: request.offset,
              length: request.length,
            }),
          ),
      });
      expect(served.onDemandScope.allowTransferId(blobTransferId)).toBe(true);
      expect(served.onDemandScope.allowTransferId('seed-op:blob:other')).toBe(
        false,
      );
      const blob = await served.onDemandScope.resolvePayloadSourceOnOpen({
        transferId: blobTransferId,
        requestBody: undefined,
      });
      await expect(readAll(blob)).rejects.toMatchObject({ code: 'EACCES' });
      expect(os.daemonOpens).toEqual([]);
    });

    it('the daemon-side serving it replaces reads the swapped daemon-private file', async () => {
      const { built, blobTransferId } = await fixture();
      const blob = await built.onDemandScope.resolvePayloadSourceOnOpen({
        transferId: blobTransferId,
        requestBody: undefined,
      });
      expect(await readAll(blob)).toBe('DAEMON-ONLY');
      expect(os.daemonOpens.length).toBeGreaterThan(0);
    });
  },
);
