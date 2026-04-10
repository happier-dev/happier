import { join } from 'node:path';

import { resolveDaemonStateBasenameForRing } from '@/cli/runtime/publicReleaseChannel';

import {
  listPublicReleaseRingCatalogEntries,
  resolvePublicReleaseRingIdForLabel,
  type PublicReleaseRingId,
} from '@happier-dev/release-runtime/releaseRings';

export const CANONICAL_DAEMON_STATE_BASENAME = 'daemon.state.json';

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

export function resolveLegacyDaemonStateBasenames(params: Readonly<{
  preferredRing?: PublicReleaseRingId | null;
}> = {}): readonly string[] {
  const preferred = params.preferredRing ? resolveDaemonStateBasenameForRing(params.preferredRing) : null;
  const publicRingBasenames = listPublicReleaseRingCatalogEntries().map((entry) =>
    resolveDaemonStateBasenameForRing(resolvePublicReleaseRingIdForLabel(entry.publicLabel)),
  );
  return unique([
    ...(preferred ? [preferred] : []),
    ...publicRingBasenames,
  ]).filter((basename) => basename !== CANONICAL_DAEMON_STATE_BASENAME);
}

export function resolveDaemonStateCandidatePaths(params: Readonly<{
  serverDir: string;
  preferredRing?: PublicReleaseRingId | null;
}>): readonly string[] {
  return [
    join(params.serverDir, CANONICAL_DAEMON_STATE_BASENAME),
    ...resolveLegacyDaemonStateBasenames({ preferredRing: params.preferredRing }).map((basename) => join(params.serverDir, basename)),
  ];
}
