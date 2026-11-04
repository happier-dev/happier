import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManagedSessionDirectories } from './managedSessionDirectories';
import { sessionFolders } from '@/storage/categories/sessionFolders';

vi.mock('@/configuration', () => ({ configuration: { activeServerDir: '/unused' } }));
vi.mock('@/ui/logger', () => ({ logger: { warn: vi.fn() } }));
// The race is injected at the filesystem syscall boundary. Ownership records,
// allocation, containment and permission/removal owners remain real.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, chmod: vi.fn(actual.chmod), open: vi.fn(actual.open), rm: vi.fn(actual.rm) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  const actual = await vi.importActual<typeof fs>('node:fs/promises');
  await Promise.all(roots.splice(0).map(root => actual.rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== 'linux')('managed payload native filesystem effects', () => {
  it.each(['delete-now', 'trash-empty'] as const)('keeps placed shared-Agent %s on the pinned remover through the storage adapter', async operation => {
    const actual = await vi.importActual<typeof fs>('node:fs/promises');
    const root = await actual.mkdtemp(join(tmpdir(), 'managed-storage-removal-'));
    roots.push(root);
    const workspace = join(root, 'shared-agent-workspace');
    const activeServerDir = join(root, 'daemon');
    await actual.mkdir(workspace);
    const owner = createManagedSessionDirectories({ activeServerDir,
      payloadPlacement: { root: workspace, agentUid: process.getuid!() } });
    const allocation = await owner.materializeForFreshSpawn({ sessionCreationTag: operation });
    await actual.writeFile(join(allocation.directory, 'payload'), 'selected Session');
    const adapter = await sessionFolders.adapterForEntry!({ kind: 'allocation', allocationId: allocation.allocationId },
      { activeServerDir, happyHomeDir: root, managedSessionDirectories: owner });
    const payloadPath = operation === 'trash-empty' ? join(root, 'trash-payload') : allocation.directory;
    if (operation === 'trash-empty') await adapter.retire({ payloadPath });
    // The real adapter supplies its generic recursive remover callback. Reject
    // that OS operation so successful deletion proves the placed owner keeps
    // its inode-pinned remover rather than delegating permission effects back.
    vi.mocked(fs.rm).mockImplementation(async (path, options) => {
      if (String(path) === payloadPath) throw new Error('Unsafe path-based recursive removal');
      return actual.rm(path, options);
    });
    await adapter.discard(operation === 'trash-empty' ? { payloadPath } : {});
    await expect(actual.stat(payloadPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await owner.listRecords({ includeTrashed: true })).toEqual([]);
  });

  it('keeps the owner directory untouched when the allocation is swapped at permission application', async () => {
    const actual = await vi.importActual<typeof fs>('node:fs/promises');
    const root = await actual.mkdtemp(join(tmpdir(), 'managed-permission-swap-'));
    roots.push(root);
    const workspace = join(root, 'accepted');
    const victim = join(root, 'owner-private');
    await actual.mkdir(workspace); await actual.mkdir(victim, { mode: 0o750 });
    const owner = createManagedSessionDirectories({ activeServerDir: join(root, 'daemon'),
      payloadPlacement: { root: workspace, agentUid: process.getuid!() } });
    const target = owner.prepareForCreation({ sessionCreationTag: 'permission-swap' });
    let attacked = false;
    const swap = async () => {
      if (attacked) return;
      attacked = true;
      await actual.rename(target.directory, `${target.directory}.moved`);
      await actual.symlink(victim, target.directory);
    };
    vi.mocked(fs.chmod).mockImplementation(async (path, mode) => {
      if (String(path) === target.directory) await swap();
      return actual.chmod(path, mode);
    });
    vi.mocked(fs.open).mockImplementation(async (path, flags, mode) => {
      const handle = await actual.open(path, flags, mode);
      if (String(path).endsWith(`/${target.allocationId}`)) await swap();
      return handle;
    });
    await owner.materializeForFreshSpawn({ sessionCreationTag: 'permission-swap' }).catch(() => undefined);
    expect(attacked).toBe(true);
    expect((await actual.stat(victim)).mode & 0o777).toBe(0o750);
  });

  it('preserves owner files when an accepted parent becomes a symlink during removal admission', async () => {
    const actual = await vi.importActual<typeof fs>('node:fs/promises');
    const root = await actual.mkdtemp(join(tmpdir(), 'managed-removal-swap-'));
    roots.push(root);
    const workspace = join(root, 'accepted');
    const victim = join(root, 'owner-private');
    await actual.mkdir(workspace); await actual.mkdir(victim);
    const owner = createManagedSessionDirectories({ activeServerDir: join(root, 'daemon'),
      payloadPlacement: { root: workspace, agentUid: process.getuid!() } });
    const target = await owner.materializeForFreshSpawn({ sessionCreationTag: 'removal-swap' });
    const victimAllocation = join(victim, target.allocationId);
    await actual.mkdir(victimAllocation);
    await actual.writeFile(join(victimAllocation, 'keep'), 'owner-private-bytes');
    await owner.removeAllocation(target.allocationId, { beforeEffect: async () => {
      await actual.rename(workspace, `${workspace}.moved`);
      await actual.symlink(victim, workspace);
    } });
    expect(await actual.readFile(join(victimAllocation, 'keep'), 'utf8')).toBe('owner-private-bytes');
    expect((await owner.listRecords())[0]?.pendingRemoval).toBe(true);
  });
});
