import { createRequire, Module } from 'node:module';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { RPC_ERROR_CODES, SESSION_RPC_METHODS } from '@happier-dev/protocol';
import { RpcError } from '@happier-dev/protocol/rpcErrors';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionMessagesFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { settingsParse } from '@/sync/domains/settings/settings';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { storage } from '@/sync/domains/state/storageStore';
import { Encryption } from '@/sync/encryption/encryption';
import { sync } from '@/sync/sync';
import { createVoiceAgentSessionController } from '@/voice/agent/VoiceAgentSessionController';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import * as voiceConversationTranscript from '@/voice/sessionBinding/voiceConversationTranscript';
import { voiceSessionBindingStore } from '@/voice/sessionBinding/voiceSessionBindingStore';
import { patchLocalVoiceState } from './localVoiceState';

let appendUser: MockInstance<typeof voiceConversationTranscript.appendVoiceConversationUserText>;
let appendAssistant: MockInstance<typeof voiceConversationTranscript.appendVoiceConversationAssistantText>;
let appendNote: MockInstance<typeof voiceConversationTranscript.appendVoiceConversationNoteText>;
let sendMessage: MockInstance<typeof sync.sendMessage>;
let submitMessage: MockInstance<typeof sync.submitMessage>;
let enqueuePendingMessage: MockInstance<typeof sync.enqueuePendingMessage>;
const accountId = 'voice-transcript-test-account';
const boundaryEvents: string[] = [];
const pendingRows = new Map<string, { sessionId: string; row: Record<string, unknown> }>();
const handledRows = new Map<string, Record<string, unknown>>();
let handledError: number | Error | null = null;
let pendingVersion = 0;
const initialStorageState = storage.getState();
const initialBindings = voiceSessionBindingStore.getState().bindingsByConversationSessionId;
const initialEncryption = Reflect.get(sync, 'encryption');
// The native require adapter must return the same real singleton already loaded by Vitest.
const nodeRequire = createRequire(import.meta.url);
const syncModulePath = nodeRequire.resolve('../../sync/sync.ts');
const priorSyncModule = nodeRequire.cache[syncModulePath];
const syncModule = new Module(syncModulePath);
syncModule.exports = { sync };
syncModule.loaded = true;
nodeRequire.cache[syncModulePath] = syncModule;
afterAll(() => {
  if (priorSyncModule) nodeRequire.cache[syncModulePath] = priorSyncModule;
  else delete nodeRequire.cache[syncModulePath];
});
let conversationMode: 'agent' | 'direct_session' = 'agent';
let voiceAgentBackend: 'daemon' | 'openai_compat' = 'daemon';

const speech = vi.hoisted(() => vi.fn<(text: string, options?: { onDone?: () => void }) => void>());
vi.mock('expo-speech', () => ({ speak: speech, stop: vi.fn() }));

function voiceSettings(autoSpeakReplies = false) {
  return { voice: { providerId: 'local_conversation', adapters: { local_conversation: {
    conversationMode, agent: { backend: voiceAgentBackend }, tts: { provider: 'device', autoSpeakReplies },
  } } } };
}

