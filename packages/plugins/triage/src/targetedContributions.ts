import { projectDefinedTargetedContributionPoints } from '@happier-dev/plugin-sdk/contributions';
import {
  TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
  TRIAGE_AGENT_ACTIONS_CONTRIBUTION_POINT_ID_V1,
  TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
  TriageAgentActionsContributionPointV1,
  TriageSourcesContributionPointV1,
} from '@happier-dev/triage-protocol/v1';

/**
 * The target-owned executable contribution-point definitions shared by the
 * authored manifest and the generated cold bundled registry.
 */
export const PLUGIN_TARGETED_CONTRIBUTION_POINT_DEFINITIONS: Readonly<{
  [TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1]: typeof TriageSourcesContributionPointV1;
  [TRIAGE_AGENT_ACTIONS_CONTRIBUTION_POINT_ID_V1]: typeof TriageAgentActionsContributionPointV1;
}> = Object.freeze({
  [TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1]: TriageSourcesContributionPointV1,
  [TRIAGE_AGENT_ACTIONS_CONTRIBUTION_POINT_ID_V1]: TriageAgentActionsContributionPointV1,
});

/** Refs derive from the exact declarations consumed by the full plugin definition. */
const points = projectDefinedTargetedContributionPoints(
  TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, PLUGIN_TARGETED_CONTRIBUTION_POINT_DEFINITIONS,
);
export const TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 = points[TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1];
export const TRIAGE_AGENT_ACTIONS_CONTRIBUTION_POINT_REF_V1 = points[TRIAGE_AGENT_ACTIONS_CONTRIBUTION_POINT_ID_V1];
