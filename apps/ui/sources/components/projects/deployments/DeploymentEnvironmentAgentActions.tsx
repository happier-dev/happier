import * as React from 'react';

import { InvestigationAgentActionButtons } from '@/components/inbox/detail/InvestigationAgentActionButtons';
import { InvestigationOutcomeBanner } from '@/components/inbox/detail/InvestigationOutcomeBanner';
import { useInvestigateFailure } from '@/hooks/inbox/useInvestigateFailure';

const ENVIRONMENT_AGENT_ACTIONS = { agentActions: 'subjectOnly' } as const;
const NO_ACTIONS = Object.freeze([]);

/**
 * The person's records for this Environment ("Set it up" once its owner declares it), each through
 * `sessions/run-configured-v1` with the Environment as the item context. No record, no control.
 */
export function DeploymentEnvironmentAgentActions(props: Readonly<{
  serverId: string;
  environmentId: string;
  compact: boolean;
}>): React.ReactElement | null {
  const subject = React.useMemo(() => ({ kind: 'deploymentEnvironment' as const,
    serverId: props.serverId, environmentId: props.environmentId }), [props.serverId, props.environmentId]);
  const investigation = useInvestigateFailure(subject, ENVIRONMENT_AGENT_ACTIONS);
  const actions = investigation.actions ?? NO_ACTIONS;
  if (actions.length === 0 && !investigation.showOutcome) return null;
  return (
    <>
      <InvestigationAgentActionButtons actions={actions} pending={investigation.pending} compact={props.compact}
        onLaunch={(mode, actionId) => { void investigation.launch(mode, actionId); }} />
      {investigation.showOutcome && investigation.outcome ? (
        <InvestigationOutcomeBanner outcome={investigation.outcome} serverId={props.serverId}
          testID="project-deployments.environment.agent-action" onChoosePlacement={investigation.investigateWithPlacement}
          pending={investigation.pending} />
      ) : null}
    </>
  );
}
