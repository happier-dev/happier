import { describe, expect, it } from 'vitest';

import {
  parseVoiceModelPackArtifactBindingV1,
  voiceModelPackArtifactBindingsEqualV1,
} from './artifactBinding.js';

describe('Voice model-pack artifact binding', () => {
  it('keeps source integrity and local materialization as non-aliasing discriminated identities', () => {
    const sameText = `sha512-${'a'.repeat(86)}==`;
    const source = parseVoiceModelPackArtifactBindingV1({
      kind: 'sourceIntegrity',
      integrity: sameText,
    });
    const materialization = parseVoiceModelPackArtifactBindingV1({
      kind: 'materialization',
      immutableGenerationId: sameText,
    });

    expect(source).toEqual({ kind: 'sourceIntegrity', integrity: sameText });
    expect(materialization).toEqual({ kind: 'materialization', immutableGenerationId: sameText });
    expect(voiceModelPackArtifactBindingsEqualV1(source, materialization)).toBe(false);
    expect(voiceModelPackArtifactBindingsEqualV1(source, { ...source })).toBe(true);
    expect(voiceModelPackArtifactBindingsEqualV1(materialization, { ...materialization })).toBe(true);
  });

  it.each([
    { kind: 'sourceIntegrity', integrity: ' source-integrity' },
    { kind: 'sourceIntegrity', integrity: 'source-integrity', unexpected: true },
    { kind: 'materialization', immutableGenerationId: ' generation-1' },
    { kind: 'materialization', immutableGenerationId: 'generation-1', integrity: 'not-allowed' },
  ])('rejects malformed strict binding %o', (value) => {
    expect(() => parseVoiceModelPackArtifactBindingV1(value)).toThrow('voice_model_pack_artifact_binding_invalid');
  });
});
