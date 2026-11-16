import { createRequire, Module } from 'node:module';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionMessagesFixture, createToolCallMessageFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { apiSocket } from '@/sync/api/session/apiSocket';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { storage } from '@/sync/domains/state/storageStore';
import { Encryption } from '@/sync/encryption/encryption';
import { sync } from '@/sync/sync';
import { patchLocalVoiceState } from './localVoiceState';
import { toggleReadAloud } from './readAloud';
import { getReadAloudActiveKey } from './readAloudState';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';

const nativeAudio = vi.hoisted(() => ({ prepare: vi.fn(), record: vi.fn(), stop: vi.fn() }));
const expoSpeechSpeak = vi.hoisted(() => vi.fn<(text: string, options?: { onDone?: () => void }) => void>());
const expoSpeechStop = vi.hoisted(() => vi.fn(async () => {}));
const recognition = vi.hoisted(() => {
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    return {
        listeners,
        start: vi.fn(),
        stop: vi.fn(() => {
            listeners.get('result')?.({ isFinal: true, results: [{ transcript: 'discard this input' }] });
            listeners.get('end')?.({});
        }),
    };
});
vi.mock('expo-speech', () => ({ speak: expoSpeechSpeak, stop: expoSpeechStop }));
// Boundary: the native speech recognizer; endpointing and input cancellation remain real.
vi.mock('expo-speech-recognition', () => ({ ExpoSpeechRecognitionModule: {
    isRecognitionAvailable: () => true,
    requestPermissionsAsync: async () => ({ granted: true }),
    start: recognition.start,
    stop: recognition.stop,
    addListener: (event: string, listener: (event: Record<string, unknown>) => void) => {
        recognition.listeners.set(event, listener);
        return { remove: () => recognition.listeners.delete(event) };
    },
} }));
vi.mock('expo-audio', () => ({
    RecordingPresets: { HIGH_QUALITY: { extension: '.m4a' } },
    AudioModule: {
        requestRecordingPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
        setAudioModeAsync: async () => {},
        AudioRecorder: class {
            uri: string | null = null;
            async prepareToRecordAsync() { await nativeAudio.prepare(); }
            record() { nativeAudio.record(); }
            async stop() {
                await nativeAudio.stop();
                this.uri = 'file:///tmp/voice-turn.m4a';
            }
        },
    },
}));

// Native require must reach the real singleton already loaded by Vitest.
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

const initialStorageState = storage.getState();
const initialEncryption = Reflect.get(sync, 'encryption');
const accountId = 'voice-turn-lifecycle-account';
let submitMessage: MockInstance<typeof sync.submitMessage>;
let rejectSubmission = false;
let transcriptionRequests = 0;

let localVoiceEngine: typeof import('./localVoiceEngine');

function configureDirectVoice(params: Readonly<{ autoSpeakReplies: boolean }>) {
    const settings = storage.getState().settings;
    storage.setState({
        settings: {
            ...settings,
            voice: voiceSettingsParse({ providerId: 'local_direct', adapters: { local_direct: {
                stt: { provider: 'openai_compat', openaiCompat: { baseUrl: 'https://stt.example.test', model: 'whisper-1' } },
                tts: { provider: 'device', autoSpeakReplies: params.autoSpeakReplies },
            } } }),
        },
    });
}

/** The server projection binds the submitted input to its own received turn. */
function setTurn(localId: string, status: 'in_progress' | 'completed', replies: readonly Message[]) {
    const now = Date.now();
    const user: Message = { id: 'voice-user', kind: 'user-text', text: 'run the tests', seq: 10, localId, createdAt: now };
    const messages = [user, ...replies];
    storage.setState(state => ({
        sessions: { ...state.sessions, s1: {
            ...state.sessions.s1!, latestTurnId: 'turn-1', latestTurnStatus: status, latestTurnStatusObservedAt: now,
            sessionTurns: { v: 1, sessionId: 's1', latestTurnId: 'turn-1', updatedAt: now, turns: [{
                turnId: 'turn-1', status, startedAt: now, updatedAt: now,
                transcriptAnchors: { startUserMessageSeq: 10, userMessageSeqs: [10],
                    ...(status === 'completed' ? { endSeqInclusive: Math.max(10, ...replies.map(message => message.seq ?? 10)) } : {}) },
            }] },
        } },
        sessionMessages: { ...state.sessionMessages, s1: createSessionMessagesFixture({
            messageIdsOldestFirst: messages.map(message => message.id),
            messagesById: Object.fromEntries(messages.map(message => [message.id, message])),
        }) },
    }));
}

