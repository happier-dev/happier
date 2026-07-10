import { describe, expect, it } from 'vitest';

import { PROVIDER_ENDPOINT_SAFETY_LIMITS } from './index.js';

describe('provider endpoint safety limits', () => {
  it('exposes one frozen bounded policy for probe clients and schemas', () => {
    expect(PROVIDER_ENDPOINT_SAFETY_LIMITS).toEqual({
      maxUrlChars: 8_192,
      maxHostnameChars: 253,
      maxPathChars: 4_096,
      maxQueryChars: 2_048,
      maxPublicHeaders: 64,
      maxHeaderNameChars: 128,
      maxHeaderValueChars: 4_096,
      maxRedirects: 5,
      maxWallTimeMs: 30_000,
      maxIdleTimeMs: 10_000,
      maxDecodedBodyBytes: 5 * 1024 * 1024,
      maxModels: 5_000,
      maxModelIdChars: 512,
      maxModelNameChars: 256,
      maxModelDescriptionChars: 1_024,
    });
    expect(Object.isFrozen(PROVIDER_ENDPOINT_SAFETY_LIMITS)).toBe(true);
  });
});
