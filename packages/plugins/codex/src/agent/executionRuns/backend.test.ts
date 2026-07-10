import type {
  RuntimeEventV1,
  RuntimeSendOptionsV1,
  RuntimeSendResultV1,
  SessionRuntimeV1,
  PluginContextV1,
} from '@happier-dev/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';

import { createCodexExecutionRunBackend } from './backend.js';

const createCodexAppServerSessionRuntimeMock = vi.hoisted(() => vi.fn());

vi.mock('../runtime/appServer/session.js', () => ({
  createCodexAppServerSessionRuntime: createCodexAppServerSessionRuntimeMock,
}));

function accepted(): RuntimeSendResultV1 {
  return { status: 'accepted' };
}

function createRuntimeOperations(): SessionRuntimeV1 & Readonly<{
  probeTurnLiveness: () => Readonly<{
    active: boolean;
    lastActivityAtMs: number;
    diagnostics: Readonly<Record<string, unknown>>;
  }>;
  sentInputs: Array<Readonly<{ text: string; options?: RuntimeSendOptionsV1 }>>;
}> {
  let providerSessionId: string | null = 'codex-thread-1';
  const runtimeHandlers = new Set<(event: RuntimeEventV1) => void>();
  const sentInputs: Array<Readonly<{ text: string; options?: RuntimeSendOptionsV1 }>> = [];
  const emitRuntimeEvent = (event: RuntimeEventV1): void => {
    for (const handler of runtimeHandlers) handler(event);
  };
  return {
    identity: {
      read: vi.fn(() => ({ providerSessionId })),
    },
    events: {
      subscribe: vi.fn((handler) => {
        runtimeHandlers.add(handler);
        return () => {
          runtimeHandlers.delete(handler);
        };
      }),
    },
    send: vi.fn(async (input, options) => {
      sentInputs.push({ text: input.text, ...(options ? { options } : {}) });
      providerSessionId = 'codex-thread-1';
      if (options?.deliverAs !== 'steer') {
        emitRuntimeEvent({
          kind: 'turn-start',
          sessionId: 'codex-thread-1',
          emittedAtMs: Date.now(),
          turnId: 'codex-turn-1',
          startedBy: 'user',
        });
        emitRuntimeEvent({
          kind: 'turn-complete',
          sessionId: 'codex-thread-1',
          emittedAtMs: Date.now(),
          turnId: 'codex-turn-1',
        });
      }
      return accepted();
    }),
    cancel: vi.fn(async () => ({ status: 'cancelled' })),
    permissions: { capability: 'inline' },
    updateSessionRuntimeConfig: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    probeTurnLiveness: vi.fn(() => ({
      active: true,
      lastActivityAtMs: 123,
      diagnostics: {
        threadId: 'codex-thread-1',
      },
    })),
    sentInputs,
  };
}

describe('createCodexExecutionRunBackend', () => {
  it('adapts the app-server turn operations through the shared execution-run host backend', async () => {
    const operations = createRuntimeOperations();
    createCodexAppServerSessionRuntimeMock.mockResolvedValue(operations);
    const ctx = {
      env: {
        list: () => ({ OPENAI_API_KEY: 'ambient-native-key' }),
      },
    } as PluginContextV1;
    const backend = createCodexExecutionRunBackend({
      ctx,
      executionRunParams: {
        runId: 'run_codex_1',
        cwd: '/tmp/codex-run',
        modelId: 'gpt-5-codex-test',
        env: {
          CODEX_THREAD_ID: 'poisoned',
        },
        isolation: {
          env: {
            PATH: '/tmp/bin',
          },
          unsetEnvKeys: ['openai_api_key'],
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
    expect(backend.permissionCapability).toBe('inline');
    await expect(backend.respondToPermission?.('permission-1', false)).resolves.toEqual({
      delivered: false,
      reason: 'unknown_request',
    });
    await expect(backend.probeTurnLiveness?.('codex-thread-1')).resolves.toMatchObject({
      active: true,
      diagnostics: {
        source: 'codex-app-server-runtime',
        threadId: 'codex-thread-1',
      },
    });
    await backend.dispose();

    expect(createCodexAppServerSessionRuntimeMock).toHaveBeenCalledWith({
      ctx,
      sessionParams: {
        backendId: 'codex',
        cwd: '/tmp/codex-run',
        directory: '/tmp/codex-run',
        sessionId: 'run_codex_1',
        modelId: 'gpt-5-codex-test',
        env: {
          CODEX_THREAD_ID: 'poisoned',
          PATH: '/tmp/bin',
        },
        initialRuntimeState: {
          providerSessionId: 'codex-thread-1',
        },
      },
    });
    expect(operations.sentInputs).toEqual([
      { text: 'inspect' },
      { text: 'follow-up', options: { deliverAs: 'steer' } },
    ]);
    expect(operations.dispose).toHaveBeenCalledTimes(1);
  });
});
