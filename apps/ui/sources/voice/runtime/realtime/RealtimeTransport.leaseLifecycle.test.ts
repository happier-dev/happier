import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RealtimeTransport } from './RealtimeTransport';
import { voiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import {
    DEFAULT_VOICE_CONVERSATION_RUNTIME_SNAPSHOT,
    setVoiceConversationRuntimeSnapshot,
} from '@/voice/runtime/machine/voiceConversationRuntimeStore';
import { VOICE_RUNTIME_CONFIG_DEFAULTS } from '@/voice/runtime/voiceRuntimeConfigDefaults';

import type { VoiceSessionConfig } from '@/realtime/types';
import type { MicSession } from '@/voice/runtime/mic/MicSession';
import type {
    PreparedRealtimeSessionStart,
    RealtimeTransportProvider,
} from './realtimeTransportProvider';

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((nextResolve, nextReject) => {
        resolve = nextResolve;
        reject = nextReject;
    });
    return { promise, resolve, reject };
}

const RECONNECT = VOICE_RUNTIME_CONFIG_DEFAULTS.realtime.reconnect;
const STALL_MS = VOICE_RUNTIME_CONFIG_DEFAULTS.realtime.inboundWatchdog.stallTimeoutMs;

/**
 * A REAL provider double that models the canonical lease lifecycle:
 *  - `handleSessionStarted` mints/holds an active lease (one per started session).
 *  - `handleSessionEnded` COMPLETES the active lease (the only completion path)
 *    then resets the active session — mirroring the production ElevenLabs
 *    provider's `completeHappierVoiceSession` + `resetActiveSession`.
 *  - `resetActiveSession` only NULLS the active session (no completion).
 *
 * Crucially, `handleSessionEnded`/`resetActiveSession` are NOT stubbed away — the
 * spec exercises the real completion bookkeeping so an orphaned lease (a bare
 * `resetActiveSession` that skips completion) is observable as a started lease
 * that was never completed.
 */
