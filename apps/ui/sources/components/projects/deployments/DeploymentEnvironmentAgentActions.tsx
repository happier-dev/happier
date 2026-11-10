import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

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
  controllerMachineId?: string;
  compact: boolean;
  /** An Environment that already serves leads with Deploy; a setup action stays secondary to it. */
  emphasis: 'primary' | 'secondary';
}>): React.ReactElement | null {
  const subject = React.useMemo(() => ({ kind: 'deploymentEnvironment' as const,
    serverId: props.serverId, environmentId: props.environmentId }), [props.serverId, props.environmentId]);
  const options = React.useMemo(() => ({ ...ENVIRONMENT_AGENT_ACTIONS,
    ...(props.controllerMachineId ? { externalActionTarget: { kind: 'machine' as const, machineId: props.controllerMachineId } } : {}),
  }), [props.controllerMachineId]);
  const investigation = useInvestigateFailure(subject, options);
  const actions = investigation.actions ?? NO_ACTIONS;
  if (actions.length === 0 && !investigation.showOutcome) return null;
  return (
    <>
      <InvestigationAgentActionButtons actions={actions} pending={investigation.pending} compact={props.compact}
        emphasis={props.emphasis}
        onLaunch={(mode, actionId) => { void investigation.launch(mode, actionId); }} />
      {investigation.showOutcome && investigation.outcome ? (
        // The facts block owns the gutter, so the outcome spans it and lines up with the button above.
        <View style={styles.outcome}>
          <InvestigationOutcomeBanner outcome={investigation.outcome} serverId={props.serverId}
            testID="project-deployments.environment.agent-action" onChoosePlacement={investigation.investigateWithPlacement}
            pending={investigation.pending} placement="inline" />
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  outcome: { alignSelf: 'stretch' },
});