async function readSubmittedLocalId(): Promise<string> {
    await vi.waitFor(() => expect(submitMessage).toHaveBeenCalledTimes(1));
    const submission = await submitMessage.mock.results[0]!.value;
    expect(submission.localId).toEqual(expect.any(String));
    return submission.localId!;
}

describe('local voice engine turn lifecycle (direct session)', () => {
    beforeEach(async () => {
        storage.setState(initialStorageState, true);
        storage.getState().activateProfileScope({ serverId: getActiveServerSnapshot().serverId, accountId });
        const now = Date.now();
        storage.setState({ sessions: { s1: createSessionFixture({
            id: 's1', active: true, activeAt: now, encryptionMode: 'plain', pendingCount: 0, pendingVersion: 0,
            latestTurnId: 'turn-0', latestTurnStatus: 'completed', latestTurnStatusObservedAt: now - 5_000,
            sessionTurns: { v: 1, sessionId: 's1', latestTurnId: 'turn-0', updatedAt: now, turns: [{
                turnId: 'turn-0', status: 'completed', startedAt: 1, updatedAt: now,
                transcriptAnchors: { startUserMessageSeq: 1, userMessageSeqs: [1], endSeqInclusive: 2 },
            }] },
        }) } });
        Reflect.set(sync, 'encryption', Encryption.createWithoutKeyMaterial());
        const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token, secret: '' });
        rejectSubmission = false;
        transcriptionRequests = 0;
        vi.stubGlobal('fetch', vi.fn<typeof fetch>(async input => {
            const url = input instanceof Request ? input.url : String(input);
            if (url === 'https://stt.example.test/v1/audio/transcriptions') {
                transcriptionRequests += 1;
                return Response.json({ text: 'run the tests' });
            }
            if (!url.endsWith('/v1/features')) throw new Error(`Unexpected HTTP request: ${url}`);
            return Response.json({
                features: { voice: { enabled: true }, sharing: { pendingQueueV2: { enabled: true }, pendingDeliveryState: { enabled: true } } },
                capabilities: { compatibility: { pendingInput: { currentPendingInputProtocolVersion: 1 } },
                    session: { pendingInput: { protocolVersion: 1 } } },
            });
        }));
        const pendingRows = new Map<string, Record<string, unknown>>();
        // HTTP acknowledgements are simulated; submission, outbox and transcript owners stay real.
        vi.spyOn(apiSocket, 'request').mockImplementation(async (path, init) => {
            if (path !== '/v2/sessions/s1/pending') throw new Error(`Unexpected pending route: ${path}`);
            if (init?.method === 'GET') {
                return Response.json({ pending: [...pendingRows.values()], pendingCount: pendingRows.size, pendingVersion: pendingRows.size });
            }
            if (init?.method !== 'POST') throw new Error(`Unexpected pending method: ${init?.method}`);
            if (rejectSubmission) return Response.json({ error: 'invalid input' }, { status: 400 });
            // This boundary fixture reads the HTTP request and echoes the server's accepted envelope.
            const body = JSON.parse(String(init?.body)) as { localId: string; content: unknown; requestedAction: unknown };
            const row = { localId: body.localId, content: body.content, status: 'queued', position: pendingRows.size,
                createdAt: 1, updatedAt: 1, discardedAt: null, discardedReason: null, authorAccountId: accountId,
                requestedAction: body.requestedAction, messageRole: 'user', deliveryStatus: { status: 'queued' } };
            pendingRows.set(body.localId, row);
            return Response.json({ didWrite: true, requestedAction: body.requestedAction, pending: row,
                pendingCount: pendingRows.size, pendingVersion: pendingRows.size });
        });
        submitMessage = vi.spyOn(sync, 'submitMessage');
        nativeAudio.record.mockClear();
        nativeAudio.prepare.mockReset();
        nativeAudio.stop.mockClear();
        recognition.start.mockClear();
        recognition.stop.mockClear();
        recognition.listeners.clear();
        expoSpeechSpeak.mockReset().mockImplementation((_text, options) => options?.onDone?.());
        expoSpeechStop.mockClear();
        patchLocalVoiceState({ status: 'idle', sessionId: null, error: null });
        localVoiceEngine = await import('./localVoiceEngine');
    }, 180_000);

    afterEach(async () => {
        await localVoiceEngine.stopLocalVoiceSession();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        Reflect.set(sync, 'encryption', initialEncryption);
        storage.setState(initialStorageState, true);
    });

    it('stops standalone message playback before starting the microphone', async () => {
        configureDirectVoice({ autoSpeakReplies: true });
        storage.setState(state => ({ settings: { ...state.settings, experiments: true, featureToggles: { voice: true } } }));
        await getServerFeaturesSnapshot({ force: true });
        let finish: (() => void) | undefined;
        expoSpeechSpeak.mockImplementation((_text, options) => { finish = options?.onDone; });
        const reading = toggleReadAloud({ key: 'message-1', text: 'Read this message', settings: storage.getState().settings });
        try {
            expect(getReadAloudActiveKey()).toBe('message-1');
            await localVoiceEngine.toggleLocalVoiceTurn('s1');
            expect(localVoiceEngine.getLocalVoiceState().status).toBe('recording');
            expect(expoSpeechStop).toHaveBeenCalledTimes(1);
            expect(getReadAloudActiveKey()).toBeNull();
        } finally {
            finish?.();
            await reading;
        }
    });

    it('cancels an active microphone recording before reading a message without sending it', async () => {
        configureDirectVoice({ autoSpeakReplies: true });
        storage.setState(state => ({ settings: { ...state.settings, experiments: true, featureToggles: { voice: true } } }));
        await getServerFeaturesSnapshot({ force: true });
        await localVoiceEngine.toggleLocalVoiceTurn('s1');
        expect(localVoiceEngine.getLocalVoiceState().status).toBe('recording');
        expoSpeechSpeak.mockImplementation((_text, options) => {
            expect(nativeAudio.stop).toHaveBeenCalledTimes(1);
            expect(localVoiceEngine.getLocalVoiceState()).toMatchObject({ status: 'idle', sessionId: 's1' });
            options?.onDone?.();
        });

        await expect(toggleReadAloud({ key: 'message-1', text: 'Read this message', settings: storage.getState().settings })).resolves.toBe(true);

        expect(expoSpeechSpeak).toHaveBeenCalledTimes(1);
        expect(transcriptionRequests).toBe(0);
        expect(submitMessage).not.toHaveBeenCalled();
        expect(localVoiceEngine.getLocalVoiceState()).toMatchObject({ status: 'idle', sessionId: 's1' });
    });

    it('can stop read-aloud while microphone cancellation is still preparing playback', async () => {
        configureDirectVoice({ autoSpeakReplies: true });
        storage.setState(state => ({ settings: { ...state.settings, experiments: true, featureToggles: { voice: true } } }));
        await getServerFeaturesSnapshot({ force: true });
        await localVoiceEngine.toggleLocalVoiceTurn('s1');
        let finishStop: (() => void) | undefined;
        nativeAudio.stop.mockImplementationOnce(() => new Promise<void>(resolve => { finishStop = resolve; }));
        const reading = toggleReadAloud({ key: 'message-1', text: 'Read this message', settings: storage.getState().settings });
        expect(getReadAloudActiveKey()).toBe('message-1');
        expect(expoSpeechSpeak).not.toHaveBeenCalled();
        await toggleReadAloud({ key: 'message-1', text: 'Read this message', settings: storage.getState().settings });
        expect(getReadAloudActiveKey()).toBeNull();
        finishStop?.();
        await reading;
        expect(expoSpeechSpeak).not.toHaveBeenCalled();
        expect(transcriptionRequests).toBe(0);
        expect(submitMessage).not.toHaveBeenCalled();
    });

    it.each([false, true])('finishes and discards pending microphone preparation before starting read-aloud (replace: %s)', async (replace) => {
        configureDirectVoice({ autoSpeakReplies: true });
        storage.setState(state => ({ settings: { ...state.settings, experiments: true, featureToggles: { voice: true } } }));
        await getServerFeaturesSnapshot({ force: true });
        let finishPrepare: (() => void) | undefined;
        nativeAudio.prepare.mockImplementationOnce(() => new Promise<void>(resolve => { finishPrepare = resolve; }));
        const starting = localVoiceEngine.toggleLocalVoiceTurn('s1');
        await vi.waitFor(() => expect(nativeAudio.prepare).toHaveBeenCalledTimes(1));
        const reading = toggleReadAloud({ key: 'pending-start', text: 'Read this message', settings: storage.getState().settings });
        const replacement = replace ? toggleReadAloud({ key: 'replacement', text: 'Read the replacement', settings: storage.getState().settings }) : null;
        const spokeDuringPreparation = expoSpeechSpeak.mock.calls.length > 0;
        finishPrepare?.();
        await starting;
        await reading;
        if (replacement) await replacement;
        expect(spokeDuringPreparation).toBe(false);
        expect(nativeAudio.stop).toHaveBeenCalledTimes(1);
        expect(expoSpeechSpeak).toHaveBeenCalledTimes(1);
        expect(expoSpeechSpeak).toHaveBeenCalledWith(replace ? 'Read the replacement' : 'Read this message', expect.any(Object));
        expect(localVoiceEngine.getLocalVoiceState()).toMatchObject({ status: 'idle', sessionId: 's1' });
        expect(transcriptionRequests).toBe(0);
        expect(submitMessage).not.toHaveBeenCalled();
    });

    it('uses the current TTS configuration after waiting for microphone cancellation', async () => {
        configureDirectVoice({ autoSpeakReplies: true });
        storage.setState(state => ({ settings: { ...state.settings, experiments: true, featureToggles: { voice: true },
            voice: voiceSettingsParse({ providerId: 'local_direct', adapters: { local_direct: {
                stt: { provider: 'openai_compat', openaiCompat: { baseUrl: 'https://stt.example.test' } },
                tts: { provider: 'openai_compat', openaiCompat: { baseUrl: 'https://old-tts.example.test' } },
            } } }),
        } }));
        await getServerFeaturesSnapshot({ force: true });
        await localVoiceEngine.toggleLocalVoiceTurn('s1');
        let finishStop: (() => void) | undefined;
        nativeAudio.stop.mockImplementationOnce(() => new Promise<void>(resolve => { finishStop = resolve; }));
        const reading = toggleReadAloud({ key: 'configuration-switch', text: 'Read privately', settings: storage.getState().settings });
        configureDirectVoice({ autoSpeakReplies: true });
        finishStop?.();
        await expect(reading).resolves.toBe(true);
        expect(expoSpeechSpeak).toHaveBeenCalledWith('Read privately', expect.any(Object));
        expect(submitMessage).not.toHaveBeenCalled();
    });

    it('does not start speech when the microphone cannot be stopped', async () => {
        configureDirectVoice({ autoSpeakReplies: true });
        storage.setState(state => ({ settings: { ...state.settings, experiments: true, featureToggles: { voice: true } } }));
        await getServerFeaturesSnapshot({ force: true });
        await localVoiceEngine.toggleLocalVoiceTurn('s1');
        nativeAudio.stop.mockRejectedValueOnce(new Error('microphone stop failed'));

        await expect(toggleReadAloud({ key: 'message-1', text: 'Read this message', settings: storage.getState().settings })).resolves.toBe(false);

        expect(expoSpeechSpeak).not.toHaveBeenCalled();
        expect(getReadAloudActiveKey()).toBeNull();
        expect(localVoiceEngine.getLocalVoiceState()).toMatchObject({ status: 'recording', sessionId: 's1', error: 'recording_stop_failed' });
        expect(transcriptionRequests).toBe(0);
        expect(submitMessage).not.toHaveBeenCalled();
    });

    it('discards device recognition and disables hands-free rearming before reading a message', async () => {
        storage.setState(state => ({ settings: { ...state.settings, experiments: true, featureToggles: { voice: true },
            voice: voiceSettingsParse({ providerId: 'local_direct', adapters: { local_direct: {
                stt: { provider: 'device' }, tts: { provider: 'device' }, handsFree: { enabled: true },
            } } }),
        } }));
        await getServerFeaturesSnapshot({ force: true });
        await localVoiceEngine.toggleLocalVoiceTurn('s1');
        expect(localVoiceEngine.getLocalVoiceState().status).toBe('recording');
        await toggleReadAloud({ key: 'message-1', text: 'Read this message', settings: storage.getState().settings });
        expect(recognition.stop).toHaveBeenCalledTimes(1);
        expect(recognition.start).toHaveBeenCalledTimes(1);
        expect(expoSpeechSpeak).toHaveBeenCalledTimes(1);
        expect(submitMessage).not.toHaveBeenCalled();
        expect(localVoiceEngine.getLocalVoiceState()).toMatchObject({ status: 'idle', sessionId: 's1' });
    });

    it('speaks the final reply of the turn instead of thinking or interim text', async () => {
        configureDirectVoice({ autoSpeakReplies: true });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');
        const turnPromise = toggleLocalVoiceTurn('s1');
        const localId = await readSubmittedLocalId();
        const thinking: Message = { id: 't1', kind: 'agent-text', text: 'thinking about it', isThinking: true,
            seq: 11, localId: null, createdAt: Date.now() };
        const interim: Message = { id: 'a1', kind: 'agent-text', text: 'Let me run them.',
            seq: 12, localId: null, createdAt: Date.now() };
        setTurn(localId, 'in_progress', [thinking, interim]);
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(expoSpeechSpeak).not.toHaveBeenCalled();

        setTurn(localId, 'completed', [thinking, interim,
            createToolCallMessageFixture({ id: 'tc1', seq: 13, tool: { name: 'Bash', state: 'completed', input: {},
                createdAt: 1, startedAt: 1, completedAt: 2, description: null } }),
            { id: 'a2', kind: 'agent-text', text: 'All tests pass.', seq: 14, localId: null, createdAt: Date.now() },
        ]);
        await turnPromise;

        expect(transcriptionRequests).toBe(1);
        expect(submitMessage).toHaveBeenCalledWith('s1', 'run the tests', undefined, undefined,
            { callerSurface: 'voice_turn', forceImmediate: true });
        expect(expoSpeechSpeak).toHaveBeenCalledTimes(1);
        expect(expoSpeechSpeak.mock.calls[0]?.[0]).toBe('All tests pass.');
        expect(getLocalVoiceState()).toMatchObject({ status: 'idle', sessionId: 's1' });
    });

    it('does not restore the voice session when the user hangs up while the reply is speaking', async () => {
        configureDirectVoice({ autoSpeakReplies: true });
        const onDoneRef: { current: (() => void) | undefined } = { current: undefined };
        expoSpeechSpeak.mockImplementation((_text, opts) => {
            onDoneRef.current = opts?.onDone;
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState, stopLocalVoiceSession } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');
        const turnPromise = toggleLocalVoiceTurn('s1');
        const localId = await readSubmittedLocalId();
        setTurn(localId, 'completed', [{ id: 'a1', kind: 'agent-text', text: 'Done.', seq: 11, localId: null, createdAt: Date.now() }]);
        await vi.waitFor(() => expect(getLocalVoiceState().status).toBe('speaking'));

        await stopLocalVoiceSession();
        expect(getLocalVoiceState()).toMatchObject({ status: 'idle', sessionId: null });
        // The platform reports playback completion only after the hang-up finished.
        onDoneRef.current?.();
        await turnPromise;

        expect(getLocalVoiceState()).toMatchObject({ status: 'idle', sessionId: null });
    });

    it('ignores a mic tap while the reply is pending instead of recording after the turn', async () => {
        configureDirectVoice({ autoSpeakReplies: true });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');
        const turnPromise = toggleLocalVoiceTurn('s1');
        const localId = await readSubmittedLocalId();
        setTurn(localId, 'in_progress', []);
        await vi.waitFor(() => expect(getLocalVoiceState().status).toBe('sending'));

        const tapPromise = toggleLocalVoiceTurn('s1');
        setTurn(localId, 'completed', []);
        await turnPromise;
        await tapPromise;

        expect(nativeAudio.record).toHaveBeenCalledTimes(1);
        expect(getLocalVoiceState()).toMatchObject({ status: 'idle', sessionId: 's1' });
    });

    it('surfaces a rejected HTTP submission with its root message without rejecting the turn', async () => {
        configureDirectVoice({ autoSpeakReplies: false });
        rejectSubmission = true;

        const { toggleLocalVoiceTurn, getLocalVoiceState } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');
        await expect(toggleLocalVoiceTurn('s1')).resolves.toBeUndefined();

        expect(transcriptionRequests).toBe(1);
        expect(getLocalVoiceState()).toMatchObject({
            status: 'idle',
            sessionId: 's1',
            error: 'send_failed',
            errorMessage: 'Failed to enqueue pending message (400)',
        });
    });
});
