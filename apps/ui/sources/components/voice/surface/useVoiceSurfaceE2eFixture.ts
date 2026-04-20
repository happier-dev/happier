import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { Platform } from 'react-native';

import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol';

import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { storage } from '@/sync/domains/state/storage';
import type { NormalizedMessage } from '@/sync/typesRaw';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { realtimeTransport } from '@/voice/runtime/realtime/RealtimeTransport';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { voiceConversationBindingResolver } from '@/voice/binding/VoiceConversationBindingResolver';
import { writeVoiceConversationBindingMetadata } from '@/voice/binding/voiceConversationBindingMetadata';
import { writeVoiceConversationScopeMetadata } from '@/voice/persistence/voiceConversationScopeMetadata';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { getVoiceSessionSnapshot, setVoiceSessionSnapshot } from '@/voice/session/voiceSessionStore';
import { selectVoiceTranscriptEntriesForConversationSession } from '@/voice/transcript/voiceTranscriptSelectors';
import {
    getVoiceConversationRuntimeSnapshot,
    setVoiceConversationRuntimeSnapshot,
} from '@/voice/runtime/machine/voiceConversationRuntimeStore';

const VOICE_SURFACE_E2E_FIXTURE_QUERY_PARAM = 'happier_voice_e2e_fixture';
const VOICE_SURFACE_E2E_FIXTURE_STORAGE_KEY = 'happier.voice.e2e.fixture';
const VOICE_SURFACE_E2E_FIXTURE_SIDEBAR_HIDDEN_CONVERSATION = 'sidebar_hidden_conversation';
const VOICE_SURFACE_E2E_FIXTURE_REALTIME_RECOVERABLE_DISCONNECT = 'realtime_recoverable_disconnect';
const VOICE_SURFACE_E2E_FIXTURE_LOCAL_AUTO_RETURN_LISTENING = 'local_auto_return_listening';
const VOICE_SURFACE_E2E_FIXTURE_WELCOME_RESUME_PERSISTENCE = 'welcome_resume_persistence';
const VOICE_SURFACE_E2E_FIXTURE_DAEMON_INFERENCE_WEB_FALLBACK_PARITY = 'daemon_inference_web_fallback_parity';
const VOICE_SURFACE_E2E_FIXTURE_CANCEL_DURING_ASSISTANT_SPEECH = 'cancel_during_assistant_speech';
const VOICE_SURFACE_E2E_ROOT_SESSION_ID = 'voice-e2e-root-session';
const VOICE_SURFACE_E2E_CONVERSATION_SESSION_ID = 'voice-e2e-hidden-conversation';
const VOICE_SURFACE_E2E_UPDATED_AT = 1_710_000_000_000;

function normalizeFixtureParam(value: string | string[] | undefined): string {
    if (Array.isArray(value)) {
        return typeof value[0] === 'string' ? value[0].trim() : '';
    }
    return typeof value === 'string' ? value.trim() : '';
}

function readPersistedFixtureId(): string {
    const localStorage =
        typeof globalThis !== 'undefined' && typeof globalThis.localStorage?.getItem === 'function'
            ? globalThis.localStorage
            : null;
    if (!localStorage) {
        return '';
    }
    return normalizeFixtureParam(localStorage.getItem(VOICE_SURFACE_E2E_FIXTURE_STORAGE_KEY) ?? undefined);
}

type VoiceSurfaceE2eFixtureVoiceSessionSnapshot = Readonly<{
    status: 'connecting' | 'connected' | 'disconnected' | 'error';
    mode: 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking';
    canStop: boolean;
    errorCode?: string;
    errorMessage?: string;
}>;

