import { describe, expect, it } from 'vitest';
import { readArtifactKindsChangeHintV1, readArtifactKindsV1 } from './index.js';

describe('Artifact AccountChange kind routing', () => {
  it('retains exact encoded kinds and treats any incomplete metadata as coarse', () => {
    expect(readArtifactKindsChangeHintV1({ artifactKinds: ['v1:other:bot_template.v1', 'v1:other:bot_template.v1'] }))
      .toEqual(['v1:other:bot_template.v1']);
    expect(readArtifactKindsChangeHintV1({ artifactKinds: ['v1:other:'] })).toEqual(['v1:other:']);
    for (const value of [undefined, null, [], ['other'], ['v1:other:bot_template.v1', null], ['v2:other:bot_template.v1']]) {
      expect(readArtifactKindsV1(value)).toBeNull();
    }
  });
});
