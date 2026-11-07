import {
  TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
  TriageSourcesContributionPointV1,
} from '@happier-dev/triage-protocol/v1';

/**
 * The target-owned executable contribution-point definitions shared by the
 * authored manifest and the generated cold bundled registry.
 */
export const PLUGIN_TARGETED_CONTRIBUTION_POINT_DEFINITIONS: Readonly<{
  [TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1]: typeof TriageSourcesContributionPointV1;
}> = Object.freeze({
  [TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1]: TriageSourcesContributionPointV1,
});
