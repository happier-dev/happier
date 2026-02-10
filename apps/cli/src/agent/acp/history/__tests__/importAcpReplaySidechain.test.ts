import { describe, expect, it, vi } from 'vitest';

import { importAcpReplaySidechainV1 } from '../importAcpReplaySidechain';
import type { AcpReplaySidechainSessionClient } from '@/agent/acp/sessionClient';
import type { ACPMessageData } from '@/api/session/sessionMessageTypes';
import { logger } from '@/utils/logger';

function createFakeSession() {
  const committed: Array<{ provider: string; body: ACPMessageData; localId: string }> = [];
  const session: AcpReplaySidechainSessionClient = {
    async sendAgentMessageCommitted(provider, body, opts) {
      committed.push({ provider, body, localId: opts.localId });
    },
  };
  return { session, committed };
}

describe('importAcpReplaySidechainV1', () => {
  it('imports agent messages and tool events with sidechainId, namespacing tool call ids to avoid collisions', async () => {
    const { session, committed } = createFakeSession();

    await importAcpReplaySidechainV1({
      session,
      provider: 'opencode',
      remoteSessionId: 'ses_123',
      sidechainId: 'tool_task_1',
      replay: [
        { type: 'message', role: 'user', text: 'ignored user prompt' },
        { type: 'message', role: 'agent', text: 'hello' },
        { type: 'tool_call', toolCallId: 't1', kind: 'execute', rawInput: { command: 'echo hi' } },
        { type: 'tool_result', toolCallId: 't1', status: 'success', rawOutput: { stdout: 'hi' } },
      ],
    });

    expect(committed.length).toBe(3);
    expect(committed[0].provider).toBe('opencode');
    expect(committed[0].body.sidechainId).toBe('tool_task_1');
    expect(committed[0].body.type).toBe('message');

    expect(committed[1].body.type).toBe('tool-call');
    expect(committed[1].body.sidechainId).toBe('tool_task_1');
    if (committed[1].body.type !== 'tool-call') throw new Error('expected tool-call');
    expect(committed[1].body.callId).toBe('sc:tool_task_1:t1');

    expect(committed[2].body.type).toBe('tool-result');
    expect(committed[2].body.sidechainId).toBe('tool_task_1');
    if (committed[2].body.type !== 'tool-result') throw new Error('expected tool-result');
    expect(committed[2].body.callId).toBe('sc:tool_task_1:t1');
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

  it('limits replay processing to a bounded number of events', async () => {
    const { session, committed } = createFakeSession();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const replay = Array.from({ length: 1_500 }, (_, i) => ({
      type: 'message',
      role: 'agent',
      text: `line-${i}`,
    }));

    await importAcpReplaySidechainV1({
      session,
      provider: 'opencode',
      remoteSessionId: 'ses_123',
      sidechainId: 'tool_task_1',
      replay,
    });

    expect(committed.length).toBe(1_000);
    expect(warnSpy).toHaveBeenCalledWith(
      '[ACP Sidechain Import] Replay exceeded max event limit; truncating import',
      expect.objectContaining({ maxEvents: 1_000, replayEvents: 1_500 }),
    );
    warnSpy.mockRestore();
  });
});
