import { describe, it, expect } from 'vitest';

import { importAcpReplayHistoryV1 } from '../importAcpReplayHistory';
import type { AcpReplayHistorySessionClient } from '@/agent/acp/sessionClient';
import type { TranscriptSessionPort } from '@/api/session/transcriptPort';
import type { Metadata } from '@/api/types';
import { CHANGE_TITLE_INSTRUCTION } from '@/agent/runtime/changeTitleInstruction';
import { AcpReplayCapture } from '../acpReplayCapture';
import { vi } from 'vitest';

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
  it.each([false, true])('imports tool/media tails immediately after an existing text overlap (new reply: %s)', async reply => {
    const { session, calls } = createFakeSession({ existing: [{ role: 'user', text: 'inspect' }] });
    const sendAgentSessionMediaCommitted = vi.fn(async () => {});
    const capture = new AcpReplayCapture();
    capture.handleUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'inspect' } });
    capture.handleUpdate({ sessionUpdate: 'tool_call', toolCallId: 'read-image', title: 'Read image', kind: 'read', rawInput: {} });
    capture.handleUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'read-image', status: 'completed', content: [
      { type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' } },
    ] });
    if (reply) capture.handleUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } });
    await importAcpReplayHistoryV1({ session: { ...session, sendAgentSessionMediaCommitted }, provider: 'opencode', remoteSessionId: 'tail-images',
      replay: capture.finalize(), permissionHandler: { handleToolCall: () => { throw new Error('No divergence'); } } as never });
    expect(calls.sendUser).toBe(0);
    expect(calls.agentCommitted).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool-call', callId: 'read-image' }),
      expect.objectContaining({ type: 'tool-result', callId: 'read-image' }),
    ]));
    expect(sendAgentSessionMediaCommitted).toHaveBeenCalledTimes(1);
    expect(sendAgentSessionMediaCommitted).toHaveBeenCalledWith('opencode', expect.objectContaining({ category: 'tool-artifact' }));
  });

  it.each([true, false])('keeps standard tool images out of the text result with a user turn: %s', async includeUser => {
    const { session, calls } = createFakeSession();
    const sendAgentSessionMediaCommitted = vi.fn(async () => {});
    const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP0cAAAAASUVORK5CYII=';
    const capture = new AcpReplayCapture();
    if (includeUser) capture.handleUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'inspect' } });
    capture.handleUpdate({ sessionUpdate: 'tool_call', toolCallId: 'read-image', title: 'Read image', kind: 'read', rawInput: {} });
    capture.handleUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'read-image', status: 'completed', content: [
      { type: 'content', content: { type: 'text', text: 'image result' } },
      { type: 'content', content: { type: 'image', mimeType: 'image/png', data } },
    ] });
    await importAcpReplayHistoryV1({ session: { ...session, sendAgentSessionMediaCommitted }, provider: 'opencode', remoteSessionId: 'tool-images',
      replay: capture.finalize(), permissionHandler: { handleToolCall: () => { throw new Error('No divergence'); } } as never });
    expect(JSON.stringify(calls.agentCommitted)).not.toContain(data);
    expect(JSON.stringify(calls.agentCommitted)).toContain('image result');
    expect(sendAgentSessionMediaCommitted).toHaveBeenCalledWith('opencode', expect.objectContaining({
      category: 'tool-artifact', media: [expect.objectContaining({ source: { kind: 'base64', data, mimeType: 'image/png' },
        origin: { source: 'tool-output', toolCallId: 'read-image' } })],
    }));
  });

  it('preserves unavailable resource images explicitly with partial item coverage', async () => {
    const { session } = createFakeSession();
    const sendAgentSessionMediaCommitted = vi.fn(async () => {});
    await importAcpReplayHistoryV1({ session: { ...session, sendAgentSessionMediaCommitted }, provider: 'opencode', remoteSessionId: 'missing-images',
      replay: [{ type: 'message', role: 'user', text: '', content: [{ type: 'resource_link', mimeType: 'image/png', uri: 'https://example.com/image.png' }] }],
      permissionHandler: { handleToolCall: () => { throw new Error('No divergence'); } } as never });
    expect(sendAgentSessionMediaCommitted).toHaveBeenCalledWith('opencode', expect.objectContaining({
      role: 'input', media: [], failures: [expect.objectContaining({ code: 'http_uri_unavailable' })],
      messageText: expect.stringMatching(/image unavailable/i), meta: expect.objectContaining({ importedHistoryCoverage: 'partial' }),
    }));
  });

  it('imports captured image-only and mixed user history through Session media custody', async () => {
    const { session, calls } = createFakeSession();
    const sendAgentSessionMediaCommitted = vi.fn(async () => {});
    const capture = new AcpReplayCapture();
    const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP0cAAAAASUVORK5CYII=';
    capture.handleUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'image', mimeType: 'image/png', data } });
    capture.handleUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'first reply' } });
    capture.handleUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'inspect' } });
    capture.handleUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'image', mimeType: 'image/png', data } });
    await importAcpReplayHistoryV1({ session: { ...session, sendAgentSessionMediaCommitted }, provider: 'opencode', remoteSessionId: 'image-history',
      replay: capture.finalize(), permissionHandler: { handleToolCall: () => { throw new Error('No divergence'); } } as never });
    expect(sendAgentSessionMediaCommitted.mock.calls).toEqual([
      ['opencode', expect.objectContaining({ role: 'input', category: 'attachment', messageText: '', media: [expect.objectContaining({ source: { kind: 'base64', data, mimeType: 'image/png' } })] })],
      ['opencode', expect.objectContaining({ role: 'input', category: 'attachment', messageText: 'inspect' })],
    ]);
    expect(calls.sendUser).toBe(0);
    expect(calls.enqueueAgent).toBe(1);
  });

  it('does not prompt when Gemini replay includes the exact predecessor title suffix', async () => {
    // Captured from ../0.2 HEAD 37a6541578749067b49d4579be8c752c9591b8c8; independent of the current live producer.
    const legacySuffix = `Before you respond, call the change-title tool once to set (or update) a short, descriptive session title based on the user's message.

The tool may be exposed under different names depending on the provider. Prefer "mcp__happier__change_title" when available; otherwise use an equivalent alias (for example: change_title, session_title_set, change-title).

Never violate the user's explicit constraints on tool usage (for example: "exactly one tool call" or "do not use any other tools"). If the user has constrained tool usage for this turn, skip calling the change-title tool.

Call this tool again if the task changes significantly.`;
    const { session, calls } = createFakeSession({
      existing: [
        { role: 'user', text: 'hi' },
        { role: 'agent', text: 'hello' },
      ],
    });

    await importAcpReplayHistoryV1({
      session,
      provider: 'gemini',
      remoteSessionId: 'session-123',
      replay: [
        { type: 'message', role: 'user', text: `hi\n\n${legacySuffix}` },
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
