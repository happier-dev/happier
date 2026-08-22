import { describe, it, expect } from 'vitest';

import { importAcpReplayHistoryV1 } from '../importAcpReplayHistory';
import type { AcpReplayHistorySessionClient } from '@/agent/acp/sessionClient';
import type { TranscriptSessionPort } from '@/api/session/transcriptPort';
import type { Metadata } from '@/api/types';
import { CHANGE_TITLE_INSTRUCTION } from '@/agent/runtime/changeTitleInstruction';

function createFakeSession(params?: {
  existing?: Array<{ role: 'user' | 'agent'; text: string }>;
  onAgentCommitted?: (body: unknown) => void;
  userAdmission?: () => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
  agentAdmission?: (
    body: unknown,
    opts: Parameters<NonNullable<TranscriptSessionPort['enqueueAgentMessageCommitted']>>[2],
  ) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
}) {
  const calls = {
    fetch: 0,
    sendUser: 0,
    enqueueAgent: 0,
    updateMetadata: 0,
    agentCommitted: [] as any[],
    agentAdmissionOptions: [] as Array<Parameters<NonNullable<TranscriptSessionPort['enqueueAgentMessageCommitted']>>[2]>,
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
    async enqueueUserTextMessageCommitted(_text, _opts) {
      calls.sendUser += 1;
      return await params?.userAdmission?.() ?? { persisted: true, delivered: false };
    },
    async enqueueAgentMessageCommitted(_provider, body, opts) {
      calls.enqueueAgent += 1;
      calls.agentCommitted.push(body);
      calls.agentAdmissionOptions.push(opts);
      params?.onAgentCommitted?.(body);
      return await params?.agentAdmission?.(body, opts) ?? { persisted: true, delivered: false };
    },
    updateMetadata(fn) {
      calls.updateMetadata += 1;
      metadata = fn(metadata);
    },
  };

  return { session, calls };
}

