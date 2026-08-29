import type { VoiceSessionStatus } from '@/voice/session/types';
import { resolveVoiceActionTargetSessionId, type VoiceAssistantScope } from '@/voice/runtime/voiceTargetStore';

export function deriveSessionMicActive(opts: Readonly<{
  voiceStatus: VoiceSessionStatus;
  scope: VoiceAssistantScope;
  sessionId: string;
  primaryActionSessionId: string | null;
  lastFocusedSessionId: string | null;
}>): boolean {
  if (opts.voiceStatus === 'disconnected') return false;

  return resolveVoiceActionTargetSessionId({
    scope: opts.scope,
    currentSessionId: opts.scope === 'session' ? opts.sessionId : null,
    primaryActionSessionId: opts.primaryActionSessionId,
    lastFocusedSessionId: opts.lastFocusedSessionId,
  }) === opts.sessionId;
}
