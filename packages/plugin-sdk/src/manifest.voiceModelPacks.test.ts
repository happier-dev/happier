import { describe, expect, it } from 'vitest';

describe('public voice model-pack manifest SDK', () => {
  it('exports the versioned declarative schema without registration callbacks', async () => {
    const sdk = await import('./manifest.js') as Record<string, unknown>;
    expect(typeof sdk.VoiceModelPackContributionV1Schema).toBe('object');
    expect(sdk).not.toHaveProperty('registerVoiceModelPack');
    expect(sdk).not.toHaveProperty('registerVoiceProvider');
  });
});
