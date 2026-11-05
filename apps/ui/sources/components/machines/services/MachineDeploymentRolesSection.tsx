import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { ICON_SIZE, Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { t } from '@/text';

import { MACHINE_DEPLOYMENT_ROLES, machineDeploymentRoleSummary } from './machineServicesPresentation';
import type { MachineDeploymentRoleEnvironment } from './useMachineServiceEnvironments';

/**
 * Environments whose exact references name a job for this Machine beyond running its services, in the role vocabulary
 * the Machine header's role facts use (`MACHINE_DEPLOYMENT_ROLES`); the services it runs are the groups above. Roles
 * come only from the canonical reference census, never from service names.
 */
export function machineDeploymentRoleRows<T extends MachineDeploymentRoleEnvironment>(environments: readonly T[]): readonly T[] {
  const serving = new Set(machineDeploymentRoleSummary(environments).flatMap((entry) => entry.environments));
  return environments.filter((environment) => serving.has(environment));
}

export function MachineDeploymentRolesSection(
  props: Readonly<{
    serverId: string;
    machineName: string;
    environments: readonly MachineDeploymentRoleEnvironment[];
    status: 'loading' | 'ready' | 'unavailable';
    sourceNames: ReadonlyMap<string, string>;
    onRetry: () => void;
    /**
     * `section` (the default): the titled section listing every Environment, for a Machine that runs no service here
     * (lab `services/empty`). `summary`: beside listed services the section is one row saying what the Machine does
     * and for how many Environments, opening `onOpenAll` (the list on its own page). `page`: that page's list, whose
     * title and sentence its page head already says.
     */
    presentation?: 'section' | 'summary' | 'page';
    onOpenAll?: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const rows = React.useMemo(
    () => machineDeploymentRoleRows(props.environments),
    [props.environments],
  );
  // Nothing to say while reading, or when the census answered that this Machine has no such job.
  if (rows.length === 0 && props.status !== 'unavailable') return null;
  const presentation = props.presentation ?? 'section';
  const summary = presentation === 'summary' && rows.length > 0 && props.onOpenAll !== undefined;
  // What the Machine does across all of them, each role once, in the header's role vocabulary.
  const summaryTitle = summary ? MACHINE_DEPLOYMENT_ROLES.filter((role) => rows.some((environment) => environment.roles.includes(role)))
    .map((role) => t(`machineServices.roles.role.${role}`)).join(' · ') : '';
  return (
    <ItemGroup
      testID="machine-services-roles"
      {...(presentation === 'page' ? {} : {
        title: t('machineServices.roles.title'),
        description: t('machineServices.roles.description', { machine: props.machineName }),
      })}
    >
      {props.status === 'unavailable' ? (
        <SurfaceFreshnessLine
          testID="machine-services-roles-unavailable"
          tone="warning"
          reason={t('machineServices.roles.unavailable', {
            machine: props.machineName,
          })}
          action={{ label: t('common.retry'), onPress: props.onRetry }}
        />
      ) : null}
      {summary ? (
        <Item
          testID="machine-services-roles-summary"
          icon={<Icon name="rocket" size={ICON_SIZE.md} color={theme.colors.text.secondary} />}
          title={summaryTitle}
          subtitle={t('machineServices.roles.forEnvironments', { count: rows.length })}
          showChevron
          onPress={props.onOpenAll}
        />
      ) : rows.map((environment, index) => {
        const source = props.sourceNames.get(environment.projectSourceId);
        const roles = MACHINE_DEPLOYMENT_ROLES.filter((role) =>
          environment.roles.includes(role),
        )
          .map((role) => t(`machineServices.roles.role.${role}`))
          .join(' · ');
        return (
          <Item
            key={environment.environmentId}
            testID={`machine-services-role:${environment.environmentId}`}
            icon={
              <Icon
                name="rocket"
                size={ICON_SIZE.md}
                color={theme.colors.text.secondary}
              />
            }
            title={
              source ? `${source} · ${environment.title}` : environment.title
            }
            subtitle={roles}
            showDivider={index < rows.length - 1}
          />
        );
      })}
    </ItemGroup>
  );
}
