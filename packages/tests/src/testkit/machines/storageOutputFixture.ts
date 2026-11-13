import { mkdir, mkdtemp, realpath, rm, statfs, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { DiskScanStateV1Schema, MachineStorageCategoryListResultV1Schema,
  MachineStoragePileResultV1Schema, PileApplyResultV1Schema, PileReviewV1Schema,
} from '@happier-dev/protocol/storage/storageV1';
import { createDaemonStorageRoutes, registerDaemonStorageRpcHandlers } from '../../../../../apps/cli/src/rpc/handlers/storage';
import { createStoragePolicyFixture } from '../../../../../apps/cli/src/storage/storagePolicy.testkit';
import { createProcessCustodyFixture } from '../../../../../apps/cli/src/testkit/processCustodyFixture';
import { createActivityLog } from '../../../../../apps/cli/src/daemon/guard/activityLog';
import { createMachineResourceSummary } from '../../../../../apps/cli/src/daemon/resources/machineResourceSummary';
import { createMachineVitalsSampler } from '../../../../../apps/cli/src/daemon/vitals/createMachineVitalsSampler';
import { createMinuteHistoryStore } from '../../../../../apps/cli/src/daemon/vitals/history/minuteHistoryStore';
import { createNativeOutputRpcManager, invokeNativeOutput, nativeOutputTarget } from './nativeOutputFixture';

export type StorageOutputFixture = Awaited<ReturnType<typeof createStorageOutputFixture>>;

/** Real receiving dispatch, catalog, measurement, pile and scan owners over
 * disposable files. Only Home admission and metadata transport are substituted
 * by the existing testkits; the prepared native helper performs real OS work. */
export async function createStorageOutputFixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'machines-output-storage-')));
  const cleanup: (() => void | Promise<void>)[] = [() => rm(directory, { recursive: true, force: true })];
  try {
    // Load source before the native-asset fixture changes the executable path.
    await import('../../../../../apps/cli/src/storage/storageService');
    cleanup.push(await createProcessCustodyFixture({ repoRoot: fileURLToPath(new URL('../../../../../', import.meta.url)) }));
    const home = join(directory, 'happier');
    const personalHome = join(directory, 'person');
    const protectedPath = join(directory, 'protected');
    const scanRoot = join(directory, 'scan');
    await Promise.all([home, personalHome, protectedPath, scanRoot, join(home, 'logs')]
      .map(path => mkdir(path, { recursive: true })));
    await writeFile(join(scanRoot, 'data.txt'), 'Measured by the real native storage scanner.');
    const policy = await createStoragePolicyFixture({ wholeDiskEnabled: true, logRetentionDays: 1 });
    cleanup.push(() => policy.stop());
    const server = join(home, 'server');
    // Activity receipts consume the real summary owner. No OS vitals sample is
    // required for a storage mutation, so its OS reader reports unavailable.
    const sampler = createMachineVitalsSampler({ readers: { read: async () => ({ state: 'unavailable', reason: 'helper_missing' }) },
      historyStore: await createMinuteHistoryStore({ directory: join(server, 'history') }) });
    cleanup.push(() => sampler.stop());
    const resourceSummary = createMachineResourceSummary({ sampler, readNearlyFull: () => null,
      onError: error => { throw error; } });
    cleanup.push(() => resourceSummary.stop());
    const activityLog = await createActivityLog({ activeServerDir: server, resourceSummary });
    const filesystem = await statfs(directory);
    const volume = { id: 'storage-output-volume', label: 'Temporary fixture filesystem', mount: directory,
      totalBytes: filesystem.bsize * filesystem.blocks, availableBytes: filesystem.bsize * filesystem.bavail };
    const manager = createNativeOutputRpcManager();
    const routes = createDaemonStorageRoutes({ target: () => nativeOutputTarget,
      readOwnSessionIds: () => new Set(),
      deps: () => ({ resourcesPolicy: policy, machineId: nativeOutputTarget.machineId,
        serverId: nativeOutputTarget.serverId, custodianAccountId: nativeOutputTarget.custodianAccountId,
        homeDir: personalHome, activityLog, catalog: { happyHomeDir: home, activeServerDir: server,
          tempRoot: join(directory, 'temporary'), readProjects: () => ({ status: 'ready', projects: [] }),
          readWorktrees: () => [], readInUsePaths: () => ({ reliable: true, paths: [] }) },
        readVolumes: () => [volume],
        readStorageProtectionFacts: () => ({ homeDir: personalHome, platform: process.platform,
          systemPaths: [], personalFolders: [], knownFolders: {}, browserProfileRoots: [], cloudSyncedFolders: [] }),
      }) });
    cleanup.push(() => routes.dispose());
    registerDaemonStorageRpcHandlers(manager, routes);
    const target = { serverId: nativeOutputTarget.serverId, machineId: nativeOutputTarget.machineId };
    const scanIds = new Set<string>();
    const invoke = async (id: ActionId, input: unknown) => {
      const result = await invokeNativeOutput(manager, id, input);
      if (id === 'machines.storage.scan.start') scanIds.add(DiskScanStateV1Schema.parse(result).scanId);
      return result;
    };
    // A summary read starts cold sizing in the background. Finish that first
    // snapshot before cases create files that their explicit refresh must see.
    await invoke('machines.storage.size.refresh', target);
    let nextLog = 0;
    const servedRef = async () => {
      const path = join(home, 'logs', `expired-${nextLog++}.log`);
      await writeFile(path, 'An expired fixture log, safely disposable.');
      const old = new Date(Date.now() - 3 * 86_400_000);
      await utimes(path, old, old);
      await invoke('machines.storage.size.refresh', { ...target, categoryId: 'logs' });
      const listed = MachineStorageCategoryListResultV1Schema.parse(await invoke('machines.storage.category.list',
        { ...target, categoryId: 'logs' }));
      const item = listed.items.find(candidate => candidate.path === path);
      if (!item) throw new Error('Real storage catalog did not serve the fixture log');
      return { itemId: item.itemId, path: item.path };
    };
    const reviewedItems = async () => {
      const ref = await servedRef();
      const pile = MachineStoragePileResultV1Schema.parse(await invoke('machines.storage.pile.set', { ...target, add: [ref] }));
      if (!pile.items.some(item => item.itemId === ref.itemId)) throw new Error('Storage pile did not retain the served fixture reference');
      const review = PileReviewV1Schema.parse(await invoke('machines.storage.items.check', { ...target, refs: [ref] }));
      const item = review.items.find(candidate => candidate.ref.itemId === ref.itemId);
      if (!item || item.verdict !== 'safe') throw new Error('Real storage review did not classify the expired fixture log as safe');
      return [{ ref: item.ref, expect: item.expect, claimedVerdict: item.verdict }];
    };
    const movedEntries = async () => {
      const moved = PileApplyResultV1Schema.parse(await invoke('machines.storage.trash.move',
        { ...target, items: await reviewedItems() }));
      if (!moved.outcomes.some(outcome => outcome.status === 'moved')) throw new Error('Real storage owner did not move the fixture log to Trash');
      const trash = MachineStorageCategoryListResultV1Schema.parse(await invoke('machines.storage.category.list',
        { ...target, categoryId: 'trash' }));
      const entries = trash.trashEntries?.filter(entry => entry.batchId === moved.batchId) ?? [];
      if (!entries.length) throw new Error('Moved fixture log was not served by the real Trash owner');
      return entries.map(entry => entry.entryId);
    };
    const retainedScan = async () => {
      const scanId = scanIds.values().next().value ?? DiskScanStateV1Schema.parse(await invoke('machines.storage.scan.start',
        { ...target, target: { folderPath: scanRoot } })).scanId;
      // The real cancel owner waits for its native child and retains the index.
      // Reuse the start case's scan rather than admitting a competing traversal.
      await invoke('machines.storage.scan.cancel', { ...target, scanId });
      return scanId;
    };
    return { target, directory, scanRoot, protectedPath, invoke, servedRef, reviewedItems, movedEntries, retainedScan,
      close: async () => {
        try {
          for (const scanId of scanIds) await invoke('machines.storage.scan.cancel', { ...target, scanId });
        } finally { for (const release of cleanup.splice(0).reverse()) await release(); }
      },
    };
  } catch (error) { for (const release of cleanup.splice(0).reverse()) await release(); throw error; }
}

