import type { VoiceSession } from './types';
import { completeHappierVoiceSession, fetchHappierVoiceToken } from '@/sync/api/voice/apiVoice';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { t } from '@/text';
import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/platform/microphonePermissions';
import { fetchElevenLabsConversationSignedUrlByo, fetchElevenLabsConversationTokenByo } from './elevenLabsByo';
import { disableVoiceBackgroundCallAudioMode, enableVoiceBackgroundCallAudioMode } from '@/voice/runtime/voiceAudioMode';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { voiceSessionBindingManager } from '@/voice/sessionBinding/voiceSessionBindingRuntime';
import { resolveVoiceSessionBindingByControlSessionId } from '@/voice/sessionBinding/resolveVoiceSessionBinding';
import { appendVoiceConversationNoteText } from '@/voice/sessionBinding/voiceConversationTranscript';
import { applyVoiceSessionTargetSelection } from '@/voice/sessionBinding/applyVoiceSessionTargetSelection';

let voiceSession: VoiceSession | null = null;
let voiceSessionStarted: boolean = false;
let startInFlight: Promise<void> | null = null;
let startInFlightAbortController: AbortController | null = null;
let currentLeaseId: string | null = null;
let currentProviderConversationId: string | null = null;
let currentBilledMode: 'happier' | 'byo' | null = null;
let currentControlSessionId: string | null = null;
let currentLeaseExpiresAtMs: number | null = null;
let currentLeaseWarningTimer: ReturnType<typeof setTimeout> | null = null;
let currentLeaseExpiryTimer: ReturnType<typeof setTimeout> | null = null;
let latestRequestedTargetSessionId: string | null = null;

function clearRealtimeLeaseTimers(): void {
    if (currentLeaseWarningTimer) {
        clearTimeout(currentLeaseWarningTimer);
        currentLeaseWarningTimer = null;
    }
    if (currentLeaseExpiryTimer) {
        clearTimeout(currentLeaseExpiryTimer);
        currentLeaseExpiryTimer = null;
    }
}

function resetRealtimeUiState(): void {
    const state = storage.getState();
    state.setRealtimeStatus('disconnected');
    state.setRealtimeMode('idle', true);
    state.clearRealtimeModeDebounce();
}

function formatVoiceLeaseDurationShort(ms: number): string {
    const bounded = Math.max(0, Math.floor(ms));
    if (bounded < 90_000) {
        return `${Math.max(1, Math.ceil(bounded / 1000))}s`;
    }
    return `${Math.max(1, Math.ceil(bounded / 60_000))}m`;
}

function appendRealtimeLeaseNote(text: string): void {
    const controlSessionId = currentControlSessionId;
    if (!controlSessionId) return;
    const binding = resolveVoiceSessionBindingByControlSessionId({
        controlSessionId,
        adapterId: 'realtime_elevenlabs',
    });
    const conversationSessionId = binding?.conversationSessionId?.trim();
    if (!conversationSessionId) return;
    appendVoiceConversationNoteText({
        conversationSessionId,
        text,
    });
}

function scheduleRealtimeLeaseAnnouncements(expiresAtMs: number): void {
    clearRealtimeLeaseTimers();
    currentLeaseExpiresAtMs = expiresAtMs;

    const remainingMs = expiresAtMs - Date.now();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) return;

    appendRealtimeLeaseNote(t('errors.voiceSessionLimitStarted', { duration: formatVoiceLeaseDurationShort(remainingMs) }));

    const warningLeadMs = 60_000;
    const warningDelayMs = remainingMs - warningLeadMs;
    if (warningDelayMs <= 0) {
        appendRealtimeLeaseNote(t('errors.voiceSessionLimitExpiring', { duration: formatVoiceLeaseDurationShort(remainingMs) }));
    } else {
        currentLeaseWarningTimer = setTimeout(() => {
            appendRealtimeLeaseNote(t('errors.voiceSessionLimitExpiring', { duration: formatVoiceLeaseDurationShort(Math.max(0, expiresAtMs - Date.now())) }));
        }, warningDelayMs);
    }

    currentLeaseExpiryTimer = setTimeout(() => {
        appendRealtimeLeaseNote(t('errors.voiceSessionLimitExpired'));
    }, remainingMs);
}

function normalizeRequestedTargetSessionId(sessionId: string | null): string | null {
    const trimmed = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!trimmed || trimmed === VOICE_AGENT_GLOBAL_SESSION_ID) return null;
    return trimmed;
}

function buildElevenLabsWelcomeContext(welcomeCfg: any): string {
    if (!welcomeCfg || welcomeCfg.enabled !== true) return '';
    const mode = welcomeCfg.mode === 'on_first_turn' ? 'on_first_turn' : 'immediate';
    if (mode === 'on_first_turn') {
        return [
            'On your first reply, start with one short friendly greeting (one sentence).',
            'Then continue with your response.',
        ].join('\n');
    }
    return [
        'Start this session with one short friendly greeting.',
        'Then wait for the user to speak again.',
    ].join('\n');
}

