import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RealtimeTransport } from './RealtimeTransport';
import { RealtimeProviderAuthError } from './realtimeProviderAuthError';
import { voiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import {
    DEFAULT_VOICE_CONVERSATION_RUNTIME_SNAPSHOT,
    getVoiceConversationRuntimeSnapshot,
    setVoiceConversationRuntimeSnapshot,
} from '@/voice/runtime/machine/voiceConversationRuntimeStore';
import { deriveLocalVoiceSessionSnapshot } from '@/voice/runtime/machine/deriveLocalVoiceSessionSnapshot';
import { VOICE_RUNTIME_CONFIG_DEFAULTS } from '@/voice/runtime/voiceRuntimeConfigDefaults';

import type { VoiceSessionConfig } from '@/realtime/types';
import type { MicSession } from '@/voice/runtime/mic/MicSession';
import type { RealtimeTransportProvider } from './realtimeTransportProvider';

const RECONNECT = VOICE_RUNTIME_CONFIG_DEFAULTS.realtime.reconnect;
const STALL_MS = VOICE_RUNTIME_CONFIG_DEFAULTS.realtime.inboundWatchdog.stallTimeoutMs;

function derivedSnapshot() {
    return deriveLocalVoiceSessionSnapshot('test_provider', getVoiceConversationRuntimeSnapshot());
}

function createProvider(overrides: Partial<RealtimeTransportProvider> = {}): RealtimeTransportProvider {
    return {
        adapterId: 'test_provider',
        buildConversationStartConfig: ({ config }) => config,
        handleProviderConnected: () => {},
        handleProviderDiagnosticsError: () => {},
        handleProviderDisconnected: () => {},
        handleProviderMessage: () => {},
        handleSessionEnded: async () => {},
        handleSessionStarted: () => {},
        isSelectedProvider: () => true,
        prepareSessionStart: async ({ controlSessionId, textOnly }) => ({
            sessionConfig: { sessionId: controlSessionId, token: 'token_1', textOnly } as VoiceSessionConfig,
            sessionState: { billingMode: 'happier', expiresAtMs: null, leaseId: null },
        }),
        resetActiveSession: () => {},
        resolveConversationId: ({ rawConversationId }) =>
            (typeof rawConversationId === 'string' ? rawConversationId : null),
        resolveProviderMode: (mode) => (mode === 'speaking' ? 'speaking' : 'idle'),
        ...overrides,
    };
}

function createMicSession(): MicSession {
    return {
        ensureActive: vi.fn(async () => {}),
        setMuted: vi.fn(),
        isMuted: () => false,
        teardown: vi.fn(async () => {}),
        getStream: () => null,
    };
}

function createTransport(provider: RealtimeTransportProvider): RealtimeTransport {
    return new RealtimeTransport(provider, {
        createMicSession: () => createMicSession(),
        getSettings: () => ({}),
        getStorageState: () =>
            ({
                settings: {},
                setRealtimeStatus: () => {},
                setRealtimeMode: () => {},
                clearRealtimeModeDebounce: () => {},
            }) as any,
        ensureBound: async () => {},
        applyVoiceSessionTargetSelection: () => {},
        enableVoiceBackgroundCallAudioMode: async () => {},
        disableVoiceBackgroundCallAudioMode: async () => {},
        now: () => Date.now(),
    });
}

describe('RealtimeTransport — transient drop reconnect (L5.T2)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        voiceConversationRuntimeMachine.reset();
        setVoiceConversationRuntimeSnapshot(DEFAULT_VOICE_CONVERSATION_RUNTIME_SNAPSHOT);
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('routes a transient drop through the recoverable path (disconnected+retry, not hard error) and reconnects on backoff', async () => {
        const startSession = vi.fn(async () => 'conv_1');
        const transport = createTransport(createProvider());
        transport.registerVoiceSession({
            startSession,
            endSession: vi.fn(async () => {}),
            sendTextMessage: vi.fn(),
            sendContextualUpdate: vi.fn(),
        });

        transport.setCurrentRealtimeControlSessionId('s1');
        transport.handleProviderConnected();

        // Transient transport drop.
        transport.handleProviderDisconnected();

        // The user-visible projection is a graceful, recoverable disconnect — NOT a hard error.
        const afterDrop = derivedSnapshot();
        expect(afterDrop.status).toBe('disconnected');
        expect(afterDrop.errorCode).toBe('transport_disconnect');
        expect(afterDrop.canStop).toBe(false);

        // Reconnect fires after the bounded backoff and re-establishes the SAME control session.
        await vi.advanceTimersByTimeAsync(RECONNECT.baseBackoffMs);
        expect(startSession).toHaveBeenCalledTimes(1);
        expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1' }));
    });

    it('surfaces a non-recoverable hard error after exhausting the retry cap', async () => {
        // Every reconnect attempt fails to connect (startSession returns no id).
        const startSession = vi.fn(async () => null);
        const transport = createTransport(createProvider());
        transport.registerVoiceSession({
            startSession,
            endSession: vi.fn(async () => {}),
            sendTextMessage: vi.fn(),
            sendContextualUpdate: vi.fn(),
        });

        transport.setCurrentRealtimeControlSessionId('s1');
        transport.handleProviderConnected();
        transport.handleProviderDisconnected();

        // Drain every capped backoff window so the budget is exhausted.
        for (let i = 0; i < RECONNECT.maxRetries + 3; i += 1) {
            await vi.advanceTimersByTimeAsync(RECONNECT.maxBackoffMs);
        }

        // After the cap the failure is non-recoverable: a hard error the user must dismiss.
        const finalSnapshot = derivedSnapshot();
        expect(finalSnapshot.status).toBe('error');
        expect(finalSnapshot.canStop).toBe(true);
    });

    it('does not reconnect a non-recoverable drop (permission denied) — surfaces hard error immediately', async () => {
        const startSession = vi.fn(async () => 'conv_1');
        const transport = createTransport(createProvider());
        transport.registerVoiceSession({
            startSession,
            endSession: vi.fn(async () => {}),
            sendTextMessage: vi.fn(),
            sendContextualUpdate: vi.fn(),
        });

        transport.setCurrentRealtimeControlSessionId('s1');
        transport.handleProviderConnected();

        // Permission denial is the canonical non-recoverable boundary.
        transport.handleProviderError(
            Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }),
        );

        await vi.advanceTimersByTimeAsync(RECONNECT.maxBackoffMs * (RECONNECT.maxRetries + 2));

        const snapshot = derivedSnapshot();
        expect(snapshot.status).toBe('error');
        expect(snapshot.errorCode).toBe('mic_permission_denied');
        // Permission denial must never trigger a reconnect attempt.
        expect(startSession).not.toHaveBeenCalled();
    });

    it('does not reconnect a non-recoverable drop (BYO invalid API key, 401) — surfaces hard error immediately', async () => {
        const startSession = vi.fn(async () => 'conv_1');
        const transport = createTransport(createProvider());
        transport.registerVoiceSession({
            startSession,
            endSession: vi.fn(async () => {}),
            sendTextMessage: vi.fn(),
            sendContextualUpdate: vi.fn(),
        });

        transport.setCurrentRealtimeControlSessionId('s1');
        transport.handleProviderConnected();

        // An invalid BYO ElevenLabs API key is a 401 — retrying a bad key is futile,
        // so it must be a hard dismiss-required error, never a recoverable retry loop.
        transport.handleProviderError(
            new RealtimeProviderAuthError({ status: 401, message: 'ElevenLabs token request failed (401)' }),
        );

        await vi.advanceTimersByTimeAsync(RECONNECT.maxBackoffMs * (RECONNECT.maxRetries + 2));

        const snapshot = derivedSnapshot();
        expect(snapshot.status).toBe('error');
        expect(snapshot.canStop).toBe(true);
        // A bad key must never trigger a reconnect attempt.
        expect(startSession).not.toHaveBeenCalled();
    });

    it('a clean stop cancels any pending reconnect', async () => {
        const startSession = vi.fn(async () => null);
        const transport = createTransport(createProvider());
        transport.registerVoiceSession({
            startSession,
            endSession: vi.fn(async () => {}),
            sendTextMessage: vi.fn(),
            sendContextualUpdate: vi.fn(),
        });

        transport.setCurrentRealtimeControlSessionId('s1');
        transport.handleProviderConnected();
        transport.handleProviderDisconnected();

        await transport.stopRealtimeSession();

        // After a clean stop no reconnect attempt should run.
        await vi.advanceTimersByTimeAsync(RECONNECT.maxBackoffMs * (RECONNECT.maxRetries + 2));
        expect(startSession).not.toHaveBeenCalled();
    });
});

