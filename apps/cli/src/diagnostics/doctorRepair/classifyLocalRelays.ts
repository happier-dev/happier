import type { PublicReleaseRingLabel } from '@happier-dev/release-runtime/releaseRings';

import { semverLessThan } from './_shared';
import type {
  LocalRelayEntry,
  LocalRelayLaneMissing,
  LocalRelayOffChannelLeftovers,
  LocalRelayVersionStale,
  RepairFinding,
} from './types';

/**
 * `cliIsLatest` — true iff the running CLI is the latest version for its
 * channel. When false, `local_relay_version_stale` is suppressed: recommending
 * a relay update while the CLI is behind could push the relay to a version
 * newer than the CLI can talk to.
 *
 * `latestRelayVersionForCurrentChannel` — latest published relay version for
 * `currentCliReleaseChannel`, resolved from cache/GitHub by the caller. When
 * null, no version-stale finding is emitted (informational-only fallback).
 */
export function classifyLocalRelays(params: Readonly<{
  relays: readonly LocalRelayEntry[];
  currentCliReleaseChannel: PublicReleaseRingLabel;
  cliIsLatest: boolean;
  latestRelayVersionForCurrentChannel: string | null;
}>): readonly RepairFinding[] {
  const findings: RepairFinding[] = [];
  // If the user has no local relays installed at all, they're a hosted-cloud
  // (or self-hosted-server) user — we don't nag them to install a local relay.
  // `local_relay_lane_missing` only fires when the user clearly uses local
  // relays (they have at least one installed) but none match the current
  // CLI's channel.
  if (params.relays.length === 0) return findings;

  const matchingRelay = params.relays.find((r) => r.releaseChannel === params.currentCliReleaseChannel);

  if (!matchingRelay) {
    const missing: LocalRelayLaneMissing = {
      kind: 'local_relay_lane_missing',
      severity: 'info',
      autoApplyWithoutPrompt: false,
      targetReleaseChannel: params.currentCliReleaseChannel,
      installed: params.relays,
    };
    findings.push(missing);
    return findings;
  }

  // Only flag relay-version-stale when the CLI itself is up-to-date. Otherwise
  // we'd recommend a relay update that could outpace the running CLI.
  if (
    params.cliIsLatest
    && matchingRelay.version !== null
    && params.latestRelayVersionForCurrentChannel !== null
    && semverLessThan(matchingRelay.version, params.latestRelayVersionForCurrentChannel)
  ) {
    const stale: LocalRelayVersionStale = {
      kind: 'local_relay_version_stale',
      severity: 'info',
      autoApplyWithoutPrompt: false,
      entry: matchingRelay,
      latestVersion: params.latestRelayVersionForCurrentChannel,
    };
    findings.push(stale);
  }

  // Off-channel leftovers: the user has the matching-channel relay AND extras
  // on other channels. Each extra runs as its own OS service unit; flag once
  // so the user can clean up unused channels.
  const leftovers = params.relays.filter((r) => r.releaseChannel !== params.currentCliReleaseChannel);
  if (leftovers.length > 0) {
    const finding: LocalRelayOffChannelLeftovers = {
      kind: 'local_relay_off_channel_leftovers',
      severity: 'info',
      autoApplyWithoutPrompt: false,
      currentChannelEntry: matchingRelay,
      leftovers,
    };
    findings.push(finding);
  }

  return findings;
}
