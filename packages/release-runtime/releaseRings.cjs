// This file exists so CommonJS consumers (notably Expo config evaluation on EAS)
// can resolve release-ring metadata without requiring a built `dist/` folder.
//
// Keep this module dependency-free and deterministic.

const RELEASE_RING_IDS = [
  'stable',
  'preview',
  'publicdev',
  'internalpreview',
  'internaldev',
];

const PUBLIC_RELEASE_RING_IDS = ['stable', 'preview', 'publicdev'];

/** @typedef {'public' | 'internal'} ReleaseRingVisibility */
/** @typedef {'stable' | 'preview' | 'dev'} PublicReleaseRingLabel */

/**
 * @typedef {Object} ReleaseRingCatalogEntry
 * @property {typeof RELEASE_RING_IDS[number]} id
 * @property {ReleaseRingVisibility} visibility
 * @property {PublicReleaseRingLabel} publicLabel
 * @property {'main' | 'preview' | 'dev'} sourceBranch
 * @property {'stable' | 'preview' | 'publicdev' | null} manifestChannel
 * @property {'stable' | 'preview' | 'dev' | null} rollingReleaseSuffix
 * @property {'production' | 'preview' | ''} embeddedPolicyEnv
 * @property {'production' | 'preview' | 'development'} expoAppEnv
 * @property {'production' | 'preview' | 'dev' | 'internalpreview' | 'internaldev'} expoUpdatesChannel
 * @property {boolean} supportsMobileStoreSubmit
 */

/** @type {Readonly<Record<typeof RELEASE_RING_IDS[number], ReleaseRingCatalogEntry>>} */
const releaseRingCatalog = Object.freeze({
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
});

/**
 * @param {typeof RELEASE_RING_IDS[number]} id
 * @returns {ReleaseRingCatalogEntry}
 */
function getReleaseRingCatalogEntry(id) {
  const entry = releaseRingCatalog[id];
  if (!entry) {
    throw new Error(`Unknown release ring: ${String(id)}`);
  }
  return entry;
}

/**
 * @returns {readonly ReleaseRingCatalogEntry[]}
 */
function listReleaseRingCatalogEntries() {
  return RELEASE_RING_IDS.map((id) => releaseRingCatalog[id]);
}

/**
 * @param {typeof RELEASE_RING_IDS[number]} id
 */
function isPublicReleaseRingId(id) {
  return getReleaseRingCatalogEntry(id).visibility === 'public';
}

/**
 * @param {typeof RELEASE_RING_IDS[number]} id
 * @returns {PublicReleaseRingLabel}
 */
function getReleaseRingPublicLabel(id) {
  return getReleaseRingCatalogEntry(id).publicLabel;
}

/** @type {Readonly<Record<string, typeof RELEASE_RING_IDS[number]>>} */
const releaseRingAliases = Object.freeze({
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
});

/**
 * @param {unknown} raw
 * @returns {typeof RELEASE_RING_IDS[number] | ''}
 */
function normalizeReleaseRingId(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return '';
  return releaseRingAliases[value] ?? '';
}

/**
 * @returns {readonly ReleaseRingCatalogEntry[]}
 */
function listPublicReleaseRingCatalogEntries() {
  return listReleaseRingCatalogEntries().filter((entry) => entry.visibility === 'public');
}

/**
 * @returns {readonly PublicReleaseRingLabel[]}
 */
function listPublicReleaseRingLabels() {
  return PUBLIC_RELEASE_RING_IDS.map((id) => releaseRingCatalog[id].publicLabel);
}

/**
 * @param {unknown} raw
 * @returns {typeof PUBLIC_RELEASE_RING_IDS[number] | ''}
 */
function normalizePublicReleaseRingId(raw) {
  const ringId = normalizeReleaseRingId(raw);
  if (!ringId || !isPublicReleaseRingId(ringId)) {
    return '';
  }
  return ringId;
}

module.exports = {
  RELEASE_RING_IDS,
  PUBLIC_RELEASE_RING_IDS,
  getReleaseRingCatalogEntry,
  listReleaseRingCatalogEntries,
  isPublicReleaseRingId,
  getReleaseRingPublicLabel,
  normalizeReleaseRingId,
  listPublicReleaseRingCatalogEntries,
  listPublicReleaseRingLabels,
  normalizePublicReleaseRingId,
};

