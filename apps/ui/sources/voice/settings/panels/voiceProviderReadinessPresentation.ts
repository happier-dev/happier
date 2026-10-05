import type { VoiceRoleReadiness } from '@/voice/registry/readiness';
import { t, tLoose } from '@/text';

export function translateVoiceReadiness(key: string, params?: { service: string }): string {
  return key === 'voice.readiness.settings_missing_required_setting'
    ? t('voice.readiness.settings_missing_required_setting', { service: params?.service ?? t('voicePresence.title') })
    : tLoose(key);
}

export type VoiceProviderReadinessPresentation = Readonly<{
  summary: string;
  reason: string | null;
  action: string | null;
  /** One short status for a choice in a list (a gallery tile); `reason` stays the full sentence. */
  short: string | null;
}>;

type VoiceReadinessShort =
  | 'needsSetup' | 'needsKey' | 'needsApproval' | 'offOnServer' | 'needsComputer' | 'needsAddress'
  | 'needsModel' | 'installing' | 'notInstalled' | 'unavailableHere' | 'needsUpdate' | 'cantCheck';

function resolveVoiceReadinessShort(code: string): VoiceReadinessShort {
  if (code.endsWith('_installing')) return 'installing';
  if (code.endsWith('_unknown') || code === 'device_stt_availability_unknown') return 'cantCheck';
  if (code === 'credential_approval_required') return 'needsApproval';
  if (code.startsWith('credential_')) return 'needsKey';
  if (code === 'server_feature_disabled') return 'offOnServer';
  if (code.startsWith('execution_machine_') || code.startsWith('daemon_')) return 'needsComputer';
  if (code.startsWith('endpoint_')) return 'needsAddress';
  if (code === 'model_missing') return 'needsModel';
  if (code === 'runtime_missing') return 'notInstalled';
  if (code === 'settings_unsupported_version' || code === 'settings_needs_migration' || code.endsWith('_incompatible')) return 'needsUpdate';
  if (code.startsWith('settings_') || code === 'provider_mode_unknown' || code === 'provider_unselected') return 'needsSetup';
  return 'unavailableHere';
}

export function resolveVoiceProviderReadinessPresentation(
  readiness: VoiceRoleReadiness,
  translate: (key: string, params?: { service: string }) => string,
  service?: string,
): VoiceProviderReadinessPresentation {
  const summary = translate(readiness.reasonKey, service ? { service } : undefined);
  if (readiness.status === 'ready') {
    return { summary, reason: null, action: null, short: null };
  }
  return {
    summary,
    reason: summary,
    action: readiness.recoveryAction === 'none'
      ? null
      : translate(`voice.readiness.actions.${readiness.recoveryAction}`),
    short: translate(`voice.readiness.short.${resolveVoiceReadinessShort(readiness.code)}`),
  };
}
