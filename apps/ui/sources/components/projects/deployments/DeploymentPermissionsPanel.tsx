import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import {
  DEPLOYMENT_ACTION_IDS_V1,
  DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1,
  DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1,
  deploymentOperationForRootActionV1,
} from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import type { MachineAuthorityPresentationV1 } from '@happier-dev/protocol/machines/machineAuthorityV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useMachineAuthority } from '@/components/machines/security/useMachineAuthority';
import { useServerScopedMachine } from '@/sync/store/hooks';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { machinePageHref } from '@/components/machines/page/machinePageHref';
import { ActionApprovalLooseningNotice } from '@/components/settings/actions/ActionApprovalLooseningNotice';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
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
import { ENVIRONMENT_APPROVAL_AUDIENCE, environmentApprovalScopes } from './environmentAgentApproval';
import { DeploymentPlatformAccess } from './DeploymentPlatformAccess';
import { useDeploymentChangePress } from './deploymentActionOutcome';
import { DeployOutcomeBanner } from './DeploymentEnvironmentDetail';
import type { DeploymentEnvironmentEditing } from './DeploymentEnvironmentSettingsPanel';

type DeployerMode = DeploymentEnvironmentReadDetailV1['environment']['deployerMode'];
type Principal = PrincipalRefV1;
const noop = () => {};
const NO_PRINCIPALS: readonly Principal[] = Object.freeze([]);
const AUDIENCE = ENVIRONMENT_APPROVAL_AUDIENCE;
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
        <EnvironmentAgentPowerNotice machineId={environment.controllerMachineId} serverId={environment.serverId}
          machine={props.machineName(environment.controllerMachineId)} />
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
        </ItemGroup>
        <DeploymentPlatformAccess detail={props.detail} scope={accountScope} lifetime={props.lifetime ?? null} />
        <EnvironmentApprovals environment={environment} environmentName={props.detail.content.name} />
        {props.onOpenPreviews ? <ItemGroup>
          <Item testID="project-deployments.environment.permissions.previews"
            title={t('projects.deployments.settingsSections.previewEditor.configure')}
            showChevron onPress={props.onOpenPreviews} />
        </ItemGroup> : null}
        {/* Last (lab envPerm): what you can do here, and the Machine that runs its jobs and alerts. */}
        <ItemGroup
          testID="project-deployments.environment.permissions.controller"
          title={t('projects.deployments.editors.yourAccessTitle')}
        >
          <Item
            testID="project-deployments.environment.permissions.role"
            title={roleLabel(environment.capabilities.role)}
            subtitle={roleHint(environment.capabilities.role)}
            mode="info"
          />
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
 * Lab d2 `access` (P40-R33): when agents on the controller Machine hold administrator power, Permissions says so first,
 * from the Machine's one authority presentation (pushed fields, no read of its own). Healthy and unknown stay quiet.
 */
const readMachineOnline = (machine: Machine | null) => (machine ? isMachineOnline(machine) : null);

function EnvironmentAgentPowerNotice(props: Readonly<{ machineId: string; serverId: string; machine: string }>) {
  const router = useRouter();
  // Its power is a current fact only while the Machine is online, as on its own Security tab.
  const online = useServerScopedMachine(props.serverId, props.machineId, readMachineOnline);
  const authority = useMachineAuthority({ machineId: props.machineId, serverId: props.serverId,
    freshness: online === true ? 'current' : 'stale' });
  return <EnvironmentAgentPowerNoticeView authority={authority} machine={props.machine}
    onTurnOn={() => router.push(machinePageHref({ door: 'rail',
      target: { machineId: props.machineId, serverId: props.serverId }, tab: { id: 'security' } }) as never)} />;
}

/** The notice from the Machine's authority presentation; the Machine's Security tab owns the reviewed change. */
export function EnvironmentAgentPowerNoticeView(props: Readonly<{
  authority: Pick<MachineAuthorityPresentationV1, 'agentHostAuthority' | 'separateUsers'>;
  machine: string;
  onTurnOn: () => void;
}>) {
  if (props.authority.agentHostAuthority !== 'administrator') return null;
  const availability = props.authority.separateUsers.availability.kind;
  return (
    <AttentionBanner
      testID="project-deployments.environment.permissions.agentPower"
      tone="warning"
      title={t('projects.deployments.overviewStatus.agentPowerTitle', { machine: props.machine })}
      description={t('projects.deployments.overviewStatus.agentPowerBody', { machine: props.machine })}
      {...(availability === 'can_turn_on' || availability === 'repairable' ? { action: {
        label: t('projects.deployments.overviewStatus.agentPowerAction'),
        testID: 'project-deployments.environment.permissions.agentPower.turnOn',
        onPress: props.onTurnOn,
      } } : {})}
    />
  );
}

/**
 * Approvals (P7 §2): one row per operation, Default | Ask first | Allowed for agents in this Environment, through the
 * shared scoped approval row and `actions.policy.set`. Approvals are each person's own Account preference, so the
 * description says a deployer can change theirs; an Allowed permission change reads the one shared warning (R23).
 */
function EnvironmentApprovals(props: Readonly<{ environment: DeploymentEnvironmentReadDetailV1['environment']; environmentName: string }>) {
  const rawSettings = useSetting('actionsSettingsV1');
  const settings = React.useMemo(() => normalizeActionsSettings(rawSettings), [rawSettings]);
  const writePolicy = useActionPolicyWriter();
  const { scope, approvalScope, admitted } = React.useMemo(() => environmentApprovalScopes(props.environment), [props.environment]);
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
      fixed: !admitted || state.kind === 'approval' && !state.approvalWaivable,
      notice: state.kind === 'approval' && value === 'allowed' ? state.approvalLooseningNotice : undefined,
    };
  }), [scope, settings, approvalScope, admitted]);
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

function roleHint(role: DeploymentEnvironmentReadDetailV1['environment']['capabilities']['role']): string {
  switch (role) {
    case 'reader': return t('projects.deployments.editors.roleReaderHint');
    case 'deployer': return t('projects.deployments.editors.roleDeployerHint');
    case 'manager': return t('projects.deployments.editors.roleManagerHint');
  }
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
