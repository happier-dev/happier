import {
    HAPPIER_VOICE_BINDING_NONCE_DYNAMIC_VARIABLE,
    HAPPIER_VOICE_LEASE_ID_DYNAMIC_VARIABLE,
} from '@happier-dev/protocol';
import {
    bindHappierVoiceSessionStart,
    completeHappierVoiceSession,
    fetchHappierVoiceToken,
} from '@/sync/api/voice/apiVoice';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { getElevenLabsCodeFromPreference } from '@/constants/Languages';
import { Modal } from '@/modal';
import { fetchElevenLabsConversationSignedUrlByo, fetchElevenLabsConversationTokenByo } from '@/realtime/elevenLabsByo';
import { sync } from '@/sync/sync';
import type { SecretString } from '@/sync/encryption/secretSettings';
import { t } from '@/text';
import { voiceConversationBindingResolver } from '@/voice/binding/VoiceConversationBindingResolver';
import { useVoiceQaStore } from '@/voice/qa/voiceQaStore';
import {
    appendVoiceConversationNoteText,
    projectRealtimeVoiceTranscriptEvent,
} from '@/voice/transcript/voiceConversationTranscript';

import type { VoiceSessionConfig } from '@/realtime/types';
import type {
    PreparedRealtimeSessionStart,
    RealtimeTransportProvider,
    RealtimeTransportProviderSessionState,
} from '@/voice/runtime/realtime/realtimeTransportProvider';

type RealtimeElevenLabsWelcomeConfig = Readonly<{
    enabled?: boolean | null;
    mode?: 'immediate' | 'on_first_turn' | null;
    templateId?: string | null;
}>;

type RealtimeElevenLabsByoConfig = Readonly<{
    agentId?: string | null;
    apiKey?: SecretString | null;
}>;

type RealtimeElevenLabsAdapterConfig = Readonly<{
    assistantLanguage?: string | null;
    billingMode?: 'happier' | 'byo' | null;
    byo?: RealtimeElevenLabsByoConfig | null;
    welcome?: RealtimeElevenLabsWelcomeConfig | null;
}>;

type VoiceSettingsShape = Readonly<{
    providerId?: string | null;
    assistantLanguage?: string | null;
    adapters?: Readonly<{
        realtime_elevenlabs?: RealtimeElevenLabsAdapterConfig | null;
    }> | null;
}>;

type ActiveRealtimeElevenLabsSessionState = Readonly<{
    controlSessionId: string;
    conversationId: string;
    sessionState: RealtimeTransportProviderSessionState;
    startBinding: Promise<'bound' | 'failed'> | null;
}>;

