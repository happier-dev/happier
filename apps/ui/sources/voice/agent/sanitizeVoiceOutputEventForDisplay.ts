import { redactBugReportSensitiveText } from '@happier-dev/protocol/bugs/reports/redaction';
import { VOICE_HISTORY_CONTEXT_FIT_STATUS_TEXT, type VoiceAgentOutputEventV1 } from '@happier-dev/protocol/voice/outputEvents';

import { redactVoicePathLikeString } from '@/voice/shared/redactVoicePathLikeData';
import { t } from '@/text';

/** Display status is untrusted provider text and never bypasses UI redaction. */
export function sanitizeVoiceOutputEventForDisplay(
  event: VoiceAgentOutputEventV1,
): VoiceAgentOutputEventV1 {
  if (event.kind !== 'display_status') return event;
  const text = event.text === VOICE_HISTORY_CONTEXT_FIT_STATUS_TEXT
    ? t('voiceSurface.earlierTurnsLeftOut')
    : event.text;
  return {
    ...event,
    text: redactVoicePathLikeString(redactBugReportSensitiveText(text)),
  };
}
