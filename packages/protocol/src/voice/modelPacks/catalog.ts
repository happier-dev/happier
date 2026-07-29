import type { ModelPackKind } from './manifest.js';
import type {
  VoiceModelPackKokoroArtifactsV1,
  VoiceModelPackTransducerArtifactsV1,
  VoiceModelPackSupportArtifactV1,
} from './artifactRolesV1.js';

/**
 * Declarative voice model-pack catalog.
 *
 * Single source of truth for the canonical model packs the UI surfaces as
 * download options and the daemon resolves at runtime. Host surfaces
 * (`kokoroAssetSets`, `sherpaStreamingSttPacks`, daemon pack-id resolution)
 * resolve THROUGH this catalog instead of carrying their own id lists.
 *
 * Runtime-family identifiers and semantic artifact roles are immutable host
 * contract data. Download URLs and sizes remain nullable until a published,
 * integrity-verifiable manifest supplies them; execution hosts independently
 * decide whether they implement a declared runtime family.
 */
type ModelPackCatalogEntryBase = Readonly<{
  /** Canonical, filesystem-safe pack id used by the daemon runtime. */
  packId: string;
  kind: ModelPackKind;
  /** Underlying model identifier. */
  model: string;
  /** When set, this entry is the default pack for the given kind. */
  defaultFor?: ModelPackKind;
  /** Archive download URL, or null until a published manifest supplies it. */
  archiveUrl: string | null;
  /** Whether the pack supports streaming inference. */
  streamingCapable: boolean;
  /** Download size in bytes, or null until sourced. */
  sizeBytes: number | null;
  /** Whether the canonical manifest and every integrity-declared asset are currently published. */
  publicationStatus: 'published' | 'unavailable';
  /** Exact non-runtime files admitted and installed with this pack. */
  supportArtifacts?: readonly VoiceModelPackSupportArtifactV1[];
}>;

export type ModelPackCatalogEntry = ModelPackCatalogEntryBase & (
  | Readonly<{
      runtimeFamily: 'sherpa_zipformer_streaming' | 'sherpa_parakeet_offline';
      runtimeArtifacts: VoiceModelPackTransducerArtifactsV1;
    }>
  | Readonly<{
      runtimeFamily: 'sherpa_kokoro_offline';
      runtimeArtifacts: VoiceModelPackKokoroArtifactsV1;
    }>
);

/** Canonical daemon TTS identity; availability is decided separately below. */
export const KOKORO_DEFAULT_TTS_PACK_ID = 'kokoro-82m-v1.0-onnx-q8-wasm';

