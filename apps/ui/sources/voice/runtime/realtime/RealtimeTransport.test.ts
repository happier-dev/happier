import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createModalModuleMock } from '@/dev/testkit/mocks/modal';
import type { IModal } from '@/modal';

const setRealtimeStatus = vi.fn();
const setRealtimeMode = vi.fn();
const clearRealtimeModeDebounce = vi.fn();
const appendRealtimeVoiceTranscriptEvent = vi.fn();
const resolveVoiceSessionBindingByControlSessionId = vi.fn();
const appendSystem = vi.fn();
const appendError = vi.fn();
const machineSetError = vi.fn();
const machineTransitionToAcquiringMic = vi.fn();
const machineTransitionToConnecting = vi.fn();
const machineTransitionToConnected = vi.fn();
const machineTransitionToEnding = vi.fn();
const machineTransitionToDisconnected = vi.fn();
const micEnsureActive = vi.fn(async () => {});
const micTeardown = vi.fn(async () => {});
const micSetMuted = vi.fn();
const disableVoiceBackgroundCallAudioMode = vi.fn(async () => {});
const modalAlert = vi.fn();
const modalMock = createModalModuleMock({
    spies: {
        alert: (...args: Parameters<IModal['alert']>) => {
            modalAlert(...args);
        },
    },
});
let micFailureListener: null | ((failure: { kind: 'mic_ended' | 'audio_context_suspended'; reason: string }) => void) = null;
const fetchHappierVoiceToken = vi.fn(async () => ({
    allowed: true,
    expiresAtMs: Date.now() + 60_000,
    leaseId: 'lease-1',
    token: 'token-1',
}));
const completeHappierVoiceSession = vi.fn(async () => {});
const getCredentials = vi.fn(async () => ({ accessToken: 'token' }));
const ensureBound = vi.fn(async () => {});
const providerHandleProviderMessage = vi.fn((args: { controlSessionId: string | null; payload: unknown }) => {
    const binding = args.controlSessionId
        ? resolveVoiceSessionBindingByControlSessionId({
            controlSessionId: args.controlSessionId,
            adapterId: 'realtime_elevenlabs',
        })
        : null;
    appendRealtimeVoiceTranscriptEvent({
        conversationSessionId: binding?.conversationSessionId ?? null,
        payload: args.payload,
    });
});
const providerHandleProviderConnected = vi.fn();
const providerHandleProviderDisconnected = vi.fn();
const providerHandleProviderDiagnosticsError = vi.fn((reason: string) => {
    appendError(reason);
});
const providerHandleSessionStarted = vi.fn();
const providerHandleSessionEnded = vi.fn(async () => {});
const providerResetActiveSession = vi.fn();
const providerPrepareSessionStart = vi.fn(async (args: {
    controlSessionId: string;
    initialContext?: string;
    textOnly: boolean;
}) => ({
    sessionConfig: {
        sessionId: args.controlSessionId,
        initialContext: args.initialContext,
        token: 'token-1',
        textOnly: args.textOnly,
    },
    sessionState: {
        billingMode: 'happier' as const,
        expiresAtMs: Date.now() + 60_000,
        leaseId: 'lease-1',
    },
}));

vi.mock('@/voice/adapters/realtimeElevenLabs/realtimeElevenLabsTransportProvider', () => ({
    createRealtimeElevenLabsTransportProvider: () => ({
        adapterId: 'realtime_elevenlabs',
        buildConversationStartConfig: ({ config }: { config: Record<string, unknown> }) => ({
            ...config,
        }),
        handleProviderConnected: () => providerHandleProviderConnected(),
        handleProviderDiagnosticsError: (reason: string) => providerHandleProviderDiagnosticsError(reason),
        handleProviderDisconnected: () => providerHandleProviderDisconnected(),
        handleProviderMessage: (args: { controlSessionId: string | null; payload: unknown }) => providerHandleProviderMessage(args),
        handleSessionEnded: () => providerHandleSessionEnded(),
        handleSessionStarted: (args: unknown) => providerHandleSessionStarted(args),
        isSelectedProvider: () => true,
        prepareSessionStart: (args: {
            controlSessionId: string;
            initialContext?: string;
            textOnly: boolean;
        }) => providerPrepareSessionStart(args),
        resetActiveSession: () => providerResetActiveSession(),
        resolveConversationId: ({ rawConversationId, handle }: {
            rawConversationId: unknown;
            handle: { getId?: () => string | null };
        }) => {
            if (typeof rawConversationId === 'string' && rawConversationId.trim().length > 0) {
                return rawConversationId;
            }
            return handle.getId?.() ?? null;
        },
        resolveProviderMode: (mode: string) => (mode === 'speaking' ? 'speaking' : 'idle'),
    }),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        storage: {
            getState: () => ({
                settings: {
                    voice: {
                        providerId: 'realtime_elevenlabs',
                        assistantLanguage: null,
                        adapters: {
                            realtime_elevenlabs: {
                                assistantLanguage: null,
                            },
                        },
                    },
                },
                setRealtimeStatus,
                setRealtimeMode,
                clearRealtimeModeDebounce,
            }),
        },
    });
});

