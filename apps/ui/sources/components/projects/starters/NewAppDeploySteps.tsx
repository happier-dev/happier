import * as React from 'react';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import {
  DeploymentEnvironmentDraft,
  type DeploymentDraftFrame,
  type DeploymentDraftStepsHost,
} from '@/components/projects/deployments/DeploymentEnvironmentDraft';
import { useDeploymentProjectChoice } from '@/components/projects/deployments/DeploymentProjectChoice';
import { createDeploymentActions } from '@/components/projects/deployments/deploymentActions';
import {
  buildDeploymentEnvironmentHref,
  type DeploymentNewDefinitionKind,
} from '@/components/projects/deployments/deploymentNavigation';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { FieldLayout, FieldValue } from '@/components/ui/lists/FieldRow';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { t } from '@/text';

/** What Deploy an app deploys once its source step is answered: a Project's repository or a stored definition. */
export type NewAppDeploySource =
  | Readonly<{ kind: 'repository'; projectSourceId: string }>
  | Readonly<{
      kind: 'definition';
      definitionKind: DeploymentNewDefinitionKind;
    }>;

/**
 * Deploy an app's Where → Configure → Review (journey-deploy D3): the one Environment draft, hosted as steps inside
 * the dialog. The draft owns every decision and Action; this host only binds its Home and says where it goes after.
 */
export function NewAppDeploySteps(
  props: Readonly<{
    serverId: string;
    source: NewAppDeploySource;
    /** A "Deploy an app here" door's Machine; the person can still choose another. */
    machineId: string | null;
    phone: boolean;
    steps: DeploymentDraftStepsHost;
    /** Closes the flow before it navigates (a dialog steps aside; a page has nothing to close). */
    onLeave: () => void;
  }>,
) {
  const { binding } = useServerCredentialAccountScopeBinding(props.serverId);
  if (!binding)
    return (
      <SurfaceStateCard
        testID="newApp.deploy.loading"
        kind="loading"
        layout="inline"
        title={t('common.loading')}
      />
    );
  return props.source.kind === 'repository' ? (
    <RepositoryDeploy
      key={`${binding.scope.serverId}:${binding.scope.accountId}`}
      {...props}
      lifetime={binding}
      projectSourceId={props.source.projectSourceId}
    />
  ) : (
    <DefinitionDeploy
      key={`${binding.scope.serverId}:${binding.scope.accountId}`}
      {...props}
      lifetime={binding}
      definitionKind={props.source.definitionKind}
    />
  );
}

type BoundProps = Readonly<{
  lifetime: ServerAccountScopeLifetime;
  machineId: string | null;
  phone: boolean;
  steps: DeploymentDraftStepsHost;
  onLeave: () => void;
}>;

function useDeployExits(props: BoundProps) {
  const router = useRouter();
  const { lifetime, onLeave } = props;
  const leaveTo = React.useCallback(
    (href: string) => {
      onLeave();
      router.push(href as never);
    },
    [onLeave, router],
  );
  const onApprovalRequested = React.useCallback(
    (artifactId: string) => {
      leaveTo(buildApprovalHref(artifactId, lifetime.scope.serverId));
    },
    [leaveTo, lifetime.scope.serverId],
  );
  return { leaveTo, onApprovalRequested };
}

function RepositoryDeploy(
  props: BoundProps & Readonly<{ projectSourceId: string }>,
) {
  const { lifetime, projectSourceId } = props;
  const actions = React.useMemo(
    () => createDeploymentActions(lifetime, projectSourceId),
    [lifetime, projectSourceId],
  );
  const { leaveTo, onApprovalRequested } = useDeployExits(props);
  return (
    <DeploymentEnvironmentDraft
      lifetime={lifetime}
      sourceId={projectSourceId}
      phone={props.phone}
      actions={actions}
      platformAvailable
      initialMachineId={props.machineId}
      steps={props.steps}
      onApprovalRequested={onApprovalRequested}
      onDiscard={props.onLeave}
      onSaved={(environmentId, next) =>
        leaveTo(
          buildDeploymentEnvironmentHref({
            serverId: lifetime.scope.serverId,
            projectSourceId,
            environmentId,
            ...(next?.tab ? { tab: next.tab } : {}),
          }),
        )
      }
    />
  );
}

function DefinitionDeploy(
  props: BoundProps & Readonly<{ definitionKind: DeploymentNewDefinitionKind }>,
) {
  const { lifetime } = props;
  const projectChoice = useDeploymentProjectChoice({
    lifetime,
    initiallyNew: true,
  });
  const actions = React.useMemo(
    () => createDeploymentActions(lifetime),
    [lifetime],
  );
  const { leaveTo, onApprovalRequested } = useDeployExits(props);
  return (
    <DeploymentEnvironmentDraft
      lifetime={lifetime}
      sourceId={null}
      projectChoice={projectChoice}
      definitionKind={props.definitionKind}
      phone={props.phone}
      actions={actions}
      initialMachineId={props.machineId}
      steps={props.steps}
      onApprovalRequested={onApprovalRequested}
      onDiscard={props.onLeave}
      onSaved={(environmentId, next) => {
        const selection = projectChoice.selection;
        const projectSourceId =
          next?.projectSourceId ??
          (selection && 'projectSourceId' in selection
            ? selection.projectSourceId
            : null);
        if (projectSourceId)
          leaveTo(
            buildDeploymentEnvironmentHref({
              serverId: lifetime.scope.serverId,
              projectSourceId,
              environmentId,
              ...(next?.tab ? { tab: next.tab } : {}),
            }),
          );
        else props.onLeave();
      }}
    />
  );
}

/**
 * The flow's one summary of answered steps (lab `jd-sum`): a label column, the answer, and Change on the same line.
 * Rendered by the host above the step, so every step reads the same facts in the same place.
 */
export function NewAppDeploySummary(
  props: Readonly<{
    phone: boolean;
    source: Readonly<{ title: string; note: string | null }>;
    frame: DeploymentDraftFrame | null;
    onChangeSource: () => void;
  }>,
) {
  const runsOn =
    props.frame && props.frame.step !== 'where' ? props.frame.runsOn : null;
  return (
    <ItemGroup testID="newApp.deploy.summary">
      <Item
        mode="info"
        testID="newApp.deploy.summary.source"
        showChevron={false}
        title={
          <FieldLayout label={t('newApp.deploy.source')} columns={!props.phone}>
            <FieldValue value={props.source.title} note={props.source.note} />
          </FieldLayout>
        }
        rightElement={
          <TextLinkButton
            testID="newApp.deploy.changeSource"
            size="meta"
            label={t('newApp.deploy.change')}
            onPress={props.onChangeSource}
          />
        }
      />
      {runsOn && props.frame ? (
        <Item
          mode="info"
          testID="newApp.deploy.summary.runsOn"
          showChevron={false}
          title={
            <FieldLayout
              label={t('newApp.deploy.runsOn')}
              columns={!props.phone}
            >
              <FieldValue
                value={runsOn.title ?? t('newApp.deploy.onMachine')}
              />
            </FieldLayout>
          }
          rightElement={
            <TextLinkButton
              testID="newApp.deploy.changeTarget"
              size="meta"
              label={t('newApp.deploy.change')}
              onPress={props.frame.toWhere}
            />
          }
        />
      ) : null}
    </ItemGroup>
  );
}