describe('sendVoiceTextTurn synthetic transcript mirroring', () => {
  beforeEach(async () => {
    storage.setState(initialStorageState, true);
    storage.getState().activateProfileScope({ serverId: getActiveServerSnapshot().serverId, accountId });
    const now = Date.now();
    storage.setState({ sessions: Object.fromEntries(['s1', 'carrier-s1'].map(id => [id, createSessionFixture({
      id, active: true, activeAt: now, encryptionMode: 'e2ee', pendingCount: 0, pendingVersion: 0,
    })])) });
    const encryption = await Encryption.create(new Uint8Array(32).fill(7));
    await encryption.initializeSessions(new Map([['s1', null], ['carrier-s1', null]]));
    Reflect.set(sync, 'encryption', encryption);
    const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token, secret: '' });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      features: { voice: { enabled: true },
        sharing: { pendingQueueV2: { enabled: true }, pendingDeliveryState: { enabled: true } } },
      capabilities: { compatibility: { pendingInput: { currentPendingInputProtocolVersion: 1 } },
        session: { pendingInput: { protocolVersion: 1 } } },
    })));
    pendingRows.clear();
    handledRows.clear();
    handledError = null;
    pendingVersion = 0;
    boundaryEvents.length = 0;
    // HTTP acknowledgements are the boundary; durable custody, handlers and transcript projection stay real.
    vi.spyOn(apiSocket, 'request').mockImplementation(async (path, init) => {
      if (/^\/v[12]\/sessions\/[^/]+\/messages(?:\?|$)/.test(path)) {
        return Response.json({ messages: [], hasMore: false });
      }
      const route = /^\/v2\/sessions\/([^/]+)\/pending(?:\/([^/]+)\/delivery\/(block|handled))?$/.exec(new URL(path, 'http://relay.test').pathname);
      if (!route) throw new Error(`Unexpected pending route: ${path}`);
      const sessionId = route[1]!;
      if (route[2]) {
        const pending = pendingRows.get(route[2]);
        if (!pending) throw new Error('Unknown pending localId');
        if (route[3] === 'handled') {
          boundaryEvents.push(`handled:${route[2]}`);
          if (handledError instanceof Error) throw handledError;
          if (handledError) return Response.json({ error: 'settlement_failed' }, { status: handledError });
          handledRows.set(route[2], pending.row);
          pendingRows.delete(route[2]);
        } else {
          boundaryEvents.push(`blocked:${route[2]}`);
          pending.row.deliveryStatus = { status: 'blocked', reason: 'delivery_outcome_uncertain' };
        }
        pendingVersion += 1;
        return Response.json({ ok: true });
      }
      if (init?.method === 'GET') {
        return Response.json({ pending: [...pendingRows.values()].filter(value => value.sessionId === sessionId).map(value => value.row),
          pendingCount: pendingRows.size, pendingVersion });
      }
      const body = JSON.parse(String(init?.body)) as { localId: string; content?: unknown; ciphertext?: string; deliveryMode?: string; requestedAction: unknown };
      boundaryEvents.push(`enqueue:${body.localId}`);
      const row = { localId: body.localId, content: body.content ?? { t: 'encrypted', c: body.ciphertext }, status: 'queued', position: pendingRows.size,
        createdAt: 1, updatedAt: 1, discardedAt: null, discardedReason: null, authorAccountId: accountId,
        requestedAction: body.requestedAction, messageRole: 'user',
        deliveryStatus: { status: body.deliveryMode === 'external_handoff' ? 'external_handoff' : 'queued' } };
      pendingRows.set(body.localId, { sessionId, row });
      pendingVersion += 1;
      return Response.json({ didWrite: true, requestedAction: body.requestedAction, pending: row,
        pendingCount: pendingRows.size, pendingVersion });
    });
    voiceSessionBindingStore.setState({ bindingsByConversationSessionId: initialBindings });
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation', controlSessionId: 'voice-global', conversationSessionId: 'carrier-s1',
      transcriptMode: 'synthetic', targetSessionId: 's1', updatedAt: 1,
    });
    patchLocalVoiceState({ status: 'idle', sessionId: null, error: null });
    speech.mockReset().mockImplementation((_text, options) => options?.onDone?.());
    appendUser = vi.spyOn(voiceConversationTranscript, 'appendVoiceConversationUserText');
    appendAssistant = vi.spyOn(voiceConversationTranscript, 'appendVoiceConversationAssistantText');
    appendNote = vi.spyOn(voiceConversationTranscript, 'appendVoiceConversationNoteText');
    sendMessage = vi.spyOn(sync, 'sendMessage');
    submitMessage = vi.spyOn(sync, 'submitMessage');
    enqueuePendingMessage = vi.spyOn(sync, 'enqueuePendingMessage');
    conversationMode = 'agent';
    voiceAgentBackend = 'daemon';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.set(sync, 'encryption', initialEncryption);
    storage.setState(initialStorageState, true);
    voiceSessionBindingStore.setState({ bindingsByConversationSessionId: initialBindings });
  });

  it('submits direct-session voice input durably before immediate provider dispatch', async () => {
    conversationMode = 'direct_session';
    const serverId = getActiveServerSnapshot().serverId;
    storage.getState().activateProfileScope({ serverId, accountId });
    const now = Date.now();
    const session = createSessionFixture({
      id: 's1', active: true, activeAt: now, encryptionMode: 'plain',
      pendingCount: 0, pendingVersion: 0,
      latestTurnId: 'old-turn', latestTurnStatus: 'completed', latestTurnStatusObservedAt: now,
      sessionTurns: { v: 1, sessionId: 's1', latestTurnId: 'old-turn', updatedAt: now, turns: [{
        turnId: 'old-turn', status: 'completed', startedAt: 1, updatedAt: now,
        transcriptAnchors: { startUserMessageSeq: 1, userMessageSeqs: [1], endSeqInclusive: 2 },
      }] },
    });
    storage.setState({ sessions: { s1: session } });
    Reflect.set(sync, 'encryption', Encryption.createWithoutKeyMaterial());
    const { sendVoiceTextTurn } = await import('./sendVoiceTextTurn');
    const abort = new AbortController();
    const sending = sendVoiceTextTurn({
      sessionId: 's1',
      settings: voiceSettings(true),
      userText: 'send this durably',
      signal: abort.signal,
      playbackController: {
        registerStopper: () => () => {},
        interrupt: () => {},
        captureEpoch: () => 1,
        isEpochCurrent: () => true,
      },
      voiceAgentSessions: {
        sendTurn: vi.fn(),
      },
    });
    try {
      const submission = await submitMessage.mock.results[0]!.value;
      const submittedLocalId = submission.localId;
      expect(submittedLocalId).toEqual(expect.any(String));
      await expect(enqueuePendingMessage.mock.results[0]!.value).resolves.toMatchObject({ accepted: true });
      const user: Message = { id: 'voice-user', kind: 'user-text', text: 'send this durably',
        seq: 12, localId: submittedLocalId!, createdAt: 2 };
      const foreign: Message = { id: 'foreign-reply', kind: 'agent-text', text: 'Unrelated reply.',
        seq: 11, localId: null, createdAt: 2 };
      storage.setState({ sessionMessages: { s1: createSessionMessagesFixture({
        messageIdsOldestFirst: [foreign.id, user.id], messagesById: { [foreign.id]: foreign, [user.id]: user },
      }) }, sessions: { s1: { ...session, latestTurnId: 'foreign-turn', sessionTurns: {
        v: 1, sessionId: 's1', latestTurnId: 'foreign-turn', updatedAt: now, turns: [{
          turnId: 'foreign-turn', status: 'completed', startedAt: 1, updatedAt: now,
          transcriptAnchors: { startUserMessageSeq: 10, userMessageSeqs: [10], endSeqInclusive: 11 },
        }],
      } } } });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(speech).not.toHaveBeenCalled();
      const reply: Message = { id: 'voice-reply', kind: 'agent-text', text: 'The bound answer.',
        seq: 13, localId: null, createdAt: 3 };
      storage.setState({ sessionMessages: { s1: createSessionMessagesFixture({
        messageIdsOldestFirst: [foreign.id, user.id, reply.id],
        messagesById: { [foreign.id]: foreign, [user.id]: user, [reply.id]: reply },
      }) }, sessions: { s1: { ...session, latestTurnId: 'voice-turn', sessionTurns: {
        v: 1, sessionId: 's1', latestTurnId: 'voice-turn', updatedAt: now, turns: [{
          turnId: 'voice-turn', status: 'completed', startedAt: 2, updatedAt: now,
          transcriptAnchors: { startUserMessageSeq: 12, userMessageSeqs: [12], endSeqInclusive: 13 },
        }],
      } } } });
      await sending;
      expect(speech).toHaveBeenCalledWith(reply.text, expect.anything());
      expect(submitMessage).toHaveBeenCalledWith('s1', 'send this durably', undefined, undefined,
        { callerSurface: 'voice_turn', forceImmediate: true });
      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      abort.abort();
      await sending;
    }
  });

  it.each([VOICE_AGENT_GLOBAL_SESSION_ID, 'carrier-s1'])('dispatches speech from %s through its native conversation binding without synthetic transcript writes', async (sessionId) => {
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation', controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID, conversationSessionId: 'carrier-s1',
      transcriptMode: 'native_session', targetSessionId: 's1', updatedAt: 2,
    });
    const settings = settingsParse({
      ...voiceSettings(), experiments: true,
      featureToggles: { voice: true, 'voice.agent': true, 'execution.runs': true },
    });
    storage.setState({ settings, sessions: Object.fromEntries(Object.entries(storage.getState().sessions)
      .map(([id, session]) => [id, { ...session, metadata: session.metadata ? { ...session.metadata, machineId: undefined } : null }])) });
    // The daemon RPC transport is the boundary; controller initialization and streaming stay real.
    let streamCount = 0;
    const rpc = vi.spyOn(apiSocket, 'sessionRPC').mockImplementation(async <R, A>(_sessionId: string, method: string, payload: A): Promise<R> => {
      // This generic transport fixture returns the response owned by each real RPC schema.
      const respond = (response: unknown): R => response as R;
      if (method === SESSION_RPC_METHODS.EXECUTION_RUN_LIST) return respond({ runs: [] });
      if (method === SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START) return respond({ ok: true, runId: 'voice-run', created: true });
      if (method === SESSION_RPC_METHODS.EXECUTION_RUN_GET) return respond({ run: { runId: 'voice-run' } });
      if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2) {
        const request = payload as { userTranscript: { mode: string; localId?: string }; displayMessage: string };
        streamCount += 1;
        if (streamCount === 1) boundaryEvents.push(`dispatch:${request.userTranscript.localId}`);
        else {
          expect(request.userTranscript).toEqual({ mode: 'suppress' });
          expect(request.displayMessage).toContain('VOICE_TOOL_RESULTS_JSON:');
          boundaryEvents.push('tool-followup');
        }
        return respond({ streamId: 'voice-stream' });
      }
      if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ) return respond({
        streamId: 'voice-stream', nextCursor: 1, done: true,
        events: [{ t: 'done', assistantText: 'Native session reply.',
          actions: streamCount === 1 ? [{ t: 'listAgentBackends', args: {} }] : [] }],
      });
      throw new Error(`Unexpected voice RPC: ${method}`);
    });
    const voiceAgentSessions = createVoiceAgentSessionController();
    await voiceAgentSessions.ensureRunning(sessionId);
    const { sendVoiceTextTurn } = await import('./sendVoiceTextTurn');

    await sendVoiceTextTurn({
      sessionId, settings: voiceSettings(), userText: 'from microphone',
      playbackController: {
        registerStopper: () => () => {}, interrupt: () => {},
        captureEpoch: () => 1, isEpochCurrent: () => true,
      },
      voiceAgentSessions,
    });

    const localId = enqueuePendingMessage.mock.calls[0]?.[4]?.localId;
    expect(localId).toEqual(expect.any(String));
    expect(enqueuePendingMessage).toHaveBeenCalledWith('carrier-s1', 'from microphone', undefined, undefined,
      expect.objectContaining({ localId, deliveryMode: 'external_handoff' }));
    expect(rpc).toHaveBeenCalledWith('carrier-s1', SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2,
      expect.objectContaining({ displayMessage: 'from microphone', userTranscript: { mode: 'persist', localId } }),
      expect.anything());
    expect(boundaryEvents).toEqual([`enqueue:${localId}`, `dispatch:${localId}`, 'tool-followup', `handled:${localId}`]);
    expect(pendingRows.size).toBe(0);
    expect(storage.getState().sessionPending['carrier-s1']?.messages ?? []).toEqual([]);
    expect(appendUser).not.toHaveBeenCalled();
    expect(appendAssistant).not.toHaveBeenCalled();
    expect(appendNote).not.toHaveBeenCalled();
  });

  it('delegates the durable user row to the daemon while mirroring assistant turns locally', async () => {
    const { sendVoiceTextTurn } = await import('./sendVoiceTextTurn');
    const sendTurn = vi.fn(async () => ({ assistantText: 'I found Claude and Codex.', actions: [] }));

    await sendVoiceTextTurn({
      sessionId: 'voice-global',
      settings: voiceSettings(),
      userText: 'list the backends',
      playbackController: {
        registerStopper: () => () => {},
        interrupt: () => {},
        captureEpoch: () => 1,
        isEpochCurrent: () => true,
      },
      voiceAgentSessions: {
        sendTurn,
      },
    });

    const localId = enqueuePendingMessage.mock.calls[0]?.[4]?.localId;
    expect(appendUser).not.toHaveBeenCalled();
    expect(sendTurn).toHaveBeenCalledWith(
      'voice-global',
      'list the backends',
      {
        userTranscript: {
          mode: 'persist',
          localId,
        },
      },
    );
    expect(appendAssistant).toHaveBeenCalledWith({
      conversationSessionId: 'carrier-s1',
      text: 'I found Claude and Codex.',
    });
    expect(appendNote).not.toHaveBeenCalled();
  });

  it('durably enqueues synthetic speech input before one exact local-agent dispatch', async () => {
    const events = boundaryEvents;
    const sendTurn = vi.fn(async (_sessionId: string, _prompt: string, options?: any) => {
      const localId = enqueuePendingMessage.mock.calls[0]?.[4]?.localId;
      events.push(`dispatch:${options?.userTranscript?.localId}`);
      return { assistantText: 'done', actions: [] };
    });
    const { sendVoiceTextTurn } = await import('./sendVoiceTextTurn');

    await sendVoiceTextTurn({
      sessionId: 'voice-global',
      settings: voiceSettings(),
      userText: 'from microphone',
      playbackController: {
        registerStopper: () => () => {},
        interrupt: () => {},
        captureEpoch: () => 1,
        isEpochCurrent: () => true,
      },
      voiceAgentSessions: { sendTurn },
    });

    const localId = enqueuePendingMessage.mock.calls[0]?.[4]?.localId;
    expect(localId).toEqual(expect.any(String));
    expect(sendTurn).toHaveBeenCalledTimes(1);
    expect(appendUser).not.toHaveBeenCalled();
    expect(sendTurn).toHaveBeenCalledWith(
      'voice-global',
      'from microphone',
      {
        userTranscript: {
          mode: 'persist',
          localId,
        },
      },
    );
    expect(events).toEqual([
      `enqueue:${localId}`,
      `dispatch:${localId}`,
      `handled:${localId}`,
    ]);
  });

  it.each(['speech', 'composer'] as const)('settles %s input through the real OpenAI-compatible client', async (entry) => {
    voiceAgentBackend = 'openai_compat';
    const settings = settingsParse({
      ...voiceSettings(),
      voice: { providerId: 'local_conversation', adapters: { local_conversation: {
        conversationMode: 'agent', agent: { backend: 'openai_compat', openaiCompat: { chatBaseUrl: 'http://voice.test' } },
        tts: { provider: 'device', autoSpeakReplies: false },
      } } },
    });
    storage.setState({ settings });
    const featureFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('http://voice.test/')) {
        boundaryEvents.push('provider-reply');
        return Response.json({ choices: [{ message: { role: 'assistant', content: 'A real backend reply.' } }] });
      }
      return featureFetch(input, init);
    }));
    const voiceAgentSessions = createVoiceAgentSessionController();
    const { sendVoiceTextTurn } = await import('./sendVoiceTextTurn');
    const sendTurn = (durableDispatch?: { localId: string; handoffMode: 'interrupt_and_send' }) => sendVoiceTextTurn({
      sessionId: 'voice-global', settings, userText: 'keep this voice input',
      playbackController: { registerStopper: () => () => {}, interrupt: () => {}, captureEpoch: () => 1, isEpochCurrent: () => true },
      voiceAgentSessions,
      ...(durableDispatch ? { durableDispatch } : {}),
    });
    if (entry === 'speech') {
      await sendTurn();
    } else {
      const { sendVoiceSessionComposerText } = await import('../sessionBinding/sendVoiceSessionComposerText');
      await expect(sendVoiceSessionComposerText({
        conversationSessionId: 'carrier-s1', text: 'keep this voice input',
        getAdapter: () => ({
          id: 'local_conversation', start: async () => {}, stop: async () => {}, toggle: async () => {},
          interrupt: async () => {}, sendContextUpdate: () => {},
          getSnapshot: () => ({ adapterId: 'local_conversation', sessionId: 'voice-global', status: 'connected', mode: 'idle', canStop: true }),
          sendTextTurn: async ({ localId, handoffMode }) => sendTurn({ localId, handoffMode }),
        }),
      })).resolves.toEqual({ ok: true, localId: expect.any(String), disposition: 'handoff_acknowledged' });
    }
    const localId = enqueuePendingMessage.mock.calls[0]?.[4]?.localId;
    expect(boundaryEvents).toEqual([`enqueue:${localId}`, 'provider-reply', `handled:${localId}`]);
    expect(handledRows.get(localId!)).toMatchObject({ localId, messageRole: 'user' });
    expect(pendingRows.size).toBe(0);
    expect(storage.getState().sessionPending['carrier-s1']?.messages ?? []).toEqual([]);
  });

  it.each([404, new RpcError('RPC method not available', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE)])(
    'keeps settlement failure %s ambiguous without another provider dispatch', async (error) => {
    handledError = error;
    const { submitDurableVoiceTextTurn } = await import('../sessionBinding/sendVoiceSessionComposerText');
    const dispatch = vi.fn(async () => {});
    await expect(submitDurableVoiceTextTurn({
      conversationSessionId: 'carrier-s1', text: 'accepted but not settled', dispatch,
    })).resolves.toMatchObject({ ok: true, disposition: 'ambiguous' });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(handledRows.size).toBe(0);
    expect([...pendingRows.values()][0]?.row.deliveryStatus).toEqual({ status: 'blocked', reason: 'delivery_outcome_uncertain' });
  });

  it('does not settle an aborted local turn as a successful handoff', async () => {
    const controller = new AbortController();
    controller.abort();
    const { sendVoiceTextTurn } = await import('./sendVoiceTextTurn');
    await expect(sendVoiceTextTurn({
      sessionId: 'voice-global', settings: voiceSettings(), userText: 'aborted input', signal: controller.signal,
      playbackController: { registerStopper: () => () => {}, interrupt: () => {}, captureEpoch: () => 1, isEpochCurrent: () => true },
      voiceAgentSessions: createVoiceAgentSessionController(),
    })).rejects.toThrow('voice_turn_dispatch_ambiguous');
    expect(handledRows.size).toBe(0);
    expect([...pendingRows.values()][0]?.row.deliveryStatus).toEqual({ status: 'blocked', reason: 'delivery_outcome_uncertain' });
  });

  it('retains the UI transcript writer for the non-daemon voice backend', async () => {
    voiceAgentBackend = 'openai_compat';
    const { sendVoiceTextTurn } = await import('./sendVoiceTextTurn');

    await sendVoiceTextTurn({
      sessionId: 'voice-global',
      settings: voiceSettings(),
      userText: 'from local compatibility backend',
      playbackController: {
        registerStopper: () => () => {},
        interrupt: () => {},
        captureEpoch: () => 1,
        isEpochCurrent: () => true,
      },
      voiceAgentSessions: {
        sendTurn: vi.fn(async () => ({ assistantText: 'done', actions: [] })),
      },
    });

    const localId = enqueuePendingMessage.mock.calls[0]?.[4]?.localId;
    expect(appendUser).toHaveBeenCalledWith({
      conversationSessionId: 'carrier-s1',
      text: 'from local compatibility backend',
      localId,
    });
  });

  it('normalizes sendSessionMessage preambles and appends concise tool execution notes into the hidden conversation session', async () => {
    const { sendVoiceTextTurn } = await import('./sendVoiceTextTurn');

    const sendTurn = vi
      .fn()
      .mockResolvedValueOnce({
        assistantText: 'I will send that now.',
        actions: [{ t: 'sendSessionMessage', args: { message: 'hello' } }],
      })
      .mockResolvedValueOnce({
        assistantText: 'Done.',
        actions: [],
      });

    await sendVoiceTextTurn({
      sessionId: 'voice-global',
      settings: voiceSettings(),
      userText: 'send hello',
      playbackController: {
        registerStopper: () => () => {},
        interrupt: () => {},
        captureEpoch: () => 1,
        isEpochCurrent: () => true,
      },
      voiceAgentSessions: {
        sendTurn,
      },
    });

    expect(appendAssistant).toHaveBeenNthCalledWith(1, {
      conversationSessionId: 'carrier-s1',
      text: 'I sent that to the coding assistant and am waiting for its update.',
    });
    expect(sendTurn.mock.calls[1]?.[1]).toContain('"ok":true');
    expect(appendNote).toHaveBeenCalledWith({
      conversationSessionId: 'carrier-s1',
      text: '[Voice] Tool result: sendSessionMessage succeeded',
    });
  });

  it('resolves implicit tool session ids from the bound target session', async () => {
    const { sendVoiceTextTurn } = await import('./sendVoiceTextTurn');

    const sendTurn = vi
      .fn()
      .mockResolvedValueOnce({
        assistantText: 'I will send that now.',
        actions: [{ t: 'sendSessionMessage', args: { message: 'hello' } }],
      })
      .mockResolvedValueOnce({
        assistantText: 'Done.',
        actions: [],
      });

    await sendVoiceTextTurn({
      sessionId: 'voice-global',
      settings: voiceSettings(),
      userText: 'send hello',
      playbackController: {
        registerStopper: () => () => {},
        interrupt: () => {},
        captureEpoch: () => 1,
        isEpochCurrent: () => true,
      },
      voiceAgentSessions: {
        sendTurn,
      },
    });

    expect(enqueuePendingMessage).toHaveBeenCalledWith('s1', 'hello', undefined, undefined,
      expect.objectContaining({ localId: expect.any(String), requestedAction: expect.anything() }));
  });

  it('rethrows agent-mode send failures after recording the error state', async () => {
    const { sendVoiceTextTurn } = await import('./sendVoiceTextTurn');

    await expect(
      sendVoiceTextTurn({
        sessionId: 'voice-global',
        settings: voiceSettings(),
        userText: 'send hello',
        playbackController: {
          registerStopper: () => () => {},
          interrupt: () => {},
          captureEpoch: () => 1,
          isEpochCurrent: () => true,
        },
        voiceAgentSessions: {
          sendTurn: async () => {
            throw new Error('send_failed');
          },
        },
      }),
    ).rejects.toThrow('voice_turn_dispatch_ambiguous');
  });
});