function appendOptionalWelcomeToContext(baseContext: string | null | undefined, welcomeCfg: any): string | undefined {
    const base = typeof baseContext === 'string' ? baseContext.trim() : '';
    const welcome = buildElevenLabsWelcomeContext(welcomeCfg).trim();
    if (!base && !welcome) return undefined;
    if (!welcome) return base;
    if (!base) return welcome;
    return `${base}\n\n${welcome}`;
}

export async function startRealtimeSession(
    sessionId: string,
    initialContext?: string,
    retryAfterPaywall = false,
    options?: Readonly<{ textOnly?: boolean }>,
) {
    const session = voiceSession;
    if (!session) {
        console.warn('No voice session registered');
        return;
    }

    const normalizedSessionId = String(sessionId ?? '').trim();
    const requestedTargetSessionId = normalizeRequestedTargetSessionId(normalizedSessionId);
    const controlSessionId = normalizedSessionId || VOICE_AGENT_GLOBAL_SESSION_ID;
    latestRequestedTargetSessionId = requestedTargetSessionId;
    if (requestedTargetSessionId) {
        applyVoiceSessionTargetSelection({
            controlSessionId,
            targetSessionId: requestedTargetSessionId,
            updateLastFocused: true,
        });
    }

    const settings: any = storage.getState().settings;
    const providerId = settings?.voice?.providerId ?? 'off';
    if (providerId !== 'realtime_elevenlabs') {
        return;
    }

    // Realtime voice is account-scoped: if a start is already in-flight, dedupe and await it.
    if (startInFlight) {
        await startInFlight;
        return;
    }
    
    const abortController = new AbortController();
    startInFlightAbortController = abortController;

    const run = async () => {
        try {
            clearRealtimeLeaseTimers();
            currentLeaseExpiresAtMs = null;
            if (options?.textOnly !== true) {
                // Request microphone permission before starting voice session
                // Critical for iOS/Android - first session will fail without this
                const permissionResult = await requestMicrophonePermission();
                if (!permissionResult.granted) {
                    showMicrophonePermissionDeniedAlert(permissionResult.canAskAgain);
                    return;
                }
            }

            if (abortController.signal.aborted) {
                return;
            }

            const realtimeCfg = settings?.voice?.adapters?.realtime_elevenlabs ?? null;
            const billingMode = realtimeCfg?.billingMode === 'byo' ? 'byo' : 'happier';
            const effectiveInitialContext = appendOptionalWelcomeToContext(initialContext, realtimeCfg?.welcome);
            await voiceSessionBindingManager.ensureBound({
                adapterId: 'realtime_elevenlabs',
                controlSessionId,
                requestedTargetSessionId,
            });

            if (billingMode === 'byo') {
                const agentId = String(realtimeCfg?.byo?.agentId ?? '').trim();
                const apiKey = sync.decryptSecretValue(realtimeCfg?.byo?.apiKey) ?? '';
                if (!agentId || !apiKey) {
                    Modal.alert(t('common.error'), t('settingsVoice.byo.notConfigured'));
                    return;
                }

                const signedUrl = options?.textOnly === true
                    ? await fetchElevenLabsConversationSignedUrlByo({ agentId, apiKey })
                    : null;
                const token = signedUrl
                    ? null
                    : await fetchElevenLabsConversationTokenByo({ agentId, apiKey });
                if (abortController.signal.aborted) return;

                await enableVoiceBackgroundCallAudioMode();
                const conversationId = await session.startSession({
                    sessionId: controlSessionId,
                    initialContext: effectiveInitialContext,
                    token: token ?? undefined,
                    signedUrl: signedUrl ?? undefined,
                    textOnly: options?.textOnly === true,
                });
                if (typeof conversationId !== 'string' || conversationId.trim().length === 0) {
                    await disableVoiceBackgroundCallAudioMode();
                    return;
                }
                if (abortController.signal.aborted) {
                    try {
                        await session.endSession();
                    } catch {
                        // best-effort cleanup
                    }
                    await disableVoiceBackgroundCallAudioMode();
                    return;
                }
                currentProviderConversationId = conversationId;
                currentLeaseId = null;
                currentBilledMode = 'byo';
                currentControlSessionId = controlSessionId;
                voiceSessionStarted = true;
                if (latestRequestedTargetSessionId && latestRequestedTargetSessionId !== requestedTargetSessionId) {
                    applyVoiceSessionTargetSelection({
                        controlSessionId,
                        targetSessionId: latestRequestedTargetSessionId,
                        updateLastFocused: false,
                    });
                }
                return;
            }

            // Happier Voice: always use authenticated server-minted conversation tokens.
            const credentials = await TokenStorage.getCredentials();
            if (!credentials) {
                Modal.alert(t('common.error'), t('errors.authenticationFailed'));
                return;
            }

            let hasRetriedAfterPaywall = retryAfterPaywall;
            for (;;) {
                const response = await fetchHappierVoiceToken(credentials, {
                    sessionId: requestedTargetSessionId,
                    signal: abortController.signal,
                });
                if (abortController.signal.aborted) return;
                if (response.allowed) {
                    await enableVoiceBackgroundCallAudioMode();
                    const conversationId = await session.startSession({
                        sessionId: controlSessionId,
                        initialContext: effectiveInitialContext,
                        token: response.token,
                        textOnly: options?.textOnly === true,
                    });
                    if (typeof conversationId !== 'string' || conversationId.trim().length === 0) {
                        await disableVoiceBackgroundCallAudioMode();
                        return;
                    }
                    if (abortController.signal.aborted) {
                        try {
                            await session.endSession();
                        } catch {
                            // best-effort cleanup
                        }
                        await disableVoiceBackgroundCallAudioMode();
                        return;
                    }
                    currentProviderConversationId = conversationId;
                    currentLeaseId = response.leaseId;
                    currentBilledMode = 'happier';
                    currentControlSessionId = controlSessionId;
                    voiceSessionStarted = true;
                    if (latestRequestedTargetSessionId && latestRequestedTargetSessionId !== requestedTargetSessionId) {
                        applyVoiceSessionTargetSelection({
                            controlSessionId,
                            targetSessionId: latestRequestedTargetSessionId,
                            updateLastFocused: false,
                        });
                    }
                    scheduleRealtimeLeaseAnnouncements(response.expiresAtMs);
                    return;
                }

                // Subscription/quota: show paywall.
                if (response.reason === 'subscription_required' || response.reason === 'quota_exceeded') {
                    if (hasRetriedAfterPaywall) {
                        Modal.alert(t('common.error'), t('errors.voiceServiceUnavailable'));
                        return;
                    }
                    const result = await sync.presentPaywall();
                    if (result.purchased) {
                        hasRetriedAfterPaywall = true;
                        continue;
                    }
                    return;
                }

                Modal.alert(t('common.error'), t('errors.voiceServiceUnavailable'));
                return;
            }
        } catch (error) {
            if (abortController.signal.aborted) {
                // If stop requested while start is in-flight, don't surface a spurious error.
                return;
            }
            console.error('Failed to start realtime session:', error);
            voiceSessionStarted = false;
            currentProviderConversationId = null;
            currentLeaseId = null;
            currentBilledMode = null;
            currentControlSessionId = null;
            Modal.alert(t('common.error'), t('errors.voiceServiceUnavailable'));
        }
    };

    const promise = run();
    startInFlight = promise;
    try {
        await promise;
    } finally {
        if (startInFlight === promise) {
            startInFlight = null;
            startInFlightAbortController = null;
        }
    }
}

