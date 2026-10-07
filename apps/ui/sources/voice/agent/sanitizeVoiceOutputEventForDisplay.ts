import { redactBugReportSensitiveText } from '@happier-dev/protocol/bugs/reports/redaction';
import type { VoiceAgentOutputEventV1 } from '@happier-dev/protocol/voice/outputEvents';

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