type VoiceSurfaceE2eFixtureVariant =
    | typeof VOICE_SURFACE_E2E_FIXTURE_SIDEBAR_HIDDEN_CONVERSATION
    | typeof VOICE_SURFACE_E2E_FIXTURE_REALTIME_RECOVERABLE_DISCONNECT
    | typeof VOICE_SURFACE_E2E_FIXTURE_LOCAL_AUTO_RETURN_LISTENING
    | typeof VOICE_SURFACE_E2E_FIXTURE_WELCOME_RESUME_PERSISTENCE
    | typeof VOICE_SURFACE_E2E_FIXTURE_DAEMON_INFERENCE_WEB_FALLBACK_PARITY
    | typeof VOICE_SURFACE_E2E_FIXTURE_CANCEL_DURING_ASSISTANT_SPEECH;

type VoiceSurfaceFixtureEntry = Readonly<{
    id: string;
    text: string;
    role: 'user' | 'assistant';
    createdAt: number;
}>;

type VoiceSurfaceFixtureOptions = Readonly<{
    bindingAdapterId: 'realtime_elevenlabs' | 'local_conversation';
    providerId: 'realtime_elevenlabs' | 'local_conversation';
    surfaceLocation?: 'auto' | 'sidebar';
    featureToggles?: Record<string, boolean>;
    localConversationOverrides?: Record<string, unknown>;
    hiddenConversationMetadata?: Record<string, unknown>;
    messages?: ReadonlyArray<VoiceSurfaceFixtureEntry>;
    voiceSessionSnapshot?: VoiceSurfaceE2eFixtureVoiceSessionSnapshot;
}>;

function resolveFixtureRuntimeState(snapshot: VoiceSurfaceE2eFixtureVoiceSessionSnapshot) {
    if (snapshot.status === 'connecting') return 'connecting' as const;
    if (snapshot.status === 'error') return 'error' as const;
    if (snapshot.status === 'disconnected') return 'disconnected' as const;

    switch (snapshot.mode) {
        case 'listening':
            return 'listening' as const;
        case 'transcribing':
            return 'transcribing' as const;
        case 'speaking':
            return 'speaking' as const;
        case 'thinking':
            return 'sending' as const;
        case 'idle':
        default:
            return 'connected' as const;
    }
}

function buildFixtureMessages(entries: ReadonlyArray<VoiceSurfaceFixtureEntry>): NormalizedMessage[] {
    return entries.map((entry) => {
        if (entry.role === 'assistant') {
            return {
                id: entry.id,
                localId: entry.id,
                createdAt: entry.createdAt,
                isSidechain: false,
                role: 'agent',
                content: [{ type: 'text' as const, text: entry.text, uuid: entry.id, parentUUID: null }],
            } satisfies NormalizedMessage;
        }

        return {
            id: entry.id,
            localId: entry.id,
            createdAt: entry.createdAt,
            isSidechain: false,
            role: 'user',
            content: { type: 'text' as const, text: entry.text },
        } satisfies NormalizedMessage;
    });
}

