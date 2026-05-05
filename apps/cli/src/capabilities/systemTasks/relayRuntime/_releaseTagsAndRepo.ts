/**
 * Shared GitHub release-tag + repo resolution for the Happier relay server.
 * Single source of truth — previously duplicated in `liveRelayRuntime.ts`
 * and `diagnostics/doctorRepair/relayUpdateCheck.ts`.
 *
 * The CLI is distributed via npm (`@happier-dev/cli`) and uses the
 * `readNpmDistTagVersion` helper instead of GitHub; this module is
 * relay-specific.
 */

import type { PublicReleaseRingId, PublicReleaseRingLabel } from '@happier-dev/release-runtime/releaseRings';
import { getReleaseRingPublicLabel } from '@happier-dev/release-runtime/releaseRings';

export type RelayChannelInput = PublicReleaseRingId | PublicReleaseRingLabel | string;

/**
 * Resolve the GitHub release tag for the relay server binary for a given
 * channel. Accepts either a ring id (`publicdev`) or a public label
 * (`dev`/`stable`/`preview`).
 *
 *   stable  → server-stable
 *   preview → server-preview
 *   dev     → server-dev
 */
export function resolveRelayReleaseTag(channel: RelayChannelInput): string {
  const label = normaliseToPublicLabel(channel);
  if (label === 'preview') return 'server-preview';
  if (label === 'dev') return 'server-dev';
  return 'server-stable';
}

/**
 * Resolve the owner/repo slug used for Happier GitHub releases.
 * Honours the `HAPPIER_GITHUB_REPO` env var (for forked or internal repos)
 * and falls back to the canonical `happier-dev/happier`.
 */
export function resolveHappierGithubRepo(): string {
  const raw = String(process.env.HAPPIER_GITHUB_REPO ?? '').trim();
  return raw || 'happier-dev/happier';
}

function normaliseToPublicLabel(channel: RelayChannelInput): PublicReleaseRingLabel {
  const raw = String(channel ?? '').trim().toLowerCase();
  if (raw === 'stable' || raw === 'preview' || raw === 'dev') return raw;
  if (raw === 'publicdev') return 'dev';
  // Fall through: try the catalog in case this is any other ReleaseRingId.
  try {
    return getReleaseRingPublicLabel(raw as PublicReleaseRingId);
  } catch {
    return 'stable';
  }
}
