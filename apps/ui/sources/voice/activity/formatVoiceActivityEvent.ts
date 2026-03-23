import { t } from '@/text';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';

import type { VoiceActivityEvent } from './voiceActivityEvents';

export function formatVoiceActivityEvent(event: VoiceActivityEvent, sessionLabelById?: ReadonlyMap<string, string>): string {
  const prefix = (() => {
    const sid = typeof event?.sessionId === 'string' ? event.sessionId : '';
    if (!sid) return '';
    const label =
      sid === VOICE_AGENT_GLOBAL_SESSION_ID ? t('voiceActivity.format.voiceAgent') : (sessionLabelById?.get(sid) ?? sid);
    return `[${label}] `;
  })();

  switch (event.kind) {
    case 'user.text':
      return `${prefix}${t('voiceActivity.format.you')}: ${event.text}`;
    case 'assistant.text':
      return `${prefix}${t('voiceActivity.format.assistant')}: ${event.text}`;
    case 'assistant.delta':
      return `${prefix}${t('voiceActivity.format.assistantStreaming')} ${event.textDelta}`;
    case 'action.executed':
      return `${prefix}${t('voiceActivity.format.action')}: ${event.summary}`;
    case 'error':
      return `${prefix}${t('voiceActivity.format.error')}: ${String(
        event.errorMessage ?? event.errorCode ?? t('voiceActivity.format.errorFallback'),
      )
        .split(VOICE_AGENT_GLOBAL_SESSION_ID)
        .join(t('voiceActivity.format.voiceAgent'))}`;
    case 'status':
      return `${prefix}${t('voiceActivity.format.status')}: ${event.status} (${event.mode})`;
    case 'lifecycle.start':
      return `${prefix}${t('voiceActivity.format.started')}`;
    case 'lifecycle.stop':
      return `${prefix}${t('voiceActivity.format.stopped')}`;
  }

  return `${prefix}${t('voiceActivity.format.eventFallback')}`;
}

export function sortVoiceActivityEventsByTsThenId(a: VoiceActivityEvent, b: VoiceActivityEvent): number {
  const ta = typeof a?.ts === 'number' ? a.ts : 0;
  const tb = typeof b?.ts === 'number' ? b.ts : 0;
  if (ta !== tb) return ta - tb;
  const ia = typeof a?.id === 'string' ? a.id : '';
  const ib = typeof b?.id === 'string' ? b.id : '';
  return ia.localeCompare(ib);
}