function createLeaseTrackingProvider(): RealtimeTransportProvider & {
    readonly leaseLog: { started: number; completed: number; activeLeaseId: number | null };
} {
    const leaseLog = { started: 0, completed: 0, activeLeaseId: null as number | null };

    const provider: RealtimeTransportProvider = {
        adapterId: 'test_provider',
        buildConversationStartConfig: ({ config }) => config,
        handleProviderConnected: () => {},
        handleProviderDiagnosticsError: () => {},
        handleProviderDisconnected: () => {},
        handleProviderMessage: () => {},
        handleSessionStarted: () => {
            leaseLog.started += 1;
            leaseLog.activeLeaseId = leaseLog.started;
        },
        handleSessionEnded: async () => {
            if (leaseLog.activeLeaseId !== null) {
                leaseLog.completed += 1;
                leaseLog.activeLeaseId = null;
            }
        },
        isSelectedProvider: () => true,
        prepareSessionStart: async ({ controlSessionId, textOnly }): Promise<PreparedRealtimeSessionStart> => ({
            sessionConfig: { sessionId: controlSessionId, token: 'token', textOnly } as VoiceSessionConfig,
            sessionState: { billingMode: 'happier', expiresAtMs: null, leaseId: 'lease' },
        }),
        resetActiveSession: () => {
            // Only nulls — never completes. An orphaned lease stays "started but
            // not completed" if a teardown boundary routes here instead of
            // `handleSessionEnded`.
            leaseLog.activeLeaseId = null;
        },
        resolveConversationId: ({ rawConversationId }) =>
            (typeof rawConversationId === 'string' ? rawConversationId : null),
        resolveProviderMode: (mode) => (mode === 'speaking' ? 'speaking' : 'idle'),
    };

    return Object.assign(provider, { leaseLog });
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

/**
 * A conversation-session double whose `startSession` returns a conversation id.
 * The transport itself drives `provider.handleSessionStarted` (minting the
 * lease) after a successful start, so this double must NOT mint a lease — doing
 * so would double-count.
 */
function createLeaseAwareVoiceSession() {
    return {
        startSession: vi.fn(async (_config: VoiceSessionConfig) => 'conv'),
        endSession: vi.fn(async () => {}),
        sendTextMessage: vi.fn(),
        sendContextualUpdate: vi.fn(),
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

describe('RealtimeTransport — lease lifecycle across reconnect/teardown (F1)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        voiceConversationRuntimeMachine.reset();
        setVoiceConversationRuntimeSnapshot(DEFAULT_VOICE_CONVERSATION_RUNTIME_SNAPSHOT);
    });

    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('completes the prior lease (does not orphan it) when an unexpected drop drives a reconnect', async () => {
        const provider = createLeaseTrackingProvider();
        const transport = createTransport(provider);
        const session = createLeaseAwareVoiceSession();
        transport.registerVoiceSession(session);

        // Live session #1 holds a lease.
        transport.setCurrentRealtimeControlSessionId('s1');
        provider.handleSessionStarted({
            controlSessionId: 's1',
            conversationId: 'conv',
            preparedStart: {
                sessionConfig: { sessionId: 's1', token: 'token' } as VoiceSessionConfig,
                sessionState: { billingMode: 'happier', expiresAtMs: null, leaseId: 'lease' },
            },
        });
        transport.handleProviderConnected();
        expect(provider.leaseLog).toMatchObject({ started: 1, completed: 0 });

        // Unexpected transport drop → recoverable reconnect path.
        transport.handleProviderDisconnected();
        await vi.advanceTimersByTimeAsync(0);

        // The prior lease must be COMPLETED (not orphaned) at the drop boundary.
        expect(provider.leaseLog.completed).toBe(1);
        expect(provider.leaseLog.activeLeaseId).toBeNull();

        // Reconnect mints a FRESH lease for the same control session.
        await vi.advanceTimersByTimeAsync(RECONNECT.baseBackoffMs);
        expect(session.startSession).toHaveBeenCalledTimes(1);
        expect(provider.leaseLog.started).toBe(2);

        // No lease is left dangling: started == completed + the one fresh live lease.
        expect(provider.leaseLog.started - provider.leaseLog.completed).toBe(1);
    });

    it('completes the prior lease when an inbound stall drives a reconnect', async () => {
        const provider = createLeaseTrackingProvider();
        const transport = createTransport(provider);
        const session = createLeaseAwareVoiceSession();
        transport.registerVoiceSession(session);

        transport.setCurrentRealtimeControlSessionId('s1');
        provider.handleSessionStarted({
            controlSessionId: 's1',
            conversationId: 'conv',
            preparedStart: {
                sessionConfig: { sessionId: 's1', token: 'token' } as VoiceSessionConfig,
                sessionState: { billingMode: 'happier', expiresAtMs: null, leaseId: 'lease' },
            },
        });
        transport.handleProviderConnected();
        transport.handleProviderModeChange('speaking');

        // Inbound goes silent during an active turn → stall → recoverable reconnect.
        await vi.advanceTimersByTimeAsync(STALL_MS);

        expect(provider.leaseLog.completed).toBe(1);
        expect(provider.leaseLog.activeLeaseId).toBeNull();

        await vi.advanceTimersByTimeAsync(RECONNECT.baseBackoffMs);
        expect(provider.leaseLog.started).toBe(2);
        expect(provider.leaseLog.started - provider.leaseLog.completed).toBe(1);
    });

    it('completes the lease on component unmount (does not orphan it)', async () => {
        const provider = createLeaseTrackingProvider();
        const transport = createTransport(provider);
        const session = createLeaseAwareVoiceSession();
        transport.registerVoiceSession(session);

        transport.setCurrentRealtimeControlSessionId('s1');
        provider.handleSessionStarted({
            controlSessionId: 's1',
            conversationId: 'conv',
            preparedStart: {
                sessionConfig: { sessionId: 's1', token: 'token' } as VoiceSessionConfig,
                sessionState: { billingMode: 'happier', expiresAtMs: null, leaseId: 'lease' },
            },
        });
        transport.handleProviderConnected();

        transport.handleProviderComponentUnmounted();
        await vi.advanceTimersByTimeAsync(0);

        expect(provider.leaseLog.completed).toBe(1);
        expect(provider.leaseLog.activeLeaseId).toBeNull();
    });

    it('completes a minted lease when start aborts after the provider returns a conversation id', async () => {
        const provider = createLeaseTrackingProvider();
        const transport = createTransport(provider);
        const startSessionCalled = createDeferred<void>();
        const startSessionDeferred = createDeferred<string>();
        const session = {
            startSession: vi.fn(async (_config: VoiceSessionConfig) => {
                startSessionCalled.resolve();
                return startSessionDeferred.promise;
            }),
            endSession: vi.fn(async () => {}),
            sendTextMessage: vi.fn(),
            sendContextualUpdate: vi.fn(),
        };
        transport.registerVoiceSession(session);

        const startPromise = transport.startRealtimeSession('s1');
        await startSessionCalled.promise;

        startSessionDeferred.resolve('conv');
        transport.handleProviderDisconnected();
        await startPromise;
        await vi.advanceTimersByTimeAsync(0);

        expect(session.endSession).toHaveBeenCalledTimes(1);
        expect(provider.leaseLog.started).toBe(1);
        expect(provider.leaseLog.completed).toBe(1);
        expect(provider.leaseLog.activeLeaseId).toBeNull();
        expect(transport.isVoiceSessionStarted()).toBe(false);
        expect(transport.getCurrentRealtimeControlSessionId()).toBeNull();
    });

    it('completes every lease across repeated drop→reconnect cycles until the retry cap (no orphans, incl. budget exhaustion)', async () => {
        const provider = createLeaseTrackingProvider();
        const transport = createTransport(provider);
        // Reconnect attempts keep failing to establish a live session so the loop
        // runs to the retry cap (budget exhaustion).
        const session = {
            startSession: vi.fn(async () => null),
            endSession: vi.fn(async () => {}),
            sendTextMessage: vi.fn(),
            sendContextualUpdate: vi.fn(),
        };
        transport.registerVoiceSession(session);

        transport.setCurrentRealtimeControlSessionId('s1');
        provider.handleSessionStarted({
            controlSessionId: 's1',
            conversationId: 'conv',
            preparedStart: {
                sessionConfig: { sessionId: 's1', token: 'token' } as VoiceSessionConfig,
                sessionState: { billingMode: 'happier', expiresAtMs: null, leaseId: 'lease' },
            },
        });
        transport.handleProviderConnected();

        transport.handleProviderDisconnected();
        // The initial lease is completed at the drop boundary.
        await vi.advanceTimersByTimeAsync(0);
        expect(provider.leaseLog.completed).toBe(1);

        // Drain the entire backoff budget; every failed attempt mints no lease.
        for (let i = 0; i < RECONNECT.maxRetries + 3; i += 1) {
            await vi.advanceTimersByTimeAsync(RECONNECT.maxBackoffMs);
        }

        // Budget exhausted → non-recoverable. No lease is left dangling.
        expect(provider.leaseLog.activeLeaseId).toBeNull();
        expect(provider.leaseLog.started - provider.leaseLog.completed).toBe(0);
    });
});