function installSidebarHiddenConversationFixture(
    options: VoiceSurfaceFixtureOptions = {
        bindingAdapterId: 'realtime_elevenlabs',
        providerId: 'realtime_elevenlabs',
    },
    voiceSessionSnapshot: VoiceSurfaceE2eFixtureVoiceSessionSnapshot = {
        status: 'connected',
        mode: 'idle',
        canStop: true,
    },
): void {
    const state = storage.getState();
    const existingSettings = state.settings ?? {};
    const existingVoice = voiceSettingsParse(existingSettings.voice);
    const existingFeatureToggles =
        existingSettings.featureToggles && typeof existingSettings.featureToggles === 'object'
            ? existingSettings.featureToggles
            : {};

    const existingLocalConversation = existingVoice.adapters.local_conversation ?? {};
    const nextFeatureToggles = {
        ...existingFeatureToggles,
        voice: true,
        'execution.runs': true,
        'voice.agent': true,
        ...(options.featureToggles ?? {}),
    };

    state.applySettingsLocal({
        experiments: true,
        featureToggles: nextFeatureToggles,
        voice: {
            ...existingVoice,
            providerId: options.providerId,
            adapters: {
                ...existingVoice.adapters,
                ...(options.providerId === 'realtime_elevenlabs'
                    ? {
                        realtime_elevenlabs: {
                            ...existingVoice.adapters.realtime_elevenlabs,
                            billingMode: 'byo',
                        },
                    }
                    : {}),
                ...(options.providerId === 'local_conversation'
                    ? {
                        local_conversation: {
                            ...existingLocalConversation,
                            conversationMode: 'agent',
                            ...options.localConversationOverrides,
                        },
                    }
                    : {}),
                ...(options.bindingAdapterId === 'local_conversation'
                    ? {
                        local_conversation: {
                            ...existingLocalConversation,
                            conversationMode: 'agent',
                            ...options.localConversationOverrides,
                        },
                    }
                    : {}),
                ...(options.featureToggles?.['voice.daemonInference'] === true
                    ? {
                        realtime_elevenlabs: {
                            ...existingVoice.adapters.realtime_elevenlabs,
                            billingMode: 'byo',
                        },
                    }
                    : {}),
            },
            ui: {
                ...existingVoice.ui,
                activityFeedEnabled: true,
                scopeDefault: 'global',
                surfaceLocation: options.surfaceLocation ?? 'auto',
            },
        },
    });

    // The voice surface reads lifecycle state from adapter snapshots driven by the canonical
    // voice runtime machine; keep the machine snapshot aligned with the fixture.
    setVoiceConversationRuntimeSnapshot({
        controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        state: resolveFixtureRuntimeState(voiceSessionSnapshot),
        micMuted: false,
        error: null,
    });

    const binding = {
        adapterId: options.bindingAdapterId,
        controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        conversationSessionId: VOICE_SURFACE_E2E_CONVERSATION_SESSION_ID,
        transcriptMode: 'synthetic' as const,
        targetSessionId: VOICE_SURFACE_E2E_ROOT_SESSION_ID,
        updatedAt: VOICE_SURFACE_E2E_UPDATED_AT,
    };
    const hiddenConversationMetadata = {
        ...writeVoiceConversationScopeMetadata(
            writeVoiceConversationBindingMetadata(
                buildSystemSessionMetadataV1({
                    key: 'voice_conversation',
                    hidden: true,
                }),
                binding,
            ),
            { kind: 'voice_home' },
        ),
        ...(options.hiddenConversationMetadata ?? {}),
    };
    const fixtureMessages = buildFixtureMessages(
        options.messages ?? [
            {
                id: 'voice-e2e-user-1',
                createdAt: VOICE_SURFACE_E2E_UPDATED_AT - 10,
                role: 'user',
                text: 'first',
            },
            {
                id: 'voice-e2e-assistant-1',
                createdAt: VOICE_SURFACE_E2E_UPDATED_AT - 5,
                role: 'assistant',
                text: 'second',
            },
        ],
    );

    storage.setState((state: any) => ({
        ...state,
        sessions: {
            ...(state?.sessions ?? {}),
            [VOICE_SURFACE_E2E_ROOT_SESSION_ID]: {
                ...(state?.sessions?.[VOICE_SURFACE_E2E_ROOT_SESSION_ID] ?? {}),
                id: VOICE_SURFACE_E2E_ROOT_SESSION_ID,
                active: true,
                updatedAt: VOICE_SURFACE_E2E_UPDATED_AT - 1,
                metadata: {
                    ...(state?.sessions?.[VOICE_SURFACE_E2E_ROOT_SESSION_ID]?.metadata ?? {}),
                    summaryText: 'Voice root session',
                },
            },
            [VOICE_SURFACE_E2E_CONVERSATION_SESSION_ID]: {
                ...(state?.sessions?.[VOICE_SURFACE_E2E_CONVERSATION_SESSION_ID] ?? {}),
                id: VOICE_SURFACE_E2E_CONVERSATION_SESSION_ID,
                active: true,
                updatedAt: VOICE_SURFACE_E2E_UPDATED_AT,
                metadata: {
                    ...(state?.sessions?.[VOICE_SURFACE_E2E_CONVERSATION_SESSION_ID]?.metadata ?? {}),
                    ...hiddenConversationMetadata,
                },
            },
        },
    }));
    state.applyMessagesLoaded(VOICE_SURFACE_E2E_CONVERSATION_SESSION_ID);
    state.applyMessages(VOICE_SURFACE_E2E_CONVERSATION_SESSION_ID, fixtureMessages);

    useVoiceTargetStore.getState().setScope('global');
    setVoiceSessionSnapshot({
        adapterId: options.bindingAdapterId,
        sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        status: voiceSessionSnapshot.status,
        mode: voiceSessionSnapshot.mode,
        canStop: voiceSessionSnapshot.canStop,
        errorCode: voiceSessionSnapshot.errorCode,
        errorMessage: voiceSessionSnapshot.errorMessage,
    });
}

