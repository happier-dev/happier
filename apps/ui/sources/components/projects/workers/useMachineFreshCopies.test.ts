import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeWorkspaceSyncPolicyDigest, type WorkspaceSyncRelationshipV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { Modal } from '@/modal';

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));

const rpc = vi.hoisted(() => ({ machine: vi.fn() }));
// The daemon network is the boundary; classification, Account scope and Sync codecs are real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
  const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
  return createServerScopedMachineRpcBoundaryMock(rpc.machine);
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { storage } = await import('@/sync/domains/state/storage');
const { useMachineFreshCopies } = await import('./useMachineFreshCopies');
const { settingsParse } = await import('@/sync/domains/settings/settings');
let serverId: string;
beforeEach(async () => {
  await homes.reset(); await loadSyncSingletonForTests(); rpc.machine.mockReset();
  serverId = await homes.addHome({ name: 'Copies', serverUrl: 'https://fresh-copies.test', accountId: 'owner' });
});
afterEach(async () => { await homes.reset(); });

async function seed() {
  const scope = { serverId, accountId: 'owner' };
  const source = { id: 'source', serverId, machineId: 'source-machine', rootPath: '/source/project', createdAtMs: 1 };
  const target = { id: 'target', serverId, machineId: 'worker', rootPath: '/worker/project', createdAtMs: 1 };
  const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
  const relationship: WorkspaceSyncRelationshipV1 = {
    v: 1, relationshipId: 'copy', controllerMachineId: 'controller',
    alphaWorkspaceRefId: target.id, betaWorkspaceRefId: source.id, mode: 'keep_synced', enabled: true,
    contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) }, createdAtMs: 1, updatedAtMs: 1,
    provenance: { kind: 'worker_clean_copy', sourceWorkspaceRefId: source.id, targetWorkspaceRefId: target.id },
  };
  await act(async () => {
    storage.getState().activateProfileScope(scope);
    await storage.getState().activateSettingsScope(scope);
    storage.getState().applySettingsForScope(scope, settingsParse({}), (storage.getState().settingsVersion ?? 0) + 1);
    storage.getState().activateProjectAccountRowsScope(scope);
    storage.getState().applyProjectAccountRowsForScope(scope, { scope, status: 'ready', coverage: 'complete',
      workspaceRefs: [source, target], relationships: [relationship, { ...relationship, provenance: undefined, relationshipId: 'ordinary' }],
      organizations: [], revisionsByPhysicalKey: {} });
  });
  return { scope, relationship, source, target };
}

async function waiveRetirement() {
  const settings = settingsParse({ actionsSettingsV1: { v: 1, actions: {},
    approvalWaivedSurfaces: { 'projects.worker.copy.retire': ['ui'] } } });
  homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
  await act(async () => { storage.getState().applySettingsForScope({ serverId, accountId: 'owner' }, settings,
    (storage.getState().settingsVersion ?? 0) + 1); });
}

function answerFacts(lastCleanSyncAtMs: number | null = 1234, sizeBytes = 0) {
  rpc.machine.mockImplementation(async ({ method }: { method: string }) => {
    if (method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_LIST) return { statuses: [{
      relationshipId: 'copy', controllerMachineId: 'controller', state: 'watching',
      alphaPath: '/worker/project', betaPath: '/source/project', mode: 'keep_synced',
      endpointStates: { alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
        beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 } },
      conflictCount: 0, lastCycleObservedAtMs: 9999, lastCleanSyncAtMs,
    }] };
    if (method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT) return { ok: true,
      preview: { targetMachineId: 'worker', workspaceRefId: 'target', rootFingerprint: 'a'.repeat(64), sizeBytes } };
    throw new Error(`unexpected_rpc:${method}`);
  });
}

