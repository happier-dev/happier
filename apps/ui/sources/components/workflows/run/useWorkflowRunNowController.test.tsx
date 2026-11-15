import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowRunStartRequestV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ExternalActionRequestEnvelopeV1 } from '@happier-dev/protocol/actions/externalActionApi';

import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createRenderCommitCounter, useRenderCommitCounter } from '@/dev/testkit/performance/counts';
import { renderHook as renderHostHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import {
  createAccountTokenForTests,
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import {
  installDisconnectedServerSocketBoundary,
  restoreServerAccountForTest,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createWorkflowDefinitionFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';

import type { WorkflowRunNowRequest } from './useWorkflowRunNowController';
import { workflowRunStoreKey } from '@/sync/store/domains/workflowRuns';

const executeMock = vi.hoisted(() =>
  vi.fn<
    (
      request: Readonly<{
        actionId: 'workflow.run.start';
        input: unknown;
        target: NonNullable<ExternalActionRequestEnvelopeV1['target']>;
      }>,
    ) => Promise<unknown>
  >(),
);
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
// Keep admission-error presentation real below the Radix DOM boundary.
vi.mock('@/utils/web/radixCjs', async () =>
  (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock(),
);
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key: string) => key });
});

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { ModalProvider, useModal } = await import('@/modal/ModalProvider');
const { Modal } = await import('@/modal');
let modals: ReturnType<typeof useModal>['state']['modals'] = [];
function ObserveModals() {
  modals = useModal().state.modals;
  return null;
}
function ModalHost({ children }: React.PropsWithChildren) {
  return (
    <ModalProvider>
      <ObserveModals />
      {children}
    </ModalProvider>
  );
}
function renderHook<Value>(useValue: () => Value) {
  return renderHostHook(useValue, { wrapper: ModalHost });
}
const { storage } = await import('@/sync/domains/state/storageStore');
const { retireActiveServerAccountScopeLifetime } =
  await import('@/sync/domains/scope/activeServerAccountScope');
const { publishAppliedActiveServerSnapshot } =
  await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { getActiveServerSnapshot } =
  await import('@/sync/domains/server/serverRuntime');
const { setActiveServerId } =
  await import('@/sync/domains/server/serverProfiles');
let homeA: string;
let homeB: string;
let connection:
  | Awaited<ReturnType<typeof restoreServerAccountForTest>>
  | undefined;

function startInput(index = 0) {
  return WorkflowRunStartRequestV1Schema.parse(
    executeMock.mock.calls[index]?.[0].input,
  );
}

function setAccountScope(
  scope: { serverId: string; accountId: string } | null,
): void {
  // Model the host reset using the real lifetime owner, not a fake generation.
  retireActiveServerAccountScopeLifetime();
  const serverId = scope?.serverId === 'server-b' ? homeB : homeA;
  if (scope) setActiveServerId(serverId);
  publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), scope !== null);
  storage.setState({ profileScope: scope ? { ...scope, serverId } : null });
}

/** The one Run UUID the caller allocates for an explicit admission attempt. */
const RUN_ID = '00000000-0000-4000-8000-000000000001';

// Not `as const`: the canonical ingress request takes mutable arrays, and a
// readonly literal would only be assignable through a cast.
const source: WorkflowRunNowRequest['source'] = {
  kind: 'inline',
  definition: { blocks: ['Do the thing'] },
};

function admitted(admission: 'created' | 'existing') {
  return {
    run: createWorkflowRunSummaryFixture({
      id: RUN_ID,
      ownerAccountId: 'account-a',
      origin: { kind: 'direct' },
    }),
    admission,
  };
}

