import { describe, expect, it } from 'vitest';

import type { ApprovalRequestV1 } from '@happier-dev/protocol';

import { createBlockingApprovalCoordinator } from './blockingApprovalCoordinator';

function createRequest(overrides: Partial<ApprovalRequestV1> = {}): ApprovalRequestV1 {
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

async function expectPending<T>(promise: Promise<T>): Promise<void> {
  await Promise.resolve();
  await expect(Promise.race([
    promise.then(() => 'settled'),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0)),
  ])).resolves.toBe('pending');
}

describe('createBlockingApprovalCoordinator', () => {
  it('resolves duplicate blocking waiters when a live approval decision is claimed', async () => {
    const coordinator = createBlockingApprovalCoordinator();
    const request = createRequest();

    const first = coordinator.waitForDecision({ artifactId: 'approval_1', request });
    const second = coordinator.waitForDecision({ artifactId: 'approval_1', request });

    await expectPending(first);

    await coordinator.resolveBlockingDecision({
      artifactId: 'approval_1',
      request: createRequest({
        status: 'approved',
        decision: { kind: 'approve', decidedAtMs: 2 },
      }),
      decision: 'approve',
    });

    await expect(first).resolves.toMatchObject({ decision: 'approve' });
    await expect(second).resolves.toMatchObject({ decision: 'approve' });
    expect(coordinator.getLiveWaiterCount('approval_1')).toBe(0);
  });

  it('does not resolve live waiters from non-terminal approved update notifications', async () => {
    const coordinator = createBlockingApprovalCoordinator();
    const pending = coordinator.waitForDecision({
      artifactId: 'approval_approved_intermediate',
      request: createRequest(),
    });

    coordinator.notifyApprovalUpdated({
      artifactId: 'approval_approved_intermediate',
      request: createRequest({
        status: 'approved',
        decision: { kind: 'approve', decidedAtMs: 2 },
      }),
    });

    await expectPending(pending);
    expect(coordinator.getLiveWaiterCount('approval_approved_intermediate')).toBe(1);
    coordinator.cancelApproval('approval_approved_intermediate', 'test cleanup');
    await expect(pending).rejects.toThrow('test cleanup');
  });

  it('resolves blocking waiters with rejection when a rejection is recorded', async () => {
    const coordinator = createBlockingApprovalCoordinator();
    const pending = coordinator.waitForDecision({
      artifactId: 'approval_2',
      request: createRequest(),
    });

    coordinator.notifyApprovalUpdated({
      artifactId: 'approval_2',
      request: createRequest({
        status: 'rejected',
        decision: { kind: 'reject', decidedAtMs: 2 },
      }),
    });

    await expect(pending).resolves.toMatchObject({ decision: 'reject' });
    expect(coordinator.getLiveWaiterCount('approval_2')).toBe(0);
  });

  it('detaches an aborted caller without canceling the durable approval', async () => {
    const coordinator = createBlockingApprovalCoordinator();
    const abortController = new AbortController();
    const pending = coordinator.waitForDecision({
      artifactId: 'approval_3',
      request: createRequest(),
      signal: abortController.signal,
    });

    abortController.abort('caller gone');

    await expect(pending).rejects.toThrow('caller gone');
    expect(coordinator.getLiveWaiterCount('approval_3')).toBe(0);
    expect(coordinator.getDetachedWaiterCount('approval_3')).toBe(1);

    expect(() => coordinator.notifyApprovalUpdated({
      artifactId: 'approval_3',
      request: createRequest({
        status: 'approved',
        decision: { kind: 'approve', decidedAtMs: 3 },
      }),
    })).not.toThrow();
    expect(coordinator.getLiveWaiterCount('approval_3')).toBe(0);
  });

  it('resolves from durable executed state without a same-process notification', async () => {
    const coordinator = createBlockingApprovalCoordinator();
    let request = createRequest();
    const pending = coordinator.waitForDecision({
      artifactId: 'approval_durable_1',
      request,
      pollIntervalMs: 1,
      readRequest: async () => request,
    });

    request = createRequest({
      status: 'executed',
      decision: { kind: 'approve', decidedAtMs: 2 },
      execution: {
        executedAtMs: 3,
        ok: true,
        result: { sessions: [{ id: 'sess_1' }] },
      },
    });

    await expect(pending).resolves.toMatchObject({
      decision: 'approve',
      request: {
        status: 'executed',
        execution: {
          ok: true,
          result: { sessions: [{ id: 'sess_1' }] },
        },
      },
    });
    expect(coordinator.getLiveWaiterCount('approval_durable_1')).toBe(0);
  });

  it('cancels live waiters when disposed', async () => {
    const coordinator = createBlockingApprovalCoordinator();
    const pending = coordinator.waitForDecision({
      artifactId: 'approval_4',
      request: createRequest(),
    });

    coordinator.dispose('session stopped');

    await expect(pending).rejects.toThrow('session stopped');
    expect(coordinator.getLiveWaiterCount('approval_4')).toBe(0);
  });

  it('resolves live waiters from failed terminal update notifications', async () => {
    const coordinator = createBlockingApprovalCoordinator();
    const pending = coordinator.waitForDecision({
      artifactId: 'approval_failed_terminal',
      request: createRequest(),
    });

    coordinator.notifyApprovalUpdated({
      artifactId: 'approval_failed_terminal',
      request: createRequest({
        status: 'failed',
        decision: { kind: 'approve', decidedAtMs: 2 },
        execution: {
          executedAtMs: 3,
          ok: false,
          errorCode: 'action_failed',
          error: 'action_failed',
        },
      }),
    });

    const settled = await Promise.race([
      pending,
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 20)),
    ]);
    expect(settled).toMatchObject({
      decision: 'approve',
      request: {
        status: 'failed',
        execution: {
          ok: false,
          errorCode: 'action_failed',
        },
      },
    });
    expect(coordinator.getLiveWaiterCount('approval_failed_terminal')).toBe(0);
  });
});
