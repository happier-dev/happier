import { describe, expect, it, vi } from 'vitest';

import type { ActionExecutorDeps, ApprovalRequestV1 } from '@happier-dev/protocol';

import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';

function createApprovalRequest(overrides: Partial<ApprovalRequestV1> = {}): ApprovalRequestV1 {
  return {
    v: 1,
    status: 'open',
    createdAtMs: 1,
    updatedAtMs: 1,
    createdBy: { surface: 'agent', sessionId: 'sess_1' },
    requestedSurface: 'agent',
    actionId: 'session.list',
    actionArgs: { limit: 10 },
    summary: 'Approve listing sessions',
    preview: { actionId: 'session.list', actionArgs: { limit: 10 } },
    ...overrides,
  } as ApprovalRequestV1;
}

async function expectPromiseStillPending(promise: Promise<unknown>): Promise<void> {
  const settled = await Promise.race([
    promise.then(() => true, () => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
  ]);
  expect(settled).toBe(false);
}

describe('createCliActionExecutorHarness', () => {
  it('lets callers override action approval policy for a specific runtime surface', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'approval_1' }));
    const sessionTitleSet = vi.fn(async () => ({ ok: true, sessionId: 'sess_1', title: 'Updated' }));
    const harness = createCliActionExecutorHarness(
      {
        token: 'token',
        sessionId: 'sess_1',
        mode: 'e2ee',
        ctx: {
          encryptionKey: new Uint8Array(32).fill(1),
          encryptionVariant: 'legacy',
        },
      },
      {
        approvalsCreate,
        sessionTitleSet,
        isActionApprovalRequired: (id, ctx) => id === 'session.title.set' && ctx.surface === 'agent',
      },
    );

    const result = await harness.executor.execute(
      'session.title.set',
      { sessionId: 'sess_1', title: 'Updated' },
      { surface: 'agent', defaultSessionId: 'sess_1' },
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        kind: 'approval_request_created',
        artifactId: 'approval_1',
        actionId: 'session.title.set',
      },
    });
    expect(approvalsCreate).toHaveBeenCalledTimes(1);
    expect(sessionTitleSet).not.toHaveBeenCalled();
  });

  it('installs a fail-closed runtime action executor bridge', async () => {
    const harness = createCliActionExecutorHarness({
      token: 'token',
      sessionId: 'sess_1',
      mode: 'e2ee',
      ctx: {
        encryptionKey: new Uint8Array(32).fill(1),
        encryptionVariant: 'legacy',
      },
    });

    expect(harness.deps.runtimeActionExecute).toBeDefined();
    await expect(harness.deps.runtimeActionExecute?.({
      actionId: 'devices.simulator.input.tap',
      input: {},
      context: {},
    })).resolves.toEqual({
      ok: false,
      errorCode: 'runtime_action_disabled',
      error: 'runtime_action_disabled:devices.simulator:runtime_family_unimplemented',
    });
  });

  it('wires blocking approval waiters to rejection artifact updates', async () => {
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const harness = createCliActionExecutorHarness(
      {
        token: 'token',
        sessionId: 'sess_1',
        mode: 'e2ee',
        ctx: {
          encryptionKey: new Uint8Array(32).fill(1),
          encryptionVariant: 'legacy',
        },
      },
      {
        approvalsUpdate,
      },
    );

    const waitForDecision = harness.deps.approvalsWaitForDecision;
    expect(waitForDecision).toBeDefined();
    if (!waitForDecision) throw new Error('expected approvalsWaitForDecision');

    const pending = waitForDecision({
      artifactId: 'approval_1',
      request: createApprovalRequest(),
    });

    await harness.deps.approvalsUpdate?.({
      artifactId: 'approval_1',
      request: createApprovalRequest({
        status: 'rejected',
        decision: { kind: 'reject', decidedAtMs: 2 },
      }),
      serverId: null,
    });

    await expect(pending).resolves.toMatchObject({ decision: 'reject' });
    expect(approvalsUpdate).toHaveBeenCalledTimes(1);
  });

  it('keeps approved blocking waiters claimed by the explicit approval decision seam', async () => {
    const approvalsUpdate = vi.fn(async () => ({ ok: true as const }));
    const harness = createCliActionExecutorHarness(
      {
        token: 'token',
        sessionId: 'sess_1',
        mode: 'e2ee',
        ctx: {
          encryptionKey: new Uint8Array(32).fill(1),
          encryptionVariant: 'legacy',
        },
      },
      {
        approvalsUpdate,
      },
    );

    const waitForDecision = harness.deps.approvalsWaitForDecision;
    const resolveBlockingDecision: ActionExecutorDeps['approvalsResolveBlockingDecision'] =
      harness.deps.approvalsResolveBlockingDecision;
    expect(waitForDecision).toBeDefined();
    expect(resolveBlockingDecision).toBeDefined();
    if (!waitForDecision || !resolveBlockingDecision) {
      throw new Error('expected blocking approval hooks');
    }

    const pending = waitForDecision({
      artifactId: 'approval_approved_1',
      request: createApprovalRequest(),
    });

    const approvedRequest = createApprovalRequest({
      status: 'approved',
      decision: { kind: 'approve', decidedAtMs: 2 },
    });
    await harness.deps.approvalsUpdate?.({
      artifactId: 'approval_approved_1',
      request: approvedRequest,
      serverId: null,
    });

    await expectPromiseStillPending(pending);

    await expect(resolveBlockingDecision({
      artifactId: 'approval_approved_1',
      decision: 'approve',
      request: approvedRequest,
      serverId: null,
    })).resolves.toEqual({ resolved: true });
    await expect(pending).resolves.toMatchObject({ decision: 'approve' });
  });
});
