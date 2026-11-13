import * as React from 'react';
import type { DeploymentEnvironmentCreationReviewV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';

import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { SessionMachineField } from '@/components/sessions/new/placement/SessionPlacementChips';
import { DeploymentExtraDefaultsRows } from './DeploymentExtraDefaultsRows';
import { DeploymentCreationDefaultsV1Schema, type DeploymentCreationDefaultsV1 } from '@happier-dev/protocol/projects/deploymentCreationDefaultsV1';

type CreationDefaults =
  DeploymentEnvironmentCreationReviewV1['creationDefaults'];
type DefaultSource = NonNullable<
  CreationDefaults['sources']['controllerMachineId']
>;

/** DK.defaultSections: the same preference rows on Account and Project pages. */
export function renderDeploymentDefaultsEditorRows(props: Readonly<{
  serverId: string;
  preferences: DeploymentCreationDefaultsV1;
  resolved: CreationDefaults;
  inheritLabel: string;
  disabled: boolean;
  onChange: React.Dispatch<React.SetStateAction<DeploymentCreationDefaultsV1>>;
}>) {
  function change<K extends keyof DeploymentCreationDefaultsV1>(key: K, value: DeploymentCreationDefaultsV1[K]) {
    props.onChange(current => {
      const next = { ...current };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });
  }
  return <>
    <SessionMachineField testID="deployment-defaults.builder" serverId={props.serverId}
      title={t('projects.deployments.buildsOn')} machineId={props.preferences.buildMachineId ?? null}
      machineName={props.resolved.values.buildMachineId ?? t('projects.deployments.buildsOnTarget')}
      subtitle={sourceWord(props.resolved.sources.buildMachineId ?? 'builtin')}
      defaultChoice={{ title: props.inheritLabel, onChoose: () => change('buildMachineId', undefined) }}
      awayMachinesChoosable disabled={props.disabled} onSelectMachine={machine => change('buildMachineId', machine.id)} />
    <SessionMachineField testID="deployment-defaults.controller" serverId={props.serverId}
      title={t('projects.deployments.controllerRow')} machineId={props.preferences.controllerMachineId ?? null}
      machineName={props.resolved.values.controllerMachineId ?? t('projects.deployments.buildsOnTarget')}
      subtitle={sourceWord(props.resolved.sources.controllerMachineId ?? 'builtin')}
      defaultChoice={{ title: props.inheritLabel, onChoose: () => change('controllerMachineId', undefined) }}
      awayMachinesChoosable disabled={props.disabled} onSelectMachine={machine => change('controllerMachineId', machine.id)} />
    <FieldValueItem testID="deployment-defaults.retention" fieldTestID="deployment-defaults.retention.input"
      title={t('projects.deployments.defaultsEditor.retention')}
      subtitle={`${sourceWord(props.resolved.sources.retainPreviousDeployments)} · ${t('projects.deployments.defaultsEditor.clearToInherit')}`}
      kind="integer" allowEmpty disabled={props.disabled}
      value={props.preferences.retainPreviousDeployments?.toString() ?? ''}
      placeholder={String(props.resolved.values.retainPreviousDeployments)}
      stepper={{ min: 0, max: Number.MAX_SAFE_INTEGER, step: 1 }}
      compactStepper
      onCommit={draft => {
        if (props.disabled) return props.preferences.retainPreviousDeployments?.toString() ?? '';
        const value = draft.trim() === '' ? undefined : Number(draft);
        const parsed = DeploymentCreationDefaultsV1Schema.safeParse({ ...props.preferences, retainPreviousDeployments: value });
        if (!parsed.success) return props.preferences.retainPreviousDeployments?.toString() ?? '';
        change('retainPreviousDeployments', value);
        return value?.toString() ?? '';
      }} />
    <DeploymentExtraDefaultsRows {...props} sourceLabel={sourceWord} />
  </>;
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
  }>,
): React.ReactElement {
  const { values, sources } = props.defaults;
  return (
    <>
      {values.buildMachineId && sources.buildMachineId !== 'explicit' ? (
        <Item
          testID={`${props.testID}.builder`}
          mode="info"
          title={t('projects.deployments.creationReview.buildsOn', {
            machine: props.machineName(values.buildMachineId),
          })}
          subtitle={sourceWord(sources.buildMachineId)}
        />
      ) : null}
      {values.controllerMachineId && sources.controllerMachineId !== 'explicit' ? (
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
