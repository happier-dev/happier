import type {
  AgentSessionControlContext,
  AgentSessionGoalControlContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { describe, expect, it, vi } from 'vitest';

const clientMocks = vi.hoisted(() => ({
  request: vi.fn(),
  dispose: vi.fn(async () => undefined),
}));

vi.mock('./appServer/client.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./appServer/client.js')>(),
  createCodexNativeAppServerClient: vi.fn(async () => ({
    request: clientMocks.request,
    dispose: clientMocks.dispose,
  })),
}));

import { createCodexNativeSessionControls } from './controls.js';

function context(activity: 'active' | 'inactive' = 'active'): AgentSessionControlContext {
  return {
    signal: new AbortController().signal,
    services: { exec: {} },
    session: {
      id: 'session-1',
      cwd: '/repo',
      activity,
      providerSessionId: 'thread-1',
      connectedAccounts: [],
    },
  } as unknown as AgentSessionControlContext;
}

describe('createCodexNativeSessionControls', () => {
  it.each([
    ['active', 'active', undefined],
    ['paused', 'paused', undefined],
    ['blocked', 'blocked', 'blocked'],
    ['usageLimited', 'blocked', 'usageLimited'],
    ['budgetLimited', 'blocked', 'budgetLimited'],
    ['complete', 'complete', undefined],
  ] as const)(
    'publishes readable native goal status %s with provider timestamps and reason',
    async (providerStatus, status, statusReason) => {
      clientMocks.request.mockResolvedValueOnce({
        goal: {
          threadId: `thread-${providerStatus}`,
          objective: `Handle ${providerStatus}`,
          status: providerStatus,
          tokenBudget: 1_000,
          tokensUsed: 250,
          timeUsedSeconds: 12,
          createdAt: 1_776_272_400,
          updatedAt: 1_776_272_460,
        },
      });
      const publish = vi.fn(async () => ({
        status: 'applied' as const,
        revision: `goal-${providerStatus}`,
        sourceSequence: 1,
      }));

      await expect(createCodexNativeSessionControls().goals.get({
        ...context(),
        goalSource: { publish },
      } as AgentSessionGoalControlContext)).resolves.toEqual({
        status: 'applied',
        revision: `goal-${providerStatus}`,
      });
      expect(publish).toHaveBeenCalledWith({
        sourceSequence: 1,
        observedAtMs: 1_776_272_460_000,
        items: [{
          localId: `goal:thread-${providerStatus}`,
          kind: 'goal',
          origin: 'vendor',
          status,
          ...(statusReason ? { statusReason } : {}),
          title: `Handle ${providerStatus}`,
          providerRef: `thread-${providerStatus}`,
          tokenBudget: 1_000,
          tokensUsed: 250,
          timeUsedSeconds: 12,
          createdAtMs: 1_776_272_400_000,
          updatedAtMs: 1_776_272_460_000,
        }],
        primaryLocalId: `goal:thread-${providerStatus}`,
      });
    },
  );

  it.each([
    ['invalid updatedAt', {
      threadId: 'thread-invalid-updated-at',
      objective: 'Keep the current goal',
      status: 'active',
      updatedAt: 'not-a-date',
    }],
    ['invalid createdAt', {
      threadId: 'thread-invalid-created-at',
      objective: 'Keep the current goal',
      status: 'paused',
      createdAt: 1_776_272_400.5,
      updatedAt: 1_776_272_460,
    }],
    ['non-object goal', 'not-a-goal'],
  ])('rejects a malformed native goal with %s without publishing', async (_label, goal) => {
    clientMocks.request.mockResolvedValueOnce({ goal });
    const publish = vi.fn();

    await expect(createCodexNativeSessionControls().goals.get({
      ...context(),
      goalSource: { publish },
    } as AgentSessionGoalControlContext)).resolves.toEqual({
      status: 'unavailable',
      retryable: false,
      diagnostic: {
        code: 'codex_goal_payload_invalid',
        severity: 'error',
        message: 'codex_goal_payload_invalid',
      },
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it('publishes an explicit absent native goal as an empty snapshot', async () => {
    clientMocks.request.mockResolvedValueOnce({ goal: null });
    const publish = vi.fn(async () => ({
      status: 'applied' as const,
      revision: 'goal-absent',
      sourceSequence: 1,
    }));

    await expect(createCodexNativeSessionControls().goals.get({
      ...context(),
      goalSource: { publish },
    } as AgentSessionGoalControlContext)).resolves.toEqual({
      status: 'applied',
      revision: 'goal-absent',
    });
    expect(publish).toHaveBeenCalledWith({
      sourceSequence: 1,
      observedAtMs: expect.any(Number),
      items: [],
    });
  });

  it('uses provider RPC evidence for rollback, continuation, goal, catalog, and usage controls', async () => {
    clientMocks.request.mockImplementation(async (method: string) => {
      if (method === 'thread/read') return { thread: { turns: [] } };
      if (method === 'thread/goal/get') {
        return {
          goal: {
            threadId: 'thread-1',
            objective: 'Ship it',
            status: 'active',
            updatedAt: 1_776_272_460,
          },
        };
      }
      if (method === 'plugin/list') {
        return [{ id: 'plugin://gmail', name: 'gmail', displayName: 'Gmail', installed: true, enabled: true }];
      }
      if (method === 'account/rateLimits/read') return { primary: { usedPercent: 10 } };
      return {};
    });
    const controls = createCodexNativeSessionControls();
    const controlContext = context();
    await expect(controls.continuation.verify({
      kind: 'resume', sessionId: 'session-1', cwd: '/repo', providerSessionId: 'thread-1',
    }, controlContext)).resolves.toEqual({ status: 'reachable' });

    const publish = vi.fn(async () => ({ status: 'applied' as const, revision: 'goal-1', sourceSequence: 1 }));
    await expect(controls.goals.get({
      ...controlContext,
      goalSource: { publish },
    } as AgentSessionGoalControlContext)).resolves.toEqual({ status: 'applied', revision: 'goal-1' });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      items: [expect.objectContaining({ title: 'Ship it', status: 'active' })],
    }));
    await expect(controls.catalog.list({ kind: 'vendorPlugins' }, controlContext)).resolves.toMatchObject({
      status: 'ok',
      items: [expect.objectContaining({ id: 'plugin://gmail', displayName: 'Gmail' })],
    });
    await expect(controls.usageLimitRecovery.execute({ kind: 'checkNow' }, controlContext))
      .resolves.toEqual({ status: 'ready' });

  });

  it('serves declared inactive goal, catalog, and usage controls through the native facets', async () => {
    clientMocks.request.mockImplementation(async (method: string) => {
      if (method === 'thread/goal/get') {
        return {
          goal: {
            threadId: 'thread-1',
            objective: 'Resume it',
            status: 'paused',
            updatedAt: 1_776_272_460,
          },
        };
      }
      if (method === 'plugin/list') {
        return [{ id: 'plugin://gmail', name: 'gmail', displayName: 'Gmail', installed: true, enabled: true }];
      }
      if (method === 'account/rateLimits/read') return { primary: { usedPercent: 10 } };
      return {};
    });
    const controls = createCodexNativeSessionControls();
    const inactiveContext = context('inactive');
    const publish = vi.fn(async () => ({ status: 'applied' as const, revision: 'goal-inactive', sourceSequence: 1 }));

    await expect(controls.goals.get({
      ...inactiveContext,
      goalSource: { publish },
    } as AgentSessionGoalControlContext)).resolves.toEqual({ status: 'applied', revision: 'goal-inactive' });
    await expect(controls.catalog.list({ kind: 'vendorPlugins' }, inactiveContext)).resolves.toMatchObject({
      status: 'ok',
      items: [expect.objectContaining({ id: 'plugin://gmail' })],
    });
    await expect(controls.usageLimitRecovery.execute({ kind: 'checkNow' }, inactiveContext))
      .resolves.toEqual({ status: 'ready' });

    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      items: [expect.objectContaining({ title: 'Resume it', status: 'paused' })],
    }));
  });
});