export const MODEL_PACK_CATALOG = [
  {
    packId: KOKORO_DEFAULT_TTS_PACK_ID,
    kind: 'tts_sherpa',
    model: 'kokoro-82m-v1.0',
    runtimeFamily: 'sherpa_kokoro_offline',
    defaultFor: 'tts_sherpa',
    runtimeArtifacts: {
      model: { type: 'file', path: 'model.onnx' },
      voices: { type: 'file', path: 'voices.bin' },
      tokens: { type: 'file', path: 'tokens.txt' },
      data: { type: 'directory_prefix', path: 'espeak-ng-data' },
    },
    supportArtifacts: [
      { type: 'file', kind: 'license', path: 'LICENSES/Apache-2.0.txt' },
      { type: 'file', kind: 'license', path: 'LICENSES/GPL-3.0.txt' },
      { type: 'file', kind: 'provenance', path: 'LICENSES/README.txt' },
      { type: 'file', kind: 'notice', path: 'THIRD_PARTY_NOTICES.txt' },
    ],
    archiveUrl: null,
    streamingCapable: false,
    sizeBytes: null,
    // The manifest is reachable, but its `espeak-ng-data/voices/!v/**`
    // release assets are not. Keep the identity stable and fail closed until
    // the canonical publication is replaced with fully reachable exact bytes.
    publicationStatus: 'unavailable',
  },
  {
    packId: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17',
    kind: 'stt_sherpa',
    model: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17',
    runtimeFamily: 'sherpa_zipformer_streaming',
    defaultFor: 'stt_sherpa',
    runtimeArtifacts: {
      encoder: { type: 'file', path: 'encoder.onnx' },
      decoder: { type: 'file', path: 'decoder.onnx' },
      joiner: { type: 'file', path: 'joiner.onnx' },
      tokens: { type: 'file', path: 'tokens.txt' },
    },
    supportArtifacts: [
      { type: 'file', kind: 'license', path: 'LICENSES/Apache-2.0.txt' },
      { type: 'file', kind: 'license', path: 'LICENSES/GPL-3.0.txt' },
      { type: 'file', kind: 'provenance', path: 'LICENSES/README.txt' },
      { type: 'file', kind: 'notice', path: 'THIRD_PARTY_NOTICES.txt' },
    ],
    archiveUrl: null,
    streamingCapable: true,
    sizeBytes: null,
    publicationStatus: 'published',
  },
  // ---------------------------------------------------------------------------
  // Local STT/TTS packs ported from the verified sherpa-onnx model catalog. URLs
  // and semantic artifact paths are copied verbatim from the vetted source extract. No sha256 or
  // sizeBytes is published by that source, so sizeBytes stays null; verification
  // is by required-file presence until a signed manifest supplies digests.
  // These are ADDITIVE: streaming defaults above remain the `defaultFor` packs.
  // ---------------------------------------------------------------------------
  {
    // Source id "parakeet-tdt-0.6b-v2-int8" (extractedDir). NeMo offline transducer.
    packId: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
    kind: 'stt_sherpa',
    model: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
    runtimeFamily: 'sherpa_parakeet_offline',
    runtimeArtifacts: {
      encoder: { type: 'file', path: 'encoder.int8.onnx' },
      decoder: { type: 'file', path: 'decoder.int8.onnx' },
      joiner: { type: 'file', path: 'joiner.int8.onnx' },
      tokens: { type: 'file', path: 'tokens.txt' },
    },
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2',
    streamingCapable: false,
    sizeBytes: null,
    publicationStatus: 'unavailable',
  },
  {
    // Source id "parakeet-tdt-0.6b-v3-int8" (extractedDir). 25 EU langs, auto-detected.
    packId: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
    kind: 'stt_sherpa',
    model: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
    runtimeFamily: 'sherpa_parakeet_offline',
    runtimeArtifacts: {
      encoder: { type: 'file', path: 'encoder.int8.onnx' },
      decoder: { type: 'file', path: 'decoder.int8.onnx' },
      joiner: { type: 'file', path: 'joiner.int8.onnx' },
      tokens: { type: 'file', path: 'tokens.txt' },
    },
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2',
    streamingCapable: false,
    sizeBytes: null,
    publicationStatus: 'unavailable',
  },
  {
    // Source id "kokoro-en-v0_19" (extractedDir). Higher-quality, larger Kokoro TTS.
    packId: 'kokoro-en-v0_19',
    kind: 'tts_sherpa',
    model: 'kokoro-en-v0_19',
    runtimeFamily: 'sherpa_kokoro_offline',
    runtimeArtifacts: {
      model: { type: 'file', path: 'model.onnx' },
      voices: { type: 'file', path: 'voices.bin' },
      tokens: { type: 'file', path: 'tokens.txt' },
      data: { type: 'directory_prefix', path: 'espeak-ng-data' },
    },
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2',
    streamingCapable: false,
    sizeBytes: null,
    publicationStatus: 'unavailable',
  },
] as const satisfies readonly ModelPackCatalogEntry[];

/**
 * Catalog viewed through the declared entry interface. `as const` narrows each
 * entry to a literal type where optional fields (`defaultFor`) are absent on
 * entries that omit them, which is unsafe to read across the union; the helpers
 * iterate over this widened view so optional-field access stays type-safe.
 */
const CATALOG_ENTRIES: readonly ModelPackCatalogEntry[] = MODEL_PACK_CATALOG;

const CATALOG_BY_ID: ReadonlyMap<string, ModelPackCatalogEntry> = new Map(
  CATALOG_ENTRIES.map((entry) => [entry.packId, entry]),
);

export function getModelPackCatalogEntry(packId: string): ModelPackCatalogEntry | null {
  return CATALOG_BY_ID.get(packId) ?? null;
}

export function isPublishedModelPackCatalogEntry(
  entry: ModelPackCatalogEntry | null | undefined,
): entry is ModelPackCatalogEntry {
  return entry?.publicationStatus === 'published';
}

export function listModelPackCatalogEntries(kind?: ModelPackKind): readonly ModelPackCatalogEntry[] {
  return kind ? CATALOG_ENTRIES.filter((entry) => entry.kind === kind) : CATALOG_ENTRIES;
}

export function getDefaultModelPackId(kind: ModelPackKind): string | null {
  return CATALOG_ENTRIES.find((entry) => entry.defaultFor === kind)?.packId ?? null;
}

/**
 * Resolve an optional asset id to an exact pack identity. Blank input selects
 * the active default; concrete ids pass through unchanged so q4/q8/fp32 packs
 * can never be silently merged across distinct persisted/install identities.
 */
export function resolveCanonicalModelPackId(assetId: string | null | undefined): string {
  const normalized = typeof assetId === 'string' ? assetId.trim() : '';
  if (!normalized) {
    return KOKORO_DEFAULT_TTS_PACK_ID;
  }
  return normalized;
}
