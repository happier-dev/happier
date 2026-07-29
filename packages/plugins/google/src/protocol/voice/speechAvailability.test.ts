import { describe, expect, it } from 'vitest';

import {
  GoogleCloudSynthesizeResponseSchema,
  GoogleGeminiTranscribeResponseSchema,
} from './index.js';

describe('Google speech availability responses', () => {
  it('represents retirement of the public daemon contribution', () => {
    expect(GoogleGeminiTranscribeResponseSchema.safeParse({
      ok: false,
      errorCode: 'provider_unavailable',
    }).success).toBe(true);
    expect(GoogleCloudSynthesizeResponseSchema.safeParse({
      ok: false,
      errorCode: 'provider_unavailable',
    }).success).toBe(true);
  });
});