function installRealtimeRecoverableDisconnectFixture(): void {
    realtimeTransport.setCurrentRealtimeControlSessionId(VOICE_AGENT_GLOBAL_SESSION_ID);
    realtimeTransport.handleProviderConnected();
    realtimeTransport.handleProviderDisconnected();
    installSidebarHiddenConversationFixture(
        {
            bindingAdapterId: 'realtime_elevenlabs',
            providerId: 'realtime_elevenlabs',
        },
        {
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        },
    );
}

function installLocalAutoReturnListeningFixture(): void {
    installSidebarHiddenConversationFixture(
        {
            bindingAdapterId: 'local_conversation',
            providerId: 'local_conversation',
        },
        {
            status: 'connected',
            mode: 'listening',
            canStop: true,
        },
    );

    // On web, continuous voice is clamped to realtime (Phase 10). Ensure the realtime adapter
    // advertises the listening mode expected by UI e2e while the transcript/binding fixture is local.
    if (Platform.OS === 'web') {
        realtimeTransport.setCurrentRealtimeControlSessionId(VOICE_AGENT_GLOBAL_SESSION_ID);
        realtimeTransport.handleProviderConnected();
        realtimeTransport.handleProviderModeChange('listening');
        // The UI surface reads from the active voice session snapshot; keep it aligned with the
        // web realtime clamp so the fixture converges to `listening` deterministically.
        setVoiceSessionSnapshot({
            adapterId: 'realtime_elevenlabs',
            sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            status: 'connected',
            mode: 'listening',
            canStop: true,
        });
    }
}

function installWelcomeResumePersistenceFixture(): void {
    installSidebarHiddenConversationFixture(
        {
            bindingAdapterId: 'local_conversation',
            providerId: 'realtime_elevenlabs',
            localConversationOverrides: {
                conversationMode: 'agent',
                agent: {
                    backend: 'daemon',
                    welcome: {
                        enabled: true,
                        mode: 'immediate',
                        templateId: null,
                    },
                },
            },
            hiddenConversationMetadata: {
                voiceAgentRunV1: {
                    v: 1,
                    runId: 'voice-e2e-run',
                    backendId: 'daemon',
                    transcriptContractVersion: 2,
                    welcomedEpoch: 1,
                    updatedAtMs: VOICE_SURFACE_E2E_UPDATED_AT,
                },
            },
            messages: [
                {
                    id: 'voice-e2e-welcome-1',
                    createdAt: VOICE_SURFACE_E2E_UPDATED_AT - 5,
                    role: 'assistant',
                    text: 'Welcome back',
                },
            ],
        },
        {
            status: 'connected',
            mode: 'idle',
            canStop: true,
        },
    );
}

