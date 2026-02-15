export type KokoroSherpaVoiceCatalogEntry = {
  id: string;
  title: string;
  subtitle?: string;
  sid: number;
};

type KokoroVoiceSidMapping = Readonly<Record<string, number>>;

// Source: sherpa-onnx Kokoro pretrained model docs (speaker_id mapping).
// These mappings are used as a fallback when the native asset manifest does not include an explicit voice catalog.
const KOKORO_V1_0_SID_BY_ID: KokoroVoiceSidMapping = {
  af_bella: 0,
  af_sarah: 1,
  af_nicole: 2,
  af_sky: 3,
  af: 4,
  am_adam: 5,
  am_michael: 6,
  am: 7,
  bf_emma: 8,
  bf_isabella: 9,
  bf: 10,
  bm_george: 11,
  bm_lewis: 12,
  bm: 13,
  af_bella_alt: 14,
  af_sarah_alt: 15,
  af_nicole_alt: 16,
  af_sky_alt: 17,
  am_adam_alt: 18,
  am_michael_alt: 19,
  bf_emma_alt: 20,
  bf_isabella_alt: 21,
  bm_george_alt: 22,
  bm_lewis_alt: 23,
  af_heart: 24,
  af_jessica: 25,
  af_river: 26,
  af_alloy: 27,
  af_aoede: 28,
  af_kore: 29,
  af_nova: 30,
  af_sophia: 31,
  af_verse: 32,
  am_aster: 33,
  am_daniel: 34,
  am_luna: 35,
  am_santa: 36,
  am_zeus: 37,
  bf_onyx: 38,
  bf_stella: 39,
  bf_athena: 40,
  bf_hera: 41,
  bf_orion: 42,
  bm_argo: 43,
  bm_darius: 44,
  bm_storm: 45,
  bm_vortex: 46,
  bm_apollo: 47,
  bm_goliath: 48,
  // Non-English voices included in the v1.0 multi-lang pack.
  ff_siwis: 49,
  hf_alpha: 50,
  hf_beta: 51,
  hm_omega: 52,
} as const;

const KOKORO_V0_19_SID_BY_ID: KokoroVoiceSidMapping = {
  // Source: sherpa-onnx Kokoro v0_19 (11 speakers) docs.
  af: 0,
  af_bella: 1,
  af_nicole: 2,
  af_sarah: 3,
  af_sky: 4,
  am_adam: 5,
  am_michael: 6,
  bf_emma: 7,
  bf_isabella: 8,
  bm_george: 9,
  bm_lewis: 10,
} as const;

const KOKORO_V1_0_VOICES: readonly KokoroSherpaVoiceCatalogEntry[] = Object.entries(KOKORO_V1_0_SID_BY_ID)
  .map(([id, sid]) => ({ id, sid, title: id }))
  .sort((a, b) => a.sid - b.sid);

const KOKORO_V0_19_VOICES: readonly KokoroSherpaVoiceCatalogEntry[] = Object.entries(KOKORO_V0_19_SID_BY_ID)
  .map(([id, sid]) => ({ id, sid, title: id }))
  .sort((a, b) => a.sid - b.sid);

export function getKokoroSherpaVoiceCatalogForSpeakerCount(speakerCount: number | null | undefined): readonly KokoroSherpaVoiceCatalogEntry[] | null {
  if (speakerCount === 53) return KOKORO_V1_0_VOICES;
  if (speakerCount === 11) return KOKORO_V0_19_VOICES;
  return null;
}

function resolveFromMap(map: KokoroVoiceSidMapping, voiceId: string): number | null {
  const sid = (map as Record<string, number | undefined>)[voiceId];
  return typeof sid === 'number' ? sid : null;
}

function tryParseSidPrefix(voiceId: string): number | null {
  const trimmed = voiceId.trim();
  if (!trimmed.startsWith('sid:')) return null;
  const raw = trimmed.slice('sid:'.length);
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export function resolveKokoroSherpaSidForVoiceIdWithSpeakerCount(
  voiceId: string,
  speakerCount: number | null | undefined,
): number | null {
  const trimmed = voiceId.trim();
  if (!trimmed) return null;

  const parsed = tryParseSidPrefix(trimmed);
  if (parsed != null) return parsed;

  if (speakerCount === 11) return resolveFromMap(KOKORO_V0_19_SID_BY_ID, trimmed);
  if (speakerCount === 53) return resolveFromMap(KOKORO_V1_0_SID_BY_ID, trimmed);

  return resolveFromMap(KOKORO_V1_0_SID_BY_ID, trimmed) ?? resolveFromMap(KOKORO_V0_19_SID_BY_ID, trimmed);
}

export function resolveKokoroSherpaSidForVoiceId(voiceId: string): number | null {
  const trimmed = voiceId.trim();
  if (!trimmed) return null;
  const parsed = tryParseSidPrefix(trimmed);
  if (parsed != null) return parsed;
  return resolveFromMap(KOKORO_V1_0_SID_BY_ID, trimmed) ?? resolveFromMap(KOKORO_V0_19_SID_BY_ID, trimmed);
}
