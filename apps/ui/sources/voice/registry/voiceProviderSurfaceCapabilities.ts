import { isBundledAgentId } from '@happier-dev/agents';
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES } from '@happier-dev/agents/agent-ids';
import type { VoiceProviderContribution } from '@happier-dev/protocol/plugins/contributions/voice';
import { readLocalConversationVoiceSettings, readVoiceProviderSettingsConfig, readVoiceSettingsInput, voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { VoiceLocalDirectSchema } from '@/voice/adapters/localDirect/settings';
import { projectExternalVoiceProviderSettings, type ExternalVoiceProviderSettingsDescriptor } from '@/voice/settings/externalProviderSettings';
import type { VoiceAdapterSurfaceCapabilities } from '@/voice/session/types';
import type { VoiceProviderRegistryEntry } from './providerRegistry';

export function projectDeclaredVoiceAgentIdentity(
  pluginId: string,
  agent: string | Readonly<{ pluginId: string; localId: string }>,
): NonNullable<VoiceAdapterSurfaceCapabilities['agentRuntime']> {
  return typeof agent === 'string' ? Object.freeze({ pluginId, localId: agent }) : agent;
}

/** Pure configuration semantics shared by cold controls and the executable Local adapters. */
export function projectLocalVoiceSurfaceCapabilities(
  providerId: 'local_direct' | 'local_conversation',
  settings: unknown,
): VoiceAdapterSurfaceCapabilities | null {
  const voice = voiceSettingsParse(readVoiceSettingsInput(settings));
  const envelope = voice.providers[providerId];
  if (envelope?.schemaVersion !== 1) return null;
  if (providerId === 'local_direct') {
    if (voice.providerId !== providerId) return null;
    const config = VoiceLocalDirectSchema.safeParse(envelope.config);
    return config.success ? {
      allowsGlobalStart: false, controlSessionScope: 'surface', requiresVoiceAgentFeature: false,
      bargeInEnabled: config.data.tts.bargeInEnabled, cancelResponse: 'immediate',
    } : null;
  }
  if (readVoiceProviderSettingsConfig(voice, providerId) === null) return null;
  const config = readLocalConversationVoiceSettings(voice);
  const agentMode = config.conversationMode === 'agent';
  const { agentSource, agentId, agentIdentity } = config.agent;
  const agentRuntime = agentMode && agentSource === 'agent'
    ? agentIdentity ?? (isBundledAgentId(agentId) ? BUNDLED_AGENT_CONTRIBUTION_IDENTITIES[agentId] : null)
    : null;
  return {
    allowsGlobalStart: agentMode, controlSessionScope: agentMode ? 'global' : 'surface',
    requiresVoiceAgentFeature: agentMode, bargeInEnabled: config.tts.bargeInEnabled !== false,
    cancelResponse: 'immediate', ...(agentRuntime ? { agentRuntime } : {}),
  };
}

/** Declaration-owned semantics do not require importing or activating a provider leaf. */
export function projectDeclaredVoiceSurfaceCapabilities(input: Readonly<{
  providerId: string;
  pluginId?: string;
  declaration: Extract<VoiceProviderContribution, Readonly<{ kind: 'conversation' }>>;
  providerSettings: ExternalVoiceProviderSettingsDescriptor;
}>, settings: unknown): VoiceAdapterSurfaceCapabilities | null {
  const voice = voiceSettingsParse(readVoiceSettingsInput(settings));
  const projection = projectExternalVoiceProviderSettings(voice.providers[input.providerId] ?? null, input.providerSettings);
  if (voice.providerId !== input.providerId || projection.status !== 'ready') return null;
  const turn = input.declaration.capabilities.turn;
  const execution = input.declaration.execution;
  const agentRuntime = execution?.kind === 'experimental_agent_session_realtime' && input.pluginId
    ? projectDeclaredVoiceAgentIdentity(input.pluginId, execution.agent) : null;
  return Object.freeze({
    allowsGlobalStart: true, controlSessionScope: 'global', requiresVoiceAgentFeature: false,
    bargeInEnabled: turn.bargeIn, cancelResponse: turn.cancelResponse ? 'immediate' : 'unsupported',
    interruptionPolicy: turn.interruptionPolicy ?? (turn.bargeIn ? 'client_two_stage' : 'disabled'),
    ...(agentRuntime ? { agentRuntime } : {}),
  });
}

export function projectVoiceProviderDescriptorSurfaceCapabilities(
  entry: VoiceProviderRegistryEntry | null,
  settings: unknown,
): VoiceAdapterSurfaceCapabilities | null {
  if (entry?.kind !== 'voice.conversation-provider.v1') return null;
  if (entry.providerId === 'local_direct' || entry.providerId === 'local_conversation') {
    return projectLocalVoiceSurfaceCapabilities(entry.providerId, settings);
  }
  return entry.declaration && entry.providerSettings
    ? projectDeclaredVoiceSurfaceCapabilities({ providerId: entry.providerId, pluginId: entry.pluginId,
      declaration: entry.declaration, providerSettings: entry.providerSettings }, settings)
    : null;
}
