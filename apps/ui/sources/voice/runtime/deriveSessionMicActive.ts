import type { VoiceSessionStatus } from '@/voice/session/types';
import type { VoiceAssistantScope } from '@/voice/runtime/voiceTargetStore';

export function deriveSessionMicActive(opts: Readonly<{
  voiceStatus: VoiceSessionStatus;
  scope: VoiceAssistantScope;
  sessionId: string;
  primaryActionSessionId: string | null;
  lastFocusedSessionId: string | null;
}>): boolean {
  if (opts.voiceStatus === 'disconnected') return false;

  if (opts.scope === 'session') return true;

  // Global scope: consider the mic "active" only when this session is the current action target.
  // If no explicit target is set, fall back to the last focused session (which is also the tool-routing fallback).
  if (opts.primaryActionSessionId) {
    return opts.primaryActionSessionId === opts.sessionId;
  }
  return Boolean(opts.lastFocusedSessionId) && opts.lastFocusedSessionId === opts.sessionId;
}

