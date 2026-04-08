import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { normalizeNonEmptyString } from './actionImpl/shared';

export function resolveToolSessionId(opts: Readonly<{
  explicitSessionId?: unknown;
  currentSessionId?: string | null;
}>): string | null {
  const explicit = normalizeNonEmptyString(opts.explicitSessionId);
  if (explicit) return explicit;

  const current = normalizeNonEmptyString(opts.currentSessionId);
  if (current) return current;

  const { scope, primaryActionSessionId, lastFocusedSessionId } = useVoiceTargetStore.getState();
  if (scope === 'global') {
    return normalizeNonEmptyString(primaryActionSessionId) ?? normalizeNonEmptyString(lastFocusedSessionId);
  }
  return current;
}
