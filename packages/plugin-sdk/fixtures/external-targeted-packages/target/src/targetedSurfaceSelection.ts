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
 * Missing, stale, differently identified, or duplicate candidates fail closed.
 */
export function selectPhysicalCopyDetailSurface(
  targetedContributions: SurfaceContext['targetedContributions'],
) {
  if (targetedContributions.target.pluginId !== TARGET_PLUGIN_ID) return null;

  const matches = targetedContributions.points.flatMap((point) => (
    point.pointId !== POINT_ID
      ? []
      : point.protocols.flatMap((protocolSnapshot) => (
        protocolSnapshot.protocol.id !== PROTOCOL_ID
          || protocolSnapshot.protocol.version !== PROTOCOL_VERSION
          ? []
          : protocolSnapshot.contributions.flatMap((contribution) => (
            contribution.protocol.id !== PROTOCOL_ID
              || contribution.protocol.version !== PROTOCOL_VERSION
              || contribution.contributor.pluginId !== CONTRIBUTOR_PLUGIN_ID
              || contribution.contributor.contributionId !== CONTRIBUTION_ID
              ? []
              : contribution.surfaces.filter((surface) => (
                surface.point.pointId === POINT_ID
                  && surface.point.protocol.id === PROTOCOL_ID
                  && surface.point.protocol.version === PROTOCOL_VERSION
                  && surface.contributor.pluginId === CONTRIBUTOR_PLUGIN_ID
                  && surface.contributor.contributionId === CONTRIBUTION_ID
                  && surface.contributor.immutableGenerationId
                    === contribution.contributor.immutableGenerationId
                  && surface.role === SURFACE_ROLE
                  && surface.presentation === 'content'
              ))
          ))
      ))
  ));

  return matches.length === 1 ? matches[0] : null;
}
