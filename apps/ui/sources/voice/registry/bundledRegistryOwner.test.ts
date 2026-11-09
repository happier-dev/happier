import { describe, expect, it } from 'vitest';

import { createDefaultVoiceProviderRegistry } from './defaultRegistry';
import { BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS } from './generatedBundledVoiceEntries';
import { getBundledVoiceProviderEntry } from './internalContributions';

describe('bundled Voice provider registry ownership', () => {
  it('normalizes each bundled declaration once for the default registry and the internal lookup', () => {
    const [first] = BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS;
    if (!first) throw new Error('no bundled Voice contribution generated');
    const entry = getBundledVoiceProviderEntry(first.providerId);

    expect(entry).not.toBeNull();
    expect(createDefaultVoiceProviderRegistry().get(first.providerId)).toBe(entry);
  });
});