export async function stopRealtimeSession() {
    if (!voiceSession) {
        resetRealtimeUiState();
        return;
    }
    
    try {
        clearRealtimeLeaseTimers();
        // Best-effort cancel any token-minting in-flight so stop can't deadlock.
        startInFlightAbortController?.abort();
        const inFlight = startInFlight;
        if (inFlight) {
            await Promise.race([inFlight.catch(() => {}), new Promise<void>((resolve) => setTimeout(resolve, 1000))]);
            // If start is still stuck (e.g., a hung provider start), clear the in-flight marker so voice can be used again.
            if (startInFlight === inFlight) {
                startInFlight = null;
                startInFlightAbortController = null;
            }
        }
        await voiceSession.endSession();

        if (currentBilledMode === 'happier' && currentLeaseId && currentProviderConversationId) {
            const credentials = await TokenStorage.getCredentials();
            if (credentials) {
                try {
                    await completeHappierVoiceSession(credentials, {
                        leaseId: currentLeaseId,
                        providerConversationId: currentProviderConversationId,
                    });
                } catch (error) {
                    console.warn('Failed to complete Happier voice session:', {
                        leaseId: currentLeaseId,
                        providerConversationId: currentProviderConversationId,
                        error,
                    });
                }
            }
        }

        voiceSessionStarted = false;
        latestRequestedTargetSessionId = null;
        currentLeaseId = null;
        currentLeaseExpiresAtMs = null;
        currentProviderConversationId = null;
        currentBilledMode = null;
        currentControlSessionId = null;
    } catch (error) {
        console.error('Failed to stop realtime session:', error);
    } finally {
        resetRealtimeUiState();
        await disableVoiceBackgroundCallAudioMode();
    }
}

export function registerVoiceSession(session: VoiceSession) {
    voiceSession = session;
}

export function isVoiceSessionStarted(): boolean {
    return voiceSessionStarted;
}

export function getVoiceSession(): VoiceSession | null {
    return voiceSession;
}

export function getCurrentRealtimeControlSessionId(): string | null {
    return currentControlSessionId;
}

export function setCurrentRealtimeControlSessionId(sessionId: string | null): void {
    currentControlSessionId = sessionId;
}
