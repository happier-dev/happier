import { describe, expect, it, vi } from 'vitest';

const { dispatchBridgeLifecycleHookEvent } = vi.hoisted(() => ({
  dispatchBridgeLifecycleHookEvent: vi.fn().mockResolvedValue({
    eventId: 'session.spawned',
    matchedHandlerCount: 0,
    outcomes: [],
  }),
}));

vi.mock('@/plugins/runtime/hooks/execution/dispatchBridgeLifecycleHookEvent', () => ({
  dispatchBridgeLifecycleHookEvent,
}));

import { SessionHostBridge } from './SessionHostBridge';

describe('SessionHostBridge lifecycle hook emission', () => {
  it('dispatches bridge lifecycle hooks through the centralized hook dispatcher', async () => {
    const bridge = new SessionHostBridge();

    await bridge.emitLifecycleHookEvent({
      happyHomeDir: '/tmp/happy-home',
      eventId: 'session.spawned',
      happySessionId: 'sess_1',
      machineId: 'machine_1',
      cwd: '/repo',
      workspaceId: 'workspace_1',
      backendTarget: 'agent:claude',
      payload: {
        sessionId: 'sess_1',
        agentId: 'claude',
        runtimeTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      },
    });

    expect(dispatchBridgeLifecycleHookEvent).toHaveBeenCalledWith({
      happyHomeDir: '/tmp/happy-home',
      event: expect.objectContaining({
        eventId: 'session.spawned',
        happySessionId: 'sess_1',
        machineId: 'machine_1',
        cwd: '/repo',
        workspaceId: 'workspace_1',
        backendTarget: 'agent:claude',
        payload: {
          sessionId: 'sess_1',
          agentId: 'claude',
          runtimeTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        },
      }),
    });
  });

  it('swallows hook dispatcher errors to keep lifecycle operations best-effort', async () => {
    dispatchBridgeLifecycleHookEvent.mockRejectedValueOnce(new Error('hook boom'));
    const bridge = new SessionHostBridge();

    await expect(bridge.emitLifecycleHookEvent({
      happyHomeDir: '/tmp/happy-home',
      eventId: 'session.message.send',
      happySessionId: 'sess_1',
      payload: {
        sessionId: 'sess_1',
        text: 'test',
        source: 'user',
      },
    })).resolves.toBeUndefined();
  });
});
