import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { readDeploymentEnvironmentApprovalScopeV1 } from '@happier-dev/protocol/deployments/deploymentApprovalScopeV1';
import {
  DEPLOYMENT_ACTION_IDS_V1,
  DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1,
  DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1,
  deploymentOperationForRootActionV1,
} from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import type { DeploymentEnvironmentDeployerPrincipalV1 } from '@happier-dev/protocol/deployments/deploymentEnvironmentDeployerV1';

import { ActionApprovalLooseningNotice } from '@/components/settings/actions/ActionApprovalLooseningNotice';
import { ActionScopedApprovalRow, type ActionScopedApprovalMode } from '@/components/settings/actions/ActionScopedApprovalRow';
import { normalizeActionsSettings } from '@/components/settings/actions/normalizeActionsSettings';
import { resolveActionSettingsTargetControlState } from '@/components/settings/actions/resolveActionSettingsControlState';
import { useActionPolicyWriter } from '@/components/settings/actions/useActionPolicyWriter';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useSetting } from '@/sync/domains/state/storage';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useProjectSource } from '@/components/projects/sources/useProjectSources';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { t } from '@/text';

import { DeploymentDeployerFields } from './DeploymentDeployerFields';
import { useDeploymentChangePress } from './deploymentActionOutcome';
import { DeployOutcomeBanner } from './DeploymentEnvironmentDetail';
import type { DeploymentEnvironmentEditing } from './DeploymentEnvironmentSettingsPanel';

type DeployerMode = DeploymentEnvironmentReadDetailV1['environment']['deployerMode'];
type Principal = DeploymentEnvironmentDeployerPrincipalV1;
const noop = () => {};
const NO_PRINCIPALS: readonly Principal[] = Object.freeze([]);
/** Agents are the audience a per-Environment approval is offered for, as for a Machine (Plan 40 §6.1). */
const AUDIENCE = 'agent' as const;
/**
 * The operations an Environment's approvals are set for: its root operations (deploy, promote, roll back, tear
 * down), as the deployment Action owner classifies them, then changing its settings and its bindings.
 */
export const ENVIRONMENT_APPROVAL_ACTION_IDS: readonly ActionId[] = Object.freeze([
  ...DEPLOYMENT_ACTION_IDS_V1.filter(id => deploymentOperationForRootActionV1(id) !== undefined),
  DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1,
  DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1,
]);

/**
 * Environment → Permissions (DEPLOY-COMPOSE P7, lab d2 `access`): who may deploy, whether agents ask first for
 * each operation here, and where its jobs and alerts run. The controller is edited only in Settings → Controller;
 * its row links there (P40-R54).
 */
export const DeploymentPermissionsPanel = React.memo(
  function DeploymentPermissionsPanel(
    props: Readonly<{
      detail: DeploymentEnvironmentReadDetailV1;
      lifetime?: ServerAccountScopeLifetime | null;
      machineName: (machineId: string) => string;
      onOpenController: () => void;
      onOpenPreviews?: () => void;
      /** The Action owner's manager edits; absent where this viewer cannot change who may deploy. */
      editing?: DeploymentEnvironmentEditing | null;
    }>,
  ) {
    const { theme } = useUnistyles();
    const { environment } = props.detail;
    const editing = environment.capabilities.role === 'manager' ? props.editing ?? null : null;
    const change = useDeploymentChangePress(editing?.review ?? null, editing?.onChanged ?? noop);
    const settingsScope = useAccountSettingsScope();
    const accountScope = props.lifetime?.scope ?? settingsScope;
    const source = useProjectSource(props.lifetime ?? null, environment.projectSourceId).source?.source ?? null;
    // Picking "Chosen people" before anyone is chosen opens the list locally; the first pick saves both.
    const [choosing, setChoosing] = React.useState(false);
    const mode: DeployerMode = choosing ? 'chosen' : environment.deployerMode;
    const principals = environment.deployerPrincipals ?? NO_PRINCIPALS;
    const writePrincipals = (next: readonly Principal[]) => {
      void change.press(() => editing!.actions.updateEnvironment(environment, {
        deployerMode: 'chosen', deployerPrincipals: [...next],
      })).then((ok) => { if (ok) setChoosing(false); });
    };
    return (
      <>
        {change.outcome && editing ? (
          <DeployOutcomeBanner
            controller={change.banner}
            machine={props.machineName(environment.controllerMachineId)}
            copy="setting"
          />
        ) : null}
        <ItemGroup
          testID="project-deployments.environment.permissions"
          title={t('projects.deployments.whoMayDeploy')}
          description={t('projects.deployments.whoMayDeployDescription')}
        >
          <DeploymentDeployerFields
            mode={mode}
            principals={choosing ? NO_PRINCIPALS : principals}
            scope={accountScope}
            lifetime={props.lifetime ?? null}
            source={source}
            owner={environment.owner}
            editable={editing !== null}
            disabled={change.running}
            onModeChange={(deployerMode) => {
              if (!editing) return;
              if (deployerMode === 'chosen') {
                if (principals.length > 0) void change.press(() => editing.actions.updateEnvironment(environment,
                  { deployerMode, deployerPrincipals: [...principals] }));
                else setChoosing(true);
                return;
              }
              setChoosing(false);
              void change.press(() => editing.actions.updateEnvironment(environment, { deployerMode }));
            }}
            onChangePrincipals={writePrincipals}
          />
          <Item
            title={t('projects.deployments.yourAccess')}
            detail={roleLabel(environment.capabilities.role)}
            mode="info"
          />
        </ItemGroup>
        <EnvironmentApprovals environment={environment} environmentName={props.detail.content.name} />
        {props.onOpenPreviews ? <ItemGroup>
          <Item testID="project-deployments.environment.permissions.previews"
            title={t('projects.deployments.settingsSections.previewEditor.configure')}
            showChevron onPress={props.onOpenPreviews} />
        </ItemGroup> : null}
        <ItemGroup
          testID="project-deployments.environment.permissions.controller"
          title={t('projects.deployments.sectionController')}
          description={t('projects.deployments.sectionControllerDescription')}
        >
          <Item
            testID="project-deployments.environment.permissions.controller.link"
            icon={
              <Icon
                name="hard-drives"
                size={18}
                color={theme.colors.text.secondary}
              />
            }
            title={t('projects.deployments.controllerRow')}
            detail={props.machineName(environment.controllerMachineId)}
            showChevron
            onPress={props.onOpenController}
          />
        </ItemGroup>
      </>
    );
  },
);