function installDaemonInferenceWebFallbackParityFixture(): void {
    installSidebarHiddenConversationFixture(
        {
            bindingAdapterId: 'local_conversation',
            providerId: 'local_conversation',
            featureToggles: {
                'voice.daemonInference': true,
            },
            localConversationOverrides: {
                conversationMode: 'agent',
                agent: {
                    backend: 'daemon',
                },
                stt: {
                    provider: 'local_neural',
                    localNeural: {
                        execution: 'daemon',
                    },
                },
                tts: {
                    provider: 'local_neural',
                    localNeural: {
                        execution: 'device',
                    },
                },
            },
        },
        {
            status: 'connected',
            mode: 'idle',
            canStop: true,
        },
    );
}

function installCancelDuringAssistantSpeechFixture(): void {
    // Web continuous voice is realtime-backed; simulate a speaking turn and verify the surface
    // can still be cancelled without getting stuck in `speaking`/`connecting`.
    realtimeTransport.setCurrentRealtimeControlSessionId(VOICE_AGENT_GLOBAL_SESSION_ID);
    realtimeTransport.handleProviderConnected();
    realtimeTransport.handleProviderModeChange('speaking');
    installSidebarHiddenConversationFixture(
        {
            bindingAdapterId: 'realtime_elevenlabs',
            providerId: 'realtime_elevenlabs',
        },
        {
            status: 'connected',
            mode: 'speaking',
            canStop: true,
        },
    );
}

function hasSidebarHiddenConversationFixtureState(params: Readonly<{
    providerId?: 'realtime_elevenlabs' | 'local_conversation';
    bindingAdapterId?: 'realtime_elevenlabs' | 'local_conversation';
    transcriptTexts?: ReadonlyArray<string>;
    requiredFeatureToggles?: ReadonlyArray<string>;
    surfaceLocation?: 'auto' | 'sidebar';
}> = {}): boolean {
    const settings = storage.getState().settings ?? {};
    const voice = voiceSettingsParse(settings.voice);
    const featureToggles =
        settings.featureToggles && typeof settings.featureToggles === 'object'
            ? settings.featureToggles
            : {};
    const providerId = params.providerId ?? 'realtime_elevenlabs';
    const bindingAdapterId = params.bindingAdapterId ?? providerId;
    const transcriptTexts = params.transcriptTexts ?? ['first', 'second'];
    const binding = voiceConversationBindingResolver.resolveByControlSessionId({
        controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        adapterId: bindingAdapterId,
    });
    const transcriptEntries = selectVoiceTranscriptEntriesForConversationSession(
        storage.getState(),
        VOICE_SURFACE_E2E_CONVERSATION_SESSION_ID,
    );

    const expectedSurfaceLocation = params.surfaceLocation ?? 'auto';
    return (
        settings.experiments === true
        && featureToggles.voice === true
        && featureToggles['execution.runs'] === true
        && featureToggles['voice.agent'] === true
        && (params.requiredFeatureToggles ?? []).every((featureId) => featureToggles[featureId] === true)
        && voice.providerId === providerId
        && (providerId !== 'realtime_elevenlabs' || voice.adapters.realtime_elevenlabs.billingMode === 'byo')
        && voice.ui.activityFeedEnabled === true
        && voice.ui.scopeDefault === 'global'
        && voice.ui.surfaceLocation === expectedSurfaceLocation
        && binding?.conversationSessionId === VOICE_SURFACE_E2E_CONVERSATION_SESSION_ID
        && transcriptEntries.length === transcriptTexts.length
        && transcriptEntries.every((entry, index) => entry.text === transcriptTexts[index])
    );
}

function ensureSidebarHiddenConversationFixtureInstalled(): void {
    if (hasSidebarHiddenConversationFixtureState()) return;
    installSidebarHiddenConversationFixture();
}

function hasRealtimeRecoverableDisconnectFixtureState(): boolean {
    if (!hasSidebarHiddenConversationFixtureState()) return false;
    const snapshot = getVoiceSessionSnapshot();
    return (
        snapshot.adapterId === 'realtime_elevenlabs'
        && snapshot.sessionId === VOICE_AGENT_GLOBAL_SESSION_ID
        && snapshot.status === 'disconnected'
        && snapshot.mode === 'idle'
        && snapshot.canStop === false
    );
}

