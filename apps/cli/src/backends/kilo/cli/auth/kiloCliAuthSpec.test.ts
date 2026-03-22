import { describe, expect, it } from 'vitest';

import { kiloCliAuthSpec } from './kiloCliAuthSpec';

describe('kiloCliAuthSpec', () => {
  it('uses the canonical Kilo binary name for auth detection', () => {
    expect(kiloCliAuthSpec.binaryNames).toEqual(['kilo']);
  });
});
