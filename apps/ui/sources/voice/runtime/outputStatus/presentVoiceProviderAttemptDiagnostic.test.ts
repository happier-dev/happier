import { beforeEach, describe, expect, it } from 'vitest';

import {
  CODEX_V3_CONVERSATIONAL_TRANSCRIPT_UNAVAILABLE,
  presentVoiceProviderAttemptDiagnostic,
} from './presentVoiceProviderAttemptDiagnostic';
import { voiceOutputStatusStore } from './voiceOutputStatusStore';

describe('Voice provider attempt diagnostic presentation', () => {
  beforeEach(() => {
    voiceOutputStatusStore.clearAttemptForSession('voice-global');
  });

  it('projects the bounded unavailable code into localized attempt status without a turn identity', () => {
    presentVoiceProviderAttemptDiagnostic({
      controlSessionId: 'voice-global',
      attemptId: 31,
      diagnostic: {
        code: CODEX_V3_CONVERSATIONAL_TRANSCRIPT_UNAVAILABLE,
        severity: 'warning',
        message: 'provider prose must not be rendered',
      },
    });

    expect(voiceOutputStatusStore.readForSession('voice-global')).toMatchObject({
      scope: 'attempt',
      attemptId: 31,
      statusId: CODEX_V3_CONVERSATIONAL_TRANSCRIPT_UNAVAILABLE,
    });
    expect(voiceOutputStatusStore.readForSession('voice-global')).not.toHaveProperty('turnId');
    expect(voiceOutputStatusStore.readForSession('voice-global')?.text)
      .not.toContain('provider prose');
  });

  it('keeps unknown provider diagnostics out of the normal user-visible status owner', () => {
    presentVoiceProviderAttemptDiagnostic({
      controlSessionId: 'voice-global',
      attemptId: 32,
      diagnostic: {
        code: 'provider_unknown_warning',
        severity: 'warning',
      },
    });

    expect(voiceOutputStatusStore.readForSession('voice-global')).toBeNull();
  });
});
