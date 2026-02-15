import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';

function normalizeSessionId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveToolSessionId(opts: Readonly<{
  explicitSessionId?: unknown;
  currentSessionId?: string | null;
}>): string | null {
  const explicit = normalizeSessionId(opts.explicitSessionId);
  if (explicit) return explicit;

  const { scope, primaryActionSessionId, lastFocusedSessionId } = useVoiceTargetStore.getState();
  if (scope === 'global') {
    return normalizeSessionId(primaryActionSessionId) ?? normalizeSessionId(opts.currentSessionId) ?? normalizeSessionId(lastFocusedSessionId);
  }
  return normalizeSessionId(opts.currentSessionId);
}
