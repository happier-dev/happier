import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { renderScreen } from '@/dev/testkit';

import {
    daemonVoiceAgentCancelTurnStream,
    createdAudioPlayers,
    daemonVoiceAgentReadTurnStream,
    daemonVoiceAgentSendTurn,
    daemonVoiceAgentStart,
    daemonVoiceAgentStartTurnStream,
    daemonVoiceAgentWelcome,
    emitSpeechRecEvent,
    expoSpeechSpeak,
    getStorage,
    loadLocalVoiceEngineWithCompatState,
    registerLocalVoiceEngineHarnessHooks,
    routerNavigate,
    sessionRpcWithServerScope,
    setActiveServerAndSwitch,
    sessionExecutionRunStart,
    sendSessionMessageWithServerScope,
    sendMessage,
    speechRecStart,
    speechRecStop,
    audioSessionRelease,
} from './localVoiceEngine.testHarness';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { VOICE_TOOL_RESULTS_JSON_PREFIX } from '@happier-dev/protocol';
import type { CurrentUiContextSnapshotV1 } from '@happier-dev/protocol/plugins/ui';
import {
    attachVoiceAgentActionEffectId,
    type VoiceAgentClient,
} from '@/voice/agent/types';

const warmDaemonVoiceInferenceOnVoiceHomeAttachMock = vi.hoisted(() => vi.fn());

vi.mock('@/voice/runtime/daemonInference/warmDaemonVoiceInferenceOnVoiceHomeAttach', () => ({
    warmDaemonVoiceInferenceOnVoiceHomeAttach: (...args: any[]) => warmDaemonVoiceInferenceOnVoiceHomeAttachMock(...args),
}));

type VoiceAgentTurnStreamReadResult = Awaited<ReturnType<VoiceAgentClient['readTurnStream']>>;

type MockWithCalls = {
    mock: {
        calls: unknown[][];
    };
};

async function waitForCondition(check: () => boolean, timeoutMessage: string) {
    await vi.waitFor(() => {
        expect(check(), timeoutMessage).toBe(true);
    });
}

async function waitForMockCalls(mock: MockWithCalls, expectedCount: number) {
    await waitForCondition(() => mock.mock.calls.length >= expectedCount, `mock call count ${expectedCount}`);
}

async function flushMicrotasks(iterations: number) {
    for (let i = 0; i < iterations; i++) {
        await Promise.resolve();
    }
}

async function waitForCreatedAudioPlayerListener(eventName: string) {
    await waitForCondition(() => createdAudioPlayers[0]?.__hasListener?.(eventName) === true, `audio player listener: ${eventName}`);
}

async function waitForCreatedAudioPlayer() {
    await waitForCondition(() => createdAudioPlayers.length > 0, 'created audio player');
}

let localVoiceEngine: Awaited<ReturnType<typeof loadLocalVoiceEngineWithCompatState>>;
let useVoiceTargetStore: typeof import('@/voice/runtime/voiceTargetStore').useVoiceTargetStore;

