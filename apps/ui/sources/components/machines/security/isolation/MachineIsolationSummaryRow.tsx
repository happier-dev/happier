import * as React from 'react';

import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';

import { useMachineIsolationSummary } from './useMachineIsolationSummary';

type MachineIsolationSummaryProps = Readonly<{
    serverId: string;
    machine: Machine;
    machineName: string;
    onOpen: () => void;
    testID?: string;
}>;

/**
 * The Isolation navigation row (lab machine-sandboxes-1115, scene 1 tab): its value is the policy sentence, and it
 * opens the Isolation page. Overview places it among This machine's rows; Security gives it its own section.
 */
export const MachineIsolationSummaryItem = React.memo(function MachineIsolationSummaryItem(props: MachineIsolationSummaryProps) {
    const summary = useMachineIsolationSummary(props);
    return (
        <Item testID={props.testID ?? 'machine-isolation-summary-row'} title={t('machineDetailPage.isolation.title')}
            subtitle={summary ? summary.join(' ') : undefined} icon={<Icon name="cube" />} showChevron onPress={props.onOpen} />
    );
});

/** Security's "Where sessions run" section: the Isolation row alone. */
export const MachineIsolationSummaryRow = React.memo(function MachineIsolationSummaryRow(props: MachineIsolationSummaryProps) {
    return (
        <ItemGroup title={t('machineDetailPage.isolation.whereTitle')}>
            <MachineIsolationSummaryItem {...props} />
        </ItemGroup>
    );
});