describe('RealtimeTransport — inbound stall watchdog (L5.T3)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        voiceConversationRuntimeMachine.reset();
        setVoiceConversationRuntimeSnapshot(DEFAULT_VOICE_CONVERSATION_RUNTIME_SNAPSHOT);
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('classifies an inbound stall during an active turn as a recoverable failure and triggers reconnect', async () => {
        const startSession = vi.fn(async () => 'conv_1');
        const transport = createTransport(createProvider());
        transport.registerVoiceSession({
            startSession,
            endSession: vi.fn(async () => {}),
            sendTextMessage: vi.fn(),
            sendContextualUpdate: vi.fn(),
        });

        transport.setCurrentRealtimeControlSessionId('s1');
        transport.handleProviderConnected();
        // A turn becomes active (agent speaking) — the inbound stream is now expected.
        transport.handleProviderModeChange('speaking');

        // No inbound events arrive for the stall window.
        await vi.advanceTimersByTimeAsync(STALL_MS);

        // The stall is recoverable: graceful disconnected + retry, then a reconnect attempt.
        const afterStall = derivedSnapshot();
        expect(afterStall.status).toBe('disconnected');
        expect(afterStall.errorCode).toBe('transport_disconnect');

        await vi.advanceTimersByTimeAsync(RECONNECT.baseBackoffMs);
        expect(startSession).toHaveBeenCalledTimes(1);
    });

    it('does not false-fire when inbound events keep arriving within the window', async () => {
        const startSession = vi.fn(async () => 'conv_1');
        const transport = createTransport(createProvider());
        transport.registerVoiceSession({
            startSession,
            endSession: vi.fn(async () => {}),
            sendTextMessage: vi.fn(),
            sendContextualUpdate: vi.fn(),
        });

        transport.setCurrentRealtimeControlSessionId('s1');
        transport.handleProviderConnected();
        transport.handleProviderModeChange('speaking');

        // Inbound messages arrive steadily, each one resetting the watchdog.
        for (let i = 0; i < 8; i += 1) {
            await vi.advanceTimersByTimeAsync(STALL_MS - 1);
            transport.handleProviderMessage({ type: 'agent_response_chunk', index: i });
        }

        expect(startSession).not.toHaveBeenCalled();
        const snapshot = derivedSnapshot();
        expect(snapshot.status).toBe('connected');
    });

    it('does not false-fire during legitimate between-turn silence', async () => {
        const startSession = vi.fn(async () => 'conv_1');
        const transport = createTransport(createProvider());
        transport.registerVoiceSession({
            startSession,
            endSession: vi.fn(async () => {}),
            sendTextMessage: vi.fn(),
            sendContextualUpdate: vi.fn(),
        });

        transport.setCurrentRealtimeControlSessionId('s1');
        transport.handleProviderConnected();
        // Connected but no active turn (idle, waiting on the user) — silence is legitimate.
        await vi.advanceTimersByTimeAsync(STALL_MS * 4);

        expect(startSession).not.toHaveBeenCalled();
        expect(derivedSnapshot().status).toBe('connected');
    });
});
