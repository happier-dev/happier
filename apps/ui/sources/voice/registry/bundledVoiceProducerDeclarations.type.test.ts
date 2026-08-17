import { describe, expect, it } from 'vitest';

import {
  BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS,
  BUNDLED_FIRST_PARTY_VOICE_PRESENTATIONS,
} from './generatedBundledVoiceEntries';

describe('bundled voice producer projection', () => {
  it('keeps manifest semantics separate from qualified presentation', () => {
    expect(BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS).toHaveLength(
      BUNDLED_FIRST_PARTY_VOICE_PRESENTATIONS.length,
    );
    for (const contribution of BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS) {
      const presentation = BUNDLED_FIRST_PARTY_VOICE_PRESENTATIONS.find(
        (candidate) => candidate.providerId === contribution.providerId,
      );
      expect(presentation).toBeDefined();
      expect(presentation).not.toHaveProperty('declaration');
      expect(presentation).not.toHaveProperty('roles');
      expect(presentation).not.toHaveProperty('requirements');
      expect(presentation).not.toHaveProperty('providerSettings');
      expect(presentation).not.toHaveProperty('projectSettings');
    }
  });
});
