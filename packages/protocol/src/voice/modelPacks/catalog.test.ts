import { describe, expect, it } from 'vitest';

import { ModelPackKindSchema } from './manifest.js';
import { assertModelPackFilePathPortable, assertPackIdFilesystemSafe } from './pathSafety.js';
import {
  KOKORO_DEFAULT_TTS_PACK_ID,
  MODEL_PACK_CATALOG,
  getModelPackCatalogEntry,
  listModelPackCatalogEntries,
  resolveCanonicalModelPackId,
} from './catalog.js';

describe('MODEL_PACK_CATALOG', () => {
  it('retains the canonical q8 Kokoro identity but marks its broken publication unavailable', () => {
    expect(KOKORO_DEFAULT_TTS_PACK_ID).toBe('kokoro-82m-v1.0-onnx-q8-wasm');
    expect(getModelPackCatalogEntry(KOKORO_DEFAULT_TTS_PACK_ID)?.defaultFor).toBe('tts_sherpa');
    expect(getModelPackCatalogEntry(KOKORO_DEFAULT_TTS_PACK_ID)?.publicationStatus).toBe('unavailable');
  });

  it('declares an explicit runtime family for every catalog entry', () => {
    for (const entry of listModelPackCatalogEntries()) {
      expect(entry.runtimeFamily, entry.packId).toMatch(/^sherpa_/);
    }
  });

  it('declares only valid model-pack kinds', () => {
    for (const entry of MODEL_PACK_CATALOG) {
      expect(ModelPackKindSchema.safeParse(entry.kind).success).toBe(true);
    }
  });

  it('has unique canonical packIds', () => {
    const ids = MODEL_PACK_CATALOG.map((e) => e.packId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('includes the canonical kokoro TTS pack and the streaming sherpa STT pack', () => {
    expect(getModelPackCatalogEntry(KOKORO_DEFAULT_TTS_PACK_ID)?.kind).toBe('tts_sherpa');
    const stt = getModelPackCatalogEntry('sherpa-onnx-streaming-zipformer-en-20M-2023-02-17');
    expect(stt?.kind).toBe('stt_sherpa');
    expect(stt?.streamingCapable).toBe(true);
    expect(stt?.runtimeFamily).toBe('sherpa_zipformer_streaming');
    expect(stt?.runtimeArtifacts).toEqual({
      encoder: { type: 'file', path: 'encoder.onnx' },
      decoder: { type: 'file', path: 'decoder.onnx' },
      joiner: { type: 'file', path: 'joiner.onnx' },
      tokens: { type: 'file', path: 'tokens.txt' },
    });
    expect(getModelPackCatalogEntry(KOKORO_DEFAULT_TTS_PACK_ID)?.runtimeFamily).toBe('sherpa_kokoro_offline');
    expect(getModelPackCatalogEntry(KOKORO_DEFAULT_TTS_PACK_ID)?.runtimeArtifacts).toEqual({
      model: { type: 'file', path: 'model.onnx' },
      voices: { type: 'file', path: 'voices.bin' },
      tokens: { type: 'file', path: 'tokens.txt' },
      data: { type: 'directory_prefix', path: 'espeak-ng-data' },
    });
  });

  it('marks exactly one default per kind', () => {
    const ttsDefaults = MODEL_PACK_CATALOG.filter((e) => e.kind === 'tts_sherpa' && e.defaultFor === 'tts_sherpa');
    const sttDefaults = MODEL_PACK_CATALOG.filter((e) => e.kind === 'stt_sherpa' && e.defaultFor === 'stt_sherpa');
    expect(ttsDefaults).toHaveLength(1);
    expect(sttDefaults).toHaveLength(1);
    expect(ttsDefaults[0]?.packId).toBe(KOKORO_DEFAULT_TTS_PACK_ID);
  });

  it('surfaces the verified local STT/TTS packs alongside the streaming defaults', () => {
    // Grounded in the vetted sherpa model-catalog extract: two offline Parakeet STT
    // packs and the Kokoro v0.19 TTS pack. Streaming defaults stay untouched.
    const expectedAdditions = [
      'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
      'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
      'kokoro-en-v0_19',
    ];
    for (const packId of expectedAdditions) {
      expect(getModelPackCatalogEntry(packId), `missing ${packId}`).not.toBeNull();
    }
  });
});

describe('MODEL_PACK_CATALOG entry integrity', () => {
  it('gives every entry the full set of required catalog fields', () => {
    for (const entry of MODEL_PACK_CATALOG) {
      expect(typeof entry.packId, entry.packId).toBe('string');
      expect(entry.packId.length).toBeGreaterThan(0);
      expect(ModelPackKindSchema.safeParse(entry.kind).success, entry.packId).toBe(true);
      expect(typeof entry.model, entry.packId).toBe('string');
      expect(entry.model.length).toBeGreaterThan(0);
      expect(typeof entry.runtimeArtifacts, entry.packId).toBe('object');
      expect(typeof entry.streamingCapable, entry.packId).toBe('boolean');
      expect(['published', 'unavailable'], entry.packId).toContain(entry.publicationStatus);
      // archiveUrl + sizeBytes are nullable until a published manifest supplies them.
      expect(entry.archiveUrl === null || typeof entry.archiveUrl === 'string').toBe(true);
      expect(entry.sizeBytes === null || typeof entry.sizeBytes === 'number').toBe(true);
    }
  });

  it('uses filesystem-safe pack ids and required file paths for every entry', () => {
    for (const entry of MODEL_PACK_CATALOG) {
      expect(() => assertPackIdFilesystemSafe(entry.packId)).not.toThrow();
      for (const rel of Object.values(entry.runtimeArtifacts).map((artifact) => artifact.path)) {
        expect(() => assertModelPackFilePathPortable(rel), `${entry.packId}:${rel}`).not.toThrow();
      }
    }
  });

  it('declares well-formed https archive urls when present', () => {
    for (const entry of MODEL_PACK_CATALOG) {
      if (entry.archiveUrl === null) continue;
      const url = new URL(entry.archiveUrl);
      expect(url.protocol, entry.packId).toBe('https:');
      expect(url.host.length, entry.packId).toBeGreaterThan(0);
    }
  });

  it('marks the offline Parakeet STT packs as non-streaming with their required files', () => {
    for (const packId of [
      'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
      'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
    ]) {
      const entry = getModelPackCatalogEntry(packId);
      expect(entry?.kind).toBe('stt_sherpa');
      expect(entry?.streamingCapable).toBe(false);
      expect(entry?.runtimeArtifacts.tokens.path).toBe('tokens.txt');
      expect(entry?.archiveUrl).toMatch(/^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\//);
    }
  });
});

describe('resolveCanonicalModelPackId', () => {
  it('preserves exact Kokoro quantization identities instead of merging them', () => {
    expect(resolveCanonicalModelPackId('kokoro-82m-v1.0-onnx-q8-wasm')).toBe(KOKORO_DEFAULT_TTS_PACK_ID);
    expect(resolveCanonicalModelPackId('kokoro-82m-v1.0-onnx-q4-wasm')).toBe('kokoro-82m-v1.0-onnx-q4-wasm');
    expect(resolveCanonicalModelPackId('kokoro-82m-v1.0-onnx-fp32-wasm')).toBe('kokoro-82m-v1.0-onnx-fp32-wasm');
    expect(resolveCanonicalModelPackId('kokoro-tts-en-v1')).toBe('kokoro-tts-en-v1');
  });

  it('returns the default kokoro pack id for empty/blank input', () => {
    expect(resolveCanonicalModelPackId('')).toBe(KOKORO_DEFAULT_TTS_PACK_ID);
    expect(resolveCanonicalModelPackId('   ')).toBe(KOKORO_DEFAULT_TTS_PACK_ID);
    expect(resolveCanonicalModelPackId(null)).toBe(KOKORO_DEFAULT_TTS_PACK_ID);
  });

  it('passes through ids that are already canonical or unknown', () => {
    expect(resolveCanonicalModelPackId(KOKORO_DEFAULT_TTS_PACK_ID)).toBe(KOKORO_DEFAULT_TTS_PACK_ID);
    expect(resolveCanonicalModelPackId('some-custom-pack')).toBe('some-custom-pack');
  });
});

describe('listModelPackCatalogEntries', () => {
  it('filters by kind', () => {
    const tts = listModelPackCatalogEntries('tts_sherpa');
    expect(tts.length).toBeGreaterThan(0);
    expect(tts.every((e) => e.kind === 'tts_sherpa')).toBe(true);
  });
});
