import type { VoiceRoleReadiness } from '@/voice/registry/readiness';

export type VoiceProviderReadinessPresentation = Readonly<{
  summary: string;
  reason: string | null;
  action: string | null;
}>;

export function resolveVoiceProviderReadinessPresentation(
  readiness: VoiceRoleReadiness,
  translate: (key: string) => string,
): VoiceProviderReadinessPresentation {
  const summary = translate(readiness.reasonKey);
  if (readiness.status === 'ready') {
    return { summary, reason: null, action: null };
  }
  return {
    summary,
    reason: summary,
    action: readiness.recoveryAction === 'none'
      ? null
      : translate(`voice.readiness.actions.${readiness.recoveryAction}`),
  };
}
