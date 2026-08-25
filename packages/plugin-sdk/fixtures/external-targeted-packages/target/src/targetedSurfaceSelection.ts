import { selectTargetedContributionSurface } from '@happier-dev/plugin-sdk/ui';
import type { SurfaceContext } from '@happier-dev/plugin-sdk/ui';

const TARGET_PLUGIN_ID = 'fixture.physical-copy-target';
const POINT_ID = 'sources';
const PROTOCOL_ID = 'physical-copy-sources';
const PROTOCOL_VERSION = 1;
const CONTRIBUTOR_PLUGIN_ID = 'fixture.physical-copy-contributor';
const CONTRIBUTION_ID = 'physical-copy-source';
const SURFACE_ROLE = 'detail';

/**
 * Select the sole exact current B handle from the host-stamped target snapshot.
 * Missing, stale, differently identified, or duplicate candidates fail closed
 * inside the shared SDK selector; only this target's own presentation
 * expectation is checked here.
 */
export function selectPhysicalCopyDetailSurface(
  targetedContributions: SurfaceContext['targetedContributions'],
) {
  if (targetedContributions.target.pluginId !== TARGET_PLUGIN_ID) return null;

  const surface = selectTargetedContributionSurface(targetedContributions, {
    pointId: POINT_ID,
    protocol: { id: PROTOCOL_ID, version: PROTOCOL_VERSION },
    contributor: { pluginId: CONTRIBUTOR_PLUGIN_ID, contributionId: CONTRIBUTION_ID },
    role: SURFACE_ROLE,
  });

  return surface !== undefined && surface.presentation === 'content' ? surface : null;
}
