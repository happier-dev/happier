import { describe, expect, it } from 'vitest';

import { getKokoroAssetSetOptions } from '@/voice/kokoro/assets/kokoroAssetSets';

describe('kokoroAssetSets', () => {
  it('exposes a default option and at least one concrete asset set option', () => {
    const options = getKokoroAssetSetOptions({});
    expect(options.length).toBeGreaterThanOrEqual(2);
    expect(options[0]?.id).toBe('');
  });
});
