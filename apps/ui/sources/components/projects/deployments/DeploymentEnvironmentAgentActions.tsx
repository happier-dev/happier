import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { InvestigationAgentActionButtons } from '@/components/inbox/detail/InvestigationAgentActionButtons';
import { InvestigationOutcomeBanner } from '@/components/inbox/detail/InvestigationOutcomeBanner';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { OperationsOutcomeGroup } from '@/components/workflows/run/OperationsOutcomeGroup';
import { useAccountNoticeInvestigation } from '@/hooks/inbox/AccountNoticeInvestigationProvider';
import { useInvestigateFailure } from '@/hooks/inbox/useInvestigateFailure';
import { useInvestigationSessionResult } from '@/hooks/inbox/useInvestigationSessionResult';
import { t } from '@/text';
import { DeploymentPreparationEntry, type DeploymentPreparationContext } from './DeploymentPreparation';

const ENVIRONMENT_AGENT_ACTIONS = { agentActions: 'subjectOnly' } as const;

/**
 * Repository preparation uses its registered Action; configured investigations retain their own owner.
 */
export function DeploymentEnvironmentAgentActions(props: Readonly<{
  serverId: string;
  environmentId: string;
  controllerMachineId?: string;
  compact: boolean;
  /** An Environment that already serves leads with Deploy; a setup action stays secondary to it. */
  emphasis: 'primary' | 'secondary';
  preparation?: DeploymentPreparationContext;
  /**
   * `facts`: the next step under an Environment that serves nothing yet. `section`: once Deploy leads, the actions are
   * a titled section of their own (QA-DEPLOY #36), so a lone control never floats under the facts.
   */
  placement: 'facts' | 'section';
}>): React.ReactElement | null {
  const subject = React.useMemo(() => ({ kind: 'deploymentEnvironment' as const,
    serverId: props.serverId, environmentId: props.environmentId }), [props.serverId, props.environmentId]);
  const options = React.useMemo(() => ({ ...ENVIRONMENT_AGENT_ACTIONS,
    ...(props.controllerMachineId ? { externalActionTarget: { kind: 'machine' as const, machineId: props.controllerMachineId } } : {}),
  }), [props.controllerMachineId]);
  const investigation = useInvestigateFailure(subject, options);
  const actions = investigation.actions ?? [];
  const owner = useAccountNoticeInvestigation();
  const started = investigation.outcome?.kind === 'started' ? investigation.outcome : null;
  const linked = useInvestigationSessionResult(owner, actions.length > 0 || started ? subject : null, started, options);
  const result = React.useMemo(() => linked ? {
    subject, finding: { kind: 'investigate' as const, ...linked }, produced: linked.produced,
  } : null, [linked, subject]);
  // Healthy with nothing to offer stays silent; a refused catalog keeps the section to say what it needs.
  if (!props.preparation && actions.length === 0 && !investigation.showOutcome && !investigation.catalogOutcome && !result) return null;
  const content = (
    <View style={styles.actions}>
      {props.preparation ? <DeploymentPreparationEntry {...props.preparation} environmentId={props.environmentId} mode="prepare"
        emphasis={actions.length === 0 ? props.emphasis : 'secondary'} /> : null}
      <InvestigationAgentActionButtons actions={actions} pending={investigation.pending} catalogOutcome={investigation.catalogOutcome} onRetry={investigation.retryCatalog} compact={props.compact}
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
      {result ? <View style={styles.outcome}>
        <OperationsOutcomeGroup input={result} testID="project-deployments.environment.investigation" />
      </View> : null}
    </View>
  );
  return props.placement === 'section' ? (
    <ItemGroup testID="project-deployments.environment.agentActions" surface="none"
      title={t('projects.deployments.overviewStatus.agentActionsTitle')}
      description={t('projects.deployments.overviewStatus.agentActionsDescription')}>
      {content}
    </ItemGroup>
  ) : (
    <ItemGroup surface="none" header="none">{content}</ItemGroup>
  );
}

const styles = StyleSheet.create((theme) => ({
  actions: { paddingHorizontal: theme.space.s16, alignItems: 'flex-start', gap: theme.space.s8 },
  outcome: { alignSelf: 'stretch' },
}));
