import { PET_CANONICAL_SPRITESHEET_MEDIA_TYPES_V1 } from './assetFormats.js';

export const PET_PACKAGE_FORMAT_CODEX_ATLAS_V1 = 'codex-compatible-atlas-v1' as const;

export const BUILT_IN_PET_IDS_V1 = ['blink', 'fury', 'milo', 'oli', 'titi'] as const;
export type BuiltInPetIdV1 = (typeof BUILT_IN_PET_IDS_V1)[number];

export const PET_SYNC_SUPPORTED_MEDIA_TYPES_V1 = PET_CANONICAL_SPRITESHEET_MEDIA_TYPES_V1;

export const PET_ATLAS_V1 = Object.freeze({
  packageFormat: PET_PACKAGE_FORMAT_CODEX_ATLAS_V1,
  columns: 8,
  rows: 9,
  cellWidth: 192,
  cellHeight: 208,
  width: 1536,
  height: 1872,
});

export const PET_ANIMATION_STATES_V1 = [
  'idle',
  'running-right',
  'running-left',
  'waving',
  'jumping',
  'failed',
  'waiting',
  'running',
  'review',
] as const;

export type PetAnimationStateV1 = (typeof PET_ANIMATION_STATES_V1)[number];

export const PET_ANIMATION_ROWS_V1 = Object.freeze([
  { row: 0, state: 'idle', frames: 6, durationsMs: [280, 110, 110, 140, 140, 320] },
  { row: 1, state: 'running-right', frames: 8, durationsMs: [120, 120, 120, 120, 120, 120, 120, 220] },
  { row: 2, state: 'running-left', frames: 8, durationsMs: [120, 120, 120, 120, 120, 120, 120, 220] },
  { row: 3, state: 'waving', frames: 4, durationsMs: [140, 140, 140, 280] },
  { row: 4, state: 'jumping', frames: 5, durationsMs: [140, 140, 140, 140, 280] },
  { row: 5, state: 'failed', frames: 8, durationsMs: [140, 140, 140, 140, 140, 140, 140, 240] },
  { row: 6, state: 'waiting', frames: 6, durationsMs: [150, 150, 150, 150, 150, 260] },
  { row: 7, state: 'running', frames: 6, durationsMs: [120, 120, 120, 120, 120, 220] },
  { row: 8, state: 'review', frames: 6, durationsMs: [150, 150, 150, 150, 150, 280] },
] satisfies ReadonlyArray<Readonly<{
  row: number;
  state: PetAnimationStateV1;
  frames: number;
  durationsMs: readonly number[];
}>>);

export const PET_PACKAGE_LIMITS_V1 = Object.freeze({
  maxManifestBytes: 16 * 1024,
  maxCanonicalSpritesheetBytes: 5 * 1024 * 1024,
  maxCanonicalPackageBytes: 6 * 1024 * 1024,
  maxPreCanonicalImportBytes: 16 * 1024 * 1024,
  maxImportedPetsPerAccount: 20,
  maxImportedPetBytesPerAccount: 100 * 1024 * 1024,
  maxImportedPetsPerDevice: 20,
  maxImportedPetBytesPerDevice: 100 * 1024 * 1024,
});

export const PET_DISCOVERY_LIMITS_V1 = Object.freeze({
  maxPetsPerRoot: 128,
  maxDiscoveryWallClockMs: 1500,
  maxCodexConnectedServiceRoots: 256,
  discoveryCacheTtlMs: 15_000,
});

export const PET_DAEMON_RPC_DEBOUNCE_LIMITS_V1 = Object.freeze({
  discoverPackagesMinIntervalMs: 750,
  validatePackageMinIntervalMs: 500,
  importPackageMinIntervalMs: 500,
  forgetLocalPackageMinIntervalMs: 250,
  readPreviewAssetMinIntervalMs: 100,
});