describe('Machine fresh-copy model', () => {
  it('reads only bound worker targets and exposes actual clean time and measured zero bytes', async () => {
    await seed(); answerFacts();
    const hook = await renderHook(() => useMachineFreshCopies(serverId, 'worker'));
    expect(hook.getCurrent().copies).toHaveLength(1);
    expect(hook.getCurrent().copies?.[0]).toHaveProperty('lastCleanSyncAtMs');
    await waitForHomeGovernance(() => expect(hook.getCurrent().copies?.[0]).toMatchObject({
      source: { id: 'source' }, target: { id: 'target' }, lastCleanSyncAtMs: 1234, sizeBytes: 0,
    }));
    await hook.unmount();
  });

  it('keeps unavailable distinct from empty and never substitutes last checked or guessed size', async () => {
    const { scope } = await seed(); answerFacts(null);
    const hook = await renderHook(() => useMachineFreshCopies(serverId, 'worker'));
    expect(hook.getCurrent().copies?.[0]).toHaveProperty('lastCleanSyncAtMs');
    await waitForHomeGovernance(() => expect(hook.getCurrent().copies?.[0]).toMatchObject({ lastCleanSyncAtMs: null }));
    await act(async () => { storage.getState().setProjectAccountRowsStatusForScope(scope, 'locked'); });
    expect(hook.getCurrent().copies).toBeNull();
    await act(async () => {
      storage.getState().applyProjectAccountRowsForScope(scope, { scope, status: 'ready', coverage: 'complete',
        workspaceRefs: [], relationships: [], organizations: [], revisionsByPhysicalKey: {} });
    });
    expect(hook.getCurrent().copies).toEqual([]);
    await hook.unmount();
  });

  it('continues Ask-first until a confirmed retirement receipt, then removes the row without replay', async () => {
    await seed(); answerFacts(); vi.spyOn(Modal, 'confirm').mockResolvedValue(true);
    const disposeExecutor = await installRealActionExecutorModuleLoader();
    const readFacts = rpc.machine.getMockImplementation()!;
    rpc.machine.mockImplementation(async input => input.method === 'projects.worker.copy.retire'
      ? { status: 'retired' } : await readFacts(input));
    const hook = await renderHook(() => useMachineFreshCopies(serverId, 'worker'));
    let pending: Promise<void>;
    await act(async () => { pending = hook.getCurrent().remove(hook.getCurrent().copies![0]!); void pending.catch(() => {}); });
    try {
      expect(hook.getCurrent()).toHaveProperty('approvalId');
      await waitForHomeGovernance(() => expect(hook.getCurrent().approvalId).toBeTypeOf('string'));
      expect(hook.getCurrent().copies).toHaveLength(1);
      expect(rpc.machine.mock.calls.filter(([input]) => input.method === 'projects.worker.copy.retire')).toHaveLength(0);
      await decideApprovalAsInbox(serverId, hook.getCurrent().approvalId!, 'approve');
      // The disconnected network fixture has no push; read the real settled approval Artifact.
      await act(async () => { await hook.getCurrent().refreshApproval(); });
      await act(async () => { await pending!; });
      expect(hook.getCurrent().copies).toEqual([]);
      expect(rpc.machine.mock.calls.filter(([input]) => input.method === 'projects.worker.copy.retire')).toHaveLength(1);
    } finally { await hook.unmount(); disposeExecutor(); }
  });

  it('honors waived Action approval without a second local confirmation and omits files removal', async () => {
    const { relationship } = await seed(); answerFacts();
    await waiveRetirement();
    const confirm = vi.spyOn(Modal, 'confirm').mockResolvedValue(false);
    const readFacts = rpc.machine.getMockImplementation()!;
    rpc.machine.mockImplementation(async input => input.method === 'projects.worker.copy.retire'
      ? { status: 'retired' } : await readFacts(input));
    const hook = await renderHook(() => useMachineFreshCopies(serverId, 'worker'));
    await act(async () => { await hook.getCurrent().remove(hook.getCurrent().copies![0]!); });
    expect(hook.getCurrent().copies).toEqual([]);
    const writes = rpc.machine.mock.calls.filter(([input]) => input.method === 'projects.worker.copy.retire');
    expect(writes.map(([input]) => input.payload)).toEqual([{
      workspace: { serverId, refId: 'source' }, machineId: 'controller', expectedRelationship: relationship,
    }]);
    expect(confirm).not.toHaveBeenCalled();
    await hook.unmount();
  });

  it('rejects repeated removal in the pending mutation lifetime and accepts renewed intent after settlement', async () => {
    await seed(); answerFacts(); await waiveRetirement();
    const readFacts = rpc.machine.getMockImplementation()!;
    const receipts: Array<() => void> = [];
    rpc.machine.mockImplementation(async input => input.method === 'projects.worker.copy.retire'
      ? await new Promise(resolve => receipts.push(() => resolve({ ok: false, error: 'in_use',
          errorCode: 'workspace_sync_relationship_in_use' })))
      : await readFacts(input));
    const hook = await renderHook(() => useMachineFreshCopies(serverId, 'worker'));
    const pending: Promise<void>[] = [];
    try {
      // Two calls before React commits must still share the existing pending interaction.
      await act(async () => {
        const copy = hook.getCurrent().copies![0]!;
        pending.push(hook.getCurrent().remove(copy), hook.getCurrent().remove(copy));
      });
      await waitForHomeGovernance(() => expect(receipts.length).toBeGreaterThan(0));
      expect(receipts).toHaveLength(1);
      await act(async () => { receipts.forEach(receipt => receipt()); await Promise.all(pending); });
      expect(hook.getCurrent().busy).toBe(false);
      expect(hook.getCurrent().copies).toHaveLength(1);
      await act(async () => { pending.push(hook.getCurrent().remove(hook.getCurrent().copies![0]!)); });
      await waitForHomeGovernance(() => expect(receipts).toHaveLength(2));
      await act(async () => { receipts[1]!(); await pending.at(-1); });
    } finally {
      await act(async () => { receipts.forEach(receipt => receipt()); await Promise.all(pending); });
      await hook.unmount();
    }
  });

  it('rejects another removal while the existing approval is pending, then permits renewed intent after denial', async () => {
    await seed(); answerFacts();
    const disposeExecutor = await installRealActionExecutorModuleLoader();
    const hook = await renderHook(() => useMachineFreshCopies(serverId, 'worker'));
    let pending: Promise<void> | null = null;
    try {
      await act(async () => { pending = hook.getCurrent().remove(hook.getCurrent().copies![0]!); });
      await waitForHomeGovernance(() => expect(hook.getCurrent().approvalId).toBeTypeOf('string'));
      const originalApproval = hook.getCurrent().approvalId!;
      let repeatedSettled = false;
      await act(async () => { void hook.getCurrent().remove(hook.getCurrent().copies![0]!).then(() => { repeatedSettled = true; }); });
      await waitForHomeGovernance(() => expect(repeatedSettled).toBe(true));
      expect(hook.getCurrent().approvalId).toBe(originalApproval);
      expect(await decideApprovalAsInbox(serverId, originalApproval, 'reject')).toMatchObject({ ok: true });
      await act(async () => { await hook.getCurrent().refreshApproval(); });
      await act(async () => { await pending; });
      expect(hook.getCurrent().busy).toBe(false);
      expect(hook.getCurrent().copies).toHaveLength(1);
      await act(async () => { pending = hook.getCurrent().remove(hook.getCurrent().copies![0]!); });
      await waitForHomeGovernance(() => {
        expect(hook.getCurrent().approvalId).toBeTypeOf('string');
        expect(hook.getCurrent().approvalId).not.toBe(originalApproval);
      });
      expect(await decideApprovalAsInbox(serverId, hook.getCurrent().approvalId!, 'reject')).toMatchObject({ ok: true });
      await act(async () => { await hook.getCurrent().refreshApproval(); });
      await act(async () => { await pending; });
      expect(rpc.machine.mock.calls.filter(([input]) => input.method === 'projects.worker.copy.retire')).toHaveLength(0);
    } finally { await hook.unmount(); disposeExecutor(); }
  });

  it('gets the exact current preview for explicitly selected files removal', async () => {
    await seed(); answerFacts(); vi.spyOn(Modal, 'confirm').mockResolvedValue(true);
    await waiveRetirement();
    const readFacts = rpc.machine.getMockImplementation()!;
    const hook = await renderHook(() => useMachineFreshCopies(serverId, 'worker'));
    await waitForHomeGovernance(() => expect(hook.getCurrent().copies?.[0]?.review).toMatchObject({
      ok: true, preview: { rootFingerprint: 'a'.repeat(64) },
    }));
    rpc.machine.mockImplementation(async input => input.method === 'projects.worker.copy.retire'
      ? { status: 'retired' } : input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT
        ? { ok: true, preview: { targetMachineId: 'worker', workspaceRefId: 'target', rootFingerprint: 'b'.repeat(64), sizeBytes: 42 } }
        : await readFacts(input));
    await act(async () => { await hook.getCurrent().remove(hook.getCurrent().copies![0]!, { removeFiles: true }); });
    const writes = rpc.machine.mock.calls.filter(([input]) => input.method === 'projects.worker.copy.retire');
    expect(writes.map(([input]) => input.payload.removeTargetCopy)).toEqual([{ workspaceRefId: 'target', rootFingerprint: 'b'.repeat(64) }]);
    expect(hook.getCurrent().copies).toEqual([]);
    await hook.unmount();
  });

  it.each([
    { errorCode: 'indeterminate', details: { kind: 'outcomeUnknown' }, kind: 'unknown' },
    { errorCode: 'workspace_sync_relationship_in_use', details: { dependencies: [{ workspaceRefId: 'target', operationId: 'busy', state: 'running' }] }, kind: 'in_use' },
  ])('retains and refreshes $kind without repeating retirement', async failure => {
    await seed(); answerFacts(); vi.spyOn(Modal, 'confirm').mockResolvedValue(true);
    await waiveRetirement();
    const readFacts = rpc.machine.getMockImplementation()!;
    rpc.machine.mockImplementation(async input => input.method === 'projects.worker.copy.retire'
      ? { ok: false, error: failure.errorCode, errorCode: failure.errorCode, details: failure.details } : await readFacts(input));
    const hook = await renderHook(() => useMachineFreshCopies(serverId, 'worker'));
    rpc.machine.mockClear();
    await act(async () => { await hook.getCurrent().remove(hook.getCurrent().copies![0]!); });
    expect(hook.getCurrent().copies).toHaveLength(1);
    expect(hook.getCurrent().notice).toMatchObject({ kind: failure.kind, details: failure.details });
    await waitForHomeGovernance(() => expect(rpc.machine.mock.calls.some(([input]) => input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_LIST)).toBe(true));
    expect(rpc.machine.mock.calls.filter(([input]) => input.method === 'projects.worker.copy.retire')).toHaveLength(1);
    await hook.unmount();
  });

  it('refuses explicit byte removal when the committed-copy preview is unavailable', async () => {
    await seed(); answerFacts(); vi.spyOn(Modal, 'confirm').mockResolvedValue(true);
    await waiveRetirement();
    const readFacts = rpc.machine.getMockImplementation()!;
    rpc.machine.mockImplementation(async input => input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT
      ? { ok: false, errorCode: 'workspace_copy_not_owned' }
      : input.method === 'projects.worker.copy.retire' ? { status: 'retired' } : await readFacts(input));
    const hook = await renderHook(() => useMachineFreshCopies(serverId, 'worker'));
    await waitForHomeGovernance(() => expect(hook.getCurrent().copies?.[0]).toMatchObject({
      lastCleanSyncAtMs: 1234, sizeBytes: null, review: { ok: false, errorCode: 'workspace_copy_not_owned' },
    }));
    await act(async () => { await hook.getCurrent().remove(hook.getCurrent().copies![0]!, { removeFiles: true }); });
    expect(hook.getCurrent().copies).toHaveLength(1);
    expect(rpc.machine.mock.calls.filter(([input]) => input.method === 'projects.worker.copy.retire')).toHaveLength(0);
    await hook.unmount();
  });
});
