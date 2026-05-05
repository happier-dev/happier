import chalk from 'chalk';
import {
  getReleaseRingCatalogEntry,
  normalizePublicReleaseRingId,
  normalizeReleaseRingId,
  type PublicReleaseRingId,
  type PublicReleaseRingLabel,
  type ReleaseRingId,
} from '@happier-dev/release-runtime/releaseRings';

/**
 * Canonical label color palette for public release channels.
 * - stable  → green
 * - preview → yellow
 * - dev     → cyan
 */
function colorizePublicLabel(label: PublicReleaseRingLabel): string {
  if (label === 'stable') return chalk.green('stable');
  if (label === 'preview') return chalk.yellow('preview');
  return chalk.cyan('dev');
}

export function ringToPublicLabel(ring: ReleaseRingId): PublicReleaseRingLabel {
  return getReleaseRingCatalogEntry(ring).publicLabel;
}

export function publicLabelToRing(label: string): PublicReleaseRingId | '' {
  return normalizePublicReleaseRingId(label);
}

/**
 * Single source of truth for rendering a release channel as a user-facing label.
 * Accepts ring ids (`publicdev`), aliases (`dev`, `public-dev`), or raw labels
 * (`stable` / `preview` / `dev`) — all are normalised to the public label.
 * Unknown inputs are returned verbatim so callers don't swallow debug info.
 */
export function formatReleaseChannel(
  ringOrLabel: string,
  opts: { colored?: boolean } = { colored: true },
): string {
  const normalizedRing = normalizeReleaseRingId(ringOrLabel);
  const label = normalizedRing
    ? getReleaseRingCatalogEntry(normalizedRing).publicLabel
    : String(ringOrLabel ?? '').trim().toLowerCase();

  if (label !== 'stable' && label !== 'preview' && label !== 'dev') {
    return String(ringOrLabel ?? '');
  }

  return opts.colored === false ? label : colorizePublicLabel(label as PublicReleaseRingLabel);
}
