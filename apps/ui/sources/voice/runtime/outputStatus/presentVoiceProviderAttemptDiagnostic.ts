import type { PluginDiagnosticData } from '@happier-dev/plugin-sdk';

import { t } from '@/text';
import { voiceOutputStatusStore } from './voiceOutputStatusStore';

export const CODEX_V3_CONVERSATIONAL_TRANSCRIPT_UNAVAILABLE =
  'codex_v3_conversational_transcript_unavailable';

const USER_VISIBLE_ATTEMPT_DIAGNOSTIC_KEYS = Object.freeze({
  [CODEX_V3_CONVERSATIONAL_TRANSCRIPT_UNAVAILABLE]:
    'voiceSurface.conversationalTranscriptUnavailable',
} as const);

/**
 * Canonical normal-UI presentation boundary for provider attempt diagnostics.
 *
 * Provider leaves supply only a bounded diagnostic identity. Unknown codes and
 * provider-supplied prose remain non-user-visible; this host owner selects and
 * localizes the small status vocabulary exposed by the Voice surface.
 */
export function presentVoiceProviderAttemptDiagnostic(input: Readonly<{
  controlSessionId: string;
  attemptId: number;
  diagnostic: PluginDiagnosticData;
}>): void {
  const translationKey =
    USER_VISIBLE_ATTEMPT_DIAGNOSTIC_KEYS[
      input.diagnostic.code as keyof typeof USER_VISIBLE_ATTEMPT_DIAGNOSTIC_KEYS
    ];
  if (!translationKey) return;
  voiceOutputStatusStore.showAttempt({
    sessionId: input.controlSessionId,
    attemptId: input.attemptId,
    statusId: input.diagnostic.code,
    text: t(translationKey),
  });
}
