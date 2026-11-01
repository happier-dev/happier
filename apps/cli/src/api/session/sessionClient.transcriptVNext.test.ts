import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionMediaMessageMetaEnvelopeV1Schema } from '@happier-dev/protocol';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';

import type { RawJSONLines } from '@/backends/claude/types';
import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import {
  type ApiSessionSocketStub,
  createApiSessionSocketStub,
  flushApiSessionClientMessageCommitQueue,
} from '@/testkit/backends/apiSessionSocketHarness';

type ClientWithQueuedCommits = {
  messageCommitQueueTail: Promise<void>;
};

async function flushQueuedCommits(client: ClientWithQueuedCommits): Promise<void> {
  await flushApiSessionClientMessageCommitQueue(client);
}

let sessionSocketStub: ApiSessionSocketStub | null = null;
let userSocketStub: ApiSessionSocketStub | null = null;

vi.mock('./sockets', () => ({
  createUserScopedSocket: () => {
    if (!userSocketStub) throw new Error('Missing user socket stub');
    return userSocketStub as any;
  },
}));

vi.mock('./connection/createSessionSocketTransport', () => ({
  createSessionSocketTransport: () => {
    if (!sessionSocketStub) throw new Error('Missing session socket stub');
    return {
      socket: sessionSocketStub as any,
      transport: {
        connect: async () => {},
        disconnect: async () => {},
        destroy: async () => {},
        isConnected: () => sessionSocketStub?.connected === true,
        onConnected: () => () => {},
        onDisconnected: () => () => {},
        onError: () => () => {},
      },
    };
  },
}));

vi.mock('@happier-dev/connection-supervisor', () => ({
  DEFAULT_MANAGED_CONNECTION_POLICY: {},
  createManagedConnectionSupervisor: (params: { createTransport: () => unknown; onConnected?: () => Promise<void> | void }) => ({
    start: async () => {
      params.createTransport();
      await params.onConnected?.();
    },
    getState: () => ({ phase: 'online' }),
    reportProbeResult: () => {},
    stop: async () => {},
  }),
}));

