import * as React from 'react';
import type { DeploymentEnvironmentCreationReviewV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';

import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';
import { DeploymentDefaultsEditorSections } from './DeploymentExtraDefaultsRows';
import type { DeploymentCreationDefaultsV1 } from '@happier-dev/protocol/projects/deploymentCreationDefaultsV1';

type CreationDefaults =
  DeploymentEnvironmentCreationReviewV1['creationDefaults'];
type DefaultSource = NonNullable<
  CreationDefaults['sources']['controllerMachineId']
>;

/** DK.defaultSections: the same preference sections on Account and Project pages (DeploymentDefaultsEditorSections). */
export function renderDeploymentDefaultsEditorRows(props: Readonly<{
  serverId: string;
  preferences: DeploymentCreationDefaultsV1;
  resolved: CreationDefaults;
  inheritLabel: string;
  resetLabel: string;
  disabled: boolean;
  onChange: React.Dispatch<React.SetStateAction<DeploymentCreationDefaultsV1>>;
}>) {
  return <DeploymentDefaultsEditorSections {...props} sourceLabel={sourceWord} />;
}

export function sourceWord(from: DefaultSource | undefined): string | undefined {
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
 * (the canonical resolver's sources). A Machine the person just chose above is not repeated back to them. Called inside the caller's `ItemGroup`: the rows come back as a fragment,
 * which the group flattens, so they take its hairlines and row positions like its other rows.
 */
export function renderDeploymentCreationDefaultsRows(
  props: Readonly<{
    defaults: CreationDefaults;
    machineName: (machineId: string) => string;
    testID: string;
    /** A Machine a row above already names (the Review's runs row): its builder and controller rows are not said again. */
    namedMachineId?: string | null;
  }>,
): React.ReactElement {
  const { values, sources } = props.defaults;
  const said = (machineId: string | undefined, source: DefaultSource | undefined) =>
    source === 'explicit' || (machineId !== undefined && machineId === props.namedMachineId);
  return (
    <>
      {values.buildMachineId && !said(values.buildMachineId, sources.buildMachineId) ? (
        <Item
          testID={`${props.testID}.builder`}
          mode="info"
          title={t('projects.deployments.creationReview.buildsOn', {
            machine: props.machineName(values.buildMachineId),
          })}
          subtitle={sourceWord(sources.buildMachineId)}
        />
      ) : null}
      {values.controllerMachineId && !said(values.controllerMachineId, sources.controllerMachineId) ? (
        <Item
          testID={`${props.testID}.controller`}
          mode="info"
          title={t('projects.deployments.creationReview.deploysFrom', {
            machine: props.machineName(values.controllerMachineId),
          })}
          subtitle={sourceWord(sources.controllerMachineId)}
        />
      ) : null}
      <Item
        testID={`${props.testID}.retention`}
        mode="info"
        title={t('projects.deployments.creationReview.keepsPrevious', {
          count: values.retainPreviousDeployments,
        })}
        subtitle={sourceWord(sources.retainPreviousDeployments)}
      />
    </>
  );
}