describe('local voice engine agent behavior', () => {
    registerLocalVoiceEngineHarnessHooks({ resetModulesBetweenTests: false });

    beforeEach(async () => {
        warmDaemonVoiceInferenceOnVoiceHomeAttachMock.mockReset();
        warmDaemonVoiceInferenceOnVoiceHomeAttachMock.mockResolvedValue(undefined);
        ({ useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore'));
        localVoiceEngine = await loadLocalVoiceEngineWithCompatState();
    }, 180_000);

    afterEach(async () => {
        await localVoiceEngine.stopLocalVoiceSession();
        await localVoiceEngine.stopLocalVoiceAgent('s1');
        await localVoiceEngine.stopLocalVoiceAgent(VOICE_AGENT_GLOBAL_SESSION_ID);

        const [
            { voiceConversationRuntimeMachine },
            { resetVoiceSessionRuntimeStateForTests },
            { voiceSessionBindingStore },
        ] = await Promise.all([
            import('@/voice/runtime/machine/VoiceConversationRuntimeMachine'),
            import('@/voice/session/voiceSessionStore'),
            import('@/voice/binding/voiceConversationBindingStore'),
        ]);
        voiceConversationRuntimeMachine.reset();
        await resetVoiceSessionRuntimeStateForTests();

        for (const binding of voiceSessionBindingStore.getState().list()) {
            voiceSessionBindingStore.getState().unbind(binding.conversationSessionId);
        }
        voiceSessionBindingStore.getState().replacePersistedBindings([]);

        const targetState = useVoiceTargetStore.getState();
        targetState.setScope('global');
        targetState.setPrimaryActionSessionId(null);
        targetState.setTrackedSessionIds([]);
        targetState.setLastFocusedSessionId(null);
        vi.restoreAllMocks();
    });









    it('keeps the selected daemon owner retryable when its execution run is unsupported', async () => {
        const storage = await getStorage();
        const readyMachine = {
            ...storage.getState().machines['machine-1'],
            active: true,
            activeAt: Date.now(),
        };
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_conversation',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_conversation: { schemaVersion: 1, config: {
                            ...storage.getState().settings.voice.providers.local_conversation.config,
                            conversationMode: 'agent',
                            stt: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.stt,
                                baseUrl: 'http://localhost:8000',
                            },
                            tts: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.tts,
                                autoSpeakReplies: false,
                            },
                        } },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', active: true, presence: 'online', modelMode: 'session-model', metadata: { flavor: 'claude' } },
            },
            machines: {
                ...storage.getState().machines,
                'machine-1': readyMachine,
            },
            machineListByServerId: {
                ...storage.getState().machineListByServerId,
                'server-a': [readyMachine],
            },
        });

        const error: any = new Error('unsupported');
        error.rpcErrorCode = 'VOICE_AGENT_UNSUPPORTED';
        daemonVoiceAgentStart.mockRejectedValueOnce(error);

        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ text: 'hello world' }),
        });

        const { toggleLocalVoiceTurn, getLocalVoiceState } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');
        await toggleLocalVoiceTurn('s1');

        expect(daemonVoiceAgentStart).toHaveBeenCalledTimes(2);
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        expect(
            (globalThis.fetch as any).mock.calls.some((call: any[]) =>
                String(call?.[0] ?? '').includes('/v1/chat/completions'),
            ),
        ).toBe(false);
        expect(sendMessage).not.toHaveBeenCalled();
        expect(getLocalVoiceState()).toMatchObject({
            status: 'idle',
            sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            error: 'send_failed',
        });
    });

    it('recreates daemon agent handle when daemon reports VOICE_AGENT_NOT_FOUND', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_conversation',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_conversation: { schemaVersion: 1, config: {
                            ...storage.getState().settings.voice.providers.local_conversation.config,
                            conversationMode: 'agent',
                            stt: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.stt,
                                baseUrl: 'http://localhost:8000',
                            },
                            tts: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.tts,
                                autoSpeakReplies: false,
                            },
                            agent: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.agent,
                            },
                        } },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
            },
        });

        daemonVoiceAgentStart
            .mockResolvedValueOnce({ voiceAgentId: 'va1' })
            .mockResolvedValueOnce({ voiceAgentId: 'va2' });
        daemonVoiceAgentSendTurn
            .mockRejectedValueOnce(Object.assign(new Error('not found'), { rpcErrorCode: 'VOICE_AGENT_NOT_FOUND' }))
            .mockResolvedValueOnce({ assistantText: 'Recovered reply' });

        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ text: 'hello world' }),
        });

        const { toggleLocalVoiceTurn } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');
        await toggleLocalVoiceTurn('s1');

        expect(daemonVoiceAgentStart).toHaveBeenCalledTimes(2);
        expect(daemonVoiceAgentSendTurn).toHaveBeenCalledTimes(2);
    });

    it('uses daemon streaming agent methods when streaming is enabled', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_conversation',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_conversation: { schemaVersion: 1, config: {
                            ...storage.getState().settings.voice.providers.local_conversation.config,
                            conversationMode: 'agent',
                            stt: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.stt,
                                baseUrl: 'http://localhost:8000',
                            },
                            tts: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.tts,
                                autoSpeakReplies: false,
                            },
                            agent: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.agent,
                            },
                            streaming: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.streaming,
                                enabled: true,
                            },
                        } },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
            },
        });
        daemonVoiceAgentStart.mockResolvedValueOnce({ voiceAgentId: 'va1' });
        daemonVoiceAgentStartTurnStream.mockResolvedValueOnce({ streamId: 'stream-abc' });
        daemonVoiceAgentReadTurnStream.mockResolvedValueOnce({
            streamId: 'stream-abc',
            events: [{ t: 'done', assistantText: 'streamed reply' }],
            nextCursor: 1,
            done: true,
        });

        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ text: 'hello world' }),
        });

        const { toggleLocalVoiceTurn } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');
        await toggleLocalVoiceTurn('s1');

        expect(daemonVoiceAgentStartTurnStream).toHaveBeenCalledTimes(1);
        expect(daemonVoiceAgentReadTurnStream).toHaveBeenCalledTimes(1);
        expect(daemonVoiceAgentSendTurn).not.toHaveBeenCalled();
    });

    it('prewarmOnConnect starts the daemon voice agent when recording begins (before STT completes)', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_conversation',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_conversation: { schemaVersion: 1, config: {
                            ...storage.getState().settings.voice.providers.local_conversation.config,
                            conversationMode: 'agent',
                            stt: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.stt,
                                baseUrl: 'http://localhost:8000',
                            },
                            tts: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.tts,
                                autoSpeakReplies: false,
                            },
                            agent: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.agent,
                                prewarmOnConnect: true,
                            },
                            streaming: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.streaming,
                                enabled: false,
                            },
                        } },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
            },
        });

        daemonVoiceAgentStart.mockResolvedValueOnce({ voiceAgentId: 'va1' });

        const { toggleLocalVoiceTurn } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');

        await flushMicrotasks(4000);

        expect(daemonVoiceAgentStart).toHaveBeenCalledTimes(1);
    });

    it('delivers automatic bounded current UI metadata through the active local agent attempt only', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_conversation',
                    privacy: {
                        ...storage.getState().settings.voice.privacy,
                        currentUiContextMode: 'automatic',
                    },
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_conversation: { schemaVersion: 1, config: {
                            ...storage.getState().settings.voice.providers.local_conversation.config,
                            conversationMode: 'agent',
                            stt: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.stt,
                                baseUrl: 'http://localhost:8000',
                            },
                            tts: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.tts,
                                autoSpeakReplies: false,
                            },
                            agent: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.agent,
                                prewarmOnConnect: true,
                            },
                            streaming: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.streaming,
                                enabled: false,
                            },
                        } },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
            },
        });

        const agentStart = {
            resolve: null as ((value: { voiceAgentId: string }) => void) | null,
        };
        daemonVoiceAgentStart.mockImplementationOnce(
            () => new Promise<{ voiceAgentId: string }>((resolve) => {
                agentStart.resolve = resolve;
            }),
        );
        let snapshot: CurrentUiContextSnapshotV1 | null = {
            navigation: {
                area: 'settings',
                screen: 'settings_page',
                title: 'VOICE_TITLE_SENTINEL',
                presentation: 'screen',
            },
            entity: { kind: 'issue', label: 'PRIVATE_ENTITY_SENTINEL' },
            detail: { secret: 'PRIVATE_DETAIL_SENTINEL' },
            commands: [],
        };
        const currentUiSubscription = {
            listener: null as (() => void) | null,
        };
        const currentUiContext = {
            readCurrentUiContext: vi.fn(() => snapshot),
            resolveCurrentUiCommand: vi.fn(() => null),
            subscribe: vi.fn((nextListener: () => void) => {
                currentUiSubscription.listener = nextListener;
                return () => { currentUiSubscription.listener = null; };
            }),
        };

        const setCurrentUiContextMode = (mode: 'automatic' | 'on_demand' | 'off') => {
            const state = storage.getState();
            storage.__setState({
                settings: {
                    ...state.settings,
                    voice: {
                        ...state.settings.voice,
                        privacy: {
                            ...state.settings.voice.privacy,
                            currentUiContextMode: mode,
                        },
                    },
                },
            });
        };
        const readLastProviderUserText = () => String(
            (daemonVoiceAgentSendTurn.mock.calls.at(-1)?.[0] as { userText?: unknown } | undefined)?.userText ?? '',
        );

        const { voiceSessionBindingManager } = await import('@/voice/binding/voiceConversationBindingRuntime');
        await expect(voiceSessionBindingManager.ensureBound({
            adapterId: 'local_conversation',
            controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            requestedTargetSessionId: null,
        })).resolves.toMatchObject({
            controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            conversationSessionId: 'voice-home-session',
        });

        const { voiceHooks } = await import('@/voice/context/voiceHooks');
        const currentUiContextChangedSpy = vi.spyOn(voiceHooks, 'onCurrentUiContextChanged');

        const toggle = localVoiceEngine.toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID, currentUiContext);
        await waitForMockCalls(daemonVoiceAgentStart, 1);
        await toggle;
        expect(currentUiContext.subscribe).not.toHaveBeenCalled();

        const resolveAgentStart = agentStart.resolve;
        if (!resolveAgentStart) throw new Error('missing local voice agent start resolver');
        resolveAgentStart({ voiceAgentId: 'va1' });
        await waitForMockCalls(currentUiContext.subscribe, 1);

        await localVoiceEngine.sendLocalVoiceAgentTextTurn(
            VOICE_AGENT_GLOBAL_SESSION_ID,
            'What can you see?',
            { localId: 'automatic-current-ui-turn', deliveryCommand: 'interrupt_and_send' },
        );
        const automaticProviderText = readLastProviderUserText();
        expect(automaticProviderText).toContain('CURRENT UI CONTEXT');
        expect(automaticProviderText).toContain('"area":"settings"');
        expect(automaticProviderText).toContain('"screen":"settings_page"');
        expect(automaticProviderText).toContain('VOICE_TITLE_SENTINEL');
        expect(automaticProviderText).not.toContain('PRIVATE_ENTITY_SENTINEL');
        expect(automaticProviderText).not.toContain('PRIVATE_DETAIL_SENTINEL');

        const attemptListener = currentUiSubscription.listener;
        if (!attemptListener) throw new Error('missing local current UI subscription');
        snapshot = null;
        attemptListener();
        attemptListener();
        await localVoiceEngine.sendLocalVoiceAgentTextTurn(
            VOICE_AGENT_GLOBAL_SESSION_ID,
            'Has the screen retired?',
            { localId: 'automatic-current-ui-retirement', deliveryCommand: 'interrupt_and_send' },
        );
        const retirementProviderText = readLastProviderUserText();
        expect(retirementProviderText).toContain('"state":"unavailable"');
        expect(retirementProviderText.match(/CURRENT UI CONTEXT/g)).toHaveLength(1);
        expect(retirementProviderText).not.toContain('PRIVATE_ENTITY_SENTINEL');
        expect(retirementProviderText).not.toContain('PRIVATE_DETAIL_SENTINEL');

        setCurrentUiContextMode('on_demand');
        snapshot = {
            navigation: { area: 'settings', screen: 'settings_page', title: 'ON_DEMAND_NAVIGATION_SENTINEL' },
            commands: [],
        };
        attemptListener();
        await localVoiceEngine.sendLocalVoiceAgentTextTurn(
            VOICE_AGENT_GLOBAL_SESSION_ID,
            'Read only when I ask.',
            { localId: 'on-demand-current-ui-turn', deliveryCommand: 'interrupt_and_send' },
        );
        expect(readLastProviderUserText()).toBe('Read only when I ask.');

        setCurrentUiContextMode('off');
        snapshot = {
            navigation: { area: 'settings', screen: 'settings_page', title: 'OFF_NAVIGATION_SENTINEL' },
            commands: [],
        };
        attemptListener();
        await localVoiceEngine.sendLocalVoiceAgentTextTurn(
            VOICE_AGENT_GLOBAL_SESSION_ID,
            'No current UI context.',
            { localId: 'off-current-ui-turn', deliveryCommand: 'interrupt_and_send' },
        );
        expect(readLastProviderUserText()).toBe('No current UI context.');

        const pendingNativeAudio = {
            release: null as (() => void) | null,
        };
        audioSessionRelease.mockImplementationOnce(
            () => new Promise<void>((resolve) => {
                pendingNativeAudio.release = resolve;
            }),
        );
        const stop = localVoiceEngine.stopLocalVoiceSession();
        await waitForMockCalls(audioSessionRelease, 1);
        expect(currentUiSubscription.listener).toBeNull();
        const releasePendingNativeAudio = pendingNativeAudio.release;
        if (!releasePendingNativeAudio) throw new Error('missing pending native audio release');
        releasePendingNativeAudio();
        await stop;
        const providerCallsAfterStop = daemonVoiceAgentSendTurn.mock.calls.length;
        setCurrentUiContextMode('automatic');
        attemptListener();
        expect(currentUiSubscription.listener).toBeNull();
        expect(daemonVoiceAgentSendTurn).toHaveBeenCalledTimes(providerCallsAfterStop);
        expect(currentUiContextChangedSpy).toHaveBeenCalled();
        expect(currentUiContextChangedSpy.mock.calls.every(([sessionId]) => sessionId === VOICE_AGENT_GLOBAL_SESSION_ID)).toBe(true);
        expect(currentUiContextChangedSpy.mock.calls.some(([sessionId]) => sessionId === 'voice-home-session')).toBe(false);

        const retiringAgentStart = {
            resolve: null as ((value: { voiceAgentId: string }) => void) | null,
        };
        daemonVoiceAgentStart.mockImplementationOnce(
            () => new Promise<{ voiceAgentId: string }>((resolve) => {
                retiringAgentStart.resolve = resolve;
            }),
        );
        const retiringCurrentUiContext = {
            readCurrentUiContext: vi.fn(() => snapshot),
            resolveCurrentUiCommand: vi.fn(() => null),
            subscribe: vi.fn(() => () => {}),
        };
        const retiringToggle = localVoiceEngine.toggleLocalVoiceTurn(
            VOICE_AGENT_GLOBAL_SESSION_ID,
            retiringCurrentUiContext,
        );
        await waitForMockCalls(daemonVoiceAgentStart, 2);
        await retiringToggle;
        expect(retiringCurrentUiContext.subscribe).not.toHaveBeenCalled();

        const retiringNativeAudio = {
            release: null as (() => void) | null,
        };
        audioSessionRelease.mockImplementationOnce(
            () => new Promise<void>((resolve) => {
                retiringNativeAudio.release = resolve;
            }),
        );
        const retiringStop = localVoiceEngine.stopLocalVoiceSession();
        await waitForMockCalls(audioSessionRelease, 2);
        const resolveRetiringAgentStart = retiringAgentStart.resolve;
        if (!resolveRetiringAgentStart) throw new Error('missing retiring local voice agent start resolver');
        resolveRetiringAgentStart({ voiceAgentId: 'va2' });
        await flushMicrotasks(4000);
        expect(retiringCurrentUiContext.subscribe).not.toHaveBeenCalled();
        const releaseRetiringNativeAudio = retiringNativeAudio.release;
        if (!releaseRetiringNativeAudio) throw new Error('missing retiring native audio release');
        releaseRetiringNativeAudio();
        await retiringStop;
    });

    it('does not read or invoke Account B after Account A capture retires during transcription', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_conversation',
                    privacy: {
                        ...storage.getState().settings.voice.privacy,
                        currentUiContextMode: 'on_demand',
                    },
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_conversation: { schemaVersion: 1, config: {
                            ...storage.getState().settings.voice.providers.local_conversation.config,
                            conversationMode: 'agent',
                            stt: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.stt,
                                baseUrl: 'http://localhost:8000',
                            },
                            tts: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.tts,
                                autoSpeakReplies: false,
                            },
                            streaming: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.streaming,
                                enabled: false,
                            },
                        } },
                    },
                },
            },
        });

        let currentAccount: 'account-a' | 'account-b' = 'account-a';
        const readAccounts: Array<'account-a' | 'account-b'> = [];
        const readCurrentUiContext = vi.fn((): CurrentUiContextSnapshotV1 => {
            readAccounts.push(currentAccount);
            return {
                navigation: {
                    area: 'settings',
                    screen: 'settings_page',
                    title: currentAccount === 'account-a'
                        ? 'ACCOUNT_A_CURRENT_UI_SENTINEL'
                        : 'ACCOUNT_B_CURRENT_UI_SENTINEL',
                    presentation: 'screen',
                },
                commands: [],
            };
        });
        const invokeCurrentUiCommand = vi.fn(async () => ({ ok: true as const }));
        const currentUiContext = {
            readCurrentUiContext,
            resolveCurrentUiCommand: vi.fn(() => null),
            subscribe: vi.fn(() => () => {}),
            invokeCurrentUiCommand,
        };

        let resolveTranscription!: (value: { ok: true; json: () => Promise<{ text: string }> }) => void;
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(() => (
            new Promise<{ ok: true; json: () => Promise<{ text: string }> }>((resolve) => {
                resolveTranscription = resolve;
            })
        ));
        daemonVoiceAgentStart.mockResolvedValue({ voiceAgentId: 'va-account-a' });
        daemonVoiceAgentSendTurn
            .mockResolvedValueOnce({
                assistantText: 'Checking the current interface.',
                actions: [
                    { t: 'readCurrentUiContext', args: {} },
                    attachVoiceAgentActionEffectId({
                        t: 'invokeCurrentUiCommand',
                        args: { commandId: 'account-b-command' },
                    }, 'account-retired-current-ui-effect'),
                ],
            })
            .mockResolvedValueOnce({ assistantText: 'Done.', actions: [] });

        await localVoiceEngine.toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID, currentUiContext);
        const pendingTurn = localVoiceEngine.toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);
        await waitForCondition(
            () => (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length === 1,
            'recorded transcription request',
        );
        const daemonTurnsBeforeEnd = daemonVoiceAgentSendTurn.mock.calls.length;
        const currentUiReadsBeforeEnd = readCurrentUiContext.mock.calls.length;
        const currentUiInvocationsBeforeEnd = invokeCurrentUiCommand.mock.calls.length;

        // VoiceSessionRuntime invokes this exact local stop when Account A's
        // active-scope lifetime retires. The raw AppShell port then follows the
        // next render and would otherwise expose Account B after transcription.
        await localVoiceEngine.stopLocalVoiceSession();
        currentAccount = 'account-b';
        resolveTranscription({
            ok: true,
            json: async () => ({ text: 'What is on the screen now?' }),
        });
        await pendingTurn;

        expect(daemonVoiceAgentSendTurn).toHaveBeenCalledTimes(daemonTurnsBeforeEnd);
        expect(readCurrentUiContext).toHaveBeenCalledTimes(currentUiReadsBeforeEnd);
        expect(invokeCurrentUiCommand).toHaveBeenCalledTimes(currentUiInvocationsBeforeEnd);
        expect(readAccounts).not.toContain('account-b');
        expect(invokeCurrentUiCommand).not.toHaveBeenCalled();
    });

    it('suppresses expected daemon-unavailable prewarm errors while still starting the local recording flow', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_conversation',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_conversation: { schemaVersion: 1, config: {
                            ...storage.getState().settings.voice.providers.local_conversation.config,
                            conversationMode: 'agent',
                            stt: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.stt,
                                baseUrl: 'http://localhost:8000',
                            },
                            tts: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.tts,
                                autoSpeakReplies: false,
                            },
                            agent: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.agent,
                                prewarmOnConnect: true,
                            },
                            streaming: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.streaming,
                                enabled: false,
                            },
                        } },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
            },
        });

        const consoleErrorSpy = vi.fn();
        console.error = consoleErrorSpy as any;
        daemonVoiceAgentStart.mockRejectedValueOnce(
            Object.assign(new Error('RPC method not available'), {
                rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            }),
        );

        const { getLocalVoiceState, toggleLocalVoiceTurn } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');

        await flushMicrotasks(4000);

        expect(daemonVoiceAgentStart).toHaveBeenCalledTimes(1);
        expect(consoleErrorSpy).not.toHaveBeenCalled();
        expect(getLocalVoiceState().status).toBe('recording');
    });

    it('welcome (immediate) triggers a daemon welcome action during prewarm on connect', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_conversation',
          welcome: { enabled: true, mode: 'immediate', templateId: null },
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_conversation: { schemaVersion: 1, config: {
                            ...storage.getState().settings.voice.providers.local_conversation.config,
                            conversationMode: 'agent',
                            stt: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.stt,
                                baseUrl: 'http://localhost:8000',
                            },
                            tts: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.tts,
                                provider: 'device',
                                autoSpeakReplies: true,
                            },
                            agent: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.agent,
                                prewarmOnConnect: true,

                            },
                        } },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
            },
        });

        daemonVoiceAgentStart.mockResolvedValueOnce({ voiceAgentId: 'va1' });
        daemonVoiceAgentWelcome.mockResolvedValueOnce({ assistantText: 'Welcome!' });

        const { toggleLocalVoiceTurn } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');

        await waitForMockCalls(daemonVoiceAgentWelcome, 1);

        expect(daemonVoiceAgentWelcome).toHaveBeenCalledTimes(1);
        await waitForMockCalls(expoSpeechSpeak, 1);
        expect(expoSpeechSpeak).toHaveBeenCalled();
    });

    it('prewarmOnConnect warms daemon inference when voice home becomes active', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_conversation',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_conversation: { schemaVersion: 1, config: {
                            ...storage.getState().settings.voice.providers.local_conversation.config,
                            conversationMode: 'agent',
                            stt: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.stt,
                                provider: 'local_neural',
                                localNeural: {
                                    assetId: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17',
                                    language: 'en',
                                    execution: 'daemon',
                                },
                            },
                            tts: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.tts,
                                provider: 'local_neural',
                                autoSpeakReplies: false,
                                localNeural: {
                                    model: 'kokoro',
                                    assetId: 'kokoro-82m-v1.0-onnx-q8-wasm',
                                    voiceId: 'af_heart',
                                    speed: 1,
                                    execution: 'daemon',
                                },
                            },
                            agent: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.agent,
                                prewarmOnConnect: true,
                            },
                            streaming: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.streaming,
                                enabled: false,
                            },
                        } },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
            },
        });

        daemonVoiceAgentStart.mockResolvedValueOnce({ voiceAgentId: 'va1' });

        const { toggleLocalVoiceTurn } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');

        await waitForMockCalls(warmDaemonVoiceInferenceOnVoiceHomeAttachMock, 1);
        expect(warmDaemonVoiceInferenceOnVoiceHomeAttachMock).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
                settings: expect.objectContaining({
                    voice: expect.objectContaining({
                        providerId: 'local_conversation',
                    }),
                }),
            }),
        );
    }, 60_000);

    it('surfaces an attach-time daemon model warm failure through the canonical runtime error state', async () => {
        let rejectWarm!: (error: unknown) => void;
        warmDaemonVoiceInferenceOnVoiceHomeAttachMock.mockReturnValueOnce(
            new Promise<void>((_resolve, reject) => {
                rejectWarm = reject;
            }),
        );
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_conversation',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_conversation: { schemaVersion: 1, config: {
                            ...storage.getState().settings.voice.providers.local_conversation.config,
                            conversationMode: 'agent',
                            tts: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.tts,
                                provider: 'local_neural',
                                autoSpeakReplies: false,
                                localNeural: {
                                    model: 'kokoro',
                                    assetId: 'kokoro-82m-v1.0-onnx-q8-wasm',
                                    voiceId: 'af_heart',
                                    speed: 1,
                                    execution: 'daemon',
                                },
                            },
                        } },
                    },
                },
            },
        });

        const { getLocalVoiceState, toggleLocalVoiceTurn } = localVoiceEngine;
        await toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);
        expect(getLocalVoiceState().status).toBe('recording');

        rejectWarm(Object.assign(
            new Error('daemon_voice_inference_model_not_installed'),
            { code: 'model_not_installed' },
        ));
        await flushMicrotasks(4);

        expect(getLocalVoiceState()).toMatchObject({
            status: 'idle',
            sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            error: 'daemon_voice_inference_model_not_installed',
        });
    }, 60_000);

    it('does not revive a stopped Voice session when its attach-time warm fails late', async () => {
        let rejectWarm!: (error: unknown) => void;
        warmDaemonVoiceInferenceOnVoiceHomeAttachMock.mockReturnValueOnce(
            new Promise<void>((_resolve, reject) => {
                rejectWarm = reject;
            }),
        );

        const {
            getLocalVoiceState,
            stopLocalVoiceSession,
            toggleLocalVoiceTurn,
        } = localVoiceEngine;
        await toggleLocalVoiceTurn('voice-warm-cancelled');
        const warmSignal = warmDaemonVoiceInferenceOnVoiceHomeAttachMock.mock.calls.at(-1)?.[0]?.signal;
        expect(warmSignal).toBeInstanceOf(AbortSignal);
        await stopLocalVoiceSession();
        expect(warmSignal.aborted).toBe(true);

        rejectWarm(Object.assign(
            new Error('daemon_voice_inference_runtime_unavailable'),
            { code: 'runtime_unavailable' },
        ));
        await flushMicrotasks(4);

        expect(getLocalVoiceState()).toMatchObject({
            status: 'idle',
            sessionId: 'voice-warm-cancelled',
            error: null,
        });
    }, 60_000);

    it('resetLocalVoiceAgentPersistence clears persisted run metadata', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_conversation',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_conversation: { schemaVersion: 1, config: {
                            ...storage.getState().settings.voice.providers.local_conversation.config,
                            conversationMode: 'agent',
                            agent: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.agent,
                                prewarmOnConnect: true,
                                transcript: { persistenceMode: 'persistent', epoch: 1 },
                            },
                        } },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                sys_voice: {
                    id: 'sys_voice',
                    modelMode: 'default',
                    metadata: {
                        flavor: 'claude',
                        systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
                        voiceAgentRunV1: { v: 1, runId: 'run_prev', backendId: 'claude', resumeHandle: null, updatedAtMs: 1 },
                    },
                },
            },
            sessionMessages: {
                sys_voice: { isLoaded: true, messages: [] },
            },
        });

        daemonVoiceAgentStart.mockResolvedValueOnce({ voiceAgentId: 'va1' });

        const { toggleLocalVoiceTurn, resetLocalVoiceAgentPersistence } = localVoiceEngine;
        await toggleLocalVoiceTurn(VOICE_AGENT_GLOBAL_SESSION_ID);

        await flushMicrotasks(4000);

        await resetLocalVoiceAgentPersistence();

        expect((storage.getState() as any).sessions.sys_voice.metadata.voiceAgentRunV1).toBeNull();
    });

    it('surfaces send_failed when daemon streaming start is unavailable', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_conversation',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_conversation: { schemaVersion: 1, config: {
                            ...storage.getState().settings.voice.providers.local_conversation.config,
                            conversationMode: 'agent',
                            stt: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.stt,
                                baseUrl: 'http://localhost:8000',
                            },
                            tts: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.tts,
                                autoSpeakReplies: false,
                            },
                            agent: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.agent,
                            },
                            streaming: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.streaming,
                                enabled: true,
                            },
                        } },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
            },
        });

        daemonVoiceAgentStart.mockResolvedValueOnce({ voiceAgentId: 'va1' });
        daemonVoiceAgentStartTurnStream.mockRejectedValueOnce(
            Object.assign(new Error('Method not found'), { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }),
        );

        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ text: 'hello world' }),
        });

        const { getLocalVoiceState, toggleLocalVoiceTurn } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');
        await expect(toggleLocalVoiceTurn('s1')).resolves.toBeUndefined();

        expect(daemonVoiceAgentStartTurnStream).toHaveBeenCalledTimes(1);
        expect(daemonVoiceAgentSendTurn).not.toHaveBeenCalled();
        expect(getLocalVoiceState()).toMatchObject({
            status: 'idle',
            sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            error: 'send_failed',
        });
    });

    it('rethrows a known before-effect streamed-turn rejection for durable delivery', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_conversation',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_conversation: { schemaVersion: 1, config: {
                            ...storage.getState().settings.voice.providers.local_conversation.config,
                            conversationMode: 'agent',
                            tts: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.tts,
                                autoSpeakReplies: false,
                            },
                            agent: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.agent,
                            },
                            streaming: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.streaming,
                                enabled: true,
                            },
                        } },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
            },
        });

        daemonVoiceAgentStart.mockResolvedValueOnce({ voiceAgentId: 'va1' });
        daemonVoiceAgentStartTurnStream.mockRejectedValueOnce(
            Object.assign(new Error('Method not found'), { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }),
        );
        const onAccepted = vi.fn(async () => {});

        await expect(localVoiceEngine.sendLocalVoiceAgentTextTurn(
            's1',
            'durable turn',
            { localId: 'voice-local-before-effect', deliveryCommand: 'interrupt_and_send' },
            onAccepted,
        )).rejects.toMatchObject({
            message: 'Method not found',
            code: 'VOICE_TEXT_TURN_REJECTED_BEFORE_EFFECT',
            pendingDeliveryBlockedReason: 'provider_unavailable_before_acceptance',
        });

        expect(daemonVoiceAgentStartTurnStream).toHaveBeenCalledTimes(1);
        expect(daemonVoiceAgentSendTurn).not.toHaveBeenCalled();
        expect(onAccepted).not.toHaveBeenCalled();
    });

    it('cancels the stream and surfaces send_failed when daemon streaming read is unavailable', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_conversation',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_conversation: { schemaVersion: 1, config: {
                            ...storage.getState().settings.voice.providers.local_conversation.config,
                            conversationMode: 'agent',
                            stt: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.stt,
                                baseUrl: 'http://localhost:8000',
                            },
                            tts: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.tts,
                                autoSpeakReplies: false,
                            },
                            agent: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.agent,
                            },
                            streaming: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.streaming,
                                enabled: true,
                            },
                        } },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
            },
        });

        daemonVoiceAgentStart.mockResolvedValueOnce({ voiceAgentId: 'va1' });
        daemonVoiceAgentStartTurnStream.mockResolvedValueOnce({ streamId: 'stream-1' });
        daemonVoiceAgentReadTurnStream.mockRejectedValueOnce(
            Object.assign(new Error('Method not found'), { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }),
        );

        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ text: 'hello world' }),
        });

        const { getLocalVoiceState, toggleLocalVoiceTurn } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');
        await expect(toggleLocalVoiceTurn('s1')).resolves.toBeUndefined();

        expect(daemonVoiceAgentCancelTurnStream).toHaveBeenCalledTimes(1);
        expect(daemonVoiceAgentSendTurn).not.toHaveBeenCalled();
        expect(getLocalVoiceState()).toMatchObject({
            status: 'idle',
            sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            error: 'send_failed',
        });
    });

    it('interrupts an in-flight local agent text update and surfaces the follow-up assistant reply', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_conversation',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_conversation: { schemaVersion: 1, config: {
                            ...storage.getState().settings.voice.providers.local_conversation.config,
                            conversationMode: 'agent',
                            tts: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.tts,
                                autoSpeakReplies: false,
                            },
                            agent: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.agent,
                            },
                            streaming: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.streaming,
                                enabled: true,
                            },
                        } },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
            },
        });

        daemonVoiceAgentStart.mockResolvedValueOnce({ voiceAgentId: 'va1' });

        let resolveFirstRead: (value: VoiceAgentTurnStreamReadResult) => void = () => {
            throw new Error('Expected first stream read resolver');
        };
        const firstReadPromise = new Promise<VoiceAgentTurnStreamReadResult>((resolve) => {
            resolveFirstRead = resolve;
        });
        daemonVoiceAgentStartTurnStream
            .mockResolvedValueOnce({ streamId: 'stream-1' })
            .mockResolvedValueOnce({ streamId: 'stream-2' });
        daemonVoiceAgentReadTurnStream.mockImplementation(async ({ streamId }: any) => {
            if (streamId === 'stream-1') {
                return await firstReadPromise;
            }
            return {
                streamId,
                events: [{ t: 'done', assistantText: 'Permission summary', actions: [] }],
                nextCursor: 1,
                done: true,
            };
        });

        const { voiceSessionBindingManager } = await import('@/voice/binding/voiceConversationBindingRuntime');
        await expect(voiceSessionBindingManager.ensureBound({
            adapterId: 'local_conversation',
            controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            requestedTargetSessionId: null,
        })).resolves.toMatchObject({
            controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            conversationSessionId: 'voice-home-session',
        });

        const { sendLocalVoiceAgentTextUpdate } = localVoiceEngine;

        const first = sendLocalVoiceAgentTextUpdate('s1', 'Initial coding request');
        await waitForMockCalls(daemonVoiceAgentStartTurnStream, 1);

        const second = sendLocalVoiceAgentTextUpdate('s1', 'Permission required. Ask the human whether to allow it.');
        await waitForMockCalls(daemonVoiceAgentCancelTurnStream, 1);

        resolveFirstRead({
            streamId: 'stream-1',
            events: [],
            nextCursor: 0,
            done: false,
        });

        await expect(first).resolves.toBeUndefined();
        await expect(second).resolves.toBeUndefined();

        expect(daemonVoiceAgentCancelTurnStream).toHaveBeenCalledWith({
            sessionId: 'voice-home-session',
            streamId: 'stream-1',
            voiceAgentId: 'va1',
        });
        expect(daemonVoiceAgentStartTurnStream).toHaveBeenCalledTimes(2);
    });

    it('streams agent deltas into chunked device TTS playback when enabled', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_conversation',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_conversation: { schemaVersion: 1, config: {
                            ...storage.getState().settings.voice.providers.local_conversation.config,
                            conversationMode: 'agent',
                            stt: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.stt,
                                baseUrl: 'http://localhost:8000',
                            },
                            tts: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.tts,
                                autoSpeakReplies: true,
                                provider: 'device',
                            },
                            agent: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.agent,
                            },
                            streaming: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.streaming,
                                enabled: true,
                                ttsEnabled: true,
                                ttsChunkChars: 32,
                            },
                        } },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
            },
        });
        storage.__setState({
            ...storage.getState(),
            settings: {
                ...storage.getState().settings,
                voiceSettingsV1: storage.getState().settings.voice,
            },
        });

        daemonVoiceAgentStart.mockResolvedValueOnce({ voiceAgentId: 'va1' });
        daemonVoiceAgentStartTurnStream.mockResolvedValueOnce({ streamId: 'stream-tts-1' });
        // The canonical settings parser may retain the released 200-character
        // chunk size rather than this legacy fixture's smaller override. Keep
        // the stream comfortably above two admitted chunks so this composed
        // test proves queueing instead of depending on a stale threshold.
        const firstStreamedDelta = 'First streamed assistant sentence with enough content to cross the canonical chunk boundary. '.repeat(3).trim();
        const secondStreamedDelta = 'Second streamed assistant sentence continues beyond another canonical chunk boundary. '.repeat(3).trim();
        const finalStreamedText = `${firstStreamedDelta} ${secondStreamedDelta}`;
        daemonVoiceAgentReadTurnStream.mockResolvedValueOnce({
            streamId: 'stream-tts-1',
            events: [
                {
                    t: 'voice_output',
                    output: {
                        v: 1,
                        kind: 'speech_segment',
                        turnId: 'stream-tts-1',
                        seq: 0,
                        segmentId: 'stream-tts-1:segment:0',
                        text: firstStreamedDelta,
                    },
                },
                {
                    t: 'voice_output',
                    output: {
                        v: 1,
                        kind: 'speech_segment',
                        turnId: 'stream-tts-1',
                        seq: 1,
                        segmentId: 'stream-tts-1:segment:1',
                        text: secondStreamedDelta,
                    },
                },
                {
                    t: 'voice_output',
                    output: {
                        v: 1,
                        kind: 'turn_final',
                        turnId: 'stream-tts-1',
                        seq: 2,
                        text: finalStreamedText,
                    },
                },
            ],
            nextCursor: 3,
            done: true,
        });
        expoSpeechSpeak.mockImplementation((_text: string, options: any) => {
            options?.onStart?.();
            queueMicrotask(() => options?.onDone?.());
        });

        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ text: 'hello world' }),
        });

        const { toggleLocalVoiceTurn } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');
        await toggleLocalVoiceTurn('s1');

        expect(daemonVoiceAgentStartTurnStream).toHaveBeenCalledTimes(1);
        await waitForMockCalls(expoSpeechSpeak, 2);
        expect(expoSpeechSpeak.mock.calls.length).toBeGreaterThan(1);
    });

    it('keeps single-shot speech playback when streaming speech is disabled', async () => {
        const storage = await getStorage();
        storage.__setState({
            settings: {
                ...storage.getState().settings,
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_conversation',
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_conversation: { schemaVersion: 1, config: {
                            ...storage.getState().settings.voice.providers.local_conversation.config,
                            conversationMode: 'agent',
                            stt: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.stt,
                                baseUrl: 'http://localhost:8000',
                            },
                            tts: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.tts,
                                autoSpeakReplies: true,
                                provider: 'device',
                            },
                            agent: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.agent,
                            },
                            streaming: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.streaming,
                                enabled: true,
                                ttsEnabled: false,
                            },
                        } },
                    },
                },
            },
            sessions: {
                ...storage.getState().sessions,
                s1: { id: 's1', active: true, presence: 'online', modelMode: 'default', metadata: { flavor: 'claude' } },
            },
        });

        daemonVoiceAgentStart.mockResolvedValueOnce({ voiceAgentId: 'va1' });
        daemonVoiceAgentStartTurnStream.mockResolvedValueOnce({ streamId: 'stream-tts-2' });
        daemonVoiceAgentReadTurnStream.mockResolvedValueOnce({
            streamId: 'stream-tts-2',
            events: [
                { t: 'delta', textDelta: 'hello world. this is chunk one. ' },
                { t: 'delta', textDelta: 'and this is chunk two with extra words.' },
                { t: 'done', assistantText: 'hello world. this is chunk one. and this is chunk two with extra words.' },
            ],
            nextCursor: 3,
            done: true,
        });
        expoSpeechSpeak.mockImplementation((_text: string, options: any) => {
            options?.onStart?.();
            queueMicrotask(() => options?.onDone?.());
        });

        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ text: 'hello world' }),
        });

        const { toggleLocalVoiceTurn } = localVoiceEngine;
        await toggleLocalVoiceTurn('s1');
        await toggleLocalVoiceTurn('s1');

        expect(daemonVoiceAgentStartTurnStream).toHaveBeenCalledTimes(1);
        expect(expoSpeechSpeak).toHaveBeenCalledTimes(1);
    });

    it('retires the real Local Agent context admission synchronously on Account retirement', async () => {
        const storage = await getStorage();
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
        expect(activeServerId).not.toBe('');
        storage.__setState({
            ...storage.getState(),
            profileScope: { serverId: activeServerId, accountId: 'account-a' },
            settings: {
                ...storage.getState().settings,
                experiments: true,
                featureToggles: {
                    ...storage.getState().settings.featureToggles,
                    voice: true,
                },
                voice: {
                    ...storage.getState().settings.voice,
                    providerId: 'local_conversation',
                    privacy: {
                        ...storage.getState().settings.voice.privacy,
                        currentUiContextMode: 'automatic',
                    },
                    providers: {
                        ...storage.getState().settings.voice.providers,
                        local_conversation: { schemaVersion: 1, config: {
                            ...storage.getState().settings.voice.providers.local_conversation.config,
                            conversationMode: 'agent',
                            stt: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.stt,
                                baseUrl: 'http://localhost:8000',
                            },
                            tts: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.tts,
                                autoSpeakReplies: false,
                            },
                            agent: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.agent,
                                prewarmOnConnect: true,
                            },
                            streaming: {
                                ...storage.getState().settings.voice.providers.local_conversation.config.streaming,
                                enabled: false,
                            },
                        } },
                    },
                },
            },
        });
        storage.__setState({
            ...storage.getState(),
            settings: {
                ...storage.getState().settings,
                voiceSettingsV1: storage.getState().settings.voice,
            },
        });

        let currentAccount: 'account-a' | 'account-b' = 'account-a';
        const reads: Array<'account-a' | 'account-b'> = [];
        const invocations: Array<'account-a' | 'account-b'> = [];
        const subscription = {
            listener: null as (() => void) | null,
            unsubscribeCalls: 0,
        };
        const currentUiContext = {
            readCurrentUiContext: () => {
                reads.push(currentAccount);
                return {
                    navigation: {
                        area: 'settings' as const,
                        screen: 'settings_page',
                        title: currentAccount === 'account-a' ? 'ACCOUNT_A_CONTEXT' : 'ACCOUNT_B_CONTEXT',
                        presentation: 'screen' as const,
                    },
                    commands: [],
                };
            },
            resolveCurrentUiCommand: () => null,
            subscribe: (listener: () => void) => {
                subscription.listener = listener;
                return () => {
                    subscription.unsubscribeCalls += 1;
                    if (subscription.listener === listener) subscription.listener = null;
                };
            },
            invokeCurrentUiCommand: async () => {
                invocations.push(currentAccount);
                return { ok: true as const };
            },
        };
        const agentStart = {
            resolve: null as ((value: { voiceAgentId: string }) => void) | null,
        };
        daemonVoiceAgentStart.mockImplementationOnce(
            () => new Promise<{ voiceAgentId: string }>((resolve) => {
                agentStart.resolve = resolve;
            }),
        );

        const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');
        registerStorageStateReader(() => storage.getState());
        const {
            captureActiveServerAccountScopeLifetime,
            retireActiveServerAccountScopeLifetime,
        } = await import('@/sync/domains/scope/activeServerAccountScope');
        const admittedAccountLifetime = captureActiveServerAccountScopeLifetime();
        expect(admittedAccountLifetime?.scope).toEqual({
            serverId: activeServerId,
            accountId: 'account-a',
        });
        const { getVoiceAdapterRegistry } = await import('@/voice/session/voiceAdapterRegistry');
        // Exercise the capture admission directly. VoiceSessionRuntime has its
        // own Account-change lifecycle responsibility; mounting it here would
        // add a second retirement writer and would not decide whether the
        // retained Local Voice port itself is fenced.
        const start = localVoiceEngine.toggleLocalVoiceTurn(
            VOICE_AGENT_GLOBAL_SESSION_ID,
            currentUiContext,
        );
        await waitForCondition(
            () => daemonVoiceAgentStart.mock.calls.length >= 1,
            'local Agent start admission',
        );
        const resolveAgentStart = agentStart.resolve;
        if (!resolveAgentStart) throw new Error('missing local agent start resolver');
        resolveAgentStart({ voiceAgentId: 'local-agent-account-a' });
        await start;
        await waitForCondition(() => subscription.listener !== null, 'local current UI subscription');
        const retainedAutomaticListener = subscription.listener;
        if (!retainedAutomaticListener) throw new Error('missing retained local current UI subscription');

        // Retirement is synchronous at the Account owner. It revokes the exact
        // admitted Current UI port independently from later resource teardown.
        retireActiveServerAccountScopeLifetime();
        currentAccount = 'account-b';
        const readsBeforeLateEvents = reads.length;
        const invocationsBeforeLateEvents = invocations.length;
        retainedAutomaticListener();
        expect(reads).toHaveLength(readsBeforeLateEvents);
        expect(invocations).toHaveLength(invocationsBeforeLateEvents);

        const localAdapter = getVoiceAdapterRegistry().get('local_conversation');
        if (!localAdapter?.sendTextTurn) throw new Error('local conversation adapter unavailable');
        daemonVoiceAgentSendTurn.mockResolvedValueOnce({
            assistantText: 'This must not reach Account B.',
            actions: [
                { t: 'readCurrentUiContext', args: {} },
                attachVoiceAgentActionEffectId({
                    t: 'invokeCurrentUiCommand',
                    args: { commandId: 'retired-account-command' },
                }, 'retired-local-agent-tool'),
            ],
        });
        await localAdapter.sendTextTurn({
            controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            conversationSessionId: 'voice-home-session',
            text: 'Run the retained tool.',
            localId: 'retired-local-agent-turn',
            deliveryCommand: 'interrupt_and_send',
            onAccepted: async () => {},
        });

        await act(async () => {
            await Promise.resolve();
        });
        await localVoiceEngine.stopLocalVoiceSession();
        retireActiveServerAccountScopeLifetime();

        expect(subscription.unsubscribeCalls).toBeGreaterThan(0);
        expect(subscription.listener).toBeNull();
        expect(reads).toHaveLength(readsBeforeLateEvents);
        expect(invocations).toHaveLength(invocationsBeforeLateEvents);
        expect(reads).not.toContain('account-b');
        expect(invocations).not.toContain('account-b');
    });


});