describe('ApiSessionClient transcript vNext transport', () => {
  it.each(['best-effort', 'exact'] as const)('persists Claude tool-result images before %s transcript delivery', async (delivery) => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'claude-jsonl:task-1:user:image-result', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const directory = await mkdtemp(join(tmpdir(), 'happier-claude-media-'));
    const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lU6w9wAAAABJRU5ErkJggg==';
    try {
      const { ApiSessionClient } = await import('./sessionClient');
      const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1', metadata: createTestMetadata({ path: directory, flavor: 'claude' }) }));
      const body: RawJSONLines = {
        type: 'user', uuid: 'image-result', sidechainId: 'task-1',
        message: { content: [{ type: 'tool_result', tool_use_id: 'read-1', content: {
          content: [{ type: 'text', text: 'comparison' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data } }],
          tool_use_result: { type: 'image' },
        } }] },
      };
      const meta = { happier: { kind: 'existing-provenance' } };
      if (delivery === 'exact') await client.sendClaudeSessionMessageCommittedExact(body, meta);
      else client.sendClaudeSessionMessage(body, meta);
      await flushQueuedCommits(client as unknown as ClientWithQueuedCommits);
      const message = sessionSocketStub.emitWithAck.mock.calls.find(call => call[0] === 'message')?.[1];
      expect(message).toMatchObject({ sidechainId: 'task-1', message: { t: 'plain', v: { meta } } });
      const envelope = SessionMediaMessageMetaEnvelopeV1Schema.parse(message?.message.v.meta.happierMedia);
      expect(envelope.payload.media).toMatchObject([{ role: 'output', category: 'tool-artifact', mimeType: 'image/png', origin: { source: 'tool-output', toolCallId: 'read-1' } }]);
      expect(await readFile(join(directory, envelope.payload.media[0]!.path))).toEqual(Buffer.from(data, 'base64'));
      expect(JSON.stringify(message)).not.toContain(data);
      expect(JSON.stringify(message)).toContain('comparison');
      expect(JSON.stringify(body)).toContain(data);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('stamps ACP assistant prose as agent', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    client.sendAgentMessage('opencode' as any, { type: 'message', message: 'hello' } as any, { localId: 'acp-message-1' });

    await flushQueuedCommits(client as unknown as ClientWithQueuedCommits);

    expect(sessionSocketStub.emitWithAck).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        localId: 'acp-message-1',
        messageRole: 'agent',
      }),
    );
  });

  it('stamps ACP tool and lifecycle records as event', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    client.sendAgentMessage('opencode' as any, { type: 'thinking', text: 'working' } as any, { localId: 'thinking-1' });
    client.sendAgentMessage('opencode' as any, { type: 'reasoning', message: 'because' } as any, { localId: 'reasoning-1' });
    client.sendAgentMessage('opencode' as any, { type: 'tool-call', callId: 'call-1', name: 'Read', input: {}, id: 'tool-1' } as any, { localId: 'tool-call-1' });
    client.sendAgentMessage('opencode' as any, { type: 'tool-result', callId: 'call-1', output: 'ok', id: 'tool-result-1' } as any, { localId: 'tool-result-1' });
    client.sendAgentMessage('opencode' as any, { type: 'token_count', tokens: { total: 1 } } as any, { localId: 'usage-1' });
    client.sendAgentMessage('opencode' as any, { type: 'task_complete', id: 'turn-1' } as any, { localId: 'lifecycle-1' });

    await flushQueuedCommits(client as unknown as ClientWithQueuedCommits);

    const messageCalls = sessionSocketStub.emitWithAck.mock.calls.filter((call) => call[0] === 'message');
    for (const localId of ['thinking-1', 'reasoning-1', 'tool-call-1', 'tool-result-1', 'usage-1', 'lifecycle-1']) {
      expect(messageCalls).toContainEqual([
        'message',
        expect.objectContaining({
          localId,
          messageRole: 'event',
        }),
      ]);
    }
  });

  it('stamps Codex structured events as event', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    client.sendCodexMessage({ type: 'tool-call', callId: 'call-1', name: 'Read', input: {}, id: 'tool-1' });
    client.sendCodexMessage({ type: 'tool-call-result', callId: 'call-1', output: 'ok', id: 'tool-result-1' });
    client.sendCodexMessage({ type: 'token_count', tokens: { total: 1 } });

    await flushQueuedCommits(client as unknown as ClientWithQueuedCommits);

    const roles = sessionSocketStub.emitWithAck.mock.calls
      .filter((call) => call[0] === 'message')
      .map((call) => call[1]?.messageRole);
    expect(roles).toEqual(['event', 'event', 'event']);
  });

  it('stamps Codex assistant prose as agent', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    client.sendCodexMessage({ type: 'message', message: 'hello' });

    await flushQueuedCommits(client as unknown as ClientWithQueuedCommits);

    expect(sessionSocketStub.emitWithAck).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({ messageRole: 'agent' }),
    );
  });

  it('stamps Claude user text as user', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    client.sendClaudeSessionMessage({
      type: 'user',
      uuid: 'user-1',
      message: { content: 'hello' },
    } as RawJSONLines);

    await flushQueuedCommits(client as unknown as ClientWithQueuedCommits);

    expect(sessionSocketStub.emitWithAck).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({ messageRole: 'user' }),
    );
  });

  it('sends Claude peer messages as agent output that keeps their sender provenance', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    client.sendClaudeSessionMessage({
      type: 'user',
      uuid: 'peer-1',
      origin: { kind: 'peer', from: 'a1', name: 'general-purpose', handback: true },
      message: { role: 'user', content: 'From general-purpose:\n\nReport' },
    } as RawJSONLines);

    await flushQueuedCommits(client as unknown as ClientWithQueuedCommits);

    expect(sessionSocketStub.emitWithAck).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        messageRole: 'agent',
        message: expect.objectContaining({
          t: 'plain',
          v: expect.objectContaining({
            role: 'agent',
            content: expect.objectContaining({
              type: 'output',
              data: expect.objectContaining({ origin: expect.objectContaining({ kind: 'peer', name: 'general-purpose' }) }),
            }),
          }),
        }),
      }),
    );
  });

  it('stamps Claude assistant prose as agent', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    client.sendClaudeSessionMessage({
      type: 'assistant',
      uuid: 'assistant-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    } as RawJSONLines);

    await flushQueuedCommits(client as unknown as ClientWithQueuedCommits);

    expect(sessionSocketStub.emitWithAck).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({ messageRole: 'agent' }),
    );
  });

  it('uses deterministic local ids for raw Claude JSONL rows', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    client.sendClaudeSessionMessage({
      type: 'assistant',
      uuid: 'assistant-1',
      sidechainId: 'toolu_1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    } as RawJSONLines);
    client.sendClaudeSessionMessage({
      type: 'assistant',
      uuid: 'assistant-1',
      sidechainId: 'toolu_1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello again' }] },
    } as RawJSONLines);

    await flushQueuedCommits(client as unknown as ClientWithQueuedCommits);

    const localIds = sessionSocketStub.emitWithAck.mock.calls
      .filter((call) => call[0] === 'message')
      .map((call) => call[1]?.localId);
    expect(localIds).toEqual([
      'claude-jsonl:toolu_1:assistant:assistant-1',
      'claude-jsonl:toolu_1:assistant:assistant-1',
    ]);
  });

  it('records consumed Claude JSONL rows as non-visible event markers keyed by the raw row id', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    client.recordClaudeJsonlMessageConsumed({
      type: 'user',
      uuid: 'user-echo-1',
      message: { content: 'already persisted prompt' },
    } as RawJSONLines);

    await flushQueuedCommits(client as unknown as ClientWithQueuedCommits);

    expect(sessionSocketStub.emitWithAck).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        localId: 'claude-jsonl:main:user:user-echo-1',
        messageRole: 'event',
        message: expect.objectContaining({
          t: 'plain',
          v: expect.objectContaining({
            role: 'agent',
            content: expect.objectContaining({
              type: 'output',
              data: expect.objectContaining({
                type: 'progress',
                marker: 'claude_jsonl_consumed_marker',
                reason: 'prompt_echo_suppressed',
              }),
            }),
          }),
        }),
      }),
    );
  });

  it('stamps Claude structured rows as event', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    client.sendClaudeSessionMessage({
      type: 'assistant',
      uuid: 'tool-use-1',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }] },
    } as RawJSONLines);
    client.sendClaudeSessionMessage({
      type: 'user',
      uuid: 'tool-result-1',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
    } as RawJSONLines);
    client.sendClaudeSessionMessage({
      type: 'summary',
      summary: 'previous context',
      leafUuid: 'leaf-1',
    } as RawJSONLines);
    client.sendClaudeSessionMessage({
      type: 'system',
      uuid: 'system-1',
      message: 'init',
    } as RawJSONLines);

    await flushQueuedCommits(client as unknown as ClientWithQueuedCommits);

    const roles = sessionSocketStub.emitWithAck.mock.calls
      .filter((call) => call[0] === 'message')
      .map((call) => call[1]?.messageRole);
    expect(roles).toEqual(['event', 'event', 'event', 'event']);
  });

  it('stamps session events as event', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    client.sendSessionEvent({ type: 'ready' });

    await flushQueuedCommits(client as unknown as ClientWithQueuedCommits);

    expect(sessionSocketStub.emitWithAck).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({ messageRole: 'event' }),
    );
  });

  it('uses a supplied session event id as the stable transcript insertion identity', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'notice-1', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');
    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    client.sendSessionEvent({ type: 'message', message: 'Activity telemetry was unavailable.' }, 'notice-1');
    await flushQueuedCommits(client as unknown as ClientWithQueuedCommits);

    expect(sessionSocketStub.emitWithAck).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({ localId: 'notice-1', messageRole: 'event' }),
    );
  });

  it('uses ephemeral assistant transcript snapshots as the current turn fallback', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const turnToken = client.beginTurnAssistantTextSnapshot({ turnToken: 'turn-1', startSeqExclusive: 0 });

    client.sendAgentMessageEphemeral(
      'codex' as any,
      { type: 'message', message: 'Streaming answer' } as any,
      { localId: 'stream-1', createdAt: 100 },
    );

    expect(client.getTurnAssistantTextSnapshot({ turnToken, startSeqExclusive: 0 })).toMatchObject({
      turnToken,
      text: 'Streaming answer',
      source: 'ephemeral',
      localId: 'stream-1',
      provider: 'codex',
    });
  });

  it('upgrades ephemeral assistant text with committed assistant text for the same turn', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 7, localId: 'l1', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    const turnToken = client.beginTurnAssistantTextSnapshot({ turnToken: 'turn-1', startSeqExclusive: 0 });

    client.sendAgentMessageEphemeral(
      'codex' as any,
      { type: 'message', message: 'Streaming answer' } as any,
      { localId: 'assistant-1', createdAt: 100 },
    );
    await client.sendAgentMessageCommitted(
      'codex' as any,
      { type: 'message', message: 'Final answer' } as any,
      { localId: 'assistant-1' },
    );

    expect(client.getTurnAssistantTextSnapshot({ turnToken, startSeqExclusive: 0 })).toMatchObject({
      turnToken,
      text: 'Final answer',
      source: 'committed',
      seq: 7,
      localId: 'assistant-1',
      provider: 'codex',
    });
  });

  it('forwards sidechainId as plaintext metadata on durable commits', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    await client.sendAgentMessageCommitted(
      'codex' as any,
      { type: 'message', message: 'hi', sidechainId: ' sc-1\n' } as any,
      { localId: 'l1' },
    );

    const messageCalls = sessionSocketStub.emitWithAck.mock.calls.filter((call) => call[0] === 'message');
    expect(messageCalls).toEqual([[
      'message',
      expect.objectContaining({ sidechainId: ' sc-1\n' }),
    ]]);
  });

  it('forwards Claude sidechainId on durable commits for imported sidechain messages', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    client.sendClaudeSessionMessage(
      {
        type: 'assistant',
        uuid: 'sidechain-uuid',
        sidechainId: ' tool_agent_1\n',
        isSidechain: true,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hello from teammate' }],
        },
      } satisfies RawJSONLines,
      { importedFrom: 'claude-team-inbox' },
    );

    await flushQueuedCommits(client as unknown as ClientWithQueuedCommits);

    const messageCalls = sessionSocketStub.emitWithAck.mock.calls.filter((call) => call[0] === 'message');
    expect(messageCalls).toEqual([[
      'message',
      expect.objectContaining({ sidechainId: ' tool_agent_1\n' }),
    ]]);
  });

  it('does not expose transcript-draft ephemerals (legacy partial streaming removed)', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    expect((client as any).sendTranscriptDraftDelta).toBeUndefined();
  });

  it('emits live transcript stream segments on the session socket without waiting for durable ACKs', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'segment-1', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    expect(client.sendAgentMessageEphemeral).toBeTypeOf('function');
    client.sendAgentMessageEphemeral(
      'codex',
      { type: 'message', message: 'Hello', sidechainId: 'sc-1' },
      {
        localId: 'segment-1',
        createdAt: 1_000,
        meta: {
          happierStreamSegmentV1: {
            v: 1,
            segmentKind: 'assistant',
            segmentLocalId: 'segment-1',
            segmentState: 'streaming',
            startedAtMs: 1_000,
            updatedAtMs: 1_025,
          },
        },
      },
    );

    expect(sessionSocketStub.emitWithAck).not.toHaveBeenCalled();
    expect(sessionSocketStub.emit).toHaveBeenCalledWith(
      'transcript-stream-segment',
      expect.objectContaining({
        sid: 's1',
        message: expect.objectContaining({
          localId: 'segment-1',
          messageRole: 'agent',
          sidechainId: 'sc-1',
          createdAt: 1_000,
          updatedAt: 1_025,
          content: {
            t: 'plain',
            v: expect.objectContaining({
              role: 'agent',
              content: {
                type: 'acp',
                provider: 'codex',
                data: { type: 'message', message: 'Hello', sidechainId: 'sc-1' },
              },
            }),
          },
        }),
      }),
    );
  });

  it('stamps ephemeral thinking stream segments as event', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'segment-1', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    client.sendAgentMessageEphemeral(
      'codex',
      { type: 'thinking', text: 'Working' },
      {
        localId: 'thinking-segment-1',
        createdAt: 1_000,
        meta: {
          happierStreamSegmentV1: {
            v: 1,
            segmentKind: 'thinking',
            segmentLocalId: 'thinking-segment-1',
            segmentState: 'streaming',
            startedAtMs: 1_000,
            updatedAtMs: 1_025,
          },
        },
      },
    );

    expect(sessionSocketStub.emitWithAck).not.toHaveBeenCalled();
    expect(sessionSocketStub.emit).toHaveBeenCalledWith(
      'transcript-stream-segment',
      expect.objectContaining({
        message: expect.objectContaining({
          localId: 'thinking-segment-1',
          messageRole: 'event',
        }),
      }),
    );
  });

  it('stamps durable thinking stream snapshots as event', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'thinking-segment-1', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    await client.sendAgentMessageCommitted(
      'codex',
      { type: 'thinking', text: 'Working' },
      { localId: 'thinking-segment-1' },
    );

    expect(sessionSocketStub.emitWithAck).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        localId: 'thinking-segment-1',
        messageRole: 'event',
      }),
    );
  });

  it('does not emit an ephemeral stream segment updatedAt earlier than createdAt', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'segment-1', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(500);

    try {
      const { ApiSessionClient } = await import('./sessionClient');

      const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
      client.sendAgentMessageEphemeral(
        'codex',
        { type: 'message', message: 'Hello' },
        {
          localId: 'segment-1',
          createdAt: 1_000,
        },
      );

      expect(sessionSocketStub.emit).toHaveBeenCalledWith(
        'transcript-stream-segment',
        expect.objectContaining({
          message: expect.objectContaining({
            createdAt: 1_000,
            updatedAt: 1_000,
          }),
        }),
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('includes the live-stream tick on transcript-stream-segment snapshot emissions when provided', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'segment-1', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    client.sendAgentMessageEphemeral(
      'codex',
      { type: 'message', message: 'Hello' },
      { localId: 'segment-1', createdAt: 1_000, tick: 5 },
    );

    expect(sessionSocketStub.emit).toHaveBeenCalledWith(
      'transcript-stream-segment',
      expect.objectContaining({
        sid: 's1',
        message: expect.objectContaining({
          localId: 'segment-1',
          tick: 5,
        }),
      }),
    );
  });

  it('emits transcript-stream-segment-delta ticks carrying only the appended text', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'segment-1', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    expect(client.sendAgentMessageEphemeralDelta).toBeTypeOf('function');
    client.sendAgentMessageEphemeralDelta(
      'codex',
      { type: 'message', message: ' world', sidechainId: 'sc-1' },
      {
        localId: 'segment-1',
        tick: 2,
        baseLength: 5,
        createdAt: 1_000,
        updatedAt: 1_040,
        meta: {
          happierStreamSegmentV1: {
            v: 1,
            segmentKind: 'assistant',
            segmentLocalId: 'segment-1',
            segmentState: 'streaming',
            startedAtMs: 1_000,
            updatedAtMs: 1_040,
          },
        },
      },
    );

    expect(sessionSocketStub.emitWithAck).not.toHaveBeenCalled();
    expect(sessionSocketStub.emit).toHaveBeenCalledWith(
      'transcript-stream-segment-delta',
      expect.objectContaining({
        sid: 's1',
        message: expect.objectContaining({
          localId: 'segment-1',
          messageRole: 'agent',
          sidechainId: 'sc-1',
          tick: 2,
          baseLength: 5,
          createdAt: 1_000,
          updatedAt: 1_040,
          content: {
            t: 'plain',
            v: expect.objectContaining({
              role: 'agent',
              content: {
                type: 'acp',
                provider: 'codex',
                data: { type: 'message', message: ' world', sidechainId: 'sc-1' },
              },
            }),
          },
        }),
      }),
    );
  });

  it('does not emit transcript-stream-segment-delta while the socket is disconnected', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: false, emitWithAckResult: { ok: true } });
    userSocketStub = createApiSessionSocketStub({ connected: false, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    client.sendAgentMessageEphemeralDelta(
      'codex',
      { type: 'message', message: 'delta' },
      { localId: 'segment-1', tick: 2, baseLength: 5, createdAt: 1_000 },
    );

    expect(sessionSocketStub.emit).not.toHaveBeenCalledWith(
      'transcript-stream-segment-delta',
      expect.anything(),
    );
  });

  it('advances the ephemeral stream connection epoch on every socket connect', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'l1', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    await Promise.resolve();
    await Promise.resolve();

    const initialEpoch = client.getEphemeralStreamConnectionEpoch();
    expect(initialEpoch).toBeGreaterThanOrEqual(1);

    // Boundary mock: the mocked connection supervisor invokes onConnected on every start().
    await (client as unknown as { sessionConnectionSupervisor: { start: () => Promise<void> } }).sessionConnectionSupervisor.start();

    expect(client.getEphemeralStreamConnectionEpoch()).toBe(initialEpoch + 1);
  });

  it('clears materialized localId state when a durable stream checkpoint arrives as message-updated', async () => {
    vi.resetModules();
    sessionSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true, id: 'm1', seq: 1, localId: 'segment-1', didWrite: true } });
    userSocketStub = createApiSessionSocketStub({ connected: true, emitWithAckResult: { ok: true } });

    const { ApiSessionClient } = await import('./sessionClient');

    const client = new ApiSessionClient('tok', createPlainSessionFixture({ id: 's1' }));
    await client.sendAgentMessageCommitted(
      'codex' as any,
      { type: 'message', message: 'Hello' } as any,
      { localId: 'segment-1' },
    );

    expect((client as any).committedLocalIdsAwaitingEcho.has('segment-1')).toBe(true);

    const updateHandler = sessionSocketStub.getHandler('update');
    expect(updateHandler).toBeTypeOf('function');

    updateHandler?.({
      id: 'u2',
      seq: 2,
      createdAt: 2_000,
      body: {
        t: 'message-updated',
        sid: 's1',
        message: {
          id: 'm1',
          seq: 1,
          localId: 'segment-1',
          createdAt: 1_000,
          updatedAt: 2_000,
          content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Hello world' }, meta: {} } },
        },
      },
    });

    expect((client as any).committedLocalIdsAwaitingEcho.has('segment-1')).toBe(false);
  });
});
