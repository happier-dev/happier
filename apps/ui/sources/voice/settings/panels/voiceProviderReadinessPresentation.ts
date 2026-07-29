import type { VoiceRoleReadiness } from '@/voice/registry/readiness';

export type VoiceProviderReadinessPresentation = Readonly<{
  reason: string | null;
  action: string | null;
}>;

export function resolveVoiceProviderReadinessPresentation(
  readiness: VoiceRoleReadiness,
  translate: (key: string) => string,
): VoiceProviderReadinessPresentation {
  if (readiness.status === 'ready') {
    return { reason: null, action: null };
  }
  return {
    reason: translate(readiness.reasonKey),
    action: readiness.recoveryAction === 'none'
      ? null
      : translate(`voice.readiness.actions.${readiness.recoveryAction}`),
  };
}
