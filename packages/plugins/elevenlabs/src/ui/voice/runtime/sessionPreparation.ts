import {
  HAPPIER_VOICE_BINDING_NONCE_DYNAMIC_VARIABLE,
  HAPPIER_VOICE_LEASE_ID_DYNAMIC_VARIABLE,
  VoiceRealtimeJsonValueSchema,
  type VoiceRealtimeJsonValue,
  type VoiceHostedConversationService,
  type VoiceRuntimePlatform,
  type VoiceRealtimeAttemptPolicy,
} from '@happier-dev/plugin-sdk/voice/client';
import type {
  VoiceCredentialAccess,
} from '@happier-dev/plugin-sdk/voice';

import { ElevenLabsVoiceProviderSettingsSchema } from '../../../protocol/voice/index.js';
import { ELEVENLABS_INITIAL_CONVERSATION_CONTEXT_VARIABLE } from '../autoprovision.js';
import {
  isElevenLabsAgentConfigurationCurrent,
  mintElevenLabsConversationAuthWithAccountOperations,
} from '../operations.js';
import type {
  ElevenLabsPreparedSession,
  ElevenLabsSessionPreparation,
} from './sessionTypes.js';
import { resolveElevenLabsLanguageCode } from './resolveLanguageCode.js';

export function createElevenLabsSessionPreparationService(deps: Readonly<{
  providerId: string;
  projectVoiceSettings: (settings: unknown, providerId: string) => Readonly<{
    providerId: string | null;
    assistantLanguage: string | null;
    providerConfig: unknown;
  }> | null;
  alert: (titleKey: string, bodyKey: string) => void;
}>) {
  const isSelected = (settings: unknown): boolean =>
    deps.projectVoiceSettings(settings, deps.providerId)?.providerId === deps.providerId;

  const prepare = async (input: Readonly<{
    controlSessionId: string;
    initialContext?: string;
    requestedTargetSessionId: string | null;
    settings: unknown;
    credentials: VoiceCredentialAccess<'prepare'>;
    hostedConversation: VoiceHostedConversationService | null;
    signal: AbortSignal;
    platform: VoiceRuntimePlatform;
    textOnly: boolean;
    attemptPolicy?: VoiceRealtimeAttemptPolicy;
  }>): Promise<ElevenLabsSessionPreparation> => {
    const voiceSettings = deps.projectVoiceSettings(input.settings, deps.providerId);
    const parsedProviderSettings = ElevenLabsVoiceProviderSettingsSchema.safeParse(
      voiceSettings?.providerConfig,
    );
    const providerSettings = parsedProviderSettings.success ? parsedProviderSettings.data : null;
    if (voiceSettings && !providerSettings) {
      return {
        kind: 'declined',
        failure: { reason: 'voice_provider_settings_unavailable' },
      };
    }
    const billingMode = providerSettings?.billingMode === 'byo' ? 'byo' : 'happier';
    const initialContext = input.initialContext?.trim();

    if (billingMode === 'byo') {
      const agentId = providerSettings?.agentId.trim() ?? '';
      if (!agentId) {
        deps.alert('common.error', 'voice.readiness.settings_missing_required_setting');
        return {
          kind: 'declined',
          failure: { reason: 'realtime_byo_not_configured' },
        };
      }
      if (input.signal.aborted) return { kind: 'aborted' };
      if (!input.credentials.mediated) {
        return {
          kind: 'declined',
          failure: { reason: 'voice_provider_credential_unavailable' },
        };
      }
      const configurationCurrent = await isElevenLabsAgentConfigurationCurrent({
        accountOperations: input.credentials.mediated, agentId, signal: input.signal,
      });
      if (input.signal.aborted) return { kind: 'aborted' };
      if (!configurationCurrent) {
        return { kind: 'declined', failure: { reason: 'realtime_agent_update_required' } };
      }
      const auth = await mintElevenLabsConversationAuthWithAccountOperations({
        accountOperations: input.credentials.mediated,
        agentId,
        connectionType: input.textOnly && input.platform === 'web' ? 'websocket' : 'webrtc',
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
          ...(input.attemptPolicy ? { attemptPolicy: input.attemptPolicy } : {}),
        },
      };
    }

    if (!input.hostedConversation) {
      return {
        kind: 'declined',
        failure: { reason: 'realtime_hosted_conversation_unavailable' },
      };
    }

    // The host-owned hosted-conversation service performs subscription/quota
    // remediation before returning. The provider leaf consumes only its final
    // admission result and never owns purchase UI or retries.
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
          ...(input.attemptPolicy ? { attemptPolicy: input.attemptPolicy } : {}),
        },
      };
    }
    await input.hostedConversation.abort();
    if (response.reason === 'authentication_required') {
      deps.alert('common.error', 'errors.authenticationFailed');
      return {
        kind: 'declined',
        failure: { reason: 'realtime_authentication_required' },
      };
    }
    if (response.reason === 'subscription_required' || response.reason === 'quota_exceeded') {
      return {
        kind: 'declined',
        failure: { reason: `realtime_${response.reason}` },
      };
    }
    deps.alert('common.error', 'errors.voiceServiceUnavailable');
    return {
      kind: 'declined',
      failure: { reason: 'realtime_provider_unavailable' },
    };
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
    const policy = input.prepared.attemptPolicy;
    const language = resolveElevenLabsLanguageCode(policy ? policy.assistantLanguage : voiceSettings?.assistantLanguage ?? null);
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
        agent: {
          ...(language ? { language } : {}),
          ...(policy ? { firstMessage: policy.welcome.enabled && policy.welcome.mode === 'immediate'
            ? policy.welcome.text ?? '' : '' } : {}),
          ...(policy ? { prompt: { prompt: [policy.instructions, ELEVENLABS_INITIAL_CONVERSATION_CONTEXT_VARIABLE].join('\n\n') } } : {}),
        },
      },
      ...(useSignedWebsocket ? { signedUrl } : { conversationToken: token }),
    });
  };

  return Object.freeze({ isSelected, prepare, buildStartConfig });
}

export type ElevenLabsSessionPreparationService = ReturnType<typeof createElevenLabsSessionPreparationService>;
