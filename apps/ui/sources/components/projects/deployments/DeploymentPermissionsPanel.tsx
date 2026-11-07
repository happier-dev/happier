import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';

import {
  SegmentedChoiceItem,
  type SegmentedChoiceOption,
} from '@/components/ui/lists/SegmentedChoiceItem';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import { useDeploymentChangePress } from './deploymentActionOutcome';
import { DeployOutcomeBanner } from './DeploymentEnvironmentDetail';
import type { DeploymentEnvironmentEditing } from './DeploymentEnvironmentSettingsPanel';

type DeployerMode = DeploymentEnvironmentReadDetailV1['environment']['deployerMode'];
const noop = () => {};

/**
 * Environment → Permissions (lab d2 `access`): who may deploy, what you can do here, and where its jobs and alerts
 * run. The controller is edited only in Settings → Controller; this row links there (P40-R54).
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
              mode={environment.deployerMode}
              disabled={change.running}
              onChoose={(deployerMode) => {
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
          <Item
            title={t('projects.deployments.yourAccess')}
            detail={roleLabel(environment.capabilities.role)}
            mode="info"
          />
        </ItemGroup>
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
 * Who may deploy: managers or every member, both visible. Chosen people need a people picker this page does not
 * have yet, so that option shows, unchoosable, only while it is the current setting.
 */
function DeployersChoice(
  props: Readonly<{ mode: DeployerMode; disabled: boolean; onChoose: (mode: 'managers' | 'members') => void }>,
) {
  const options = React.useMemo((): SegmentedChoiceOption<DeployerMode>[] => [
    { id: 'managers', label: deployersLabel('managers') },
    { id: 'members', label: deployersLabel('members') },
    ...(props.mode === 'chosen' ? [{ id: 'chosen' as const, label: deployersLabel('chosen'), disabled: true }] : []),
  ], [props.mode]);
  return (
    <SegmentedChoiceItem
      testID="project-deployments.environment.permissions.deployers"
      testIDPrefix="project-deployments.environment.permissions.deployers"
      title={t('projects.deployments.deployers')}
      options={options}
      value={props.mode}
      disabled={props.disabled}
      onChange={(next) => {
        if ((next === 'managers' || next === 'members') && next !== props.mode) props.onChoose(next);
      }}
    />
  );
}

function deployersLabel(
  mode: DeploymentEnvironmentReadDetailV1['environment']['deployerMode'],
): string {
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