vi.mock('@/voice/runtime/mic/createRealtimeMicSession', () => ({
    createRealtimeMicSession: (options?: { onFailure?: (failure: { kind: 'mic_ended' | 'audio_context_suspended'; reason: string }) => void }) => {
        micFailureListener = options?.onFailure ?? null;
        return {
        ensureActive: () => micEnsureActive(),
        teardown: () => micTeardown(),
        setMuted: (muted: boolean) => micSetMuted(muted),
        isMuted: vi.fn(() => false),
        getStream: vi.fn(() => null),
        };
    },
}));

vi.mock('@/sync/api/voice/apiVoice', () => ({
    completeHappierVoiceSession,
    fetchHappierVoiceToken,
}));

vi.mock('@/voice/binding/voiceConversationBindingRuntime', () => ({
    voiceSessionBindingManager: {
        ensureBound,
        syncTargetSession: vi.fn(),
    },
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentials: () => getCredentials(),
    },
}));

vi.mock('@/modal', () => modalMock.module);

vi.mock('@/voice/runtime/voiceAudioMode', () => ({
    enableVoiceBackgroundCallAudioMode: vi.fn(async () => {}),
    disableVoiceBackgroundCallAudioMode: () => disableVoiceBackgroundCallAudioMode(),
}));

vi.mock('@/voice/binding/VoiceConversationBindingResolver', () => ({
    voiceConversationBindingResolver: {
        resolveByControlSessionId: (params: any) => resolveVoiceSessionBindingByControlSessionId(params),
    },
}));

vi.mock('@/voice/runtime/machine/VoiceConversationRuntimeMachine', () => ({
    createVoiceMachineError: (params: any) => params,
    voiceConversationRuntimeMachine: {
        setError: (params: any) => machineSetError(params),
        transitionToAcquiringMic: (params: any) => machineTransitionToAcquiringMic(params),
        transitionToConnecting: (params: any) => machineTransitionToConnecting(params),
        transitionToConnected: (params: any) => machineTransitionToConnected(params),
        transitionToEnding: (params: any) => machineTransitionToEnding(params),
        transitionToDisconnected: (params: any) => machineTransitionToDisconnected(params),
    },
}));

vi.mock('@/voice/transcript/voiceConversationTranscript', () => ({
    appendVoiceConversationNoteText: vi.fn(),
    projectRealtimeVoiceTranscriptEvent: (params: any) => appendRealtimeVoiceTranscriptEvent(params),
}));

vi.mock('@/voice/qa/voiceQaStore', () => ({
    useVoiceQaStore: {
        getState: () => ({
            appendSystem,
            appendError,
        }),
    },
}));

