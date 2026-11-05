import * as React from 'react';
import type { DeploymentEnvironmentCreationReviewV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';

type CreationDefaults =
  DeploymentEnvironmentCreationReviewV1['creationDefaults'];
type DefaultSource = NonNullable<
  CreationDefaults['sources']['controllerMachineId']
>;

function sourceWord(from: DefaultSource | undefined): string | undefined {
  if (from === undefined) return undefined;
  if (from === 'explicit')
    return t('projects.deployments.creationReview.fromExplicit');
  if (from === 'project')
    return t('projects.deployments.creationReview.fromProject');
  if (from === 'account')
    return t('projects.deployments.creationReview.fromAccount');
  return t('projects.deployments.creationReview.fromBuiltin');
}

/**
 * What a new Environment takes from the creation defaults, one row per value, each saying where it came from
 * (the canonical resolver's sources). Called inside the caller's `ItemGroup`: the rows come back as a fragment,
 * which the group flattens, so they take its hairlines and row positions like its other rows.
 */
export function renderDeploymentCreationDefaultsRows(
  props: Readonly<{
    defaults: CreationDefaults;
    machineName: (machineId: string) => string;
    iconColor: string;
    testID: string;
  }>,
): React.ReactElement {
  const { values, sources } = props.defaults;
  const icon = (name: 'hammer' | 'rocket' | 'clock-counter-clockwise') => (
    <Icon name={name} size={ICON_SIZE.md} color={props.iconColor} />
  );
  return (
    <>
      {values.buildMachineId ? (
        <Item
          testID={`${props.testID}.builder`}
          mode="info"
          icon={icon('hammer')}
          title={t('projects.deployments.creationReview.buildsOn', {
            machine: props.machineName(values.buildMachineId),
          })}
          subtitle={sourceWord(sources.buildMachineId)}
        />
      ) : null}
      {values.controllerMachineId ? (
        <Item
          testID={`${props.testID}.controller`}
          mode="info"
          icon={icon('rocket')}
          title={t('projects.deployments.creationReview.deploysFrom', {
            machine: props.machineName(values.controllerMachineId),
          })}
          subtitle={sourceWord(sources.controllerMachineId)}
        />
      ) : null}
      <Item
        testID={`${props.testID}.retention`}
        mode="info"
        icon={icon('clock-counter-clockwise')}
        title={t('projects.deployments.creationReview.keepsPrevious', {
          count: values.retainPreviousDeployments,
        })}
        subtitle={sourceWord(sources.retainPreviousDeployments)}
      />
    </>
  );
}
