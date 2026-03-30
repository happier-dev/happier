export const RELEASE_RING_IDS = [
  'stable',
  'preview',
  'publicdev',
  'internalpreview',
  'internaldev',
] as const;

export type ReleaseRingId = (typeof RELEASE_RING_IDS)[number];
export const PUBLIC_RELEASE_RING_IDS = ['stable', 'preview', 'publicdev'] as const;
export type PublicReleaseRingId = (typeof PUBLIC_RELEASE_RING_IDS)[number];
export type ReleaseRingVisibility = 'public' | 'internal';
export type PublicReleaseRingLabel = 'stable' | 'preview' | 'dev';

export interface ReleaseRingCatalogEntry {
  id: ReleaseRingId;
  visibility: ReleaseRingVisibility;
  publicLabel: PublicReleaseRingLabel;
  sourceBranch: 'main' | 'preview' | 'dev';
  manifestChannel: 'stable' | 'preview' | 'publicdev' | null;
  rollingReleaseSuffix: 'stable' | 'preview' | 'dev' | null;
  embeddedPolicyEnv: 'production' | 'preview' | '';
  expoAppEnv: 'production' | 'preview' | 'development';
  expoUpdatesChannel: 'production' | 'preview' | 'dev' | 'internalpreview' | 'internaldev';
  supportsMobileStoreSubmit: boolean;
}

const releaseRingCatalog = {
  stable: {
    id: 'stable',
    visibility: 'public',
    publicLabel: 'stable',
    sourceBranch: 'main',
    manifestChannel: 'stable',
    rollingReleaseSuffix: 'stable',
    embeddedPolicyEnv: 'production',
    expoAppEnv: 'production',
    expoUpdatesChannel: 'production',
    supportsMobileStoreSubmit: true,
  },
  preview: {
    id: 'preview',
    visibility: 'public',
    publicLabel: 'preview',
    sourceBranch: 'preview',
    manifestChannel: 'preview',
    rollingReleaseSuffix: 'preview',
    embeddedPolicyEnv: 'preview',
    expoAppEnv: 'preview',
    expoUpdatesChannel: 'preview',
    supportsMobileStoreSubmit: true,
  },
  publicdev: {
    id: 'publicdev',
    visibility: 'public',
    publicLabel: 'dev',
    sourceBranch: 'dev',
    manifestChannel: 'publicdev',
    rollingReleaseSuffix: 'dev',
    embeddedPolicyEnv: 'preview',
    expoAppEnv: 'preview',
    expoUpdatesChannel: 'dev',
    supportsMobileStoreSubmit: true,
  },
  internalpreview: {
    id: 'internalpreview',
    visibility: 'internal',
    publicLabel: 'preview',
    sourceBranch: 'dev',
    manifestChannel: null,
    rollingReleaseSuffix: null,
    embeddedPolicyEnv: 'preview',
    expoAppEnv: 'preview',
    expoUpdatesChannel: 'internalpreview',
    supportsMobileStoreSubmit: false,
  },
  internaldev: {
    id: 'internaldev',
    visibility: 'internal',
    publicLabel: 'dev',
    sourceBranch: 'dev',
    manifestChannel: null,
    rollingReleaseSuffix: null,
    embeddedPolicyEnv: '',
    expoAppEnv: 'development',
    expoUpdatesChannel: 'internaldev',
    supportsMobileStoreSubmit: false,
  },
} as const satisfies Record<ReleaseRingId, ReleaseRingCatalogEntry>;

export function getReleaseRingCatalogEntry(id: ReleaseRingId): ReleaseRingCatalogEntry {
  const entry = releaseRingCatalog[id];
  if (!entry) {
    throw new Error(`Unknown release ring: ${String(id)}`);
  }
  return entry;
}

export function listReleaseRingCatalogEntries(): readonly ReleaseRingCatalogEntry[] {
  return RELEASE_RING_IDS.map((id) => releaseRingCatalog[id]);
}

export function isPublicReleaseRingId(id: ReleaseRingId): boolean {
  return getReleaseRingCatalogEntry(id).visibility === 'public';
}

export function getReleaseRingPublicLabel(id: ReleaseRingId): PublicReleaseRingLabel {
  return getReleaseRingCatalogEntry(id).publicLabel;
}

const releaseRingAliases: Readonly<Record<string, ReleaseRingId>> = {
  stable: 'stable',
  production: 'stable',
  prod: 'stable',
  preview: 'preview',
  publicdev: 'publicdev',
  'public-dev': 'publicdev',
  public_dev: 'publicdev',
  dev: 'publicdev',
  internalpreview: 'internalpreview',
  'internal-preview': 'internalpreview',
  internal_preview: 'internalpreview',
  canary: 'internalpreview',
  internaldev: 'internaldev',
  'internal-dev': 'internaldev',
  internal_dev: 'internaldev',
  development: 'internaldev',
};

export function normalizeReleaseRingId(raw: unknown): ReleaseRingId | '' {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return '';
  return releaseRingAliases[value] ?? '';
}

export function listPublicReleaseRingCatalogEntries(): readonly ReleaseRingCatalogEntry[] {
  return listReleaseRingCatalogEntries().filter((entry) => entry.visibility === 'public');
}

export function listPublicReleaseRingLabels(): readonly PublicReleaseRingLabel[] {
  return PUBLIC_RELEASE_RING_IDS.map((id) => releaseRingCatalog[id].publicLabel);
}

export function normalizePublicReleaseRingId(raw: unknown): PublicReleaseRingId | '' {
  const ringId = normalizeReleaseRingId(raw);
  if (!ringId || !isPublicReleaseRingId(ringId)) {
    return '';
  }
  return ringId as PublicReleaseRingId;
}
