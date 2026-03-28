// @ts-check

import {
  getReleaseRingCatalogEntry,
  listPublicReleaseRingLabels,
  normalizePublicReleaseRingId,
} from '@happier-dev/release-runtime/releaseRings';

/**
 * @param {unknown} raw
 * @returns {import('@happier-dev/release-runtime/releaseRings').PublicReleaseRingId | ''}
 */
export function normalizePublicReleaseChannel(raw) {
  return normalizePublicReleaseRingId(raw);
}

/**
 * @param {{ stableAlias?: 'stable' | 'production'; preferredOrder?: readonly ('stable' | 'preview' | 'dev')[] }} [opts]
 */
export function listPublicReleaseChannelInputLabels(opts = {}) {
  const stableAlias = opts.stableAlias ?? 'stable';
  const preferredOrder = opts.preferredOrder ?? ['stable', 'preview', 'dev'];
  const labels = new Set(
    listPublicReleaseRingLabels().map((label) => (label === 'stable' ? stableAlias : label))
  );
  return preferredOrder
    .map((label) => (label === 'stable' ? stableAlias : label))
    .filter((label) => labels.has(label));
}

/**
 * @param {{ stableAlias?: 'stable' | 'production'; preferredOrder?: readonly ('stable' | 'preview' | 'dev')[] }} [opts]
 */
export function formatPublicReleaseChannelChoices(opts = {}) {
  return listPublicReleaseChannelInputLabels(opts).join('|');
}

/**
 * @param {import('@happier-dev/release-runtime/releaseRings').PublicReleaseRingId} channel
 */
export function getPublicReleaseRingEntry(channel) {
  return getReleaseRingCatalogEntry(channel);
}

/**
 * @param {import('@happier-dev/release-runtime/releaseRings').PublicReleaseRingId} channel
 * @param {{ stableAlias?: 'stable' | 'production' }} [opts]
 */
export function formatPublicReleaseChannel(channel, opts = {}) {
  const stableAlias = opts.stableAlias ?? 'stable';
  const label = getPublicReleaseRingEntry(channel).publicLabel;
  return label === 'stable' ? stableAlias : label;
}

/**
 * @param {import('@happier-dev/release-runtime/releaseRings').PublicReleaseRingId} channel
 */
export function resolveRollingReleaseTagSuffix(channel) {
  const ring = getPublicReleaseRingEntry(channel);
  if (!ring.rollingReleaseSuffix) {
    throw new Error(`[release] channel ${channel} does not publish a rolling tag`);
  }
  return ring.rollingReleaseSuffix;
}

/**
 * @param {import('@happier-dev/release-runtime/releaseRings').PublicReleaseRingId} channel
 */
export function resolveRollingReleaseLabel(channel) {
  const label = getPublicReleaseRingEntry(channel).publicLabel;
  return label.slice(0, 1).toUpperCase() + label.slice(1);
}

/**
 * @param {import('@happier-dev/release-runtime/releaseRings').PublicReleaseRingId} channel
 */
export function resolveRollingPrerelease(channel) {
  return channel === 'stable' ? 'false' : 'true';
}

/**
 * @param {import('@happier-dev/release-runtime/releaseRings').PublicReleaseRingId} channel
 * @param {string} [requestedSourceRef]
 */
export function resolvePublicReleaseSourceRef(channel, requestedSourceRef = 'auto') {
  const requested = String(requestedSourceRef ?? '').trim();
  if (requested && requested !== 'auto') return requested;
  return getPublicReleaseRingEntry(channel).sourceBranch;
}

/**
 * @param {import('@happier-dev/release-runtime/releaseRings').PublicReleaseRingId} channel
 */
export function resolveEmbeddedPolicyForChannel(channel) {
  const embeddedPolicy = getPublicReleaseRingEntry(channel).embeddedPolicyEnv;
  return embeddedPolicy || 'preview';
}

/**
 * @param {import('@happier-dev/release-runtime/releaseRings').PublicReleaseRingId} channel
 */
export function resolveExpoAppEnvironmentForChannel(channel) {
  const expoAppEnv = getPublicReleaseRingEntry(channel).expoAppEnv;
  return expoAppEnv === 'production' ? 'production' : 'preview';
}

function parseOptionalPositiveInt(value) {
  const raw = String(value ?? '').trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor(parsed));
}

/**
 * @param {import('@happier-dev/release-runtime/releaseRings').PublicReleaseRingId} channel
 */
export function resolveRollingVersionSuffix(channel) {
  if (channel === 'stable') return '';
  const base = resolveRollingReleaseTagSuffix(channel);
  const runNumber = parseOptionalPositiveInt(process.env.GITHUB_RUN_NUMBER);
  const attemptNumber = parseOptionalPositiveInt(process.env.GITHUB_RUN_ATTEMPT);
  const run = runNumber ?? Math.floor(Date.now() / 1000);
  const attempt = Math.max(1, attemptNumber ?? Math.floor(process.pid));
  return `${base}.${run}.${attempt}`;
}
