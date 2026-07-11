import {
  HAPPIER_VOICE_BINDING_NONCE_DYNAMIC_VARIABLE,
  HAPPIER_VOICE_LEASE_ID_DYNAMIC_VARIABLE,
  VoiceRealtimeJsonValueSchema,
  type VoiceRealtimeJsonValue,
} from '@happier-dev/protocol';

import type { ElevenLabsVoiceProviderSettings } from '../../../protocol/voice/index.js';
import type {
  ElevenLabsPreparedSession,
  ElevenLabsSessionPreparation,
} from './elevenLabsSessionTypes.js';
import { resolveElevenLabsLanguageCode } from './resolveElevenLabsLanguageCode.js';

type WelcomeConfig = Readonly<{
  enabled?: boolean | null;
  mode?: 'immediate' | 'on_first_turn' | null;
}>;

function buildWelcomeContext(config: WelcomeConfig | null | undefined): string {
  if (config?.enabled !== true) return '';
  return config.mode === 'on_first_turn'
    ? 'On your first reply, start with one short friendly greeting (one sentence).\nThen continue with your response.'
    : 'Start this session with one short friendly greeting.\nThen wait for the user to speak again.';
}

function appendWelcome(baseContext: string | undefined, config: WelcomeConfig | null | undefined): string | undefined {
  const base = typeof baseContext === 'string' ? baseContext.trim() : '';
  const welcome = buildWelcomeContext(config);
  if (!base) return welcome || undefined;
  return welcome ? `${base}\n\n${welcome}` : base;
}

