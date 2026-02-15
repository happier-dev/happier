import type { VoiceSession } from './types';
import { completeHappierVoiceSession, fetchHappierVoiceToken } from '@/sync/api/voice/apiVoice';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { t } from '@/text';
import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/platform/microphonePermissions';
import { fetchElevenLabsConversationTokenByo } from './elevenLabsByo';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { disableVoiceBackgroundCallAudioMode, enableVoiceBackgroundCallAudioMode } from '@/voice/runtime/voiceAudioMode';

let voiceSession: VoiceSession | null = null;
let voiceSessionStarted: boolean = false;
let startInFlight: Promise<void> | null = null;
let startInFlightAbortController: AbortController | null = null;
let currentLeaseId: string | null = null;
let currentProviderConversationId: string | null = null;
let currentBilledMode: 'happier' | 'byo' | null = null;

export async function startRealtimeSession(sessionId: string, initialContext?: string, retryAfterPaywall = false) {
    const session = voiceSession;
    if (!session) {
        console.warn('No voice session registered');
        return;
    }

    const normalizedSessionId = String(sessionId ?? '').trim();
    if (normalizedSessionId.length > 0) {
        useVoiceTargetStore.getState().setPrimaryActionSessionId(normalizedSessionId);
        useVoiceTargetStore.getState().setLastFocusedSessionId(normalizedSessionId);
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
            // Request microphone permission before starting voice session
            // Critical for iOS/Android - first session will fail without this
            const permissionResult = await requestMicrophonePermission();
            if (!permissionResult.granted) {
                showMicrophonePermissionDeniedAlert(permissionResult.canAskAgain);
                return;
            }

            if (abortController.signal.aborted) {
                return;
            }

            const realtimeCfg = settings?.voice?.adapters?.realtime_elevenlabs ?? null;
            const billingMode = realtimeCfg?.billingMode === 'byo' ? 'byo' : 'happier';

            if (billingMode === 'byo') {
                const agentId = String(realtimeCfg?.byo?.agentId ?? '').trim();
                const apiKey = sync.decryptSecretValue(realtimeCfg?.byo?.apiKey) ?? '';
                if (!agentId || !apiKey) {
                    Modal.alert(t('common.error'), t('settingsVoice.byo.notConfigured'));
                    return;
                }

                const token = await fetchElevenLabsConversationTokenByo({ agentId, apiKey });
                if (abortController.signal.aborted) return;

                await enableVoiceBackgroundCallAudioMode();
                const conversationId = await session.startSession({
                    sessionId,
                    initialContext,
                    token,
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
                voiceSessionStarted = true;
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
                const response = await fetchHappierVoiceToken(credentials, { sessionId, signal: abortController.signal });
                if (abortController.signal.aborted) return;
                if (response.allowed) {
                    await enableVoiceBackgroundCallAudioMode();
                    const conversationId = await session.startSession({
                        sessionId,
                        initialContext,
                        token: response.token,
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
                    voiceSessionStarted = true;
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
        return;
    }
    
    try {
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
        currentLeaseId = null;
        currentProviderConversationId = null;
        currentBilledMode = null;
    } catch (error) {
        console.error('Failed to stop realtime session:', error);
    } finally {
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
