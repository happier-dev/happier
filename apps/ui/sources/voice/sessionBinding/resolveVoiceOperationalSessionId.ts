import type { VoiceSessionBinding } from './voiceSessionBindingTypes';

function normalizeSessionId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveVoiceOperationalSessionId(
  binding: VoiceSessionBinding | null | undefined,
  fallbackControlSessionId: string,
): string {
  const normalizedFallback = normalizeSessionId(fallbackControlSessionId);
  if (!normalizedFallback) return '';
  if (!binding) return normalizedFallback;

  if (binding.transcriptMode === 'native_session') {
    return normalizeSessionId(binding.conversationSessionId)
      ?? normalizeSessionId(binding.controlSessionId)
      ?? normalizedFallback;
  }

  return normalizeSessionId(binding.controlSessionId) ?? normalizedFallback;
}
