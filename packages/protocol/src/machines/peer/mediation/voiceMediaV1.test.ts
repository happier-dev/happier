import { describe, expect, it } from 'vitest';

import {
  VoiceMediaApplicationAuthorityV1Schema,
  VoiceMediaApplicationKindV1Schema,
} from './voiceMediaV1.js';

describe('voice media v1', () => {
  it('admits only speech transcription and binds an opaque attempt plus authority digest', () => {
    expect(VoiceMediaApplicationKindV1Schema.parse('speech_transcription')).toBe(
      'speech_transcription',
    );
    expect(VoiceMediaApplicationKindV1Schema.safeParse('agent_realtime').success).toBe(false);
    expect(VoiceMediaApplicationAuthorityV1Schema.safeParse({
      v: 1,
      applicationKind: 'agent_realtime',
      applicationAttemptId: 'attempt-1',
      applicationAuthorityDigest: `sha256:${'ab'.repeat(32)}`,
    }).success).toBe(false);
    expect(VoiceMediaApplicationAuthorityV1Schema.safeParse({
      v: 1,
      applicationKind: 'speech_transcription',
      applicationAttemptId: 'attempt-1',
      applicationAuthorityDigest: `sha256:${'ab'.repeat(32)}`,
      sessionId: 'raw-session-id-must-not-enter-the-carrier',
    }).success).toBe(false);
  });
});