describe('importAcpReplayHistoryV1', () => {
  it('does not prompt when the only divergence is the internal change-title instruction suffix', async () => {
    const { session, calls } = createFakeSession({
      existing: [
        { role: 'user', text: 'hi' },
        { role: 'agent', text: 'hello' },
      ],
    });

    await importAcpReplayHistoryV1({
      session,
      provider: 'opencode',
      remoteSessionId: 'session-123',
      replay: [
        { type: 'message', role: 'user', text: `hi\n\n${CHANGE_TITLE_INSTRUCTION}` },
        { type: 'message', role: 'agent', text: 'hello' },
      ] as any,
      permissionHandler: {
        handleToolCall: () => {
          throw new Error('permission handler should not be called for change-title divergence');
        },
      } as any,
    });

    expect(calls.fetch).toBe(1);
    expect(calls.sendUser).toBe(0);
    expect(calls.enqueueAgent).toBe(0);
    expect(calls.updateMetadata).toBe(0);
  });

  it('treats earlier change-title instruction text as part of the visible transcript', async () => {
    let permissionPrompted = false;
    const { session, calls } = createFakeSession({
      existing: [
        { role: 'user', text: `Please quote ${CHANGE_TITLE_INSTRUCTION} and say alpha` },
        { role: 'agent', text: 'hello' },
      ],
    });

    await importAcpReplayHistoryV1({
      session,
      provider: 'opencode',
      remoteSessionId: 'session-123',
      replay: [
        {
          type: 'message',
          role: 'user',
          text: `Please quote ${CHANGE_TITLE_INSTRUCTION} and say beta\n\n${CHANGE_TITLE_INSTRUCTION}`,
        },
        { type: 'message', role: 'agent', text: 'hello' },
      ] as any,
      permissionHandler: {
        handleToolCall: async () => {
          permissionPrompted = true;
          return { decision: 'denied' };
        },
      } as any,
    });

    expect(calls.fetch).toBe(1);
    expect(permissionPrompted).toBe(true);
    expect(calls.sendUser).toBe(0);
    expect(calls.enqueueAgent).toBe(0);
    expect(calls.updateMetadata).toBe(0);
  });

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
    expect(calls.enqueueAgent).toBe(0);
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
    expect(calls.enqueueAgent).toBe(1);
    expect(calls.updateMetadata).toBe(1);
  });

  it('durably admits replayed agent rows in order with stable history provenance and local ids', async () => {
    const { session, calls } = createFakeSession();
    const input = {
      session,
      provider: 'claude' as const,
      remoteSessionId: 'session-123',
      replay: [
        { type: 'message', role: 'agent', text: 'first' },
        { type: 'message', role: 'agent', text: 'second' },
      ],
      permissionHandler: {
        handleToolCall: () => {
          throw new Error('permission handler should not be called when overlap is unambiguous');
        },
      } as any,
    };

    await importAcpReplayHistoryV1(input);
    const firstRunOptions = calls.agentAdmissionOptions.map((opts) => ({ ...opts }));
    await importAcpReplayHistoryV1(input);

    expect(calls.agentCommitted).toEqual([
      { type: 'message', message: 'first' },
      { type: 'message', message: 'second' },
      { type: 'message', message: 'first' },
      { type: 'message', message: 'second' },
    ]);
    expect(firstRunOptions).toHaveLength(2);
    expect(calls.agentAdmissionOptions.slice(2)).toEqual(firstRunOptions);
    expect(firstRunOptions).toEqual([
      expect.objectContaining({
        localId: expect.stringMatching(/^acp-import:v1:claude:session-123:0:/),
        meta: { importedFrom: 'acp-history', remoteSessionId: 'session-123' },
        provenance: { kind: 'non_dependent', source: 'history' },
      }),
      expect.objectContaining({
        localId: expect.stringMatching(/^acp-import:v1:claude:session-123:1:/),
        meta: { importedFrom: 'acp-history', remoteSessionId: 'session-123' },
        provenance: { kind: 'non_dependent', source: 'history' },
      }),
    ]);
  });

  it('fails and stops before watermarking when durable custody rejects a replayed agent row', async () => {
    const { session, calls } = createFakeSession({
      agentAdmission: async () => ({ persisted: false, delivered: false }),
    });

    await expect(importAcpReplayHistoryV1({
      session,
      provider: 'claude',
      remoteSessionId: 'session-123',
      replay: [
        { type: 'message', role: 'agent', text: 'first' },
        { type: 'message', role: 'agent', text: 'must not be admitted' },
      ],
      permissionHandler: {
        handleToolCall: () => {
          throw new Error('permission handler should not be called when overlap is unambiguous');
        },
      } as any,
    })).rejects.toThrow(/durable custody/i);

    expect(calls.enqueueAgent).toBe(1);
    expect(calls.updateMetadata).toBe(0);
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

  it('imports think tool_call events as thinking messages (skips tool_result)', async () => {
    let resolveThinking: (() => void) | null = null;
    const thinkingCommitted = new Promise<void>((resolve) => {
      resolveThinking = resolve;
    });

    const { session, calls } = createFakeSession({
      existing: [{ role: 'user', text: 'local message' }],
      onAgentCommitted: (body) => {
        if ((body as { type?: unknown })?.type === 'thinking') {
          resolveThinking?.();
        }
      },
    });

    await importAcpReplayHistoryV1({
      session,
      provider: 'opencode',
      remoteSessionId: 'session-123',
      replay: [
        { type: 'message', role: 'agent', text: 'hello' },
        { type: 'tool_call', toolCallId: 't1', kind: 'think', rawInput: { thinking: 'Hello' } },
        { type: 'tool_result', toolCallId: 't1', status: 'success', rawOutput: { ok: true } },
      ] as any,
      permissionHandler: {
        handleToolCall: async () => ({ decision: 'approved' }),
      } as any,
    });

    await thinkingCommitted;
    expect(calls.enqueueAgent).toBe(2);
    expect(calls.agentCommitted).toEqual([
      { type: 'message', message: 'hello' },
      { type: 'thinking', text: 'Hello' },
    ]);
  });

  it('does not advance history import when durable user custody is rejected', async () => {
    const { session, calls } = createFakeSession({
      userAdmission: async () => ({ persisted: false, delivered: false }),
    });

    await expect(importAcpReplayHistoryV1({
      session,
      provider: 'opencode',
      remoteSessionId: 'session-123',
      replay: [{ type: 'message', role: 'user', text: 'history prompt' }] as any,
      permissionHandler: { handleToolCall: async () => ({ decision: 'approved' }) } as any,
    })).rejects.toThrow('durable transcript custody');

    expect(calls.sendUser).toBe(1);
    expect(calls.updateMetadata).toBe(0);
  });
});
