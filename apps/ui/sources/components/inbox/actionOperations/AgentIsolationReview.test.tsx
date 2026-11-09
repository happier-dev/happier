import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { executeActionOperationActionV1 } from '@happier-dev/protocol/actions/executor/actionOperationActions';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { createActionOperationSelectors } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { storage } from '@/sync/domains/state/storageStore';

const initialState = storage.getState();
const frontDoor = vi.hoisted(() => ({ execute: vi.fn() }));
const router = vi.hoisted(() => ({ push: vi.fn() }));
const rpc = vi.hoisted(() => ({
  calls: [] as { method: string; payload: unknown }[],
  respond: null as null | (() => unknown),
}));

// Inject settled executor responses through the real front door; preserve every other export.
// The modal, projection, decision hook, submit adapter and operation store stay real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
  const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
  const create = createFrontDoorActionExecuteForVitest(original);
  return { ...original, createFrontDoorActionExecute: (executor, options) =>
    create(executor ?? { execute: frontDoor.execute }, options),
  } satisfies typeof original;
});
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  () => ({
    machineRpcWithServerScope: async ({
      method,
      payload,
    }: {
      method: string;
      payload: unknown;
    }) => {
      rpc.calls.push({ method, payload });
      return rpc.respond?.();
    },
  }),
);
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key) => key });
});
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({ router }).module;
});

beforeEach(() => storage.setState(initialState, true));
afterEach(() => {
  standardCleanup();
  storage.setState(initialState, true);
  actionOperationStore.reset();
  frontDoor.execute.mockReset();
  router.push.mockReset();
  rpc.calls.length = 0;
  rpc.respond = null;
});

const { ActionOperationDetailModal } =
  await import('./ActionOperationDetailModal');

const preview = (planDigest: string, roots: readonly string[]) => ({
  kind: 'ready' as const,
  plan: {
    roots: roots.map((path, index) => ({
      rootId: `root-${index}`,
      path,
      changes: ['group' as const, 'gitShared' as const],
    })),
    ancestorAcls: [{ path: '/srv', add: 'x' as const }],
    sessionsToReplace: 2,
    requiresAdmin: true,
    planDigest,
  },
  policy: { enabled: false },
  metadataVersion: 7,
  status: { kind: 'disabled' as const },
});

const heldReview = (
  planDigest = 'digest-1',
  roots = ['/srv/shop', '/srv/site', '/srv/infra'],
  revision = 4,
): ActionOperationSnapshotV1 => ({
  version: 1,
  operationId: 'operation-1',
  revision,
  actionId: 'machines.agentIsolation.set',
  state: 'running',
  scope: { accountId: 'account-1', machineId: 'machine-1' },
  title: 'Change Agent isolation',
  requestId: 'request-original',
  createdAt: 1_000,
  startedAt: 1_100,
  cancellation: 'unsupported',
  observation: {
    kind: 'review_required',
    code: 'agent_isolation_effect_changed',
    machineId: 'machine-1',
    enabled: true,
    current: preview(planDigest, roots),
  },
});

async function renderHeldReview(snapshot = heldReview()) {
  actionOperationStore.mergeSnapshots({
    serverId: 'home-a',
    snapshots: [snapshot],
  });
  return await renderScreen(
    <ActionOperationDetailModal
      serverId="home-a"
      operationId="operation-1"
      onClose={vi.fn()}
      setChrome={vi.fn()}
    />,
  );
}