function ensureRealtimeRecoverableDisconnectFixtureInstalled(): void {
    if (hasRealtimeRecoverableDisconnectFixtureState()) return;
    installRealtimeRecoverableDisconnectFixture();
}

function hasLocalAutoReturnListeningFixtureState(): boolean {
    if (!hasSidebarHiddenConversationFixtureState({
        providerId: 'local_conversation',
        bindingAdapterId: 'local_conversation',
    })) return false;
    const settings = voiceSettingsParse(storage.getState().settings?.voice);
    const snapshot = getVoiceSessionSnapshot();
    const adapterOk =
        Platform.OS === 'web'
            ? snapshot.adapterId === 'realtime_elevenlabs' || snapshot.adapterId === 'local_conversation'
            : snapshot.adapterId === 'local_conversation';
    return (
        settings.providerId === 'local_conversation'
        && adapterOk
        && snapshot.sessionId === VOICE_AGENT_GLOBAL_SESSION_ID
        && snapshot.status === 'connected'
        && snapshot.mode === 'listening'
        && snapshot.canStop === true
    );
}

function ensureLocalAutoReturnListeningFixtureInstalled(): void {
    if (hasLocalAutoReturnListeningFixtureState()) return;
    installLocalAutoReturnListeningFixture();
}

function hasWelcomeResumePersistenceFixtureState(): boolean {
    if (!hasSidebarHiddenConversationFixtureState({
        providerId: 'realtime_elevenlabs',
        bindingAdapterId: 'local_conversation',
        transcriptTexts: ['Welcome back'],
    })) return false;
    const settings = voiceSettingsParse(storage.getState().settings?.voice);
    const metadata = (storage.getState().sessions?.[VOICE_SURFACE_E2E_CONVERSATION_SESSION_ID] as Record<string, any> | undefined)?.metadata;
    return (
        settings.providerId === 'realtime_elevenlabs'
        && metadata?.voiceAgentRunV1?.welcomedEpoch === 1
        && metadata?.voiceAgentRunV1?.transcriptContractVersion === 2
    );
}

function ensureWelcomeResumePersistenceFixtureInstalled(): void {
    if (hasWelcomeResumePersistenceFixtureState()) return;
    installWelcomeResumePersistenceFixture();
}

function hasDaemonInferenceWebFallbackParityFixtureState(): boolean {
    if (!hasSidebarHiddenConversationFixtureState({
        providerId: 'local_conversation',
        bindingAdapterId: 'local_conversation',
        requiredFeatureToggles: ['voice.daemonInference'],
    })) return false;
    const settings = voiceSettingsParse(storage.getState().settings?.voice);
    const featureToggles = storage.getState().settings?.featureToggles ?? {};
    return (
        settings.providerId === 'local_conversation'
        && featureToggles['voice.daemonInference'] === true
        && settings.adapters.local_conversation?.tts?.provider === 'local_neural'
        && settings.adapters.local_conversation?.tts?.localNeural?.execution === 'device'
    );
}

function ensureDaemonInferenceWebFallbackParityFixtureInstalled(): void {
    if (hasDaemonInferenceWebFallbackParityFixtureState()) return;
    installDaemonInferenceWebFallbackParityFixture();
}

function hasCancelDuringAssistantSpeechFixtureState(): boolean {
    if (!hasSidebarHiddenConversationFixtureState({
        providerId: 'realtime_elevenlabs',
        bindingAdapterId: 'realtime_elevenlabs',
    })) return false;

    const snapshot = getVoiceSessionSnapshot();
    return (
        snapshot.adapterId === 'realtime_elevenlabs'
        && snapshot.sessionId === VOICE_AGENT_GLOBAL_SESSION_ID
        && snapshot.status === 'connected'
        && snapshot.mode === 'speaking'
        && snapshot.canStop === true
    );
}