function buildElevenLabsWelcomeContext(welcomeCfg: RealtimeElevenLabsWelcomeConfig | null | undefined): string {
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

function appendOptionalWelcomeToContext(
    baseContext: string | null | undefined,
    welcomeCfg: RealtimeElevenLabsWelcomeConfig | null | undefined,
): string | undefined {
    const base = typeof baseContext === 'string' ? baseContext.trim() : '';
    const welcome = buildElevenLabsWelcomeContext(welcomeCfg).trim();
    if (!base && !welcome) return undefined;
    if (!welcome) return base;
    if (!base) return welcome;
    return `${base}\n\n${welcome}`;
}

function formatVoiceLeaseDurationShort(ms: number): string {
    const bounded = Math.max(0, Math.floor(ms));
    if (bounded < 90_000) {
        return `${Math.max(1, Math.ceil(bounded / 1000))}s`;
    }
    return `${Math.max(1, Math.ceil(bounded / 60_000))}m`;
}

function readVoiceSettings(settings: unknown): VoiceSettingsShape | null {
    if (!settings || typeof settings !== 'object') {
        return null;
    }
    const maybeVoice = (settings as { voice?: unknown }).voice;
    if (!maybeVoice || typeof maybeVoice !== 'object') {
        return null;
    }
    return maybeVoice as VoiceSettingsShape;
}

function readRealtimeElevenLabsSettings(settings: unknown): RealtimeElevenLabsAdapterConfig | null {
    return readVoiceSettings(settings)?.adapters?.realtime_elevenlabs ?? null;
}

function appendRealtimeLeaseNote(controlSessionId: string, text: string): void {
    const binding = voiceConversationBindingResolver.resolveByControlSessionId({
        controlSessionId,
        adapterId: 'realtime_elevenlabs',
    });
    const conversationSessionId = binding?.conversationSessionId?.trim();
    if (!conversationSessionId) {
        return;
    }
    appendVoiceConversationNoteText({
        conversationSessionId,
        text,
    });
}

class RealtimeElevenLabsTransportProviderImpl implements RealtimeTransportProvider {
    readonly adapterId = 'realtime_elevenlabs';

    private activeSession: ActiveRealtimeElevenLabsSessionState | null = null;
    private leaseWarningTimer: ReturnType<typeof setTimeout> | null = null;
    private leaseExpiryTimer: ReturnType<typeof setTimeout> | null = null;

    isSelectedProvider(settings: unknown): boolean {
        return readVoiceSettings(settings)?.providerId === this.adapterId;
    }

    buildConversationStartConfig(args: Readonly<{ config: VoiceSessionConfig; settings: unknown }>): unknown {
        const voiceSettings = readVoiceSettings(args.settings);
        const realtimeSettings = readRealtimeElevenLabsSettings(args.settings);
        const adapterLanguagePreference = realtimeSettings?.assistantLanguage ?? null;
        const userLanguagePreference = adapterLanguagePreference ?? voiceSettings?.assistantLanguage ?? null;
        const elevenLabsLanguage = getElevenLabsCodeFromPreference(userLanguagePreference);

        const useSignedWebsocket =
            args.config.textOnly === true
            && typeof args.config.signedUrl === 'string'
            && args.config.signedUrl.trim().length > 0;
        if (!useSignedWebsocket && !args.config.token) {
            throw new Error('Missing conversation token');
        }

        const dynamicVariables: Record<string, unknown> = {
            sessionId: args.config.sessionId,
            initialConversationContext: args.config.initialContext ?? '',
        };
        const leaseId = typeof args.config.leaseId === 'string' ? args.config.leaseId.trim() : '';
        if (leaseId) {
            dynamicVariables[HAPPIER_VOICE_LEASE_ID_DYNAMIC_VARIABLE] = leaseId;
        }
        const bindingNonce = typeof args.config.bindingNonce === 'string' ? args.config.bindingNonce.trim() : '';
        if (bindingNonce) {
            dynamicVariables[HAPPIER_VOICE_BINDING_NONCE_DYNAMIC_VARIABLE] = bindingNonce;
        }

        const sessionConfig: Record<string, unknown> = {
            connectionType: useSignedWebsocket ? 'websocket' : 'webrtc',
            textOnly: args.config.textOnly === true,
            dynamicVariables,
            overrides: {
                conversation: {
                    textOnly: args.config.textOnly === true,
                },
                agent: {
                    language: elevenLabsLanguage,
                },
            },
        };
        if (useSignedWebsocket) {
            sessionConfig.signedUrl = args.config.signedUrl;
        } else {
            sessionConfig.conversationToken = args.config.token;
        }
        return sessionConfig;
    }

    resolveConversationId(args: Readonly<{ handle: { getId?: () => string | null }; rawConversationId: unknown }>): string | null {
        if (typeof args.rawConversationId === 'string' && args.rawConversationId.trim().length > 0) {
            return args.rawConversationId;
        }
        return args.handle.getId?.() ?? null;
    }

    resolveProviderMode(mode: string): 'idle' | 'speaking' {
        return mode === 'speaking' ? 'speaking' : 'idle';
    }

    async prepareSessionStart(args: Readonly<{
        controlSessionId: string;
        initialContext?: string;
        requestedTargetSessionId: string | null;
        retryAfterPaywall: boolean;
        settings: unknown;
        signal: AbortSignal;
        textOnly: boolean;
    }>): Promise<PreparedRealtimeSessionStart | null> {
        const realtimeSettings = readRealtimeElevenLabsSettings(args.settings);
        const billingMode = realtimeSettings?.billingMode === 'byo' ? 'byo' : 'happier';
        const initialContext = appendOptionalWelcomeToContext(args.initialContext, realtimeSettings?.welcome);

        if (billingMode === 'byo') {
            const agentId = String(realtimeSettings?.byo?.agentId ?? '').trim();
            const apiKey = sync.decryptSecretValue(realtimeSettings?.byo?.apiKey) ?? '';
            if (!agentId || !apiKey) {
                Modal.alert(t('common.error'), t('settingsVoice.byo.notConfigured'));
                return null;
            }

            const signedUrl = args.textOnly
                ? await fetchElevenLabsConversationSignedUrlByo({ agentId, apiKey })
                : null;
            const token = signedUrl
                ? null
                : await fetchElevenLabsConversationTokenByo({ agentId, apiKey });
            if (args.signal.aborted) {
                return null;
            }

            return {
                sessionConfig: {
                    sessionId: args.controlSessionId,
                    initialContext,
                    token: token ?? undefined,
                    signedUrl: signedUrl ?? undefined,
                    textOnly: args.textOnly,
                },
                sessionState: {
                    billingMode: 'byo',
                    expiresAtMs: null,
                    leaseId: null,
                },
            };
        }

        const credentials = await TokenStorage.getCredentials();
        if (!credentials) {
            Modal.alert(t('common.error'), t('errors.authenticationFailed'));
            return null;
        }

        let hasRetriedAfterPaywall = args.retryAfterPaywall;
        for (;;) {
            const response = await fetchHappierVoiceToken(credentials, {
                sessionId: args.requestedTargetSessionId,
                signal: args.signal,
            });
            if (args.signal.aborted) {
                return null;
            }
            if (response.allowed) {
                return {
                    sessionConfig: {
                        sessionId: args.controlSessionId,
                        initialContext,
                        leaseId: response.leaseId,
                        bindingNonce: response.bindingNonce,
                        token: response.token,
                        textOnly: args.textOnly,
                    },
                    sessionState: {
                        billingMode: 'happier',
                        expiresAtMs: response.expiresAtMs,
                        leaseId: response.leaseId,
                    },
                };
            }

            if (response.reason === 'subscription_required' || response.reason === 'quota_exceeded') {
                if (hasRetriedAfterPaywall) {
                    Modal.alert(t('common.error'), t('errors.voiceServiceUnavailable'));
                    return null;
                }
                const result = await sync.presentPaywall();
                if (result.purchased) {
                    hasRetriedAfterPaywall = true;
                    continue;
                }
                return null;
            }

            Modal.alert(t('common.error'), t('errors.voiceServiceUnavailable'));
            return null;
        }
    }

    handleSessionStarted(args: Readonly<{
        controlSessionId: string;
        conversationId: string;
        preparedStart: PreparedRealtimeSessionStart;
    }>): void {
        const sessionState = args.preparedStart.sessionState;
        const startBinding =
            sessionState.billingMode === 'happier' && sessionState.leaseId
                ? this.bindProviderConversationToLease({
                    conversationId: args.conversationId,
                    leaseId: sessionState.leaseId,
                }).then(
                    () => 'bound' as const,
                    () => 'failed' as const,
                )
                : null;
        this.activeSession = {
            controlSessionId: args.controlSessionId,
            conversationId: args.conversationId,
            sessionState,
            startBinding,
        };
        const expiresAtMs = sessionState.expiresAtMs;
        if (sessionState.billingMode === 'happier' && typeof expiresAtMs === 'number') {
            this.scheduleRealtimeLeaseAnnouncements(args.controlSessionId, expiresAtMs);
        }
    }

    async handleSessionEnded(): Promise<void> {
        const activeSession = this.activeSession;
        this.resetActiveSession();
        if (!activeSession) {
            return;
        }
        if (activeSession.sessionState.billingMode !== 'happier' || !activeSession.sessionState.leaseId) {
            return;
        }
        const credentials = await TokenStorage.getCredentials();
        if (!credentials) {
            return;
        }
        if (activeSession.startBinding) {
            const bindingResult = await activeSession.startBinding;
            if (bindingResult !== 'bound') {
                try {
                    await bindHappierVoiceSessionStart(credentials, {
                        leaseId: activeSession.sessionState.leaseId,
                        providerConversationId: activeSession.conversationId,
                    });
                } catch {
                    return;
                }
            }
        }
        try {
            await completeHappierVoiceSession(credentials, {
                leaseId: activeSession.sessionState.leaseId,
                providerConversationId: activeSession.conversationId,
            });
        } catch {
            // best-effort cleanup
        }
    }

    resetActiveSession(): void {
        if (this.leaseWarningTimer) {
            clearTimeout(this.leaseWarningTimer);
            this.leaseWarningTimer = null;
        }
        if (this.leaseExpiryTimer) {
            clearTimeout(this.leaseExpiryTimer);
            this.leaseExpiryTimer = null;
        }
        this.activeSession = null;
    }

    private async bindProviderConversationToLease(params: Readonly<{
        conversationId: string;
        leaseId: string;
    }>): Promise<void> {
        const credentials = await TokenStorage.getCredentials();
        if (!credentials) {
            throw new Error('voice_session_start_missing_credentials');
        }
        await bindHappierVoiceSessionStart(credentials, {
            leaseId: params.leaseId,
            providerConversationId: params.conversationId,
        });
    }

    handleProviderMessage(args: Readonly<{
        controlSessionId: string | null;
        payload: unknown;
    }>): void {
        useVoiceQaStore.getState().appendRealtimeProviderPayload?.(args.payload);
        const binding = args.controlSessionId
            ? voiceConversationBindingResolver.resolveByControlSessionId({
                controlSessionId: args.controlSessionId,
                adapterId: this.adapterId,
            })
            : null;
        projectRealtimeVoiceTranscriptEvent({
            conversationSessionId: binding?.conversationSessionId ?? null,
            payload: args.payload,
        });
    }

    handleProviderConnected(): void {
        useVoiceQaStore.getState().appendSystem('Realtime ElevenLabs session connected');
    }

    handleProviderDisconnected(): void {
        useVoiceQaStore.getState().appendSystem('Realtime ElevenLabs session disconnected');
    }

    handleProviderDiagnosticsError(reason: string): void {
        useVoiceQaStore.getState().appendError(reason);
    }

    private scheduleRealtimeLeaseAnnouncements(controlSessionId: string, expiresAtMs: number): void {
        this.resetLeaseTimersOnly();

        const remainingMs = expiresAtMs - Date.now();
        if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
            return;
        }

        appendRealtimeLeaseNote(
            controlSessionId,
            t('errors.voiceSessionLimitStarted', { duration: formatVoiceLeaseDurationShort(remainingMs) }),
        );

        const warningLeadMs = 60_000;
        const warningDelayMs = remainingMs - warningLeadMs;
        if (warningDelayMs <= 0) {
            appendRealtimeLeaseNote(
                controlSessionId,
                t('errors.voiceSessionLimitExpiring', { duration: formatVoiceLeaseDurationShort(remainingMs) }),
            );
        } else {
            this.leaseWarningTimer = setTimeout(() => {
                appendRealtimeLeaseNote(
                    controlSessionId,
                    t('errors.voiceSessionLimitExpiring', {
                        duration: formatVoiceLeaseDurationShort(Math.max(0, expiresAtMs - Date.now())),
                    }),
                );
            }, warningDelayMs);
        }

        this.leaseExpiryTimer = setTimeout(() => {
            appendRealtimeLeaseNote(controlSessionId, t('errors.voiceSessionLimitExpired'));
        }, remainingMs);
    }

    private resetLeaseTimersOnly(): void {
        if (this.leaseWarningTimer) {
            clearTimeout(this.leaseWarningTimer);
            this.leaseWarningTimer = null;
        }
        if (this.leaseExpiryTimer) {
            clearTimeout(this.leaseExpiryTimer);
            this.leaseExpiryTimer = null;
        }
    }
}

export function createRealtimeElevenLabsTransportProvider(): RealtimeTransportProvider {
    return new RealtimeElevenLabsTransportProviderImpl();
}