export function createElevenLabsSessionPreparationService(deps: Readonly<{
  providerId: string;
  projectVoiceSettings: (settings: unknown, providerId: string) => Readonly<{
    providerId: string | null;
    assistantLanguage: string | null;
    welcome: WelcomeConfig;
    providerConfig: ElevenLabsVoiceProviderSettings | null;
  }> | null;
  createProviderClient: (providerId: string) => Readonly<{
    credentialStatus: () => Promise<Readonly<{ exists: boolean }>>;
    mintConversationAuth: (input: Readonly<{
      agentId: string;
      textOnly: boolean;
      signal?: AbortSignal | null;
    }>) => Promise<Readonly<{ kind: 'token' | 'signed_url'; value: string }>>;
  }>;
  getCredentials: () => Promise<unknown | null>;
  fetchHostedVoiceToken: (credentials: unknown, input: Readonly<{
    sessionId: string | null;
    signal: AbortSignal;
  }>) => Promise<
    | Readonly<{
        allowed: true;
        leaseId: string;
        bindingNonce: string;
        token: string;
        expiresAtMs: number;
      }>
    | Readonly<{
        allowed: false;
        reason: string;
      }>
  >;
  presentPaywall: () => Promise<Readonly<{ purchased: boolean }>>;
  alert: (titleKey: string, bodyKey: string) => void;
  createMachineError: (input: Readonly<{ kind: string; reason: string }>) => Readonly<{ kind: string; reason: string }>;
}>) {
  const isSelected = (settings: unknown): boolean =>
    deps.projectVoiceSettings(settings, deps.providerId)?.providerId === deps.providerId;

  const prepare = async (input: Readonly<{
    controlSessionId: string;
    initialContext?: string;
    requestedTargetSessionId: string | null;
    retryAfterPaywall: boolean;
    settings: unknown;
    signal: AbortSignal;
    textOnly: boolean;
  }>): Promise<ElevenLabsSessionPreparation> => {
    const voiceSettings = deps.projectVoiceSettings(input.settings, deps.providerId);
    const providerSettings = voiceSettings?.providerConfig ?? null;
    if (voiceSettings && !providerSettings) {
      return {
        kind: 'declined',
        error: deps.createMachineError({
          kind: 'provider_error',
          reason: 'voice_provider_settings_unavailable',
        }),
      };
    }
    const billingMode = providerSettings?.billingMode === 'byo' ? 'byo' : 'happier';
    const initialContext = appendWelcome(input.initialContext, voiceSettings?.welcome);

    if (billingMode === 'byo') {
      const agentId = String(providerSettings?.byo?.agentId ?? '').trim();
      if (!agentId) {
        deps.alert('common.error', 'settingsVoice.byo.notConfigured');
        return {
          kind: 'declined',
          error: deps.createMachineError({ kind: 'provider_error', reason: 'realtime_byo_not_configured' }),
        };
      }
      const providerClient = deps.createProviderClient(deps.providerId);
      const status = await providerClient.credentialStatus();
      if (input.signal.aborted) return { kind: 'aborted' };
      if (!status.exists) {
        deps.alert('common.error', 'settingsVoice.byo.notConfigured');
        return {
          kind: 'declined',
          error: deps.createMachineError({ kind: 'provider_error', reason: 'realtime_byo_not_configured' }),
        };
      }
      const auth = await providerClient.mintConversationAuth({
        agentId,
        textOnly: input.textOnly,
        signal: input.signal,
      });
      if (input.signal.aborted) return { kind: 'aborted' };
      return {
        kind: 'prepared',
        session: {
          sessionConfig: VoiceRealtimeJsonValueSchema.parse({
            sessionId: input.controlSessionId,
            ...(initialContext ? { initialContext } : {}),
            ...(auth.kind === 'token' ? { token: auth.value } : { signedUrl: auth.value }),
            textOnly: input.textOnly,
          }),
          sessionState: { billingMode: 'byo', expiresAtMs: null, leaseId: null },
        },
      };
    }

    const credentials = await deps.getCredentials();
    if (input.signal.aborted) return { kind: 'aborted' };
    if (!credentials) {
      deps.alert('common.error', 'errors.authenticationFailed');
      return {
        kind: 'declined',
        error: deps.createMachineError({ kind: 'provider_auth_invalid', reason: 'realtime_authentication_required' }),
      };
    }

    let retriedAfterPaywall = input.retryAfterPaywall;
    for (;;) {
      const response = await deps.fetchHostedVoiceToken(credentials, {
        sessionId: input.requestedTargetSessionId,
        signal: input.signal,
      });
      if (input.signal.aborted) return { kind: 'aborted' };
      if (response.allowed) {
        return {
          kind: 'prepared',
          session: {
            sessionConfig: VoiceRealtimeJsonValueSchema.parse({
              sessionId: input.controlSessionId,
              ...(initialContext ? { initialContext } : {}),
              leaseId: response.leaseId,
              bindingNonce: response.bindingNonce,
              token: response.token,
              textOnly: input.textOnly,
            }),
            sessionState: {
              billingMode: 'happier',
              expiresAtMs: response.expiresAtMs,
              leaseId: response.leaseId,
            },
          },
        };
      }
      if (response.reason === 'subscription_required' || response.reason === 'quota_exceeded') {
        if (retriedAfterPaywall) {
          deps.alert('common.error', 'errors.voiceServiceUnavailable');
          return {
            kind: 'declined',
            error: deps.createMachineError({ kind: 'provider_error', reason: `realtime_${response.reason}` }),
          };
        }
        const result = await deps.presentPaywall();
        if (input.signal.aborted) return { kind: 'aborted' };
        if (result.purchased) {
          retriedAfterPaywall = true;
          continue;
        }
        return { kind: 'aborted' };
      }
      deps.alert('common.error', 'errors.voiceServiceUnavailable');
      return {
        kind: 'declined',
        error: deps.createMachineError({ kind: 'provider_error', reason: 'realtime_provider_unavailable' }),
      };
    }
  };

  const buildStartConfig = (input: Readonly<{
    prepared: ElevenLabsPreparedSession;
    settings: unknown;
  }>): VoiceRealtimeJsonValue => {
    const raw = input.prepared.sessionConfig;
    const config = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as Readonly<Record<string, VoiceRealtimeJsonValue>>
      : {};
    const voiceSettings = deps.projectVoiceSettings(input.settings, deps.providerId);
    const language = resolveElevenLabsLanguageCode(voiceSettings?.assistantLanguage ?? null);
    const token = typeof config.token === 'string' ? config.token : '';
    const signedUrl = typeof config.signedUrl === 'string' ? config.signedUrl.trim() : '';
    const textOnly = config.textOnly === true;
    const useSignedWebsocket = textOnly && signedUrl.length > 0;
    if (!useSignedWebsocket && !token) throw new Error('Missing conversation token');

    const dynamicVariables: Record<string, VoiceRealtimeJsonValue> = {
      sessionId: typeof config.sessionId === 'string' ? config.sessionId : '',
      initialConversationContext: typeof config.initialContext === 'string' ? config.initialContext : '',
    };
    const leaseId = typeof config.leaseId === 'string' ? config.leaseId.trim() : '';
    if (leaseId) dynamicVariables[HAPPIER_VOICE_LEASE_ID_DYNAMIC_VARIABLE] = leaseId;
    const bindingNonce = typeof config.bindingNonce === 'string' ? config.bindingNonce.trim() : '';
    if (bindingNonce) dynamicVariables[HAPPIER_VOICE_BINDING_NONCE_DYNAMIC_VARIABLE] = bindingNonce;

    return VoiceRealtimeJsonValueSchema.parse({
      connectionType: useSignedWebsocket ? 'websocket' : 'webrtc',
      textOnly,
      dynamicVariables,
      overrides: {
        conversation: { textOnly },
        agent: language ? { language } : {},
      },
      ...(useSignedWebsocket ? { signedUrl } : { conversationToken: token }),
    });
  };

  return Object.freeze({ isSelected, prepare, buildStartConfig });
}

export type ElevenLabsSessionPreparationService = ReturnType<typeof createElevenLabsSessionPreparationService>;
