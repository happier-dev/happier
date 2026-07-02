import type { PluginContextV1 } from '@happier-dev/plugin-sdk';
import type { InternalRuntimeTurnOperationsV1 } from '@happier-dev/plugin-sdk/internal/runtime/session';
import { describe, expect, it, vi } from 'vitest';

import { createCodexExecutionRunBackend } from './backend.js';

const createCodexAppServerRuntimeMock = vi.hoisted(() => vi.fn());

vi.mock('../runtime/appServer/runtime.js', () => ({
  createCodexAppServerRuntime: createCodexAppServerRuntimeMock,
}));

function createRuntimeOperations(): InternalRuntimeTurnOperationsV1 & Readonly<{
  probeTurnLiveness: () => Readonly<{
    active: boolean;
    lastActivityAtMs: number;
    diagnostics: Readonly<Record<string, unknown>>;
  }>;
}> {
  return {
    beginTurnLifecycle: vi.fn(),
    startOrLoadSession: vi.fn(async () => 'codex-thread-1'),
    sendTurnPrompt: vi.fn(async () => undefined),
    steerInFlightTurn: vi.fn(async () => undefined),
    waitForTurnCompletion: vi.fn(async () => undefined),
    subscribeRuntimeEvents: vi.fn(() => () => undefined),
    respondToPermission: vi.fn(async () => undefined),
    cancelTurn: vi.fn(async () => undefined),
    readSessionIdentity: vi.fn(() => ({ sessionId: 'codex-thread-1' })),
    updateSessionRuntimeConfig: vi.fn(async () => undefined),
    resetOrDisposeRuntime: vi.fn(async () => undefined),
    probeTurnLiveness: vi.fn(() => ({
      active: true,
      lastActivityAtMs: 123,
      diagnostics: {
        threadId: 'codex-thread-1',
      },
    })),
  };
}

describe('createCodexExecutionRunBackend', () => {
  it('adapts the app-server turn operations through the shared execution-run host backend', async () => {
    const operations = createRuntimeOperations();
    createCodexAppServerRuntimeMock.mockReturnValue(operations);
    const backend = createCodexExecutionRunBackend({
      ctx: {} as PluginContextV1,
      executionRunParams: {
        runId: 'run_codex_1',
        cwd: '/tmp/codex-run',
        env: {
          CODEX_THREAD_ID: 'poisoned',
        },
        isolation: {
          env: {
            PATH: '/tmp/bin',
          },
        },
      },
    });

    if (!('provisionSession' in backend)) {
      throw new Error('Expected Codex execution-run backend to expose host backend operations.');
    }

    await expect(backend.provisionSession({
      resumeSessionId: 'codex-thread-1',
      initialPrompt: 'inspect',
    })).resolves.toEqual({ sessionId: 'codex-thread-1' });
    await backend.sendSteerPrompt?.('codex-thread-1', 'follow-up');
    await backend.respondToPermission?.('permission-1', false);
    await expect(backend.probeTurnLiveness?.('codex-thread-1')).resolves.toMatchObject({
      active: true,
      diagnostics: {
        source: 'codex-app-server-runtime',
        threadId: 'codex-thread-1',
      },
    });
    await backend.dispose();

    expect(createCodexAppServerRuntimeMock).toHaveBeenCalledWith({
      ctx: {},
      directory: '/tmp/codex-run',
      happierSessionId: 'run_codex_1',
      processEnv: {
        CODEX_THREAD_ID: 'poisoned',
        PATH: '/tmp/bin',
      },
    });
    expect(operations.startOrLoadSession).toHaveBeenCalledWith({
      resumeId: 'codex-thread-1',
      importHistory: false,
    });
    expect(operations.sendTurnPrompt).toHaveBeenCalledWith('inspect');
    expect(operations.waitForTurnCompletion).toHaveBeenCalledWith({ timeoutMs: null });
    expect(operations.steerInFlightTurn).toHaveBeenCalledWith('follow-up');
    expect(operations.respondToPermission).toHaveBeenCalledWith('permission-1', false);
    expect(operations.resetOrDisposeRuntime).toHaveBeenCalledTimes(1);
  });
});
