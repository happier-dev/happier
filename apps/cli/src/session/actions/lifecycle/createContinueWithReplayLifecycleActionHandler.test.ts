import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';

const mocks = vi.hoisted(() => ({
  continueSessionWithReplay: vi.fn(),
}));

vi.mock('@/session/replay/continueWithReplay', () => ({
  continueSessionWithReplay: (...args: unknown[]) => mocks.continueSessionWithReplay(...args),
}));

import { createContinueWithReplayLifecycleActionHandler } from './createContinueWithReplayLifecycleActionHandler';

function createBridge(): ReturnType<typeof getSessionHostBridge> {
  return {
    resolveContinueWithReplayBackendTarget: vi.fn(({ backendTarget }: { backendTarget: unknown }) => ({
      ok: true,
      backendTargetV2: backendTarget,
    })),
  } as unknown as ReturnType<typeof getSessionHostBridge>;
}

describe('createContinueWithReplayLifecycleActionHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.continueSessionWithReplay.mockResolvedValue({
      type: 'success',
      sessionId: 'child-session',
    });
  });

  it('accepts legacy agent-only replay params at the CLI ingress boundary', async () => {
    const sessionHostBridge = createBridge();
    const handler = createContinueWithReplayLifecycleActionHandler({
      sessionHostBridge,
      spawnSession: vi.fn(),
    });

    const result = await handler({
      directory: '/tmp/project',
      agent: 'claude',
      replay: { previousSessionId: 'sess-prev' },
    });

    expect(result).toEqual({ type: 'success', sessionId: 'child-session' });
    expect(sessionHostBridge.resolveContinueWithReplayBackendTarget).toHaveBeenCalledWith({
      backendTarget: {
        kind: 'backend',
        backendId: 'claude',
        sourceKind: 'built_in',
      },
    });
  });

  it('accepts canonical backendTarget-only replay params unchanged', async () => {
    const sessionHostBridge = createBridge();
    const handler = createContinueWithReplayLifecycleActionHandler({
      sessionHostBridge,
      spawnSession: vi.fn(),
    });

    const result = await handler({
      directory: '/tmp/project',
      backendTarget: {
        kind: 'backend',
        backendId: 'review-bot',
        configuredBackendId: 'review-bot',
        sourceKind: 'configured',
      },
      replay: { previousSessionId: 'sess-prev' },
    });

    expect(result).toEqual({ type: 'success', sessionId: 'child-session' });
    expect(sessionHostBridge.resolveContinueWithReplayBackendTarget).toHaveBeenCalledWith({
      backendTarget: {
        kind: 'backend',
        backendId: 'review-bot',
        configuredBackendId: 'review-bot',
        sourceKind: 'configured',
      },
    });
  });

  it('rejects mismatched legacy agent and backendTarget params before replay continues', async () => {
    const sessionHostBridge = createBridge();
    const handler = createContinueWithReplayLifecycleActionHandler({
      sessionHostBridge,
      spawnSession: vi.fn(),
    });

    const result = await handler({
      directory: '/tmp/project',
      agent: 'claude',
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
      replay: { previousSessionId: 'sess-prev' },
    });

    expect(result).toEqual({
      type: 'error',
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      errorMessage: 'Invalid params',
    });
    expect(sessionHostBridge.resolveContinueWithReplayBackendTarget).not.toHaveBeenCalled();
    expect(mocks.continueSessionWithReplay).not.toHaveBeenCalled();
  });
});