function ensureCancelDuringAssistantSpeechFixtureInstalled(): void {
    if (hasCancelDuringAssistantSpeechFixtureState()) return;
    installCancelDuringAssistantSpeechFixture();
}

function isVoiceSurfaceE2eFixtureRuntimeEnabled(): boolean {
    if (__DEV__ === true) return true;
    return process.env.EXPO_PUBLIC_DEBUG === '1';
}

function subscribeThrottledFixtureRepair(repair: () => void, delayMs: number): () => void {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    let lastRepairAtMs = 0;
    let microtaskScheduled = false;

    const runRepair = () => {
        if (disposed) return;
        lastRepairAtMs = Date.now();
        repair();
    };

    const schedule = () => {
        if (disposed) return;
        const now = Date.now();
        const elapsed = now - lastRepairAtMs;

        if (elapsed >= delayMs) {
            if (microtaskScheduled) return;
            microtaskScheduled = true;
            queueMicrotask(() => {
                microtaskScheduled = false;
                runRepair();
            });
            return;
        }

        if (timer) return;
        timer = setTimeout(() => {
            timer = null;
            runRepair();
        }, Math.max(1, delayMs - elapsed));
    };

    // Repair once soon after mount (covers initial async store hydration churn), but avoid
    // forcing tests to advance real timers by doing the first attempt in a microtask.
    schedule();

    const unsubscribe = storage.subscribe(() => {
        schedule();
    });

    return () => {
        disposed = true;
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        unsubscribe();
    };
}

