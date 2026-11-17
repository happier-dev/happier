import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { InlineStatus } from '@/components/ui/status/InlineStatus';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { t } from '@/text';

import { DeploymentEnvironmentStateMark } from './deployments/rows/DeploymentEnvironmentRow';
import type { ProjectsTreeAttention, ProjectsTreeRow } from './projectsTreeRows';
import { useTeamSetupRepositoryProgress } from '@/components/teams/setup/useTeamSetupRepositoryProgress';
import { resolveActionOperationStatus } from '@/components/inbox/actionOperations/actionOperationPresentation';
import { readActionOperationTaskQuestion, type ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';

/**
 * A Project or checkout row's end while something beneath it asks for a look (the Projects column and the phone list).
 * An Environment's trouble is that Environment's state mark (UI refinements ruling 2026-11-15 08:57Z), the same words
 * and tone the Services column says; a deploy at work yields to a checkout that needs the person, whose Session fact
 * keeps its quiet needs-you dot. Otherwise a working checkout spins.
 */
export function ProjectsTreeRowAttention(
  props: Readonly<{
    row: Pick<ProjectsTreeRow, 'attention' | 'state'> & Partial<Pick<ProjectsTreeRow, 'kind' | 'source' | 'machineId'>>;
    testID?: string;
  }>,
) {
  const source = props.row.kind === 'project' ? props.row.source : undefined;
  // A Project row that names its Source also says how that Source's setup run is going (lab L3 Projects column).
  return source
    ? <ProjectsTreeSourceSetupAttention row={props.row} source={source} testID={props.testID} />
    : <ProjectsTreeRowAttentionMark row={props.row} attention={props.row.attention} testID={props.testID} />;
}

/** Ambient setup progress for one Source: the Project Open and setup operations' own states, never inferred. */
function ProjectsTreeSourceSetupAttention(props: Readonly<{
  row: Pick<ProjectsTreeRow, 'attention' | 'state'> & Partial<Pick<ProjectsTreeRow, 'machineId'>>;
  source: NonNullable<ProjectsTreeRow['source']>;
  testID?: string;
}>) {
  const { binding } = useServerCredentialAccountScopeBinding(props.source.serverId);
  // The Open ran on the Machine that holds the row's checkout; a row with no single checkout has none to ask about.
  const machineId = props.row.machineId ?? null;
  const query = React.useMemo(() => ({ serverId: props.source.serverId, accountId: binding?.accountId ?? null,
    machineId, sourceId: props.source.source.id }), [binding?.accountId, machineId, props.source.serverId, props.source.source.id]);
  const progress = useTeamSetupRepositoryProgress(query, binding ?? null);
  const setup = readSetupAttention(progress.setupOperation) ?? readSetupAttention(progress.openOperation);
  // A checkout's own needs-you (a Session waiting) still leads; setup fills in where the row has nothing to say.
  if (props.row.attention === 'needs-you' || setup === null)
    return <ProjectsTreeRowAttentionMark row={props.row} attention={props.row.attention} testID={props.testID} />;
  return <ProjectsTreeSetupStatus attention={setup} testID={props.testID} />;
}

/**
 * A Source's setup run in words at its Project row's end (lab L3 Projects column: "Setting up", "Needs you"),
 * through the one inline state mark core rows use (UI refinements ruling 2026-11-15 08:57Z).
 */
function ProjectsTreeSetupStatus(props: Readonly<{ attention: NonNullable<ProjectsTreeAttention>; testID?: string }>) {
  const needsYou = props.attention === 'needs-you';
  return (
    <InlineStatus
      tone={needsYou ? 'attention' : 'secondary'}
      label={needsYou ? t('inbox.needsYou') : t('projects.checkouts.settingUp')}
      pulsing={!needsYou}
      {...(props.testID ? { testID: `${props.testID}-setup` } : {})}
    />
  );
}

function readSetupAttention(operation: ActionOperationProjection | null): ProjectsTreeAttention {
  if (!operation) return null;
  // Only a run in progress speaks here; a settled failure belongs to Activity and the Project's own page.
  if (resolveActionOperationStatus(operation.snapshot, operation.observation).tone !== 'active') return null;
  return readActionOperationTaskQuestion(operation.snapshot) !== null ? 'needs-you' : 'working';
}

function ProjectsTreeRowAttentionMark(
  props: Readonly<{
    row: Pick<ProjectsTreeRow, 'attention' | 'state'>;
    attention: ProjectsTreeAttention;
    testID?: string;
  }>,
) {
  const { theme } = useUnistyles();
  const { attention } = props;
  const state = props.row.state ?? null;
  if (state && (state.tone !== null || attention !== 'needs-you')) {
    return (
      <DeploymentEnvironmentStateMark
        state={state}
        {...(props.testID ? { testID: `${props.testID}-state` } : {})}
      />
    );
  }
  if (attention === 'needs-you') {
    return (
      <StatusDot
        {...(props.testID ? { testID: `${props.testID}-needs-you` } : {})}
        color={theme.colors.state.warning.foreground}
        size={6}
        accessibilityLabel={t('projects.checkouts.needsYou')}
      />
    );
  }
  if (attention === 'working')
    return <ActivitySpinner size="small" color={theme.colors.text.tertiary} />;
  return null;
}
