import { describe, expect, it } from 'vitest';

import * as protocol from '../index.js';

type SchemaLike<T = unknown> = {
  parse(input: unknown): T;
  safeParse(input: unknown): { success: boolean; data?: T };
};

function schema<T = unknown>(name: string): SchemaLike<T> {
  const candidate = (protocol as Record<string, unknown>)[name] as SchemaLike<T> | undefined;
  expect(candidate, `${name} must be exported from protocol index`).toBeDefined();
  expect(candidate?.safeParse, `${name} must be a Zod-like schema`).toBeTypeOf('function');
  return candidate!;
}

describe('A.14 session protocol contracts', () => {
  it('parses provider-neutral subagent refs without exposing sidechain ref abstractions', () => {
    const subagentRef = schema('SubagentRefV1Schema');

    const parsed = subagentRef.parse({
      id: 'subagent-1',
      parentSessionId: 'session-1',
      origin: 'agent',
      kind: 'native',
      agentRef: {
        agentId: 'claude',
        agentKind: 'claude-task',
        providerExtra: 'kept',
      },
      status: 'running',
      createdAt: 1,
      transcript: {
        parentSessionId: 'session-1',
        sidechainId: 'sidechain-1',
      },
      futureField: 'kept',
    }) as Record<string, unknown>;

    expect(parsed).toMatchObject({
      id: 'subagent-1',
      origin: 'agent',
      kind: 'native',
      agentRef: {
        agentId: 'claude',
        agentKind: 'claude-task',
        providerExtra: 'kept',
      },
      transcript: {
        sidechainId: 'sidechain-1',
      },
      futureField: 'kept',
    });
    expect((protocol as Record<string, unknown>).SidechainRefV1Schema).toBeUndefined();
  });

  it('requires execution-run subagent refs to carry a run ref', () => {
    const subagentRef = schema('SubagentRefV1Schema');

    expect(() => subagentRef.parse({
      id: 'subagent-run-1',
      parentSessionId: 'session-1',
      origin: 'happier',
      kind: 'execution-run',
      status: 'running',
      createdAt: 1,
    })).toThrow();

    expect(subagentRef.parse({
      id: 'subagent-run-1',
      parentSessionId: 'session-1',
      origin: 'happier',
      kind: 'execution-run',
      status: 'running',
      createdAt: 1,
      runRef: { runId: 'run-1' },
    })).toMatchObject({
      kind: 'execution-run',
      runRef: { runId: 'run-1' },
    });
  });

  it('validates opaque spawn tool ids without rewriting their wire value', () => {
    const subagentRef = schema('SubagentRefV1Schema');

    expect(subagentRef.parse({
      id: 'subagent-native-1',
      parentSessionId: 'session-1',
      origin: 'agent',
      kind: 'native',
      status: 'completed',
      createdAt: 1,
      spawnRef: { toolCallId: ' exact tool id\n ' },
    })).toMatchObject({
      spawnRef: { toolCallId: ' exact tool id\n ' },
    });
  });

  it('parses runtime mode and runtime-mode set payloads without a local mode', () => {
    const runtimeMode = schema('SessionRuntimeModeV1Schema');
    const runtimeModeSetInput = schema('SessionRuntimeModeSetInputV1Schema');
    const runtimeModeSetResult = schema('SessionRuntimeModeSetResultV1Schema');

    expect(runtimeMode.safeParse('external').success).toBe(true);
    expect(runtimeMode.safeParse('terminal').success).toBe(true);
    expect(runtimeMode.safeParse('remote').success).toBe(true);
    expect(runtimeMode.safeParse('local').success).toBe(false);

    expect(runtimeModeSetInput.parse({
      sessionId: 'session-1',
      to: 'remote',
      reason: 'incoming_ui_message',
      futureField: 'kept',
    })).toMatchObject({
      sessionId: 'session-1',
      to: 'remote',
      reason: 'incoming_ui_message',
      futureField: 'kept',
    });

    expect(() => runtimeModeSetInput.parse({
      sessionId: 'session-1',
      to: 'external',
      reason: 'user_request',
    })).toThrow();

    expect(runtimeModeSetResult.parse({
      ok: false,
      code: 'pending_messages',
      message: 'needs confirmation',
      futureField: 'kept',
    })).toMatchObject({
      ok: false,
      code: 'pending_messages',
      futureField: 'kept',
    });
  });

  it('keeps takeover schemas while omitting the unreleased legacy translators', () => {
    const takeoverInput = schema('ExternalSessionTakeoverInputV1Schema');
    const takeoverResult = schema('ExternalSessionTakeoverResultV1Schema');
    expect((protocol as Record<string, unknown>)
      .mapExternalSessionsTakeoverToExternalSessionTakeoverInputV1).toBeUndefined();
    expect((protocol as Record<string, unknown>)
      .mapExternalSessionsTakeoverPersistToExternalSessionTakeoverInputV1).toBeUndefined();
    expect(takeoverInput.parse({
      linkedSessionId: 'session-1',
      targetRuntimeMode: 'terminal',
      storageMode: 'persisted',
    })).toEqual({
      linkedSessionId: 'session-1',
      targetRuntimeMode: 'terminal',
      storageMode: 'persisted',
    });

    expect(takeoverResult.parse({
      ok: true,
      sessionId: 'session-2',
      targetRuntimeMode: 'remote',
      storageMode: 'persisted',
      converted: true,
      futureField: 'kept',
    })).toMatchObject({
      ok: true,
      converted: true,
      futureField: 'kept',
    });
  });
});
