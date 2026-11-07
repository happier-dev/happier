import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
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
import {
  TeamCredentialAudiencePicker,
  type TeamCredentialAudiencePrincipal,
} from '@/components/settings/teams/credentials/TeamCredentialAudiencePicker';
import { IconButton } from '@/components/ui/buttons/IconButton';
import {
  SegmentedChoiceItem,
  type SegmentedChoiceOption,
} from '@/components/ui/lists/SegmentedChoiceItem';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useTeamMembersRoster } from '@/hooks/teams/useTeamMembersRoster';
import { formatAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { useSetting } from '@/sync/domains/state/storage';
import { createTeamAddress, type TeamAddress } from '@/sync/domains/teams/teamAddress';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { resolveActionTitle } from '@/text/actionTitles';
import { t } from '@/text';

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
const principalKey = (principal: Principal) => JSON.stringify([principal.principalKind, principal.principalId]);

/**
 * Environment → Permissions (DEPLOY-COMPOSE P7, lab d2 `access`): who may deploy, whether agents ask first for
 * each operation here, and where its jobs and alerts run. The controller is edited only in Settings → Controller;
 * its row links there (P40-R54).
 */
export const DeploymentPermissionsPanel = React.memo(
  function DeploymentPermissionsPanel(
    props: Readonly<{
      detail: DeploymentEnvironmentReadDetailV1;
      machineName: (machineId: string) => string;
      onOpenController: () => void;
      /** The Action owner's manager edits; absent where this viewer cannot change who may deploy. */
      editing?: DeploymentEnvironmentEditing | null;
    }>,
  ) {
    const { theme } = useUnistyles();
    const { environment } = props.detail;
    const editing = environment.capabilities.role === 'manager' ? props.editing ?? null : null;
    const change = useDeploymentChangePress(editing?.review ?? null, editing?.onChanged ?? noop);
    const accountScope = useAccountSettingsScope();
    // Chosen people are Team members or Groups; a personal Environment has only its owner to choose.
    const team = environment.owner.kind === 'team' && accountScope
      ? createTeamAddress(accountScope.serverId, environment.owner.teamId) : null;
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
            outcome={change.outcome}
            pending={change.outcome.kind === 'approval' && editing.review.pendingId === change.outcome.artifactId}
            machine={props.machineName(environment.controllerMachineId)}
            onOpenReview={editing.review.open}
            copy="setting"
          />
        ) : null}
        <ItemGroup
          testID="project-deployments.environment.permissions"
          title={t('projects.deployments.whoMayDeploy')}
          description={t('projects.deployments.whoMayDeployDescription')}
        >
          {editing ? (
            <DeployersChoice
              mode={mode}
              chosenAvailable={team !== null || environment.deployerMode === 'chosen'}
              disabled={change.running}
              onChoose={(deployerMode) => {
                if (deployerMode === 'chosen') {
                  if (principals.length > 0) void change.press(() => editing.actions.updateEnvironment(environment,
                    { deployerMode, deployerPrincipals: [...principals] }));
                  else setChoosing(true);
                  return;
                }
                setChoosing(false);
                void change.press(() => editing.actions.updateEnvironment(environment, { deployerMode }));
              }}
            />
          ) : (
            <Item
              title={t('projects.deployments.deployers')}
              detail={deployersLabel(environment.deployerMode)}
              mode="info"
            />
          )}
          {mode === 'chosen' && team && accountScope ? (
            <ChosenPeople
              scope={accountScope}
              team={team}
              principals={choosing ? NO_PRINCIPALS : principals}
              editable={editing !== null && !change.running}
              onAdd={(principal) => writePrincipals([...(choosing ? NO_PRINCIPALS : principals), principal])}
              onRemove={(principal) => writePrincipals(principals.filter(item => principalKey(item) !== principalKey(principal)))}
            />
          ) : null}
          <Item
            title={t('projects.deployments.yourAccess')}
            detail={roleLabel(environment.capabilities.role)}
            mode="info"
          />
        </ItemGroup>
        <EnvironmentApprovals environmentId={environment.id} environmentName={props.detail.content.name} />
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
 * Who may deploy: managers, every member, or chosen people. Chosen people are offered where there is someone to
 * choose (a Team's Environment), and stay visible while they are the current setting.
 */
function DeployersChoice(
  props: Readonly<{ mode: DeployerMode; chosenAvailable: boolean; disabled: boolean; onChoose: (mode: DeployerMode) => void }>,
) {
  const options = React.useMemo((): SegmentedChoiceOption<DeployerMode>[] => [
    { id: 'managers', label: deployersLabel('managers') },
    { id: 'members', label: deployersLabel('members') },
    ...(props.chosenAvailable ? [{ id: 'chosen' as const, label: deployersLabel('chosen') }] : []),
  ], [props.chosenAvailable]);
  return (
    <SegmentedChoiceItem
      testID="project-deployments.environment.permissions.deployers"
      testIDPrefix="project-deployments.environment.permissions.deployers"
      title={t('projects.deployments.deployers')}
      options={options}
      value={props.mode}
      disabled={props.disabled}
      onChange={(next) => {
        if (next !== props.mode) props.onChoose(next);
      }}
    />
  );
}

/** The chosen people and Groups, each removable, then the Team's shared people picker to add one. */
function ChosenPeople(
  props: Readonly<{
    scope: ServerAccountScope;
    team: TeamAddress;
    principals: readonly Principal[];
    editable: boolean;
    onAdd: (principal: Principal) => void;
    onRemove: (principal: Principal) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const roster = useTeamMembersRoster({ scope: props.scope, address: props.team, filter: 'all', enabled: props.principals.length > 0 });
  // Names picked in this visit read at once; the roster names the rest, and an unread page reads as a Team member.
  const [picked, setPicked] = React.useState<ReadonlyMap<string, string>>(new Map());
  const names = React.useMemo(() => {
    const map = new Map(picked);
    for (const member of roster.rows) {
      const name = formatAccountDisplayName(member.account);
      if (name) map.set(principalKey({ principalKind: 'account', principalId: member.accountId }), name);
    }
    return map;
  }, [picked, roster.rows]);
  const choose = (chosen: TeamCredentialAudiencePrincipal) => {
    const principal: Principal = chosen.kind === 'member'
      ? { principalKind: 'account', principalId: chosen.accountId }
      : { principalKind: 'teamGroup', principalId: chosen.id };
    if (props.principals.some(item => principalKey(item) === principalKey(principal))) return;
    setPicked(current => new Map(current).set(principalKey(principal), chosen.name));
    props.onAdd(principal);
  };
  const prefix = 'project-deployments.environment.permissions.chosen';
  return (
    <>
      {props.principals.length === 0 ? (
        <Item testID={`${prefix}.empty`} title={t('projects.deployments.editors.chosenEmpty')} mode="info" />
      ) : props.principals.map(principal => {
        const key = principalKey(principal);
        const group = principal.principalKind === 'teamGroup';
        const name = names.get(key) ?? (group ? t('projects.deployments.editors.chosenGroup') : t('projects.deployments.editors.chosenUnknown'));
        return (
          <Item
            key={key}
            testID={`${prefix}.${principal.principalKind}.${principal.principalId}`}
            icon={<Icon name={group ? 'users' : 'user-circle'} size={18} color={theme.colors.text.secondary} />}
            title={name}
            subtitle={group ? t('projects.deployments.editors.chosenGroup') : undefined}
            mode="info"
            rightElement={props.editable ? (
              <IconButton
                testID={`${prefix}.${principal.principalKind}.${principal.principalId}.remove`}
                iconName="x"
                variant="plain"
                accessibilityLabel={`${t('projects.deployments.editors.chosenRemove')} ${name}`}
                onPress={() => props.onRemove(principal)}
              />
            ) : undefined}
          />
        );
      })}
      {props.editable ? (
        <TeamCredentialAudiencePicker
          testID={`${prefix}.add`}
          scope={props.scope}
          address={props.team}
          excludedGroupIds={props.principals.flatMap(item => item.principalKind === 'teamGroup' ? [item.principalId] : [])}
          // The picker excludes members by membership; chosen Accounts are skipped on pick instead.
          excludedMemberIds={[]}
          label={t('projects.deployments.editors.chosenAdd')}
          disabled={!props.editable}
          onChoose={choose}
        />
      ) : null}
    </>
  );
}

/**
 * Approvals (P7 §2): one row per operation, Default | Ask first | Allowed for agents in this Environment, through the
 * shared scoped approval row and `actions.policy.set`. Approvals are each person's own Account preference, so the
 * description says a deployer can change theirs; an Allowed permission change reads the one shared warning (R23).
 */
function EnvironmentApprovals(props: Readonly<{ environmentId: string; environmentName: string }>) {
  const rawSettings = useSetting('actionsSettingsV1');
  const settings = React.useMemo(() => normalizeActionsSettings(rawSettings), [rawSettings]);
  const writePolicy = useActionPolicyWriter();
  const scope = React.useMemo(() => ({ kind: 'environment' as const, environmentId: props.environmentId }), [props.environmentId]);
  const prefix = 'project-deployments.environment.permissions.approvals';
  const rows = React.useMemo(() => ENVIRONMENT_APPROVAL_ACTION_IDS.map((actionId) => {
    const state = resolveActionSettingsTargetControlState({ settings, scope, actionId, targetId: AUDIENCE });
    const value: ActionScopedApprovalMode = state.kind === 'approval' && (state.value === 'ask_first' || state.value === 'allowed')
      ? state.value : 'default';
    return {
      actionId,
      value,
      // An Action that always asks (irreversible) has no choice to offer here.
      fixed: state.kind === 'approval' && !state.approvalWaivable,
      notice: state.kind === 'approval' && value === 'allowed' ? state.approvalLooseningNotice : undefined,
    };
  }), [scope, settings]);
  return (
    <ItemGroup
      testID={prefix}
      title={t('projects.deployments.editors.approvalsTitle')}
      description={t('projects.deployments.editors.approvalsDescription')}
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
          title={resolveActionTitle(row.actionId, getActionSpec(row.actionId))}
          value={row.fixed ? 'ask_first' : row.value}
          disabled={row.fixed}
          onChange={(mode) => { void writePolicy({ actionId: row.actionId, audience: AUDIENCE, scope, mode }); }}
        />
      ))}
    </ItemGroup>
  );
}

function deployersLabel(mode: DeployerMode): string {
  switch (mode) {
    case 'managers':
      return t('projects.deployments.deployersManagers');
    case 'members':
      return t('projects.deployments.deployersMembers');
    case 'chosen':
      return t('projects.deployments.deployersChosen');
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
