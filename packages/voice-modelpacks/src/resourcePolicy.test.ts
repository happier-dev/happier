import { describe, expect, it } from 'vitest';

import { VOICE_MODEL_PACK_CONTRIBUTION_MAX_FILES_V1 } from '@happier-dev/protocol';

import {
  DEFAULT_VOICE_MODEL_PACK_RESOURCE_POLICY_V1,
  assertVoiceModelPackDeclaredResourcesV1,
} from './resourcePolicy.js';

describe('Voice model-pack declared resource policy', () => {
  it('shares the strict public contribution file ceiling and enforces exact limit / limit + 1', () => {
    expect(DEFAULT_VOICE_MODEL_PACK_RESOURCE_POLICY_V1.maxFiles)
      .toBe(VOICE_MODEL_PACK_CONTRIBUTION_MAX_FILES_V1);

    const atLimit = Array.from(
      { length: VOICE_MODEL_PACK_CONTRIBUTION_MAX_FILES_V1 },
      () => ({ sizeBytes: 1 }),
    );
    expect(() => assertVoiceModelPackDeclaredResourcesV1(atLimit)).not.toThrow();
    expect(() => assertVoiceModelPackDeclaredResourcesV1([
      ...atLimit,
      { sizeBytes: 1 },
    ])).toThrow('model_pack_file_count_limit_exceeded');
  });

  it('accepts an exact aggregate byte limit and rejects aggregate limit + 1', () => {
    const policy = { maxFiles: 2, maxFileBytes: 4, maxTotalBytes: 7 };
    expect(() => assertVoiceModelPackDeclaredResourcesV1([
      { sizeBytes: 3 },
      { sizeBytes: 4 },
    ], policy)).not.toThrow();
    expect(() => assertVoiceModelPackDeclaredResourcesV1([
      { sizeBytes: 4 },
      { sizeBytes: 4 },
    ], policy)).toThrow('model_pack_total_size_limit_exceeded');
  });
});