describe('RealtimeTransport provider event ownership', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        micFailureListener = null;
        providerHandleProviderMessage.mockClear();
        providerHandleProviderConnected.mockClear();
        providerHandleProviderDisconnected.mockClear();
        providerHandleProviderDiagnosticsError.mockClear();
        providerHandleSessionStarted.mockClear();
        providerHandleSessionEnded.mockClear();
        providerResetActiveSession.mockClear();
        providerPrepareSessionStart.mockClear();
        resolveVoiceSessionBindingByControlSessionId.mockReturnValue({
            conversationSessionId: 'carrier-s1',
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('owns provider connected/disconnected mode publication', async () => {
        const { realtimeTransport } = await import('./RealtimeTransport');

        realtimeTransport.setCurrentRealtimeControlSessionId('s1');
        realtimeTransport.handleProviderConnected();
        realtimeTransport.handleProviderModeChange('speaking');
        realtimeTransport.handleProviderDisconnected();

        expect(setRealtimeStatus).toHaveBeenNthCalledWith(1, 'connected');
        expect(setRealtimeMode).toHaveBeenNthCalledWith(1, 'idle', false);
        expect(setRealtimeMode).toHaveBeenNthCalledWith(2, 'speaking', false);
        expect(setRealtimeStatus).toHaveBeenLastCalledWith('disconnected');
        expect(setRealtimeMode).toHaveBeenLastCalledWith('idle', true);
        expect(clearRealtimeModeDebounce).toHaveBeenCalledTimes(1);
    });

    it('mirrors disconnected snapshots as idle even if a stale speaking mode is present', async () => {
        const { RealtimeTransport } = await import('./RealtimeTransport');
        const transport = new RealtimeTransport();

        transport.publishSessionSnapshot({
            adapterId: 'realtime_elevenlabs',
            sessionId: null,
            status: 'disconnected',
            mode: 'speaking',
            canStop: false,
        });

        expect(setRealtimeStatus).toHaveBeenLastCalledWith('disconnected');
        expect(setRealtimeMode).toHaveBeenLastCalledWith('idle', true);
        expect(clearRealtimeModeDebounce).toHaveBeenCalledTimes(1);
    });

    it('surfaces unexpected provider disconnects as machine transport_disconnect errors', async () => {
        const { realtimeTransport } = await import('./RealtimeTransport');

        realtimeTransport.setCurrentRealtimeControlSessionId('s1');
        realtimeTransport.handleProviderConnected();
        realtimeTransport.handleProviderDisconnected();

        expect(machineSetError).toHaveBeenCalledWith(
            expect.objectContaining({
                controlSessionId: 's1',
                error: expect.objectContaining({
                    kind: 'transport_disconnect',
                    recoverable: true,
                }),
            }),
        );
    });

    it('surfaces provider errors through the runtime machine for recovery UI', async () => {
        const { realtimeTransport } = await import('./RealtimeTransport');

        realtimeTransport.setCurrentRealtimeControlSessionId('s1');
        realtimeTransport.handleProviderError(new Error('provider_start_failed'));

        expect(machineSetError).toHaveBeenCalledWith(
            expect.objectContaining({
                controlSessionId: 's1',
                error: expect.objectContaining({
                    kind: 'provider_error',
                    reason: 'realtime_provider_error',
                    recoverable: true,
                }),
            }),
        );
    });

    it('maps browser permission-denied mic failures onto mic_permission_denied recoverable errors', async () => {
        const { RealtimeTransport } = await import('./RealtimeTransport');
        const transport = new RealtimeTransport();
        transport.registerVoiceSession({
            startSession: vi.fn(async () => 'conv_1'),
            endSession: vi.fn(async () => {}),
            sendTextMessage: vi.fn(),
            sendContextualUpdate: vi.fn(),
        });

        micEnsureActive.mockRejectedValueOnce(Object.assign(new Error('Permission denied'), {
            name: 'NotAllowedError',
        }));

        await transport.startRealtimeSession('s1');

        expect(machineSetError).toHaveBeenCalledWith(
            expect.objectContaining({
                controlSessionId: 's1',
                error: expect.objectContaining({
                    kind: 'mic_permission_denied',
                    reason: 'realtime_mic_permission_denied',
                    recoverable: true,
                }),
            }),
        );
    });

    it('does not log raw provider error messages', async () => {
        const { realtimeTransport } = await import('./RealtimeTransport');

        realtimeTransport.setCurrentRealtimeControlSessionId('s1');
        realtimeTransport.handleProviderError(new Error('TOP_SECRET_CONTEXT'));

        expect(JSON.stringify((console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls))
            .not
            .toContain('TOP_SECRET_CONTEXT');
        expect(JSON.stringify((machineSetError as unknown as { mock: { calls: unknown[][] } }).mock.calls))
            .not
            .toContain('TOP_SECRET_CONTEXT');
    });

    it('surfaces provider session start failures through the runtime machine instead of leaf alerts', async () => {
        const { RealtimeTransport } = await import('./RealtimeTransport');
        const transport = new RealtimeTransport();
        transport.registerConversationHandle({
            textOnly: false,
            handle: {
                startSession: vi.fn(async () => {
                    throw new Error('provider_start_failed');
                }),
                endSession: vi.fn(async () => {}),
                getId: vi.fn(() => null),
                sendUserMessage: vi.fn(),
                sendContextualUpdate: vi.fn(),
            } as any,
        });

        await transport.startRealtimeSession('s1');

        expect(machineSetError).toHaveBeenCalledWith(
            expect.objectContaining({
                controlSessionId: 's1',
                error: expect.objectContaining({
                    kind: 'provider_error',
                    reason: 'realtime_provider_error',
                    recoverable: true,
                }),
            }),
        );
        expect(modalAlert).not.toHaveBeenCalled();
    });

    it('does not reject when mic teardown fails after a provider start failure (best-effort cleanup)', async () => {
        // First teardown is fired-and-forgotten inside surfaceRecoverableRealtimeFailure, second teardown
        // is awaited in startRealtimeSession finally. Ensure the awaited path cannot crash the caller.
        micTeardown.mockImplementationOnce(async () => {});
        micTeardown.mockImplementationOnce(async () => {
            throw new Error('mic_teardown_failed');
        });

        const { RealtimeTransport } = await import('./RealtimeTransport');
        const transport = new RealtimeTransport();
        transport.registerConversationHandle({
            textOnly: false,
            handle: {
                startSession: vi.fn(async () => {
                    throw new Error('provider_start_failed');
                }),
                endSession: vi.fn(async () => {}),
                getId: vi.fn(() => null),
                sendUserMessage: vi.fn(),
                sendContextualUpdate: vi.fn(),
            } as any,
        });

        await expect(transport.startRealtimeSession('s1')).resolves.toBeUndefined();
        expect(machineSetError).toHaveBeenCalledWith(
            expect.objectContaining({
                controlSessionId: 's1',
                error: expect.objectContaining({
                    kind: 'provider_error',
                    recoverable: true,
                }),
            }),
        );
    });

    it('falls back to the voice conversation handle when starting a text-only realtime session without a dedicated text handle', async () => {
        const { RealtimeTransport } = await import('./RealtimeTransport');
        const transport = new RealtimeTransport();
        const startSession = vi.fn(async () => 'conv_1');
        transport.registerConversationHandle({
            textOnly: false,
            handle: {
                startSession,
                endSession: vi.fn(async () => {}),
                getId: vi.fn(() => 'conv_1'),
                sendUserMessage: vi.fn(),
                sendContextualUpdate: vi.fn(),
            } as any,
        });

        await transport.startRealtimeSession('s1', 'hi', false, { textOnly: true });

        expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ textOnly: true }));
        expect(machineTransitionToConnecting).toHaveBeenCalledWith({
            controlSessionId: 's1',
        });
    });

    it('transitions through acquiring_mic before connecting for microphone-backed realtime starts', async () => {
        const { RealtimeTransport } = await import('./RealtimeTransport');
        const transport = new RealtimeTransport();
        transport.registerConversationHandle({
            textOnly: false,
            handle: {
                startSession: vi.fn(async () => 'conv_1'),
                endSession: vi.fn(async () => {}),
                getId: vi.fn(() => 'conv_1'),
                sendUserMessage: vi.fn(),
                sendContextualUpdate: vi.fn(),
            } as any,
        });

        await transport.startRealtimeSession('s1');

        expect(machineTransitionToAcquiringMic).toHaveBeenCalledWith({
            controlSessionId: 's1',
        });
        expect(machineTransitionToConnecting).toHaveBeenCalledWith({
            controlSessionId: 's1',
        });
        expect(machineTransitionToAcquiringMic.mock.invocationCallOrder[0]).toBeLessThan(
            machineTransitionToConnecting.mock.invocationCallOrder[0],
        );
    });

    it('does not crash when the outbound audio stats reader throws during watchdog polling', async () => {
        vi.useFakeTimers();
        const endSession = vi.fn(async () => {});
        const statsHandle = {
            connection: {
                getStats: vi.fn(async () => {
                    throw new Error('stats_unavailable');
                }),
            },
        };

        const { RealtimeTransport } = await import('./RealtimeTransport');
        const transport = new RealtimeTransport();
        transport.registerVoiceSession({
            startSession: vi.fn(async () => 'conv_1'),
            endSession,
            sendTextMessage: vi.fn(),
            sendContextualUpdate: vi.fn(),
        });
        transport.setActiveConversationHandle(statsHandle as any);
        transport.setCurrentRealtimeControlSessionId('s1');

        transport.handleProviderConnected();
        await vi.advanceTimersByTimeAsync(15_000);

        expect(endSession).not.toHaveBeenCalled();
        expect(machineSetError).not.toHaveBeenCalledWith(
            expect.objectContaining({
                error: expect.objectContaining({
                    kind: 'mic_plateau',
                }),
            }),
        );
    });

    it('surfaces missing conversation ids as recoverable provider errors instead of leaving the transport stuck connecting', async () => {
        const { RealtimeTransport } = await import('./RealtimeTransport');
        const transport = new RealtimeTransport();
        const endSession = vi.fn(async () => {});
        transport.registerConversationHandle({
            textOnly: false,
            handle: {
                startSession: vi.fn(async () => null),
                endSession,
                getId: vi.fn(() => null),
                sendUserMessage: vi.fn(),
                sendContextualUpdate: vi.fn(),
            } as any,
        });

        await transport.startRealtimeSession('s1');

        expect(machineSetError).toHaveBeenCalledWith(
            expect.objectContaining({
                controlSessionId: 's1',
                error: expect.objectContaining({
                    kind: 'provider_error',
                    reason: 'realtime_missing_conversation_id',
                    recoverable: true,
                }),
            }),
        );
        expect(endSession).toHaveBeenCalledTimes(1);
        expect(setRealtimeStatus).toHaveBeenLastCalledWith('disconnected');
        expect(modalAlert).not.toHaveBeenCalled();
    });

    it('surfaces recoverable web mic failures through the machine and session snapshot owner', async () => {
        const { RealtimeTransport } = await import('./RealtimeTransport');
        const transport = new RealtimeTransport();

        transport.setCurrentRealtimeControlSessionId('s1');
        transport.handleProviderConnected();
        micFailureListener?.({
            kind: 'mic_ended',
            reason: 'web_mic_track_ended',
        });

        expect(machineSetError).toHaveBeenCalledWith(
            expect.objectContaining({
                controlSessionId: 's1',
                error: expect.objectContaining({
                    kind: 'mic_ended',
                    reason: 'web_mic_track_ended',
                    recoverable: true,
                }),
            }),
        );
        expect(micTeardown).toHaveBeenCalledTimes(1);
        expect(disableVoiceBackgroundCallAudioMode).toHaveBeenCalledTimes(1);
        expect(setRealtimeStatus).toHaveBeenLastCalledWith('disconnected');
    });

    it('publishes a transport-owned session snapshot for subscribers', async () => {
        const { realtimeTransport } = await import('./RealtimeTransport');
        const listener = vi.fn();
        const unsubscribe = realtimeTransport.subscribe(listener);

        realtimeTransport.handleProviderConnected();
        realtimeTransport.handleProviderModeChange('speaking');

        expect(realtimeTransport.getSessionSnapshot()).toMatchObject({
            adapterId: 'realtime_elevenlabs',
            sessionId: null,
            status: 'connected',
            mode: 'speaking',
            canStop: true,
        });
        expect(listener).toHaveBeenCalled();

        unsubscribe();
    });

    it('includes the active control session id in connected mode snapshots', async () => {
        const { RealtimeTransport } = await import('./RealtimeTransport');
        const transport = new RealtimeTransport();

        transport.setCurrentRealtimeControlSessionId('s1');
        transport.handleProviderConnected();
        transport.handleProviderModeChange('speaking');

        expect(transport.getSessionSnapshot()).toMatchObject({
            adapterId: 'realtime_elevenlabs',
            sessionId: 's1',
            status: 'connected',
            mode: 'speaking',
            canStop: true,
        });
    });

    it('drives explicit machine lifecycle transitions for realtime connect and clean stop', async () => {
        const { RealtimeTransport } = await import('./RealtimeTransport');
        const transport = new RealtimeTransport();
        const endSession = vi.fn(async () => {
            transport.handleProviderDisconnected();
        });
        transport.registerConversationHandle({
            textOnly: false,
            handle: {
                startSession: vi.fn(async () => 'conv_1'),
                endSession,
                getId: vi.fn(() => 'conv_1'),
                sendUserMessage: vi.fn(),
                sendContextualUpdate: vi.fn(),
            } as any,
        });

        await transport.getConversationBackedVoiceSession().startSession({
            sessionId: 's1',
            token: 'token_1',
        });

        transport.handleProviderConnected();
        await transport.stopRealtimeSession();

        expect(machineTransitionToConnecting).toHaveBeenCalledWith({
            controlSessionId: 's1',
        });
        expect(machineTransitionToConnected).toHaveBeenCalledWith({
            controlSessionId: 's1',
        });
        expect(machineTransitionToEnding).toHaveBeenCalledWith({
            controlSessionId: 's1',
        });
        expect(machineTransitionToDisconnected).toHaveBeenCalledWith({
            controlSessionId: 's1',
        });
        expect(endSession).toHaveBeenCalledTimes(1);
    });

    it('owns provider transcript mirroring through the binding lookup', async () => {
        const { realtimeTransport } = await import('./RealtimeTransport');

        realtimeTransport.setCurrentRealtimeControlSessionId('s1');
        realtimeTransport.handleProviderMessage({
            type: 'agent_response',
            agent_response_event: {
                agent_response: 'hello',
                event_id: 1,
            },
        });

        expect(appendRealtimeVoiceTranscriptEvent).toHaveBeenCalledWith({
            conversationSessionId: 'carrier-s1',
            payload: expect.objectContaining({
                type: 'agent_response',
            }),
        });
    });

    it('forces disconnect and surfaces a recoverable machine error when outbound audio stats plateau', async () => {
        vi.useFakeTimers();
        const endSession = vi.fn(async () => {});
        const statsHandle = {
            connection: {
                getStats: vi.fn(async () => [
                    { type: 'outbound-rtp', kind: 'audio', bytesSent: 128 },
                ]),
            },
        };

        const { RealtimeTransport } = await import('./RealtimeTransport');
        const transport = new RealtimeTransport();
        transport.registerVoiceSession({
            startSession: vi.fn(async () => 'conv_1'),
            endSession,
            sendTextMessage: vi.fn(),
            sendContextualUpdate: vi.fn(),
        });
        transport.setActiveConversationHandle(statsHandle as any);
        transport.setCurrentRealtimeControlSessionId('s1');

        transport.handleProviderConnected();
        await vi.advanceTimersByTimeAsync(15_000);

        expect(endSession).toHaveBeenCalledTimes(1);
        expect(machineSetError).toHaveBeenCalledWith(
            expect.objectContaining({
                controlSessionId: 's1',
                error: expect.objectContaining({
                    kind: 'mic_plateau',
                    recoverable: true,
                }),
            }),
        );
        expect(setRealtimeStatus).toHaveBeenLastCalledWith('disconnected');
        expect(setRealtimeMode).toHaveBeenLastCalledWith('idle', true);
    });

    it('does not surface transport_disconnect when the transport initiated a clean stop', async () => {
        const { RealtimeTransport } = await import('./RealtimeTransport');
        const transport = new RealtimeTransport();
        transport.registerVoiceSession({
            startSession: vi.fn(async () => 'conv_1'),
            endSession: vi.fn(async () => {
                transport.handleProviderDisconnected();
            }),
            sendTextMessage: vi.fn(),
            sendContextualUpdate: vi.fn(),
        });

        transport.setCurrentRealtimeControlSessionId('s1');
        transport.handleProviderConnected();
        await transport.stopRealtimeSession();

        expect(machineSetError).not.toHaveBeenCalledWith(
            expect.objectContaining({
                error: expect.objectContaining({
                    kind: 'transport_disconnect',
                }),
            }),
        );
    });

    it('does not reject when mic teardown fails during stopRealtimeSession cleanup (best-effort cleanup)', async () => {
        micTeardown.mockImplementationOnce(async () => {
            throw new Error('mic_teardown_failed');
        });

        const { RealtimeTransport } = await import('./RealtimeTransport');
        const transport = new RealtimeTransport();
        transport.registerVoiceSession({
            startSession: vi.fn(async () => 'conv_1'),
            endSession: vi.fn(async () => {}),
            sendTextMessage: vi.fn(),
            sendContextualUpdate: vi.fn(),
        });

        transport.setCurrentRealtimeControlSessionId('s1');
        transport.handleProviderConnected();

        await expect(transport.stopRealtimeSession()).resolves.toBeUndefined();
    });

    it('forwards mute commands to both the transport mic session and the active conversation handle', async () => {
        const setConversationMicMuted = vi.fn();
        const { RealtimeTransport } = await import('./RealtimeTransport');
        const transport = new RealtimeTransport();
        transport.registerConversationHandle({
            textOnly: false,
            handle: {
                startSession: vi.fn(async () => 'conv_1'),
                endSession: vi.fn(async () => {}),
                getId: vi.fn(() => 'conv_1'),
                sendUserMessage: vi.fn(),
                sendContextualUpdate: vi.fn(),
                setMicMuted: setConversationMicMuted,
            } as any,
        });

        transport.setMicMuted(true);

        expect(micSetMuted).toHaveBeenCalledWith(true);
        expect(setConversationMicMuted).toHaveBeenCalledWith(true);
        expect(transport.getSessionSnapshot()).toMatchObject({
            micMuted: true,
        });
    });
});
