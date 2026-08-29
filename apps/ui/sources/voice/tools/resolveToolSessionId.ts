import { resolveVoiceActionTargetSessionId, useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { normalizeNonEmptyString } from './actionImpl/shared';

export function resolveToolSessionId(opts: Readonly<{
  explicitSessionId?: unknown;
  currentSessionId?: string | null;
}>): string | null {
  const explicit = normalizeNonEmptyString(opts.explicitSessionId);
  if (explicit) return explicit;

  const { scope, primaryActionSessionId, lastFocusedSessionId } = useVoiceTargetStore.getState();
  return resolveVoiceActionTargetSessionId({
    scope,
    currentSessionId: opts.currentSessionId,
    primaryActionSessionId,
    lastFocusedSessionId,
  });
}