export function useVoiceSurfaceE2eFixture(): void {
    const params = useLocalSearchParams<{ happier_voice_e2e_fixture?: string | string[] }>();
    const installedFixtureRef = React.useRef<string | null>(null);
    const fixtureId = normalizeFixtureParam(params[VOICE_SURFACE_E2E_FIXTURE_QUERY_PARAM]) || readPersistedFixtureId();

    React.useEffect(() => {
        if (!isVoiceSurfaceE2eFixtureRuntimeEnabled()) return;
        if (!fixtureId) return;

        if (fixtureId === VOICE_SURFACE_E2E_FIXTURE_SIDEBAR_HIDDEN_CONVERSATION) {
            if (installedFixtureRef.current !== fixtureId) {
                fireAndForget(getServerFeaturesSnapshot({ force: true }), {
                    tag: 'voiceSurfaceE2eFixture.forceServerFeaturesSnapshot',
                });
            }
            ensureSidebarHiddenConversationFixtureInstalled();
            installedFixtureRef.current = fixtureId;
            return subscribeThrottledFixtureRepair(() => {
                ensureSidebarHiddenConversationFixtureInstalled();
            }, 250);
        }

        if (fixtureId === VOICE_SURFACE_E2E_FIXTURE_REALTIME_RECOVERABLE_DISCONNECT) {
            if (installedFixtureRef.current !== fixtureId) {
                fireAndForget(getServerFeaturesSnapshot({ force: true }), {
                    tag: 'voiceSurfaceE2eFixture.forceServerFeaturesSnapshot',
                });
            }
            ensureRealtimeRecoverableDisconnectFixtureInstalled();
            installedFixtureRef.current = fixtureId;
            return subscribeThrottledFixtureRepair(() => {
                ensureRealtimeRecoverableDisconnectFixtureInstalled();
            }, 250);
        }

        if (fixtureId === VOICE_SURFACE_E2E_FIXTURE_LOCAL_AUTO_RETURN_LISTENING) {
            if (installedFixtureRef.current !== fixtureId) {
                fireAndForget(getServerFeaturesSnapshot({ force: true }), {
                    tag: 'voiceSurfaceE2eFixture.forceServerFeaturesSnapshot',
                });
            }
            ensureLocalAutoReturnListeningFixtureInstalled();
            installedFixtureRef.current = fixtureId;
            // The local-conversation fixture needs to converge to `listening` quickly (it simulates a
            // hands-free turn that has already completed). Some runtime init paths can overwrite the
            // initial fixture snapshot while sync is hydrating; keep a short, bounded repair loop.
            const repairListening = () => {
                const snap = getVoiceSessionSnapshot();
                if (snap.adapterId === 'realtime_elevenlabs') {
                    if (snap.status !== 'connected') return;
                    if (snap.mode === 'listening') return;
                    realtimeTransport.setCurrentRealtimeControlSessionId(VOICE_AGENT_GLOBAL_SESSION_ID);
                    realtimeTransport.handleProviderConnected();
                    realtimeTransport.handleProviderModeChange('listening');
                    return;
                }

                const runtime = getVoiceConversationRuntimeSnapshot();
                if (runtime.controlSessionId === VOICE_AGENT_GLOBAL_SESSION_ID && runtime.state === 'listening') return;
                setVoiceConversationRuntimeSnapshot({
                    ...runtime,
                    controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
                    state: 'listening',
                    micMuted: runtime.micMuted === true,
                    error: null,
                });
                // Best-effort store mirror update for any legacy readers (and unit-test harnesses
                // that don't install the lifecycle controller).
                setVoiceSessionSnapshot({
                    adapterId: 'local_conversation',
                    sessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
                    status: 'connected',
                    mode: 'listening',
                    canStop: true,
                });
            };
            const repairInterval = setInterval(repairListening, 250);
            const stopRepairTimer = setTimeout(() => clearInterval(repairInterval), 5_000);
            const unsubscribe = subscribeThrottledFixtureRepair(() => {
                ensureLocalAutoReturnListeningFixtureInstalled();
            }, 250);
            return () => {
                clearInterval(repairInterval);
                clearTimeout(stopRepairTimer);
                unsubscribe();
            };
        }

        if (fixtureId === VOICE_SURFACE_E2E_FIXTURE_WELCOME_RESUME_PERSISTENCE) {
            if (installedFixtureRef.current !== fixtureId) {
                fireAndForget(getServerFeaturesSnapshot({ force: true }), {
                    tag: 'voiceSurfaceE2eFixture.forceServerFeaturesSnapshot',
                });
            }
            ensureWelcomeResumePersistenceFixtureInstalled();
            installedFixtureRef.current = fixtureId;
            return subscribeThrottledFixtureRepair(() => {
                ensureWelcomeResumePersistenceFixtureInstalled();
            }, 250);
        }

        if (fixtureId === VOICE_SURFACE_E2E_FIXTURE_DAEMON_INFERENCE_WEB_FALLBACK_PARITY) {
            if (installedFixtureRef.current !== fixtureId) {
                fireAndForget(getServerFeaturesSnapshot({ force: true }), {
                    tag: 'voiceSurfaceE2eFixture.forceServerFeaturesSnapshot',
                });
            }
            ensureDaemonInferenceWebFallbackParityFixtureInstalled();
            installedFixtureRef.current = fixtureId;
            return subscribeThrottledFixtureRepair(() => {
                ensureDaemonInferenceWebFallbackParityFixtureInstalled();
            }, 250);
        }

        if (fixtureId === VOICE_SURFACE_E2E_FIXTURE_CANCEL_DURING_ASSISTANT_SPEECH) {
            if (installedFixtureRef.current !== fixtureId) {
                fireAndForget(getServerFeaturesSnapshot({ force: true }), {
                    tag: 'voiceSurfaceE2eFixture.forceServerFeaturesSnapshot',
                });
            }
            ensureCancelDuringAssistantSpeechFixtureInstalled();
            installedFixtureRef.current = fixtureId;
            // Do not run a repair loop for this fixture: the spec asserts an intentional state transition
            // after pressing cancel, and a repair loop would race that assertion by reinstalling `speaking`.
            return;
        }
    }, [fixtureId]);
}
