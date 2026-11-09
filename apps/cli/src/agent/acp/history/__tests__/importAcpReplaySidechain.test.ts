import { describe, expect, it, vi } from 'vitest';

import { importAcpReplaySidechainV1 } from '../importAcpReplaySidechain';
import type { AcpReplaySidechainSessionClient } from '@/agent/acp/sessionClient';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import type { TranscriptSessionPort } from '@/api/session/transcriptPort';
import { logger } from '@/utils/logger';

function createFakeSession(params?: Readonly<{
  admission?: (
    body: ACPMessageData,
    opts: Parameters<NonNullable<TranscriptSessionPort['enqueueAgentMessageCommitted']>>[2],
  ) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
}>) {
  const committed: Array<{
    provider: string;
    body: ACPMessageData;
    localId: string;
    opts: Parameters<NonNullable<TranscriptSessionPort['enqueueAgentMessageCommitted']>>[2];
  }> = [];
  const session: AcpReplaySidechainSessionClient = {
    async enqueueAgentMessageCommitted(provider, body, opts) {
      committed.push({ provider, body, localId: opts.localId, opts });
      return await params?.admission?.(body, opts) ?? { persisted: true, delivered: false };
    },
  };
  return { session, committed };
}

describe('importAcpReplaySidechainV1', () => {
  it('imports the complete sidechain including a terminal tool result beyond the former event cap', async () => {
    const { session, committed } = createFakeSession();
    const messages = Array.from({ length: 1_000 }, (_, index) => ({ type: 'message', role: 'agent', text: `row-${index}` }));
    await importAcpReplaySidechainV1({
      session, provider: 'opencode', remoteSessionId: 'native-long', sidechainId: 'task-long',
      replay: [...messages,
        { type: 'tool_call', toolCallId: 'tail', kind: 'execute', rawInput: { command: 'build' } },
        { type: 'tool_result', toolCallId: 'tail', status: 'success', rawOutput: { stdout: 'built' } },
      ],
    });
    expect(committed).toHaveLength(messages.length + 2);
    expect(committed.at(-1)?.body).toMatchObject({ type: 'tool-result', callId: 'sc:task-long:tail', sidechainId: 'task-long' });
    expect(new Set(committed.map(row => row.localId)).size).toBe(committed.length);
  });

  it('uses Session media custody for an image-only agent message while preserving the sidechain', async () => {
    const { session, committed } = createFakeSession();
    const sendAgentSessionMediaCommitted = vi.fn(async () => {});
    await importAcpReplaySidechainV1({ session: { ...session, sendAgentSessionMediaCommitted }, provider: 'opencode',
      remoteSessionId: 'native-1', sidechainId: 'task-1', replay: [{ type: 'message', role: 'agent', text: '', content: [
        { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' },
      ] }] });
    expect(committed).toEqual([]);
    expect(sendAgentSessionMediaCommitted).toHaveBeenCalledWith('opencode', expect.objectContaining({
      role: 'output', sidechainId: 'task-1', provenanceSource: 'sidechain', media: [expect.anything()],
    }));
  });

  it('imports agent messages and tool events with sidechainId, namespacing tool call ids to avoid collisions', async () => {
    const { session, committed } = createFakeSession();
    const opaqueToolCallId = ' \tcall/工具+=\n ';
    const distinctToolCallId = opaqueToolCallId.trim();

    await importAcpReplaySidechainV1({
      session,
      provider: 'opencode',
      remoteSessionId: 'ses_123',
      sidechainId: 'tool_task_1',
      replay: [
        { type: 'message', role: 'user', text: 'ignored user prompt' },
        { type: 'message', role: 'agent', text: 'hello' },
        { type: 'tool_call', toolCallId: opaqueToolCallId, kind: 'execute', rawInput: { command: 'echo hi' } },
        { type: 'tool_result', toolCallId: opaqueToolCallId, status: 'success', rawOutput: { stdout: 'hi' } },
        { type: 'tool_call', toolCallId: distinctToolCallId, kind: 'execute', rawInput: { command: 'echo again' } },
        { type: 'tool_result', toolCallId: distinctToolCallId, status: 'success', rawOutput: { stdout: 'again' } },
      ],
    });

    expect(committed.length).toBe(5);
    expect(committed[0].provider).toBe('opencode');
    expect(committed[0].body.sidechainId).toBe('tool_task_1');
    expect(committed[0].body.type).toBe('message');

    expect(committed[1].body.type).toBe('tool-call');
    expect(committed[1].body.sidechainId).toBe('tool_task_1');
    if (committed[1].body.type !== 'tool-call') throw new Error('expected tool-call');
    expect(committed[1].body.callId).toBe(`sc:tool_task_1:${opaqueToolCallId}`);

    expect(committed[2].body.type).toBe('tool-result');
    expect(committed[2].body.sidechainId).toBe('tool_task_1');
    if (committed[2].body.type !== 'tool-result') throw new Error('expected tool-result');
    expect(committed[2].body.callId).toBe(`sc:tool_task_1:${opaqueToolCallId}`);
    expect(committed.slice(1).map(({ body }) =>
      body.type === 'tool-call' || body.type === 'tool-result' ? body.callId : null)).toEqual([
      `sc:tool_task_1:${opaqueToolCallId}`,
      `sc:tool_task_1:${opaqueToolCallId}`,
      `sc:tool_task_1:${distinctToolCallId}`,
      `sc:tool_task_1:${distinctToolCallId}`,
    ]);
    expect(committed.map((entry) => entry.opts.provenance)).toEqual([
      { kind: 'non_dependent', source: 'sidechain' },
      { kind: 'non_dependent', source: 'sidechain' },
      { kind: 'non_dependent', source: 'sidechain' },
      { kind: 'non_dependent', source: 'sidechain' },
      { kind: 'non_dependent', source: 'sidechain' },
    ]);
  });

  it('keeps replay order and stable local ids when delivery is deferred after durable admission', async () => {
    const { session, committed } = createFakeSession();
    const input = {
      session,
      provider: 'opencode' as const,
      remoteSessionId: 'ses_123',
      sidechainId: 'tool_task_1',
      replay: [
        { type: 'message', role: 'agent', text: 'first' },
        { type: 'message', role: 'agent', text: 'second' },
      ],
    };

    await importAcpReplaySidechainV1(input);
    const firstRunLocalIds = committed.map((entry) => entry.localId);
    await importAcpReplaySidechainV1(input);

    expect(committed.map((entry) => entry.body)).toEqual([
      { type: 'message', message: 'first', sidechainId: 'tool_task_1' },
      { type: 'message', message: 'second', sidechainId: 'tool_task_1' },
      { type: 'message', message: 'first', sidechainId: 'tool_task_1' },
      { type: 'message', message: 'second', sidechainId: 'tool_task_1' },
    ]);
    expect(committed.slice(2).map((entry) => entry.localId)).toEqual(firstRunLocalIds);
    expect(committed.map((entry) => entry.opts.provenance)).toEqual([
      { kind: 'non_dependent', source: 'sidechain' },
      { kind: 'non_dependent', source: 'sidechain' },
      { kind: 'non_dependent', source: 'sidechain' },
      { kind: 'non_dependent', source: 'sidechain' },
    ]);
  });

  it('fails and stops when durable custody rejects a sidechain replay row', async () => {
    const { session, committed } = createFakeSession({
      admission: async () => ({ persisted: false, delivered: false }),
    });

    await expect(importAcpReplaySidechainV1({
      session,
      provider: 'opencode',
      remoteSessionId: 'ses_123',
      sidechainId: 'tool_task_1',
      replay: [
        { type: 'message', role: 'agent', text: 'first' },
        { type: 'message', role: 'agent', text: 'must not be admitted' },
      ],
    })).rejects.toThrow(/durable custody/i);

    expect(committed).toHaveLength(1);
  });

  it('imports think tool calls as thinking messages and skips their tool results', async () => {
    const { session, committed } = createFakeSession();

    await importAcpReplaySidechainV1({
      session,
      provider: 'opencode',
      remoteSessionId: 'ses_123',
      sidechainId: 'tool_task_1',
      replay: [
        { type: 'tool_call', toolCallId: 't1', kind: 'think', rawInput: { thought: 'Hello' } },
        { type: 'tool_result', toolCallId: 't1', status: 'success', rawOutput: { ok: true } },
      ],
    });

    expect(committed).toHaveLength(1);
    expect(committed[0].body).toEqual({ type: 'thinking', text: 'Hello', sidechainId: 'tool_task_1' });
  });

  it('generates MySQL-safe localIds (<= 191 chars) even when sidechainId is long', async () => {
    const { session, committed } = createFakeSession();

    await importAcpReplaySidechainV1({
      session,
      provider: 'opencode',
      remoteSessionId: 'r'.repeat(128),
      sidechainId: `sc_${'x'.repeat(400)}`,
      replay: [{ type: 'message', role: 'agent', text: 'hello' }],
    });

    expect(committed).toHaveLength(1);
    expect(committed[0].localId.length).toBeLessThanOrEqual(191);
  });

  it('does not throw when tool input/output contain circular references', async () => {
    const { session } = createFakeSession();
    const rawInput: any = { command: 'echo hi' };
    rawInput.self = rawInput;
    const rawOutput: any = { stdout: 'hi' };
    rawOutput.self = rawOutput;

    await importAcpReplaySidechainV1({
      session,
      provider: 'opencode',
      remoteSessionId: 'ses_123',
      sidechainId: 'tool_task_1',
      replay: [
        { type: 'tool_call', toolCallId: 't1', kind: 'execute', rawInput },
        { type: 'tool_result', toolCallId: 't1', status: 'success', rawOutput },
      ],
    });
  });

  it('uses the same synthetic toolCallId scheme for tool_result events when toolCallId is missing', async () => {
    const { session, committed } = createFakeSession();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await importAcpReplaySidechainV1({
      session,
      provider: 'opencode',
      remoteSessionId: 'ses_123',
      sidechainId: 'tool_task_1',
      replay: [
        { type: 'tool_result', status: 'success', rawOutput: { ok: true } },
      ],
    });

    expect(committed.length).toBe(1);
    expect(committed[0].body.type).toBe('tool-result');
    if (committed[0].body.type !== 'tool-result') throw new Error('expected tool-result');
    expect(committed[0].body.callId).toBe('sc:tool_task_1:synthetic_0');
    warnSpy.mockRestore();
  });

  it('warns when a tool_result is missing toolCallId and no queued synthetic tool_call id exists', async () => {
    const { session } = createFakeSession();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await importAcpReplaySidechainV1({
      session,
      provider: 'opencode',
      remoteSessionId: 'ses_123',
      sidechainId: 'tool_task_1',
      replay: [{ type: 'tool_result', status: 'success', rawOutput: { ok: true } }],
    });

    expect(warnSpy).toHaveBeenCalledWith(
      '[ACP Sidechain Import] Missing toolCallId on tool_result event with no pending synthetic tool_call id; generated synthetic id',
      expect.objectContaining({
        provider: 'opencode',
        remoteSessionId: 'ses_123',
        sidechainId: 'tool_task_1',
        matchedSyntheticToolCall: false,
      }),
    );

    warnSpy.mockRestore();
  });

  it('ignores unknown event shapes without throwing', async () => {
    const { session, committed } = createFakeSession();

    await importAcpReplaySidechainV1({
      session,
      provider: 'opencode',
      remoteSessionId: 'ses_123',
      sidechainId: 'tool_task_1',
      replay: [
        null,
        123,
        { foo: 'bar' }, // missing type
        { type: 'message', role: 'agent', text: 'hello' },
      ],
    });

    expect(committed).toHaveLength(1);
    expect(committed[0].body.type).toBe('message');
  });

  it('skips import when sidechainId is unsafe', async () => {
    const { session, committed } = createFakeSession();

    await importAcpReplaySidechainV1({
      session,
      provider: 'opencode',
      remoteSessionId: 'ses_123',
      sidechainId: 'task / bad',
      replay: [{ type: 'message', role: 'agent', text: 'hello' }],
    });

    expect(committed).toHaveLength(0);
  });

});