/**
 * Approvals (P7 §2): one row per operation, Default | Ask first | Allowed for agents in this Environment, through the
 * shared scoped approval row and `actions.policy.set`. Approvals are each person's own Account preference, so the
 * description says a deployer can change theirs; an Allowed permission change reads the one shared warning (R23).
 */
function EnvironmentApprovals(props: Readonly<{ environment: DeploymentEnvironmentReadDetailV1['environment']; environmentName: string }>) {
  const rawSettings = useSetting('actionsSettingsV1');
  const settings = React.useMemo(() => normalizeActionsSettings(rawSettings), [rawSettings]);
  const writePolicy = useActionPolicyWriter();
  const scope = React.useMemo(() => ({ kind: 'environment' as const, environmentId: props.environment.id }), [props.environment.id]);
  const admission = React.useMemo(() => readDeploymentEnvironmentApprovalScopeV1(props.environment), [props.environment]);
  const approvalScope = 'scope' in admission ? admission.scope ?? undefined : undefined;
  const prefix = 'project-deployments.environment.permissions.approvals';
  const rows = React.useMemo(() => ENVIRONMENT_APPROVAL_ACTION_IDS.map((actionId) => {
    const state = resolveActionSettingsTargetControlState({ settings, scope, approvalScope, actionId, targetId: AUDIENCE });
    const value: ActionScopedApprovalMode = state.kind === 'approval' && (state.value === 'ask_first' || state.value === 'allowed')
      ? state.value : 'default';
    return {
      actionId,
      label: approvalLabel(actionId),
      value,
      // An Action that always asks (irreversible) has no choice to offer here.
      fixed: !('scope' in admission) || state.kind === 'approval' && !state.approvalWaivable,
      notice: state.kind === 'approval' && value === 'allowed' ? state.approvalLooseningNotice : undefined,
    };
  }), [scope, settings, approvalScope, 'scope' in admission]);
  return (
    <ItemGroup
      testID={prefix}
      title={t('projects.deployments.editors.approvalsTitle')}
      description={props.environment.purpose === 'preview' ? t('projects.deployments.settingsSections.previewEditor.inherited')
        : t('projects.deployments.editors.approvalsDescription')}
    >
      {rows.map(row => row.notice ? (
        <ActionApprovalLooseningNotice
          key={`${row.actionId}:loosening`}
          testID={`${prefix}.${row.actionId}.loosening`}
          notice={row.notice}
          description={t('projects.deployments.editors.approvalsLoosening', { environment: props.environmentName })}
        />
      ) : null)}
      {rows.map(row => (
        <ActionScopedApprovalRow
          key={row.actionId}
          testIDPrefix={`${prefix}.${row.actionId}`}
          title={row.label.title}
          subtitle={row.label.hint}
          value={row.fixed ? 'ask_first' : row.value}
          disabled={row.fixed}
          onChange={(mode) => { void writePolicy({ actionId: row.actionId, audience: AUDIENCE, scope, mode }); }}
        />
      ))}
    </ItemGroup>
  );
}

/**
 * What each approval row is about, in the person's words with its consequence (lab d2 `access`): the root
 * operation the deployment Action owner classifies, then editing settings and variables.
 */
function approvalLabel(actionId: ActionId): Readonly<{ title: string; hint: string }> {
  switch (deploymentOperationForRootActionV1(actionId)) {
    case 'deploy': return { title: t('projects.deployments.editors.approveDeploy'), hint: t('projects.deployments.editors.approveDeployHint') };
    case 'rollback': return { title: t('projects.deployments.editors.approveRollback'), hint: t('projects.deployments.editors.approveRollbackHint') };
    case 'promote': return { title: t('projects.deployments.editors.approvePromote'), hint: t('projects.deployments.editors.approvePromoteHint') };
    case 'teardown': return { title: t('projects.deployments.editors.approveTeardown'), hint: t('projects.deployments.editors.approveTeardownHint') };
    case undefined: break;
  }
  return actionId === DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1
    ? { title: t('projects.deployments.editors.approveVariables'), hint: t('projects.deployments.editors.approveVariablesHint') }
    : { title: t('projects.deployments.editors.approveSettings'), hint: t('projects.deployments.editors.approveSettingsHint') };
}

function roleLabel(
  role: DeploymentEnvironmentReadDetailV1['environment']['capabilities']['role'],
): string {
  switch (role) {
    case 'reader':
      return t('projects.deployments.roleReader');
    case 'deployer':
      return t('projects.deployments.roleDeployer');
    case 'manager':
      return t('projects.deployments.roleManager');
  }
}
