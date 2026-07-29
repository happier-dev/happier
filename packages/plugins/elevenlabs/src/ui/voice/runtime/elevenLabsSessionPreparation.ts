import {
  HAPPIER_VOICE_BINDING_NONCE_DYNAMIC_VARIABLE,
  HAPPIER_VOICE_LEASE_ID_DYNAMIC_VARIABLE,
  VoiceRealtimeJsonValueSchema,
  type VoiceRealtimeJsonValue,
} from '@happier-dev/protocol';
import type {
  VoiceMachineError,
  VoiceMachineErrorKind,
} from '@happier-dev/bundled-voice-runtime-contract';
import type {
  PluginVoiceAccountOperationService,
  PluginVoiceHostedConversationService,
} from '@happier-dev/plugin-sdk/runtime';

import { ElevenLabsVoiceProviderSettingsSchema } from '../../../protocol/voice/index.js';
import { mintElevenLabsConversationAuthWithAccountOperations } from '../providerOperations.js';
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
    providerConfig: unknown;
  }> | null;
  presentPaywall: () => Promise<Readonly<{ purchased: boolean }>>;
  alert: (titleKey: string, bodyKey: string) => void;
  createMachineError: (input: Readonly<{
    kind: VoiceMachineErrorKind;
    reason: string;
  }>) => VoiceMachineError;
}>) {
  const isSelected = (settings: unknown): boolean =>
    deps.projectVoiceSettings(settings, deps.providerId)?.providerId === deps.providerId;

  const prepare = async (input: Readonly<{
    controlSessionId: string;
    initialContext?: string;
    requestedTargetSessionId: string | null;
    retryAfterPaywall: boolean;
    settings: unknown;
    accountOperations: PluginVoiceAccountOperationService;
    hostedConversation: PluginVoiceHostedConversationService | null;
    signal: AbortSignal;
    textOnly: boolean;
  }>): Promise<ElevenLabsSessionPreparation> => {
    const voiceSettings = deps.projectVoiceSettings(input.settings, deps.providerId);
    const parsedProviderSettings = ElevenLabsVoiceProviderSettingsSchema.safeParse(
      voiceSettings?.providerConfig,
    );
    const providerSettings = parsedProviderSettings.success ? parsedProviderSettings.data : null;
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
      if (input.signal.aborted) return { kind: 'aborted' };
      const auth = await mintElevenLabsConversationAuthWithAccountOperations({
        accountOperations: input.accountOperations,
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

    if (!input.hostedConversation) {
      return {
        kind: 'declined',
        error: deps.createMachineError({
          kind: 'provider_error',
          reason: 'realtime_hosted_conversation_unavailable',
        }),
      };
    }

    let retriedAfterPaywall = input.retryAfterPaywall;
    for (;;) {
      const response = await input.hostedConversation.start({
        sessionId: input.requestedTargetSessionId,
      });
      if (input.signal.aborted) {
        await input.hostedConversation.abort();
        return { kind: 'aborted' };
      }
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
      if (response.reason === 'authentication_required') {
        await input.hostedConversation.abort();
        deps.alert('common.error', 'errors.authenticationFailed');
        return {
          kind: 'declined',
          error: deps.createMachineError({
            kind: 'provider_auth_invalid',
            reason: 'realtime_authentication_required',
          }),
        };
      }
      if (response.reason === 'subscription_required' || response.reason === 'quota_exceeded') {
        if (retriedAfterPaywall) {
          await input.hostedConversation.abort();
          deps.alert('common.error', 'errors.voiceServiceUnavailable');
          return {
            kind: 'declined',
            error: deps.createMachineError({ kind: 'provider_error', reason: `realtime_${response.reason}` }),
          };
        }
        const result = await deps.presentPaywall();
        if (input.signal.aborted) {
          await input.hostedConversation.abort();
          return { kind: 'aborted' };
        }
        if (result.purchased) {
          retriedAfterPaywall = true;
          continue;
        }
        await input.hostedConversation.abort();
        return { kind: 'aborted' };
      }
      await input.hostedConversation.abort();
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
