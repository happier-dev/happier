import { randomUUID } from '@/platform/randomUUID';
import type { VoiceAdapterId, VoiceSessionMode, VoiceSessionStatus } from '@/voice/session/types';
import { useVoiceActivityStore } from '@/voice/activity/voiceActivityStore';

import type { VoiceActivityActionId, VoiceActivityEvent } from './voiceActivityEvents';

function nowMs(): number {
  return Date.now();
}

function append(event: VoiceActivityEvent): void {
  useVoiceActivityStore.getState().append(event);
}

export const voiceActivityController = {
  clearSession(sessionId: string) {
    useVoiceActivityStore.getState().clearSession(sessionId);
  },
  append,
  appendLifecycle(sessionId: string, adapterId: VoiceAdapterId, kind: 'lifecycle.start' | 'lifecycle.stop') {
    append({ id: randomUUID(), ts: nowMs(), sessionId, adapterId, kind });
  },
  appendStatus(sessionId: string, adapterId: VoiceAdapterId, status: VoiceSessionStatus, mode: VoiceSessionMode) {
    append({ id: randomUUID(), ts: nowMs(), sessionId, adapterId, kind: 'status', status, mode });
  },
  appendUserText(sessionId: string, adapterId: VoiceAdapterId, text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    append({ id: randomUUID(), ts: nowMs(), sessionId, adapterId, kind: 'user.text', text: trimmed });
  },
  appendAssistantText(sessionId: string, adapterId: VoiceAdapterId, text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    append({ id: randomUUID(), ts: nowMs(), sessionId, adapterId, kind: 'assistant.text', text: trimmed });
  },
  appendAssistantDelta(sessionId: string, adapterId: VoiceAdapterId, textDelta: string) {
    const trimmed = textDelta;
    if (!trimmed) return;
    append({ id: randomUUID(), ts: nowMs(), sessionId, adapterId, kind: 'assistant.delta', textDelta: trimmed });
  },
  appendActionExecuted(sessionId: string, adapterId: VoiceAdapterId, action: VoiceActivityActionId, summary: string) {
    const trimmed = summary.trim();
    if (!trimmed) return;
    append({ id: randomUUID(), ts: nowMs(), sessionId, adapterId, kind: 'action.executed', action, summary: trimmed });
  },
  appendError(sessionId: string, adapterId: VoiceAdapterId, errorCode: string, errorMessage: string) {
    const code = String(errorCode || '').trim() || 'unknown';
    const msg = String(errorMessage || '').trim() || code;
    append({ id: randomUUID(), ts: nowMs(), sessionId, adapterId, kind: 'error', errorCode: code, errorMessage: msg });
  },
};

