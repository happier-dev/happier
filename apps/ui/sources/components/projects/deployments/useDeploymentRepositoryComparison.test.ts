import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { useDeploymentRepositoryComparison, type DeploymentRepositoryComparisonInput } from './useDeploymentRepositoryComparison';

// Machine RPC is the transport boundary; the SCM facade and its response parser remain real.
const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

afterEach(async () => { await standardCleanup(); rpc.mockReset(); });

function input(): DeploymentRepositoryComparisonInput {
  const source = createDeploymentReceiptDetailV1().content.sourceIntent;
  if (source.kind !== 'repository') throw new Error('Repository fixture required');
  return { source, current: createDeploymentEnvironmentDetailV1().content.definition,
    workspaceRef: { id: 'checkout', serverId: 'home', machineId: 'source-machine', rootPath: '/source', label: null,
      createdAtMs: 1, lastOpenedAtMs: null, source: { sourceId: source.projectSourceId, revision: source.sourceRevision } },
    serverId: 'home', accountId: 'account-owner', demand: { mounted: true, visible: true, focused: true } };
}

describe('Environment deployed-to-candidate comparison', () => {
  it.each(['forward', 'equal', 'diverged', 'partial', 'mismatch', 'unavailable'] as const)(
    'publishes a newer-commit fact only for proven forward history: %s', async relation => {
      const props = input();
      const ref = props.current?.kind === 'repository' ? props.current.ref : '';
      const headOid = relation === 'equal' ? props.source.sha : 'b'.repeat(40);
      rpc.mockResolvedValue(relation === 'unavailable' ? { success: false, errorCode: 'FEATURE_UNSUPPORTED', error: 'Unavailable' }
        : { success: true, entries: [], revisionRange: { kind: 'revisionRange', baseOid: props.source.sha,
          headOid, headRef: relation === 'mismatch' ? 'other-ref' : ref,
          historyComplete: relation !== 'partial', graphRelation: relation === 'equal' || relation === 'diverged' ? relation : 'forward',
          totalCount: relation === 'equal' ? 0 : 3 } });
      const hook = await renderHook(() => useDeploymentRepositoryComparison(props));
      try {
        await flushHookEffects();
        expect(hook.getCurrent()).toMatchObject({ pending: false,
          newerCommitCount: relation === 'forward' ? 3 : relation === 'equal' ? 0 : null,
          newerCommitWaiting: relation === 'forward' });
        expect(rpc).toHaveBeenCalledTimes(1);
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'source-machine',
          payload: expect.objectContaining({ cwd: '/source', revisionRangeFromRef: { baseOid: props.source.sha, headRef: ref } }) }));
        expect(hook.getCurrent().unavailable).toBe(relation === 'mismatch' || relation === 'unavailable');
      } finally { await hook.unmount(); }
    });

  it('keeps selected immutable endpoints until refresh and reads nothing while hidden or without a checkout', async () => {
    const props = input();
    const ref = props.current?.kind === 'repository' ? props.current.ref : '';
    let headOid = 'b'.repeat(40);
    rpc.mockImplementation(async () => ({ success: true, entries: [], revisionRange: { kind: 'revisionRange',
      baseOid: props.source.sha, headOid, headRef: ref, historyComplete: true, graphRelation: 'forward', totalCount: 3 } }));
    const hook = await renderHook((value: DeploymentRepositoryComparisonInput) => useDeploymentRepositoryComparison(value),
      { initialProps: { ...props, demand: { mounted: true, visible: false, focused: false } } });
    try {
      expect(rpc).not.toHaveBeenCalled();
      await hook.rerender(props);
      await flushHookEffects();
      expect(hook.getCurrent().comparison?.range.headOid).toBe(headOid);
      headOid = 'c'.repeat(40);
      await hook.rerender(props);
      expect(hook.getCurrent().comparison?.range.headOid).toBe('b'.repeat(40));
      expect(rpc).toHaveBeenCalledTimes(1);
      await act(async () => hook.getCurrent().refresh());
      await flushHookEffects();
      expect(hook.getCurrent().comparison?.range.headOid).toBe(headOid);
      expect(rpc).toHaveBeenCalledTimes(2);
      await hook.rerender({ ...props, current: null });
      expect(hook.getCurrent()).toMatchObject({ comparison: null, newerCommitCount: null, newerCommitWaiting: false });
      await hook.rerender(props);
      await flushHookEffects();
      expect(hook.getCurrent()).toMatchObject({ newerCommitCount: 3, newerCommitWaiting: true });
      await hook.rerender({ ...props, workspaceRef: null });
      expect(hook.getCurrent()).toMatchObject({ comparison: null, newerCommitCount: null, newerCommitWaiting: false });
    } finally { await hook.unmount(); }
    rpc.mockClear();
    const absent = await renderHook(() => useDeploymentRepositoryComparison({ ...props, workspaceRef: null }));
    try { expect(rpc).not.toHaveBeenCalled(); } finally { await absent.unmount(); }
  });
});