type StorageCase = Readonly<{ input(fixture: StorageOutputFixture): unknown | Promise<unknown>;
  execute?(fixture: StorageOutputFixture, input: unknown): Promise<unknown> }>;
export const storageOutputCases = new Map<ActionId, StorageCase>([
  ['machines.storage.summary.get', { input: f => f.target }],
  ['machines.storage.path.capacity.get', { input: f => ({ ...f.target, path: f.directory }) }],
  ['machines.storage.pile.get', { input: async f => {
    await f.invoke('machines.storage.pile.set', { ...f.target, add: [await f.servedRef()] });
    return f.target;
  } }],
  ['machines.storage.pile.set', { input: async f => ({ ...f.target, add: [await f.servedRef()] }) }],
  ['machines.storage.items.check', { input: async f => ({ ...f.target, refs: [await f.servedRef()] }) }],
  ['machines.storage.trash.move', { input: async f => ({ ...f.target, items: await f.reviewedItems() }) }],
  ['machines.storage.deleteNow', { input: async f => ({ ...f.target,
    items: (await f.reviewedItems()).map(({ ref, expect }) => ({ ref, expect })) }) }],
  // No Docker runtime is configured on this disposable Machine. The receiving
  // handler's declared unsupported result is real, after ordinary admission.
  ['machines.storage.docker.prune', { input: f => ({ ...f.target, selection: { kind: 'unusedBuildCacheAndUnreferencedImages' } }) }],
  ['machines.storage.trash.empty', { input: async f => ({ ...f.target, entryIds: await f.movedEntries() }) }],
  ['machines.storage.trash.restore', { input: async f => ({ ...f.target, entryIds: await f.movedEntries() }) }],
  ['machines.storage.worktrees.list', { input: f => f.target }],
  ['machines.storage.suggestions.list', { input: async f => { await f.servedRef(); return f.target; } }],
  ['machines.storage.suggestions.decline', { input: async f => ({ ...f.target,
    items: (await f.reviewedItems()).map(({ ref, expect }) => ({ ref, expect })) }) }],
  ['machines.storage.scan.start', { input: f => ({ ...f.target, target: { folderPath: f.scanRoot } }) }],
  ['machines.storage.scan.get', { input: async f => ({ ...f.target, scanId: await f.retainedScan() }) }],
  ['machines.storage.scan.cancel', { input: async f => ({ ...f.target, scanId: await f.retainedScan() }) }],
  ['machines.storage.scan.skip', { input: async f => ({ ...f.target, scanId: await f.retainedScan(), path: f.scanRoot }) }],
  ['machines.storage.protected.add', { input: f => ({ ...f.target, path: f.protectedPath }) }],
  ['machines.storage.protected.remove', { input: async f => {
    await f.invoke('machines.storage.protected.add', { ...f.target, path: f.protectedPath });
    return { ...f.target, path: f.protectedPath };
  } }],
  ['machines.storage.category.list', { input: async f => { await f.servedRef(); return { ...f.target, categoryId: 'logs' }; } }],
  ['machines.storage.size.refresh', { input: async f => { await f.servedRef(); return { ...f.target, categoryId: 'logs' }; } }],
]);
