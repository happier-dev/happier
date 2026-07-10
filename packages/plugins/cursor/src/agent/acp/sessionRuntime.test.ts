import { buildSessionRuntimeIssueV1 } from '@happier-dev/plugin-sdk/experimental/runtime/session';
import type {
  AcpRuntimeHandleV1,
  AcpSessionRuntimeV1,
  RuntimeEventV1,
} from '@happier-dev/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';

import { createCursorPublicSessionRuntime } from './sessionRuntime.js';

type RuntimeEventHandler = (event: RuntimeEventV1) => void;

function createRuntimeFixture(params?: Readonly<{
  sendTurnPrompt?: AcpSessionRuntimeV1['sendTurnPrompt'];
}>) {
  let runtimeEventHandler: RuntimeEventHandler | null = null;
  const emitRuntimeEvent = (event: RuntimeEventV1): void => {
    runtimeEventHandler?.(event);
  };
  const sessionRuntime: AcpSessionRuntimeV1 = {
    beginTurnLifecycle: vi.fn(),
    startOrLoadSession: vi.fn(async () => 'cursor-provider-session-1'),
    sendTurnPrompt: vi.fn(params?.sendTurnPrompt ?? (async () => undefined)),
    steerInFlightTurn: vi.fn(async () => undefined),
    waitForTurnCompletion: vi.fn(async () => undefined),
    subscribeRuntimeEvents: vi.fn((handler) => {
      runtimeEventHandler = handler;
      return () => {
        if (runtimeEventHandler === handler) runtimeEventHandler = null;
      };
    }),
    cancelTurn: vi.fn(async () => undefined),
    updateSessionRuntimeConfig: vi.fn(async () => undefined),
  };
  const handle: AcpRuntimeHandleV1 = {
    sessionRuntime,
    dispose: vi.fn(async () => undefined),
  };
  const runtime = createCursorPublicSessionRuntime({
    createHandle: async () => handle,
    initialProviderSessionId: null,
  });
  return {
    emitRuntimeEvent,
    runtime,
    sessionRuntime,
  };
}

function buildTerminalEvent(kind: 'turn-failed' | 'turn-cancelled'): RuntimeEventV1 {
  const base = {
    sessionId: 'happier-session-1',
    emittedAtMs: 1,
    turnId: 'cursor-turn-1',
    agentTurnId: 'cursor-provider-turn-1',
  };
  if (kind === 'turn-cancelled') {
    return {
      ...base,
      kind,
      reason: 'provider_cancelled_before_acceptance',
    };
  }
  return {
    ...base,
    kind,
    issue: buildSessionRuntimeIssueV1({
      code: 'cursor_prompt_rejected_before_acceptance',
      source: 'agent_session_error',
      provider: 'cursor',
      agentTurnId: 'cursor-provider-turn-1',
      occurredAt: 1,
    }),
  };
}

describe('createCursorPublicSessionRuntime', () => {
  it.each([
    ['failed', 'turn-failed'],
    ['cancelled', 'turn-cancelled'],
  ] as const)(
    'terminally rejects a prompt when Cursor emits %s before positive provider evidence',
    async (_label, kind) => {
      let emitRuntimeEvent: ((event: RuntimeEventV1) => void) | null = null;
      const fixture = createRuntimeFixture({
        sendTurnPrompt: async () => {
          emitRuntimeEvent?.(buildTerminalEvent(kind));
        },
      });
      emitRuntimeEvent = fixture.emitRuntimeEvent;
      const accepted = vi.fn();
      const terminallyRejected = vi.fn();
      fixture.runtime.setOnPromptAcceptedByProvider?.(accepted);
      fixture.runtime.setOnPromptTerminallyRejectedBeforeProvider?.(terminallyRejected);

      await expect(fixture.runtime.send({ v: 1, text: 'hello Cursor' }, {
        localInputId: 'local-input-1',
        userMessageSeq: 7,
      })).resolves.toEqual({ status: 'accepted' });

      expect(accepted).not.toHaveBeenCalled();
      expect(terminallyRejected).toHaveBeenCalledWith({
        localInputId: 'local-input-1',
        localInputIds: ['local-input-1'],
        userMessageSeq: 7,
        userMessageSeqs: [7],
      });
      expect(terminallyRejected).toHaveBeenCalledTimes(1);
    },
  );
});
