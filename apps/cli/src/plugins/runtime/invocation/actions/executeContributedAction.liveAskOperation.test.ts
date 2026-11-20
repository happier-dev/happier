import { afterEach, expect, it } from 'vitest';
import type { TargetActionApprovalRequestV1 } from '@happier-dev/protocol';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createTargetActionApprovalDecision } from '@happier-dev/protocol/actions/targetActionApprovalDecision';
import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { admitTargetActionApprovalTransition } from '@happier-dev/protocol/approvals/targetActionApprovalRequestTransition';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createTargetActionCurrentIntentAdapter } from '@/session/actions/approvals/targetActionCurrentIntent';
import { createExternalActionRuntime } from '@/daemon/externalActions/externalActionRuntime.testkit';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { executeContributedAction } from './executeContributedAction';

afterEach(() => getSharedBlockingApprovalCoordinator().dispose());

// F10 (Plugin platform ruling B, 2026-11-20): a live-only Ask keeps its operands in
// the daemon-held waiter. The Agent gets the operation receipt at admission, the
// operation waits for the person's decision, and it settles exactly once.
it.each([
  { decision: 'approve', state: 'succeeded', effects: 1 },
  { decision: 'reject', state: 'failed', effects: 0 },
] as const)(
  'returns the Agent receipt before a live-only Ask is decided, then settles once: $decision',
  async ({ decision, state, effects: expectedEffects }) => {
    let effects = 0;
    let stored: TargetActionApprovalRequestV1 | null = null;
    let waiterReady!: () => void;
    const waiting = new Promise<void>((resolve) => {
      waiterReady = resolve;
    });
    const artifactId = `held-ask-${decision}`;
    const operationId = `held-operation-${decision}`;
    const scope = { accountId: 'account', machineId: 'machine' };
    const read = async () => stored && structuredClone(stored);
    const update = async ({
      request,
    }: {
      request: TargetActionApprovalRequestV1;
    }) => {
      if (!stored) throw new Error('Missing approval Artifact');
      const admitted = admitTargetActionApprovalTransition(stored, request);
      if (admitted.ok) stored = request;
      return admitted;
    };
    // Only Artifact persistence and its change feed are substituted.
    const requestCurrentIntent = createTargetActionCurrentIntentAdapter({
      read,
      update,
      create: async (request) => {
        stored = request;
        return { artifactId, request };
      },
      subscribeChanges: () => {
        waiterReady();
        return { dispose() {} };
      },
    });
    const runtime = createExternalActionRuntime(
      'global',
      'acme.held-operation',
      () => {
        effects++;
      },
      undefined,
      undefined,
      undefined,
      undefined,
      'writesRemote',
      undefined,
      {
        surfaces: ['agent'],
        operation: {
          version: 1,
          visibility: 'activity',
          progress: 'indeterminate',
          presentation: { onStart: 'activity' },
        },
      },
    );
    const host = createHostActionOperationRuntime({
      machineId: 'machine',
      serverId: 'home',
      resolveAccountId: async () => 'account',
      generateOperationId: () => operationId,
    });
    const approvalContext = {
      surface: 'agent',
      runtimeAccountId: 'account',
      serverId: 'home',
      authority: 'account_automation',
      actionCaller: {
        kind: 'session',
        sessionId: 'originating-agent',
        starterDepth: 0,
        turnDepth: 0,
      },
    } satisfies ActionExecutorContext;
    const context = {
      ...approvalContext,
      approvalInputCustody: 'live_only' as const,
      observePluginExecution: host.observePluginExecution,
    };
    let admission:
      | Awaited<ReturnType<typeof executeContributedAction>>
      | undefined;
    const pending = executeContributedAction({
      runtimeRegistry: runtime,
      actionId: 'acme.held-operation/inspect',
      input: {},
      context,
      approvalContext,
      requestCurrentIntent,
      daemonHoldsApprovalWaiter: true,
      actionsSettings: {
        v: 1,
        actions: {
          'acme.held-operation/actions/inspect': {
            approvalRequiredSurfaces: ['agent'],
          },
        },
      },
    }).then((result) => {
      admission = result;
      return result;
    });
    await waiting;
    // The Agent is not held for the person's decision.
    await expect
      .poll(() => admission, { timeout: 2_000 })
      .toMatchObject({
        matched: true,
        result: {
          ok: true,
          result: {
            status: 'accepted',
            operationId,
            machineId: 'machine',
          },
        },
      });
    expect(effects).toBe(0);
    expect(host.store.get(scope, operationId)).toMatchObject({
      progress: {
        phase: 'waiting_for_approval',
        approval: { kind: 'approval_request_created', artifactId },
      },
    });
    const executor = createActionExecutor({
      ...createUnavailableActionTransportDeps(),
      targetActionApprovalReplay: createTargetActionApprovalDecision({
        read,
        update,
      }),
    });
    expect(
      await executor.execute(
        'approval.request.decide',
        { artifactId, decision },
        {
          surface: 'cli',
          authority: 'present_user',
          runtimeAccountId: 'person',
        },
      ),
    ).toMatchObject({ ok: true });
    const terminal = await host.runner.waitForTerminal(scope, operationId);
    expect(terminal).toMatchObject({ state });
    if (state === 'failed')
      expect(terminal).toMatchObject({
        error: { errorCode: 'plugin_action_current_intent_rejected' },
      });
    expect(effects).toBe(expectedEffects);
    await pending;
  },
);