describe('useWorkflowRunNowController', () => {
  it('one Start only renders its own intent while preserving the admitted Run', async () => {
    const { useWorkflowRunNowController } = await import('./useWorkflowRunNowController');
    const { useAutomationRunNowController } = await import('@/components/automations/list/useAutomationRunNowController');
    const ownCount = createRenderCommitCounter();
    const otherCount = createRenderCommitCounter();
    const automationCount = createRenderCommitCounter();
    const own = await renderHook(() => {
      useRenderCommitCounter(ownCount);
      return useWorkflowRunNowController(undefined, 'cost:selected-start');
    });
    const other = await renderHook(() => {
      useRenderCommitCounter(otherCount);
      return useWorkflowRunNowController(undefined, 'cost:unrelated-start');
    });
    const automation = await renderHook(() => {
      useRenderCommitCounter(automationCount);
      return useAutomationRunNowController();
    });
    const request = createDeferred<unknown>();
    executeMock.mockReturnValueOnce(request.promise);
    ownCount.reset();
    otherCount.reset();
    automationCount.reset();
    let started!: Promise<unknown>;
    await act(async () => {
      started = own.getCurrent().runNow({ runId: RUN_ID, source });
    });
    expect(own.getCurrent().pendingRunId).toBe(RUN_ID);
    expect(own.getCurrent().stateFor(RUN_ID)).toBe('submitting');
    await act(async () => {
      request.resolve(admitted('created'));
      await started;
    });
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(storage.getState().workflowRunsById[workflowRunStoreKey(RUN_ID)]?.id).toBe(RUN_ID);
    expect(ownCount.read().commits).toBeGreaterThan(0);
    expect(other.getCurrent().pendingRunId).toBeNull();
    expect(otherCount.read()).toEqual({ renders: 0, commits: 0 });
    expect(automation.getCurrent().stateFor('unrelated-trigger')).toBe('idle');
    expect(automationCount.read()).toEqual({ renders: 0, commits: 0 });
  });
  it('preserves the committed Discussion origin at the shared start boundary', async () => {
    executeMock.mockResolvedValueOnce(admitted('created'));
    const { useWorkflowRunNowController } =
      await import('./useWorkflowRunNowController');
    const hook = await renderHook(() => useWorkflowRunNowController());
    const origin = {
      kind: 'discussion' as const,
      discussion: { serverId: homeA, discussionId: 'discussion-1' },
      addressingMessageId: 'question-1',
    };
    await act(async () => {
      await hook.getCurrent().runNow({ runId: RUN_ID, source, origin });
    });
    expect(executeMock.mock.calls[0]?.[0].input).toMatchObject({ origin });
  });
  it('admits the reviewed role overrides rather than silently using the Account roles', async () => {
    executeMock.mockResolvedValueOnce(admitted('created'));
    const { useWorkflowRunNowController } =
      await import('./useWorkflowRunNowController');
    const hook = await renderHook(() => useWorkflowRunNowController());
    const roleOverrides = [
      {
        roleId: 'builder',
        runsAs: {
          kind: 'background_run' as const,
          intent: 'delegate' as const,
        },
      },
    ];
    await act(async () => {
      await hook.getCurrent().runNow({ runId: RUN_ID, source, roleOverrides });
    });
    expect(executeMock.mock.calls[0]?.[0].input).toMatchObject({
      roleOverrides,
    });
  });
  beforeEach(async () => {
    modals = [];
    // Confirmation is the presentation boundary; admission and settlement stay real.
    vi.spyOn(Modal, 'confirm').mockResolvedValue(true);
    homeA = await homes.addHome({
      name: 'A',
      serverUrl: 'https://workflow-a.test',
      serverIdentityId: 'srv_workflow_a',
      accountId: 'account-a',
      currentAccount: true,
    });
    homeB = await homes.addHome({
      name: 'B',
      serverUrl: 'https://workflow-b.test',
      accountId: 'account-b',
      currentAccount: true,
      active: false,
    });
    homes.answer(homeA, '/v1/features', {
      body: createRootLayoutFeaturesResponse({
        features: { workflows: { enabled: true } },
      }),
    });
    const actions = await createExternalActionAccountHttpBoundary({
      serverUrl: 'https://workflow-a.test',
      serverIdentityId: 'srv_workflow_a',
      accountId: 'account-a',
      machineId: 'machine-1',
      actionId: 'workflow.run.start',
      tokenEpoch: 0,
      execute: (input, { target }) =>
        executeMock({ actionId: 'workflow.run.start', input, target }),
      failure: (result) => {
        const parsed = ActionExecuteFailureSchema.safeParse(result);
        return parsed.success ? parsed.data : null;
      },
    });
    connection = await restoreServerAccountForTest({
      serverUrl: 'https://workflow-a.test',
      accountId: 'account-a',
      serverIdentityId: 'srv_workflow_a',
      credentials: {
        token: createAccountTokenForTests('account-a', {
          currentAccount: true,
        }),
      },
      request: async (url, init) =>
        (await actions.handle(new URL(String(url)), init)) ??
        homes.request(url, init),
    });
    setAccountScope({ serverId: 'server-a', accountId: 'account-a' });
    const machine = createMachineFixture({
      id: 'machine-1',
      activeAt: Date.now(),
    });
    storage.setState({
      workflowRunsById: {},
      machines: { [machine.id]: machine },
      machineListByServerId: { [homeA]: [machine] },
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.mocked(Modal.confirm).mockRestore();
    await connection?.dispose();
    connection = undefined;
    executeMock.mockReset();
    setAccountScope(null);
    storage.setState({ workflowRunsById: {} });
    await standardCleanup();
    await homes.reset();
  });

  it('returns the exact admitted handle and stores that Run by its own runId', async () => {
    vi.useFakeTimers();
    executeMock.mockResolvedValueOnce(admitted('created'));
    const { useWorkflowRunNowController } =
      await import('./useWorkflowRunNowController');
    const hook = await renderHook(() => useWorkflowRunNowController());

    let outcome: Awaited<
      ReturnType<ReturnType<typeof useWorkflowRunNowController>['runNow']>
    >;
    await act(async () => {
      outcome = await hook
        .getCurrent()
        .runNow({ runId: RUN_ID, source, metadata: { title: 'Frozen title' } });
    });

    expect(outcome!?.run.id).toBe(RUN_ID);
    expect(outcome!?.admission).toBe('created');
    expect(executeMock.mock.calls[0]?.[0].actionId).toBe('workflow.run.start');
    expect(startInput().runId).toBe(RUN_ID);
    expect(executeMock.mock.calls[0]?.[0].input).toMatchObject({
      metadata: { title: 'Frozen title' },
    });
    // The admitted Run reaches the one Account-scoped row map keyed by runId,
    // so the exact route can open it without any list being loaded.
    expect(
      storage.getState().workflowRunsById[workflowRunStoreKey(RUN_ID)]?.summary
        ?.id,
    ).toBe(RUN_ID);
    expect(
      storage.getState().workflowRunsById[workflowRunStoreKey(RUN_ID)]
        ?.metadata,
    ).toEqual({ kind: 'available', value: { title: 'Frozen title' } });
    // An acknowledgement is command state, not a Run state.
    expect(hook.getCurrent().stateFor(RUN_ID)).toBe('acknowledged');
    await act(async () => {
      vi.advanceTimersByTime(2_500);
    });
    expect(hook.getCurrent().stateFor(RUN_ID)).toBe('idle');
  });

  it('owns an ordinary start identity until admission settles, then permits a new explicit start', async () => {
    const reply = createDeferred<unknown>();
    executeMock.mockImplementation(async ({ input }) =>
      WorkflowRunStartRequestV1Schema.parse(input).runId === RUN_ID
        ? admitted('created')
        : reply.promise,
    );
    const { useWorkflowRunNowController } =
      await import('./useWorkflowRunNowController');
    const hook = await renderHook(() => useWorkflowRunNowController());
    let first!: Promise<unknown>;
    await act(async () => {
      first = hook.getCurrent().runNow({ source });
    });
    const firstId = startInput().runId;
    expect(firstId).toBeTypeOf('string');
    expect(hook.getCurrent().pendingRunId).toBe(firstId);
    await act(async () => {
      expect(await hook.getCurrent().runNow({ source })).toBeNull();
    });
    expect(executeMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      reply.resolve({
        admission: 'created',
        run: createWorkflowRunSummaryFixture({
          id: firstId,
          ownerAccountId: 'account-a',
          origin: { kind: 'direct' },
        }),
      });
      await first;
    });
    expect(hook.getCurrent().pendingRunId).toBeNull();
    executeMock.mockImplementation(async ({ input }) => ({
      admission: 'created',
      run: createWorkflowRunSummaryFixture({
        id: WorkflowRunStartRequestV1Schema.parse(input).runId,
        ownerAccountId: 'account-a',
        origin: { kind: 'direct' },
      }),
    }));
    await act(async () => {
      await hook.getCurrent().runNow({ source });
    });
    expect(startInput(1).runId).not.toBe(firstId);
  });

  it('releases its owned identity after a confirmed refusal without affecting explicit recovery IDs', async () => {
    executeMock.mockResolvedValue({
      ok: false,
      errorCode: 'target_unavailable',
      error: 'Confirmed not sent',
    });
    const { useWorkflowRunNowController } =
      await import('./useWorkflowRunNowController');
    const hook = await renderHook(() => useWorkflowRunNowController());
    await act(async () => {
      await hook.getCurrent().runNow({ source });
    });
    const refusedId = startInput().runId;
    expect(hook.getCurrent().pendingRunId).toBeNull();
    await act(async () => {
      await hook.getCurrent().runNow({ source });
    });
    expect(startInput(1).runId).not.toBe(refusedId);
    await act(async () => {
      await hook.getCurrent().runNow({ runId: RUN_ID, source });
    });
    expect(startInput(2).runId).toBe(RUN_ID);
  });

  it('names the selected project Machine in a refused Start', async () => {
    executeMock.mockResolvedValue({ ok: false, errorCode: 'target_unavailable', error: 'Confirmed not sent' });
    const { useWorkflowRunNowController } = await import('./useWorkflowRunNowController');
    const hook = await renderHook(() => useWorkflowRunNowController());
    await act(async () => {
      await hook.getCurrent().runNow({ source, refusal: 'inline', project: { machineId: 'machine-1', directory: '/repo' } });
    });
    expect(hook.getCurrent().refusal).toMatchObject({ code: 'target_unavailable', message: expect.stringContaining('tester.local') });
  });

  it('keeps a known refusal for the composer instead of interrupting with an alert', async () => {
    executeMock.mockResolvedValue({
      ok: false,
      errorCode: 'target_unavailable',
      error: 'Confirmed not sent',
    });
    const { useWorkflowRunNowController } =
      await import('./useWorkflowRunNowController');
    const hook = await renderHook(() => useWorkflowRunNowController());
    await act(async () => {
      await hook.getCurrent().runNow({ source, refusal: 'inline' });
    });
    expect(modals.filter((entry) => entry.type === 'alert')).toEqual([]);
    expect(hook.getCurrent().refusal?.message).toBe(
      'workflows.problem.targetUnavailable',
    );
    // A new press is a new attempt: the previous reason does not outlive it.
    executeMock.mockResolvedValue(admitted('created'));
    await act(async () => {
      await hook
        .getCurrent()
        .runNow({ runId: RUN_ID, source, refusal: 'inline' });
    });
    expect(hook.getCurrent().refusal).toBeNull();
  });

  it('settles a proved unsent setup failure as a typed refusal without waiting for a missing Run', async () => {
    executeMock.mockResolvedValueOnce({
      ok: false,
      errorCode: 'target_unavailable',
      error: 'Machine setup failed',
    });
    const { useWorkflowRunNowController } =
      await import('./useWorkflowRunNowController');
    const hook = await renderHook(() => useWorkflowRunNowController());
    await act(async () => {
      expect(
        await hook.getCurrent().runNow({ source, refusal: 'inline' }),
      ).toBeNull();
    });
    const runId = startInput().runId;
    expect(hook.getCurrent().pendingRunId).toBeNull();
    expect(hook.getCurrent().isPending(runId)).toBe(false);
    expect(hook.getCurrent().refusal?.code).toBe('target_unavailable');
    expect(
      homes.requests.filter(
        (request) => request.path === '/v3/automations/runs/workflow-storage',
      ),
    ).toHaveLength(0);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it('stamps the selected project into host context rather than Action input', async () => {
    executeMock.mockResolvedValueOnce(admitted('created'));
    const { useWorkflowRunNowController } =
      await import('./useWorkflowRunNowController');
    const hook = await renderHook(() => useWorkflowRunNowController());
    const project = {
      machineId: 'machine-1',
      directory: '/repo/project',
      workspaceRefId: 'workspace-1',
      // Run-again starts from an accepted descriptor. These historical
      // facts are not part of a new ExternalActionTarget.
      checkoutRootPath: '/repo',
      checkout: { kind: 'git_worktree' as const, branchName: 'old-run' },
    };

    await act(async () => {
      await hook.getCurrent().runNow({ runId: RUN_ID, source, project });
    });

    expect(executeMock.mock.calls[0]?.[0]).toEqual({
      actionId: 'workflow.run.start',
      input: { runId: RUN_ID, source },
      target: {
        kind: 'machine',
        machineId: project.machineId,
        project: {
          machineId: project.machineId,
          directory: project.directory,
          workspaceRefId: project.workspaceRefId,
        },
      },
    });
  });

  it('rejoins an absent unknown managed admission with its exact original birth carrier', async () => {
    executeMock
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce(admitted('existing'));
    homes.answer(homeA, '/v3/automations/runs/workflow-storage', {
      status: 404,
      body: { error: 'run_not_found' },
    });
    const observations = () =>
      homes.requests.filter(
        (request) => request.path === '/v3/automations/runs/workflow-storage',
      );
    const { useWorkflowRunNowController } =
      await import('./useWorkflowRunNowController');
    const hook = await renderHook(() => useWorkflowRunNowController());
    const managedCreation = { homeId: 'srv_workflow_a', managedId: 'task-guest',
      controller: { machineId: 'controller', installationId: 'installation' } };
    let pending!: ReturnType<
      ReturnType<typeof useWorkflowRunNowController>['runNow']
    >;
    await act(async () => {
      pending = hook.getCurrent().runNow({ runId: RUN_ID, source, managedCreation });
    });
    expect(executeMock).toHaveBeenCalledTimes(2);
    await expect(pending).resolves.toMatchObject({ admission: 'existing' });
    expect(startInput()).toMatchObject({ managedCreation });
    expect(startInput(1)).toEqual(startInput());
    expect(hook.getCurrent().isPending(RUN_ID)).toBe(false);
    expect(observations()).toHaveLength(1);
    expect(observations()[0]?.input).toMatchObject({ runId: RUN_ID });
    expect(
      storage.getState().workflowRunsById[workflowRunStoreKey(RUN_ID)]?.summary
        ?.id,
    ).toBe(RUN_ID);
  });

  it('retains unknown admission custody without publishing a dismissed invocation refusal', async () => {
    const rejoin = createDeferred<unknown>();
    executeMock
      .mockRejectedValueOnce(new Error('Start response lost'))
      .mockReturnValueOnce(rejoin.promise);
    homes.answer(homeA, '/v3/automations/runs/workflow-storage', {
      status: 404,
      body: { error: 'run_not_found' },
    });
    const { useWorkflowRunNowController } =
      await import('./useWorkflowRunNowController');
    const hook = await renderHook(() => useWorkflowRunNowController());
    let invocationCurrent = true;
    let pending!: ReturnType<ReturnType<typeof useWorkflowRunNowController>['runNow']>;
    await act(async () => {
      pending = hook.getCurrent().runNow({ runId: RUN_ID, source, refusal: 'inline',
        isInvocationCurrent: () => invocationCurrent });
    });
    await vi.waitFor(() => expect(executeMock).toHaveBeenCalledTimes(2));
    // Dismissing/reselecting keeps admitted custody, but retires this form's presentation.
    await act(async () => {
      invocationCurrent = false;
      hook.getCurrent().clearRefusal();
    });
    await act(async () => {
      rejoin.reject(new Error('Rejoin response lost'));
      expect(await pending).toBeNull();
    });
    expect(hook.getCurrent().hasUnsettledAdmission(RUN_ID)).toBe(true);
    expect(hook.getCurrent().refusal).toBeNull();
    expect(modals.filter((entry) => entry.type === 'alert')).toEqual([]);
  });

  it('surfaces a still-unknown rejoin and retains its immutable id and input for a later press', async () => {
    executeMock.mockRejectedValue(new Error('response lost'));
    homes.answer(homeA, '/v3/automations/runs/workflow-storage', {
      status: 404,
      body: { error: 'run_not_found' },
    });
    const { useWorkflowRunNowController } =
      await import('./useWorkflowRunNowController');
    const hook = await renderHook(() => useWorkflowRunNowController());
    let pending!: ReturnType<
      ReturnType<typeof useWorkflowRunNowController>['runNow']
    >;
    const originalSource = {
      kind: 'inline' as const,
      definition: { blocks: ['Original work'] },
    };
    await act(async () => {
      pending = hook
        .getCurrent()
        .runNow({
          source: originalSource,
          inputs: { branch: 'original' },
          refusal: 'inline',
        });
    });
    const originalInput = startInput();
    const retainedId = startInput().runId;
    expect(hook.getCurrent().pendingRunId).toBe(retainedId);
    expect(hook.getCurrent().isPending(retainedId)).toBe(false);
    await expect(pending).resolves.toBeNull();
    expect(hook.getCurrent().refusal?.code).toBe('workflow_outcome_unresolved');
    originalSource.definition.blocks[0] = 'Edited work';
    // A later unsent retry cannot prove that the original was never admitted.
    executeMock.mockResolvedValueOnce({
      ok: false,
      errorCode: 'target_unavailable',
      error: 'Retry was not sent',
    });
    await act(async () => {
      expect(
        await hook.getCurrent().runNow({ source, refusal: 'inline' }),
      ).toBeNull();
    });
    expect(hook.getCurrent().pendingRunId).toBe(retainedId);
    expect(hook.getCurrent().refusal?.code).toBe('workflow_outcome_unresolved');
    executeMock.mockResolvedValueOnce({
      ...admitted('existing'),
      run: createWorkflowRunSummaryFixture({
        id: retainedId,
        ownerAccountId: 'account-a',
      }),
    });
    await act(async () => {
      expect(
        (
          await hook
            .getCurrent()
            .runNow({
              source,
              inputs: { branch: 'changed' },
              refusal: 'inline',
            })
        )?.run.id,
      ).toBe(retainedId);
    });
    expect(startInput(2)).toEqual(originalInput);
    expect(startInput(3)).toEqual(originalInput);
    expect(hook.getCurrent().pendingRunId).toBeNull();
  });

  it('does not dispatch twice while one admission is still in flight', async () => {
    const request = createDeferred<unknown>();
    executeMock.mockReturnValueOnce(request.promise);
    const { useWorkflowRunNowController } =
      await import('./useWorkflowRunNowController');
    const hook = await renderHook(() => useWorkflowRunNowController());

    let first!: Promise<unknown>;
    await act(async () => {
      first = hook.getCurrent().runNow({ runId: RUN_ID, source });
    });
    expect(hook.getCurrent().stateFor(RUN_ID)).toBe('submitting');

    await act(async () => {
      expect(
        await hook.getCurrent().runNow({ runId: RUN_ID, source }),
      ).toBeNull();
    });
    expect(executeMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      request.resolve(admitted('created'));
      await first;
    });
  });

  it('retains the reviewed request when its surface unmounts during an unknown rejoin', async () => {
    const rejoin = createDeferred<unknown>();
    executeMock
      .mockRejectedValueOnce(new Error('Start response lost'))
      .mockReturnValueOnce(rejoin.promise);
    homes.answer(homeA, '/v3/automations/runs/workflow-storage', {
      status: 404,
      body: { error: 'run_not_found' },
    });
    const { useWorkflowRunNowController } =
      await import('./useWorkflowRunNowController');
    const first = await renderHook(() => useWorkflowRunNowController());
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = first
        .getCurrent()
        .runNow({
          runId: RUN_ID,
          source,
          inputs: { branch: 'reviewed' },
          refusal: 'inline',
        });
    });
    const original = startInput();
    expect(executeMock).toHaveBeenCalledTimes(2);
    await first.unmount();
    const next = await renderHook(() => useWorkflowRunNowController());
    await act(async () => {
      rejoin.reject(new Error('Rejoin response lost'));
      expect(await pending).toBeNull();
    });
    expect(next.getCurrent().hasUnsettledAdmission(RUN_ID)).toBe(true);
    executeMock.mockResolvedValueOnce(admitted('existing'));
    await act(async () => {
      await next
        .getCurrent()
        .runNow({
          runId: RUN_ID,
          source,
          inputs: { branch: 'edited after leaving' },
          refusal: 'inline',
        });
    });
    expect(startInput(2)).toEqual(original);
  });

  it('retains an ordinary source intent across remount while permitting a different source', async () => {
    executeMock.mockRejectedValue(new Error('Start response lost'));
    homes.answer(homeA, '/v3/automations/runs/workflow-storage', {
      status: 404,
      body: { error: 'run_not_found' },
    });
    const { useWorkflowRunNowController } =
      await import('./useWorkflowRunNowController');
    const first = await renderHook(() =>
      useWorkflowRunNowController(undefined, 'editor:source-a'),
    );
    await act(async () => {
      await first
        .getCurrent()
        .runNow({ source, inputs: { branch: 'reviewed' }, refusal: 'inline' });
    });
    const original = startInput();
    await first.unmount();
    const other = await renderHook(() =>
      useWorkflowRunNowController(undefined, 'editor:source-b'),
    );
    await act(async () => {
      await other
        .getCurrent()
        .runNow({ source, inputs: { branch: 'other' }, refusal: 'inline' });
    });
    expect(startInput(2).runId).not.toBe(original.runId);
    const returned = await renderHook(() =>
      useWorkflowRunNowController(undefined, 'editor:source-a'),
    );
    expect(returned.getCurrent().pendingRunId).toBe(original.runId);
    expect(returned.getCurrent().refusal?.code).toBe(
      'workflow_outcome_unresolved',
    );
    executeMock.mockImplementation(async ({ input }) => ({
      admission: 'existing',
      run: createWorkflowRunSummaryFixture({
        id: WorkflowRunStartRequestV1Schema.parse(input).runId,
        ownerAccountId: 'account-a',
      }),
    }));
    await act(async () => {
      await returned
        .getCurrent()
        .runNow({ source, inputs: { branch: 'edited' }, refusal: 'inline' });
    });
    expect(startInput(4)).toEqual(original);
    expect(returned.getCurrent().pendingRunId).toBeNull();
    // Only unresolved custody is retained; a later deliberate press is fresh.
    await act(async () => {
      await returned.getCurrent().runNow({ source, refusal: 'inline' });
    });
    expect(startInput(5).runId).not.toBe(original.runId);
  });

  it('exposes the retained request for review while an intent is unresolved, and nothing once it settles', async () => {
    executeMock.mockRejectedValue(new Error('Start response lost'));
    homes.answer(homeA, '/v3/automations/runs/workflow-storage', {
      status: 404,
      body: { error: 'run_not_found' },
    });
    const { useWorkflowRunNowController } =
      await import('./useWorkflowRunNowController');
    const first = await renderHook(() =>
      useWorkflowRunNowController(undefined, 'editor:source-a'),
    );
    expect(first.getCurrent().retainedRequest).toBeNull();
    const project = { machineId: 'machine-1', directory: '/repo/original' };
    await act(async () => {
      await first
        .getCurrent()
        .runNow({
          source,
          inputs: { branch: 'reviewed' },
          project,
          refusal: 'inline',
        });
    });
    const original = startInput();
    expect(first.getCurrent().retainedRequest).toEqual({
      input: original,
      project,
      unresolved: true,
    });
    await first.unmount();
    // A different source is its own intent and sees nothing of A's request.
    const other = await renderHook(() =>
      useWorkflowRunNowController(undefined, 'editor:source-b'),
    );
    expect(other.getCurrent().retainedRequest).toBeNull();
    const returned = await renderHook(() =>
      useWorkflowRunNowController(undefined, 'editor:source-a'),
    );
    expect(returned.getCurrent().retainedRequest).toEqual({
      input: original,
      project,
      unresolved: true,
    });
    executeMock.mockImplementation(async ({ input }) => ({
      admission: 'existing',
      run: createWorkflowRunSummaryFixture({
        id: WorkflowRunStartRequestV1Schema.parse(input).runId,
        ownerAccountId: 'account-a',
      }),
    }));
    await act(async () => {
      await returned
        .getCurrent()
        .runNow({ source, inputs: { branch: 'edited' }, refusal: 'inline' });
    });
    expect(returned.getCurrent().retainedRequest).toBeNull();
  });

  it('retains saved Artifact, Team and edited Run-as across Start remount and submits those reviewed choices', async () => {
    executeMock.mockImplementation(async ({ input }) => ({ admission: 'created', run: createWorkflowRunSummaryFixture({
      id: WorkflowRunStartRequestV1Schema.parse(input).runId, ownerAccountId: 'account-a' }) }));
    const { useWorkflowComposerStart } = await import('./useWorkflowComposerStart');
    const workflow = { id: 'saved-workflow', name: 'Saved workflow', description: '',
      source: { kind: 'saved' as const, definitionId: 'saved-workflow', revision: { headerVersion: 2, bodyVersion: 3 } },
      definition: createWorkflowDefinitionFixture() };
    const renderStart = () => renderHook(() => useWorkflowComposerStart({ intentKey: 'session:saved-review',
      project: { machineId: 'machine-1', directory: '/repo' }, onStarted: vi.fn() }));
    const first = await renderStart();
    await act(async () => { first.getCurrent().start(workflow); });
    expect(first.getCurrent().composerProps?.sourceArtifactId).toBe('saved-workflow');
    const overrides = [{ roleId: 'builder', runsAs: { kind: 'background_run' as const, intent: 'task' as const } }];
    await act(async () => {
      first.getCurrent().composerProps!.onChangeRoleOverrides!(overrides);
      first.getCurrent().composerProps!.onChangeVisibleTeamId!('team-b');
    });
    await first.unmount();
    const reopened = await renderStart();
    await act(async () => { reopened.getCurrent().start(workflow); });
    expect(reopened.getCurrent().composerProps).toMatchObject({ sourceArtifactId: 'saved-workflow',
      roleOverrides: overrides, visibleTeamId: 'team-b' });
    await act(async () => {
      reopened.getCurrent().composerProps!.onRun(undefined, overrides, 'team-b');
      await vi.waitFor(() => expect(reopened.getCurrent().composerProps).toBeNull());
    });
    expect(executeMock).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({
      source: { ...workflow.source, visibleTeamId: 'team-b' }, roleOverrides: overrides,
    }) }));
  });

  it('rehydrates only the same Account and Start review, then clears authored setup after acceptance or credential retirement', async () => {
    executeMock.mockImplementation(async ({ input }) => ({ admission: 'created', run: createWorkflowRunSummaryFixture({
      id: WorkflowRunStartRequestV1Schema.parse(input).runId, ownerAccountId: 'account-a' }) }));
    const { useWorkflowComposerStart } = await import('./useWorkflowComposerStart');
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const renderStart = (intentKey: string) => renderHook(() => useWorkflowComposerStart({
      intentKey, project: { machineId: 'machine-1', directory: '/repo' }, onStarted: vi.fn(),
    }));
    const workflow = 'builtin:plan-with-a-panel';
    const first = await renderStart('session:a');
    await act(async () => { first.getCurrent().start(workflow, { retainedDraft: 'Original' }); });
    await act(async () => {
      first.getCurrent().composerProps!.onChangeValues({ request: 'Reviewed' });
      first.getCurrent().composerProps!.onChangeRawTextValues({ request: 'Reviewed', previousRoundContext: '{ unfinished' });
    });
    await first.unmount();
    const other = await renderStart('session:b');
    await act(async () => { other.getCurrent().start(workflow, { retainedDraft: 'Original' }); });
    expect(other.getCurrent().composerProps!.values.request).toBe('Original');
    const returned = await renderStart('session:a');
    await act(async () => { returned.getCurrent().start(workflow, { retainedDraft: 'Original' }); });
    expect(returned.getCurrent().composerProps!.values.request).toBe('Reviewed');
    expect(returned.getCurrent().composerProps!.rawTextValues.previousRoundContext).toBe('{ unfinished');
    const otherStartUpdates = vi.fn();
    const stopObserving = other.subscribe(otherStartUpdates);
    await act(async () => {
      returned.getCurrent().composerProps!.onChangeValues({ request: 'Reviewed again' });
      returned.getCurrent().composerProps!.onChangeRawTextValues({ request: 'Reviewed again' });
    });
    expect(otherStartUpdates).not.toHaveBeenCalled();
    stopObserving();
    await act(async () => {
      returned.getCurrent().composerProps!.onRun({ request: 'Reviewed again' });
      await vi.waitFor(() => expect(returned.getCurrent().composerProps).toBeNull());
    });
    await returned.unmount();
    const accepted = await renderStart('session:a');
    await act(async () => { accepted.getCurrent().start(workflow, { retainedDraft: 'Original' }); });
    expect(accepted.getCurrent().composerProps!.values.request).toBe('Original');
    await act(async () => accepted.getCurrent().composerProps!.onChangeValues({ request: 'Private again' }));
    await accepted.unmount();
    await act(async () => {
      const write = await TokenStorage.setCredentialsForServerUrlWithRollback('https://workflow-a.test', { serverId: homeA },
        { token: createAccountTokenForTests('account-a', { currentAccount: true }) });
      expect(write).not.toBeNull();
    });
    const retired = await renderStart('session:a');
    await act(async () => { retired.getCurrent().start(workflow, { retainedDraft: 'Original' }); });
    expect(retired.getCurrent().composerProps!.values.request).toBe('Original');
    await act(async () => retired.getCurrent().composerProps!.onChangeValues({ request: 'Account A private' }));
    await retired.unmount();
    await act(async () => setAccountScope({ serverId: 'server-b', accountId: 'account-b' }));
    const nextAccount = await renderStart('session:a');
    await act(async () => { nextAccount.getCurrent().start(workflow, { retainedDraft: 'Original' }); });
    expect(nextAccount.getCurrent().composerProps!.values.request).toBe('Original');
  });

  it('adopts an in-flight Start after remount and clears setup when accepted after the form unmounts', async () => {
    const response = createDeferred<unknown>();
    executeMock.mockReturnValue(response.promise);
    const { useWorkflowComposerStart } = await import('./useWorkflowComposerStart');
    const renderStart = () => renderHook(() => useWorkflowComposerStart({ intentKey: 'session:in-flight',
      project: { machineId: 'machine-1', directory: '/repo' }, onStarted: vi.fn() }));
    const first = await renderStart();
    await act(async () => { first.getCurrent().start('builtin:plan-with-a-panel', { retainedDraft: 'Original' }); });
    await act(async () => {
      first.getCurrent().composerProps!.onChangeValues({ request: 'Reviewed' });
      first.getCurrent().composerProps!.onRun({ request: 'Reviewed' });
      await vi.waitFor(() => expect(executeMock).toHaveBeenCalledTimes(1));
    });
    const original = startInput();
    await first.unmount();
    const pending = await renderStart();
    await act(async () => { pending.getCurrent().start('builtin:plan-with-a-panel', { retainedDraft: 'Original', reuseInputs: true }); });
    expect(pending.getCurrent().composerProps!.pending).toBe(true);
    expect(pending.getCurrent().composerProps!.values.request).toBe('Reviewed');
    await act(async () => pending.getCurrent().composerProps!.onRun({ request: 'Duplicate' }));
    expect(executeMock).toHaveBeenCalledTimes(1);
    await pending.unmount();
    await act(async () => {
      response.resolve({ admission: 'created', run: createWorkflowRunSummaryFixture({ id: original.runId, ownerAccountId: 'account-a' }) });
      await vi.waitFor(() => expect(Object.values(storage.getState().workflowRunsById).some(row => row.id === original.runId)).toBe(true));
    });
    const accepted = await renderStart();
    await act(async () => { accepted.getCurrent().start('builtin:plan-with-a-panel', { retainedDraft: 'Original' }); });
    expect(accepted.getCurrent().composerProps!.pending).toBe(false);
    expect(accepted.getCurrent().composerProps!.retainedRequest).toBeNull();
    expect(accepted.getCurrent().composerProps!.values.request).toBe('Original');
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it('reopens an unresolved composer on its original reviewed request and retries the same admission', async () => {
    executeMock.mockRejectedValue(new Error('Start response lost'));
    homes.answer(homeA, '/v3/automations/runs/workflow-storage', { status: 404, body: { error: 'run_not_found' } });
    const { useWorkflowComposerStart } = await import('./useWorkflowComposerStart');
    const renderStart = () => renderHook(() => useWorkflowComposerStart({ intentKey: 'session:unresolved',
      project: { machineId: 'machine-1', directory: '/repo' }, onStarted: vi.fn() }));
    const first = await renderStart();
    await act(async () => { first.getCurrent().start('builtin:plan-with-a-panel', { retainedDraft: 'Original' }); });
    await act(async () => {
      first.getCurrent().composerProps!.onChangeValues({ request: 'Reviewed' });
      first.getCurrent().composerProps!.onRun({ request: 'Reviewed' });
      await vi.waitFor(() => expect(first.getCurrent().composerProps!.retainedRequest?.unresolved).toBe(true));
    });
    const original = startInput();
    const reviewedDefinition = first.getCurrent().composerProps!.definition;
    await first.unmount();
    const reopened = await renderStart();
    await act(async () => { reopened.getCurrent().start('builtin:plan-with-a-panel', { retainedDraft: 'Changed origin draft', reuseInputs: true }); });
    expect(reopened.getCurrent().composerProps!.retainedRequest).toMatchObject({ input: original, unresolved: true, reviewedDefinition });
    executeMock.mockImplementation(async ({ input }) => ({ admission: 'existing', run: createWorkflowRunSummaryFixture({
      id: WorkflowRunStartRequestV1Schema.parse(input).runId, ownerAccountId: 'account-a' }) }));
    await act(async () => {
      reopened.getCurrent().composerProps!.onRun({ request: 'Changed after reopening' });
      await vi.waitFor(() => expect(reopened.getCurrent().composerProps).toBeNull());
    });
    expect(executeMock).toHaveBeenCalledTimes(3);
    expect(startInput(2)).toEqual(original);
  });

  it('keeps a caller-selected new intent distinct from an unresolved explicit recovery id', async () => {
    executeMock.mockRejectedValue(new Error('Start response lost'));
    homes.answer(homeA, '/v3/automations/runs/workflow-storage', {
      status: 404,
      body: { error: 'run_not_found' },
    });
    const { useWorkflowRunNowController } =
      await import('./useWorkflowRunNowController');
    const hook = await renderHook(() => useWorkflowRunNowController());
    await act(async () => {
      await hook
        .getCurrent()
        .runNow({
          runId: RUN_ID,
          source,
          inputs: { branch: 'old source' },
          refusal: 'inline',
        });
    });
    const newId = '00000000-0000-4000-8000-000000000002';
    await act(async () => {
      await hook
        .getCurrent()
        .runNow({
          runId: newId,
          source,
          inputs: { branch: 'new source' },
          refusal: 'inline',
        });
    });
    expect(startInput(2)).toMatchObject({
      runId: newId,
      inputs: { branch: 'new source' },
    });
    expect(hook.getCurrent().hasUnsettledAdmission(RUN_ID)).toBe(true);
    expect(hook.getCurrent().hasUnsettledAdmission(newId)).toBe(true);
  });

  it('retires an in-flight rejoin without publishing a result or retaining the old Account input', async () => {
    const rejoin = createDeferred<unknown>();
    executeMock
      .mockRejectedValueOnce(new Error('Start response lost'))
      .mockReturnValueOnce(rejoin.promise);
    homes.answer(homeA, '/v3/automations/runs/workflow-storage', {
      status: 404,
      body: { error: 'run_not_found' },
    });
    const { useWorkflowRunNowController } =
      await import('./useWorkflowRunNowController');
    const hook = await renderHook(() => useWorkflowRunNowController());
    let pending!: ReturnType<
      ReturnType<typeof useWorkflowRunNowController>['runNow']
    >;
    await act(async () => {
      pending = hook
        .getCurrent()
        .runNow({
          runId: RUN_ID,
          source,
          inputs: { branch: 'old' },
          refusal: 'inline',
        });
    });
    expect(hook.getCurrent().hasUnsettledAdmission(RUN_ID)).toBe(true);
    await act(async () => {
      setAccountScope({ serverId: 'server-b', accountId: 'account-b' });
    });
    await act(async () => {
      rejoin.resolve(admitted('existing'));
      expect(await pending).toBeNull();
    });
    expect(hook.getCurrent().hasUnsettledAdmission(RUN_ID)).toBe(false);
    expect(hook.getCurrent().refusal).toBeNull();
    expect(modals).toEqual([]);
    expect(
      storage.getState().workflowRunsById[workflowRunStoreKey(RUN_ID)],
    ).toBeUndefined();
    await act(async () => {
      setAccountScope({ serverId: 'server-a', accountId: 'account-a' });
      hook.rerender();
    });
    executeMock.mockResolvedValueOnce(admitted('created'));
    await act(async () => {
      await hook
        .getCurrent()
        .runNow({ runId: RUN_ID, source, inputs: { branch: 'new' } });
    });
    expect(startInput(2).inputs).toEqual({ branch: 'new' });
  });

  it('owns asynchronous preparation once and refuses to dispatch after its captured Account retires', async () => {
    const prepared = createDeferred<{
      source: WorkflowRunNowRequest['source'];
    }>();
    const { useWorkflowRunNowController } =
      await import('./useWorkflowRunNowController');
    const hook = await renderHook(() => useWorkflowRunNowController());
    let pending!: Promise<unknown>;
    let preparations = 0;
    const request = {
      prepareRequest: async () => {
        preparations++;
        return prepared.promise;
      },
    };
    await act(async () => {
      pending = hook.getCurrent().runNow(request);
    });
    const id = hook.getCurrent().pendingRunId;
    expect(id).not.toBeNull();
    expect(hook.getCurrent().stateFor(id!)).toBe('submitting');
    await act(async () => {
      expect(await hook.getCurrent().runNow(request)).toBeNull();
    });
    expect(preparations).toBe(1);
    expect(executeMock).not.toHaveBeenCalled();
    await act(async () => {
      setAccountScope({ serverId: 'server-b', accountId: 'account-b' });
    });
    await act(async () => {
      prepared.resolve({ source });
      expect(await pending).toBeNull();
    });
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('retires a result whose Account scope changed between dispatch and response', async () => {
    const request = createDeferred<unknown>();
    executeMock.mockReturnValueOnce(request.promise);
    const { useWorkflowRunNowController } =
      await import('./useWorkflowRunNowController');
    const hook = await renderHook(() => useWorkflowRunNowController());

    let invocation!: Promise<unknown>;
    await act(async () => {
      invocation = hook.getCurrent().runNow({ runId: RUN_ID, source });
    });
    expect(hook.getCurrent().stateFor(RUN_ID)).toBe('submitting');

    await act(async () => {
      setAccountScope({ serverId: 'server-b', accountId: 'account-b' });
    });
    let outcome: unknown;
    await act(async () => {
      request.resolve(admitted('created'));
      outcome = await invocation;
    });

    // No navigation handle and no row: another Account's session must not be
    // shown this Run, and no error is surfaced for a retired command.
    expect(outcome).toBeNull();
    expect(
      storage.getState().workflowRunsById[
        workflowRunStoreKey(RUN_ID, { serverId: homeA, accountId: 'account-a' })
      ],
    ).toBeUndefined();
    expect(modals.filter((entry) => entry.type === 'alert')).toEqual([]);
    await act(async () => {
      setAccountScope({ serverId: 'server-a', accountId: 'account-a' });
      hook.rerender();
    });
    expect(hook.getCurrent().stateFor(RUN_ID)).toBe('idle');
  });

  it('rejects a malformed admission response instead of navigating to it', async () => {
    // A partially migrated owner answering with a Run body but no admission.
    executeMock.mockResolvedValueOnce({
      run: createWorkflowRunSummaryFixture({
        id: RUN_ID,
        ownerAccountId: 'account-a',
      }),
    });
    const { useWorkflowRunNowController } =
      await import('./useWorkflowRunNowController');
    const hook = await renderHook(() => useWorkflowRunNowController());

    let outcome: unknown;
    await act(async () => {
      outcome = await hook.getCurrent().runNow({ runId: RUN_ID, source });
    });

    expect(outcome).toBeNull();
    expect(
      storage.getState().workflowRunsById[workflowRunStoreKey(RUN_ID)],
    ).toBeUndefined();
    expect(hook.getCurrent().stateFor(RUN_ID)).toBe('idle');
    expect(modals).toHaveLength(1);
    expect(modals[0]).toMatchObject({ type: 'alert', visible: true });
    expect(
      hook.tree.root.findAll(
        (node) => node.props.testID === 'web-modal-button-0',
      ),
    ).not.toHaveLength(0);
  });

  it('sends declared inputs and the originating-session completion choice with the admission', async () => {
    executeMock.mockResolvedValueOnce(admitted('created'));
    const { useWorkflowRunNowController } =
      await import('./useWorkflowRunNowController');
    const hook = await renderHook(() => useWorkflowRunNowController());

    await act(async () => {
      await hook.getCurrent().runNow({
        runId: RUN_ID,
        source,
        inputs: { branch: 'main' },
        onComplete: { kind: 'originating_session' },
      });
    });

    expect(executeMock.mock.calls[0]?.[0].input).toEqual({
      runId: RUN_ID,
      source,
      inputs: { branch: 'main' },
      onComplete: { kind: 'originating_session' },
    });
  });

  it('preserves an explicit Run execution target while omitting the default Session target', async () => {
    executeMock
      .mockResolvedValueOnce(admitted('created'))
      .mockResolvedValueOnce(admitted('created'));
    const { useWorkflowRunNowController } =
      await import('./useWorkflowRunNowController');
    const hook = await renderHook(() => useWorkflowRunNowController());

    await act(async () => {
      await hook.getCurrent().runNow({
        runId: RUN_ID,
        source,
        executionTarget: { kind: 'detached_run' },
      });
      await hook.getCurrent().runNow({
        runId: '00000000-0000-4000-8000-000000000002',
        source,
        executionTarget: { kind: 'session' },
      });
    });

    expect(executeMock.mock.calls[0]?.[0].input).toEqual({
      runId: RUN_ID,
      source,
      executionTarget: { kind: 'detached_run' },
    });
    expect(executeMock.mock.calls[1]?.[0].input).not.toHaveProperty(
      'executionTarget',
    );
  });

  it('does not dispatch without an active Account', async () => {
    setAccountScope(null);
    const { useWorkflowRunNowController } =
      await import('./useWorkflowRunNowController');
    const hook = await renderHook(() => useWorkflowRunNowController());

    await act(async () => {
      expect(
        await hook.getCurrent().runNow({ runId: RUN_ID, source }),
      ).toBeNull();
    });

    expect(executeMock).not.toHaveBeenCalled();
    expect(hook.getCurrent().stateFor(RUN_ID)).toBe('idle');
  });
});
