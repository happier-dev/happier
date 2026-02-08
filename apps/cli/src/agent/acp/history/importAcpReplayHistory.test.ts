import { describe, it, expect } from 'vitest';

import { importAcpReplayHistoryV1 } from './importAcpReplayHistory';
import type { AcpReplayHistorySessionClient } from '@/agent/acp/sessionClient';
import type { Metadata } from '@/api/types';

function createFakeSession(params?: {
  existing?: Array<{ role: 'user' | 'agent'; text: string }>;
  onAgentCommitted?: (body: unknown) => void;
}) {
  const calls = {
    fetch: 0,
    sendUser: 0,
    sendAgent: 0,
    updateMetadata: 0,
    agentCommitted: [] as any[],
  };

  const baseMetadata: Metadata = {
    path: '/tmp',
    host: 'host',
    homeDir: '/home',
    happyHomeDir: '/happy',
    happyLibDir: '/lib',
    happyToolsDir: '/tools',
  };
  let metadata = baseMetadata;

  const session: AcpReplayHistorySessionClient = {
    async fetchRecentTranscriptTextItemsForAcpImport() {
      calls.fetch += 1;
      return params?.existing ?? [];
    },
    async sendUserTextMessageCommitted(_text: string) {
      calls.sendUser += 1;
    },
    async sendAgentMessageCommitted(_provider, body, _opts) {
      calls.sendAgent += 1;
      calls.agentCommitted.push(body);
      params?.onAgentCommitted?.(body);
    },
    updateMetadata(fn) {
      calls.updateMetadata += 1;
      metadata = fn(metadata);
    },
  };

  return { session, calls };
}

describe('importAcpReplayHistoryV1', () => {
  it('fails closed when remoteSessionId contains path separators', async () => {
    const { session, calls } = createFakeSession();

    await importAcpReplayHistoryV1({
      session,
      provider: 'claude',
      remoteSessionId: 'foo/bar',
      replay: [
        { type: 'message', role: 'user', text: 'hi' },
        { type: 'message', role: 'agent', text: 'hello' },
      ] as any,
      permissionHandler: {
        handleToolCall: () => {
          throw new Error('permission handler should not be called for invalid ids');
        },
      } as any,
    });

    expect(calls.fetch).toBe(0);
    expect(calls.sendUser).toBe(0);
    expect(calls.sendAgent).toBe(0);
    expect(calls.updateMetadata).toBe(0);
  });

  it('imports new messages for valid remoteSessionId', async () => {
    const { session, calls } = createFakeSession();

    await importAcpReplayHistoryV1({
      session,
      provider: 'claude',
      remoteSessionId: 'session-123',
      replay: [
        { type: 'message', role: 'user', text: 'hi' },
        { type: 'message', role: 'agent', text: 'hello' },
      ] as any,
      permissionHandler: {
        handleToolCall: () => {
          throw new Error('permission handler should not be called when overlap is unambiguous');
        },
      } as any,
    });

    expect(calls.fetch).toBe(1);
    expect(calls.sendUser).toBe(1);
    expect(calls.sendAgent).toBe(1);
    expect(calls.updateMetadata).toBe(1);
  });

  it('treats cancelled tool results as errors when importing full replay', async () => {
    let resolveToolResult: (() => void) | null = null;
    const toolResultCommitted = new Promise<void>((resolve) => {
      resolveToolResult = resolve;
    });
    const { session, calls } = createFakeSession({
      existing: [{ role: 'user', text: 'local message' }],
      onAgentCommitted: (body) => {
        if ((body as { type?: unknown })?.type === 'tool-result') {
          resolveToolResult?.();
        }
      },
    });

    await importAcpReplayHistoryV1({
      session,
      provider: 'claude',
      remoteSessionId: 'session-123',
      replay: [
        { type: 'message', role: 'user', text: 'remote message' },
        { type: 'tool_result', toolCallId: 't1', status: 'cancelled', rawOutput: { ok: false } },
      ] as any,
      permissionHandler: {
        handleToolCall: async () => ({ decision: 'approved' }),
      } as any,
    });

    await toolResultCommitted;
    const toolResult = calls.agentCommitted.find((b) => b?.type === 'tool-result');
    expect(toolResult?.isError).toBe(true);
  });

  it('handles circular tool_call input when importing full replay', async () => {
    let resolveToolCall: (() => void) | null = null;
    const toolCallCommitted = new Promise<void>((resolve) => {
      resolveToolCall = resolve;
    });
    const { session, calls } = createFakeSession({
      existing: [{ role: 'user', text: 'local message' }],
      onAgentCommitted: (body) => {
        if ((body as { type?: unknown })?.type === 'tool-call') {
          resolveToolCall?.();
        }
      },
    });

    const circularInput: Record<string, unknown> = { value: 1 };
    circularInput.self = circularInput;

    await expect(
      importAcpReplayHistoryV1({
        session,
        provider: 'claude',
        remoteSessionId: 'session-123',
        replay: [
          { type: 'message', role: 'user', text: 'remote message' },
          { type: 'tool_call', toolCallId: 'tc-1', kind: 'writeTextFile', rawInput: circularInput },
        ] as any,
        permissionHandler: {
          handleToolCall: async () => ({ decision: 'approved' }),
        } as any,
      }),
    ).resolves.toBeUndefined();

    await expect(
      Promise.race([
        toolCallCommitted,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('timed out waiting for imported tool_call')), 200),
        ),
      ]),
    ).resolves.toBeUndefined();

    const toolCall = calls.agentCommitted.find((body) => body?.type === 'tool-call');
    expect(toolCall).toBeTruthy();
  });
});
