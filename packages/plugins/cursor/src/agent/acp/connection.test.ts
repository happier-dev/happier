import { describe, expect, it, vi } from 'vitest';

import type {
  AcpRuntimeHandleV1,
  AcpSessionStartParamsV1,
  AcpSessionRuntimeV1,
  PluginContextV1,
} from '@happier-dev/plugin-sdk';

import { createCursorAcpRuntimeConnection } from './connection.js';

function createSessionRuntimeFixture() {
  const startOrLoadSession = vi.fn(async (input?: AcpSessionStartParamsV1) => (
    input?.providerSessionId ?? 'cursor-provider-created'
  ));
  const sessionRuntime: AcpSessionRuntimeV1 = {
    startOrLoadSession,
    beginTurnLifecycle: vi.fn(),
    sendTurnPrompt: vi.fn(async () => undefined),
    waitForTurnCompletion: vi.fn(async () => undefined),
    subscribeRuntimeEvents: vi.fn(() => () => undefined),
    cancelTurn: vi.fn(async () => undefined),
    updateSessionRuntimeConfig: vi.fn(async () => undefined),
  };
  const handle: AcpRuntimeHandleV1 = {
    sessionRuntime,
    dispose: vi.fn(async () => undefined),
  };
  const ctx = {
    env: {
      get: vi.fn(() => undefined),
      list: vi.fn(() => ({})),
    },
    config: {
      values: {},
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    agentRuntime: {
      acp: {
        createRuntime: vi.fn(async () => handle),
      },
    },
    sessions: {
      current: {
        permissions: {
          requestDecision: vi.fn(async () => ({ decision: 'approved' })),
          getMode: vi.fn(() => 'default'),
        },
        writeMetadata: vi.fn(async () => undefined),
      },
    },
  } as unknown as PluginContextV1;
  return { ctx, startOrLoadSession };
}

describe('createCursorAcpRuntimeConnection', () => {
  it('does not treat generic Happier session ids as Cursor provider session ids', async () => {
    const { ctx, startOrLoadSession } = createSessionRuntimeFixture();
    const runtime = await createCursorAcpRuntimeConnection({
      ctx,
      sessionParams: {
        backendId: 'cursor',
        sessionId: 'happier-session-from-launch',
        cwd: '/repo',
        initialRuntimeState: {
          sessionId: 'happier-session-from-state',
        },
      },
    });

    await runtime.send({ v: 1, text: 'hello cursor' });

    expect(startOrLoadSession).toHaveBeenCalledWith({ mcpServers: [] });
  });
});
