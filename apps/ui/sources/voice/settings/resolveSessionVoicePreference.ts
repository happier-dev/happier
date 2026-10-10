import type { DeclaredSessionVoicePreferenceResolutionV1, SessionVoiceDeclarationV1, SessionVoicePreferenceV1 } from '@happier-dev/protocol/sessions/instructions/sessionVoicePreferenceV1';
import { readSessionVoiceSettingValueV1, resolveDeclaredSessionVoicePreferenceV1 } from '@happier-dev/protocol/sessions/instructions/sessionVoicePreferenceV1';
import type { VoiceProviderSettingsJsonValueV1 } from '@happier-dev/protocol/voice/realtime/providerSettings';
import type { VoiceConversationInUseVoice } from '@happier-dev/protocol/actions/voiceConversationActionFamily';
import { t } from '@/text';

export type SessionVoicePreferenceResolutionInput = Readonly<{
  providerContributionId: string;
  declaration: SessionVoiceDeclarationV1;
  providerConfig: VoiceProviderSettingsJsonValueV1;
  preference: SessionVoicePreferenceV1 | null;
  catalog?: readonly Readonly<{ id: string; name: string }>[] | null;
}>;
export type SessionVoicePreferenceResolution =
  | Extract<DeclaredSessionVoicePreferenceResolutionV1, { kind: 'unavailable' }>
  | (Exclude<DeclaredSessionVoicePreferenceResolutionV1, { kind: 'unavailable' }> & Readonly<{ inUseVoice: VoiceConversationInUseVoice | null }>);

export function resolveSessionVoicePreference(input: SessionVoicePreferenceResolutionInput): SessionVoicePreferenceResolution {
  const resolved = resolveDeclaredSessionVoicePreferenceV1(input);
  if (resolved.kind === 'unavailable') return resolved;
  const { field, providerConfig } = resolved;
  const value = field ? readSessionVoiceSettingValueV1(providerConfig, field) : undefined;
  const selection = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  const id = typeof value === 'string' ? value : typeof selection?.id === 'string' ? selection.id : null;
  const row = input.catalog?.find(row => row.id === id);
  const custom = selection?.kind === 'custom' || (typeof value === 'string' && field?.customIdAllowed);
  const inUseVoice: VoiceConversationInUseVoice | null = field && value !== undefined && id?.trim() && (row || custom)
    ? { providerContributionId: input.providerContributionId, settingFieldPath: field.path, value,
      displayName: row?.name ?? t('voicePresence.customVoice') }
    : null;
  return { ...resolved, inUseVoice };
}
