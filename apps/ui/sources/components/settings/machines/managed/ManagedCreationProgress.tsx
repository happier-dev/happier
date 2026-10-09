import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { ManagedMachineStateRow, type ManagedLifecycleHandlers } from './ManagedMachineStateRow';
import { canRetryManagedInstallation, currentManagedCreationOperation, managedCreationState } from './managedCreationPresentation';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { describeActionOperationStatusLabel, resolveActionOperationStatus } from '@/components/inbox/actionOperations/actionOperationPresentation';

/** Only durable allocation/enrollment observations; task stages are supplied by their operation owner. */
export function ManagedCreationProgress(props: Readonly<{ machine: ManagedMachineV1; handlers?: ManagedLifecycleHandlers;
    operation?: ActionOperationProjection | null }>) {
    const { theme } = useUnistyles();
    const { machine } = props;
    const state = managedCreationState(machine);
    const awaitingConnection = !machine.enrolledMachineId || state.kind !== 'resourceReady';
    const operation = currentManagedCreationOperation(machine, props.operation);
    const status = operation ? resolveActionOperationStatus(operation.snapshot, operation.observation) : null;
    return <>
        {operation && status ? <ItemGroup>
            <Item title={machine.launch.name} subtitle={describeActionOperationStatusLabel(status.label)}
                mode="info" showChevron={false} testID="managed-machine.installation"
                subtitleLeading={status.tone === 'active' ? <ActivitySpinner size="small"
                    accessibilityElementsHidden importantForAccessibility="no" /> : undefined}
                rightElement={canRetryManagedInstallation(machine, operation) && props.handlers?.reinstall ?
                    <RoundButton title={t('managedMachines.creation.retryInstall')} display="secondary" size="small"
                        testID="managed-machine.installation-retry" onPress={props.handlers.reinstall} /> : undefined} />
            {operation.snapshot.error ? <SurfaceStateCard kind="error" size="line"
                title={operation.snapshot.error.error} diagnosticCode={operation.snapshot.error.errorCode}
                testID="managed-machine.installation-error" /> : null}
        </ItemGroup> : null}
        {awaitingConnection ? <ItemGroup>
            <ManagedMachineStateRow name={machine.launch.name}
                mark={<Icon name="desktop" color={theme.colors.text.secondary} />}
                state={state} handlers={props.handlers ?? {}}
                ended={machine.allocation === 'confirmed-absent'} testID="managed-machine.progress" />
            {machine.allocation !== 'confirmed-absent' && (machine.allocation === 'may-exist' || machine.cleanup) ? <Item title={t('managedMachines.creation.mayBill')}
                mode="info" showChevron={false} titleLines={0} testID="managed-machine.possible-cost" /> : null}
        </ItemGroup> : null}
        {machine.resource || machine.recovery ? <ItemGroup title={t('managedMachines.detail.recoveryTitle')}>
            <Item title={t('managedMachines.detail.nativeIdentity')} mode="info" showChevron={false}
                testID="managed-machine.recovery" accessoryLayout="stacked" rightElement={
                    <Text selectable style={Typography.mono()}>{machine.recovery?.reference ?? JSON.stringify(machine.resource?.value)}</Text>
                } />
        </ItemGroup> : null}
    </>;
}
