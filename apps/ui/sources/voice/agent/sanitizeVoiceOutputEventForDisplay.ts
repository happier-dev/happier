import {
  redactBugReportSensitiveText,
  type VoiceAgentOutputEventV1,
} from '@happier-dev/protocol';

import { redactVoicePathLikeString } from '@/voice/shared/redactVoicePathLikeData';

/** Display status is untrusted provider text and never bypasses UI redaction. */
export function sanitizeVoiceOutputEventForDisplay(
  event: VoiceAgentOutputEventV1,
): VoiceAgentOutputEventV1 {
  if (event.kind !== 'display_status') return event;
  return {
    ...event,
    text: redactVoicePathLikeString(redactBugReportSensitiveText(event.text)),
  };
}
