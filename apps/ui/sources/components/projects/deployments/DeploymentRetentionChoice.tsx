import * as React from 'react';

import { describeRetention } from '@/components/settings/machines/managed/managedRetentionPresentation';
import { useManagedMachineInventory } from '@/components/settings/machines/managed/useManagedMachineInventory';
import {
  SegmentedChoiceItem,
  type SegmentedChoiceOption,
} from '@/components/ui/lists/SegmentedChoiceItem';
import { t } from '@/text';

/** `alwaysOn` is the target-enable offer (sent as omission, reviewed as an included step); `keep` declines it. */
export type DeploymentRetentionChoiceValue = 'alwaysOn' | 'keep';

/** The `managedRetention` operand a choice sends: only declining the offer needs saying. */
export function deploymentManagedRetention(
  value: DeploymentRetentionChoiceValue,
): Readonly<{ managedRetention?: 'keep' }> {
  return value === 'keep' ? { managedRetention: 'keep' } : {};
}

/**
 * "Keeps running: Always on | Current rule" for the Machine a deploy targets (P41-R31). Shown only when that
 * Machine is a managed allocation with a finite rule, read from the allocation itself by enrolled id; an
 * unmanaged or already always-on Machine has nothing to choose, so the row is absent.
 */
export const DeploymentRetentionChoice = React.memo(
  function DeploymentRetentionChoice(
    props: Readonly<{
      serverId: string | null;
      machineId: string | null;
      value: DeploymentRetentionChoiceValue;
      onChange: (value: DeploymentRetentionChoiceValue) => void;
      testID: string;
    }>,
  ) {
    const { serverId, machineId } = props;
    const managed = useManagedMachineInventory(
      serverId && machineId ? [serverId] : [],
      undefined,
      undefined,
      false,
      machineId ?? undefined,
    );
    const row =
      serverId && machineId
        ? managed.machinesByServerId[serverId]?.find(
            (machine) =>
              machine.enrolledMachineId === machineId &&
              machine.archivedAt === undefined,
          )
        : undefined;
    const policy =
      row && row.retention.kind !== 'until-delete'
        ? describeRetention(row.retention)
        : null;
    const options = React.useMemo(
      (): ReadonlyArray<
        SegmentedChoiceOption<DeploymentRetentionChoiceValue>
      > =>
        policy === null
          ? []
          : [
              {
                id: 'alwaysOn',
                label: t('projects.deployments.retentionAlwaysOn'),
                description: t('projects.deployments.retentionAlwaysOnBody'),
              },
              {
                id: 'keep',
                label: t('projects.deployments.retentionCurrentRule'),
                description: t(
                  'projects.deployments.retentionCurrentRuleBody',
                  { policy },
                ),
              },
            ],
      [policy],
    );
    if (policy === null) return null;
    return (
      <SegmentedChoiceItem<DeploymentRetentionChoiceValue>
        testID={props.testID}
        testIDPrefix={props.testID}
        title={t('projects.deployments.retentionTitle')}
        options={options}
        value={props.value}
        onChange={props.onChange}
      />
    );
  },
);