describe('Agent isolation review in the operation detail', () => {
  it('shows the exact reviewed effects and one primary approval, with the plan references as technical facts', async () => {
    const screen = await renderHeldReview();
    const text = screen.getTextContent();
    expect(text).toContain('/srv/shop');
    expect(text).toContain('/srv/infra');
    expect(text).toContain('inbox.actionOperations.isolationReview.turnOn');
    expect(
      screen.findByTestId('action-operation-isolation-sessions'),
    ).not.toBeNull();
    expect(
      screen.findByTestId('action-operation-isolation-approve'),
    ).not.toBeNull();
    // A held review is a person's decision, not an unavailable status.
    expect(text).not.toContain(
      'inbox.actionOperations.observation.unavailable',
    );
    expect(text).toContain('inbox.needsYou');
  });

  it('says what the agent-requested change leaves behind: the after-state and the Docker consequence', async () => {
    const screen = await renderHeldReview();
    expect(screen.findByTestId('action-operation-isolation-after')).not.toBeNull();
    expect(screen.findByTestId('action-operation-isolation-docker')).not.toBeNull();
    const text = screen.getTextContent();
    expect(text).toContain('inbox.actionOperations.isolationReview.afterOn');
    expect(text).toContain('inbox.actionOperations.isolationReview.dockerHint');
  });

  it('turning separate users off says agents return to Happier’s user and names no Docker loss', async () => {
    const off = heldReview();
    const screen = await renderHeldReview({ ...off, observation: { ...off.observation!, enabled: false } as typeof off.observation });
    const text = screen.getTextContent();
    expect(text).toContain('inbox.actionOperations.isolationReview.afterOff');
    expect(screen.findByTestId('action-operation-isolation-docker')).toBeNull();
  });

  it('lists a held review among the Inbox items that need the person, and puts it nowhere once it is decided', () => {
    actionOperationStore.mergeSnapshots({
      serverId: 'home-a',
      snapshots: [heldReview()],
    });
    const selectors = createActionOperationSelectors();
    expect(
      selectors
        .selectInbox(actionOperationStore.getSnapshot())
        .map((entry) => entry.reason),
    ).toEqual(['review_required']);
    expect(
      selectors.selectInboxSummary(actionOperationStore.getSnapshot()).count,
    ).toBe(1);
    actionOperationStore.mergeSnapshots({
      serverId: 'home-a',
      snapshots: [{ ...heldReview(), revision: 5, observation: undefined }],
    });
    expect(selectors.selectInbox(actionOperationStore.getSnapshot())).toEqual(
      [],
    );
  });

  it('approves the reviewed set on the original request identity', async () => {
    frontDoor.execute.mockResolvedValue({
      ok: true,
      result: {
        kind: 'accepted',
        operationId: 'operation-1',
        metadataVersion: 8,
        status: { kind: 'applying', phase: 'account' },
      },
    });
    const screen = await renderHeldReview();
    await screen.pressByTestIdAsync('action-operation-isolation-approve');
    expect(frontDoor.execute).toHaveBeenCalledTimes(1);
    expect(frontDoor.execute.mock.calls[0]?.[2]).toMatchObject({
      actionRequestId: 'request-original',
    });
    expect(frontDoor.execute.mock.calls[0]?.[1]).toMatchObject({
      expectedPlanDigest: 'digest-1',
      machineId: 'machine-1',
      enabled: true,
    });
    // Accepted is not done: the page says it is applying until the operation's own push replaces it.
    expect(screen.getTextContent()).toContain(
      'inbox.actionOperations.isolationRecovery.applyingTitle',
    );
    expect(
      screen.findByTestId('action-operation-isolation-approve'),
    ).toBeNull();
  });

  it('answers an approval the Account asked for with the canonical waiting notice and its way to the review', async () => {
    frontDoor.execute.mockResolvedValue({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'artifact-9', actionId: 'machines.agentIsolation.set' },
    });
    const screen = await renderHeldReview();
    await screen.pressByTestIdAsync('action-operation-isolation-approve');
    expect(screen.findByTestId('action-operation-isolation-approval')).not.toBeNull();
    await screen.pressByTestIdAsync('action-operation-isolation-approval.open');
    expect(router.push).toHaveBeenCalledWith(
      expect.stringContaining('/inbox/approvals/artifact-9'),
    );
  });

  it('reads a stale digest as a changed review: readable, no auto-retry, re-review shows the fresh effects', async () => {
    frontDoor.execute.mockResolvedValue({
      ok: true,
      result: {
        kind: 'plan_changed',
        current: preview('digest-2', ['/srv/shop']),
      },
    });
    const screen = await renderHeldReview();
    await screen.pressByTestIdAsync('action-operation-isolation-approve');
    expect(screen.getTextContent()).toContain(
      'inbox.actionOperations.isolationReview.changedTitle',
    );
    // The reviewed set is not approvable again, and nothing replayed it.
    expect(
      screen.findByTestId('action-operation-isolation-approve'),
    ).toBeNull();
    expect(frontDoor.execute).toHaveBeenCalledTimes(1);

    rpc.respond = () => ({
      kind: 'found',
      operation: heldReview('digest-2', ['/srv/shop'], 6),
    });
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
      actionOperationAction: args => executeActionOperationActionV1({ ...args, transport: async request => {
        rpc.calls.push({ method: request.method, payload: request.payload });
        return rpc.respond?.();
      } }),
    }));
    frontDoor.execute.mockImplementation((id, input, context) => executor.execute(id, input,
      { ...context, runtimeAccountId: 'account-1' }));
    await screen.pressByTestIdAsync('action-operation-isolation-notice.action');
    expect(rpc.calls.map((call) => call.method)).toEqual([
      'actionOperation.get.v2',
    ]);
    expect(rpc.calls[0]?.payload).toEqual({ operationId: 'operation-1', refreshSetupReview: true });
    expect(screen.getTextContent()).not.toContain('/srv/infra');
    expect(screen.getTextContent()).not.toContain(
      'inbox.actionOperations.isolationReview.changedTitle',
    );
    expect(
      screen.findByTestId('action-operation-isolation-approve'),
    ).not.toBeNull();
    expect(frontDoor.execute).toHaveBeenCalledTimes(2);
  });

  it('keeps an unconfirmed outcome nonterminal with no way to approve it again', async () => {
    frontDoor.execute.mockResolvedValue({
      ok: true,
      result: {
        kind: 'failed',
        operationId: 'operation-1',
        code: 'outcome_unknown',
      },
    });
    const screen = await renderHeldReview();
    await screen.pressByTestIdAsync('action-operation-isolation-approve');
    expect(screen.getTextContent()).toContain(
      'inbox.actionOperations.isolationReview.unknownTitle',
    );
    expect(
      screen.findByTestId('action-operation-isolation-approve'),
    ).toBeNull();
    expect(
      screen.findByTestId('action-operation-isolation-notice.action'),
    ).toBeNull();
    expect(frontDoor.execute).toHaveBeenCalledTimes(1);
  });
  describe('after an unknown outcome (reconnect CHECK)', () => {
    const unknownOperation = (): ActionOperationSnapshotV1 => ({
      ...heldReview(),
      observation: { kind: 'outcome_uncertain', code: 'action_outcome_unknown' },
    });
    const applyAgain = () => ({
      ok: true,
      result: { kind: 'accepted', operationId: 'operation-2', metadataVersion: 8, status: { kind: 'applying', phase: 'account' } },
    });
    async function renderUnknown(recovery: Parameters<typeof actionOperationStore.reobserveMachineAgentIsolation>[0]['recovery']) {
      actionOperationStore.mergeSnapshots({ serverId: 'home-a', snapshots: [unknownOperation()] });
      actionOperationStore.reobserveMachineAgentIsolation({
        serverId: 'home-a', accountId: 'account-1', machineId: 'machine-1', operationId: 'operation-1', recovery,
      });
      return await renderScreen(
        <ActionOperationDetailModal serverId="home-a" operationId="operation-1" onClose={vi.fn()} setChrome={vi.fn()} />,
      );
    }

    it('applies again only on the person\'s press, with the CHECK\'s reviewed set and a NEW request id', async () => {
      frontDoor.execute.mockResolvedValue(applyAgain());
      const screen = await renderUnknown({ enabled: true, preview: { ...preview('digest-check', ['/srv/shop']), policy: { enabled: false } } });
      expect(screen.getTextContent()).toContain('/srv/shop');
      expect(frontDoor.execute).not.toHaveBeenCalled();
      await screen.pressByTestIdAsync('action-operation-isolation-retry');
      expect(frontDoor.execute).toHaveBeenCalledTimes(1);
      expect(frontDoor.execute.mock.calls[0]?.[0]).toBe('machines.agentIsolation.set');
      expect(frontDoor.execute.mock.calls[0]?.[1]).toMatchObject({
        machineId: 'machine-1', enabled: true, expectedPolicy: { enabled: false }, expectedMetadataVersion: 7, expectedPlanDigest: 'digest-check',
      });
      const requestId = (frontDoor.execute.mock.calls[0]?.[2] as { actionRequestId?: string }).actionRequestId;
      expect(requestId).toBeTruthy();
      expect(requestId).not.toBe('request-original');
      // Once accepted it cannot be pressed again from this view.
      expect(screen.findByTestId('action-operation-isolation-retry')).toBeNull();
      expect(screen.getTextContent()).toContain('inbox.actionOperations.isolationRecovery.appliedTitle');
    });

    it('shows isolation as satisfied with nothing to apply', async () => {
      const done = {
        ...preview('digest-done', []),
        plan: { roots: [], ancestorAcls: [], sessionsToReplace: 0, requiresAdmin: false, planDigest: 'digest-done' },
        policy: { enabled: true },
        status: { kind: 'effective' as const, platform: 'linux' as const, agentUser: 'happier-agent' as const },
      };
      const screen = await renderUnknown({ enabled: true, preview: done });
      expect(screen.getTextContent()).toContain('inbox.actionOperations.isolationRecovery.onTitle');
      expect(screen.findByTestId('action-operation-isolation-retry')).toBeNull();
      expect(frontDoor.execute).not.toHaveBeenCalled();
    });
  });
});
