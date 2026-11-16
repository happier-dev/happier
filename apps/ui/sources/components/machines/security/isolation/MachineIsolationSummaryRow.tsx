import * as React from 'react';

import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';

import { useMachineIsolationSummary } from './useMachineIsolationSummary';

/**
 * "Where work runs" (lab machine-sandboxes-1115, scene 1 tab): one navigation row whose value is the policy sentence,
 * shown on Security and on Overview. It opens the Isolation page.
 */
export const MachineIsolationSummaryRow = React.memo(function MachineIsolationSummaryRow(props: Readonly<{
    serverId: string;
    machine: Machine;
    machineName: string;
    onOpen: () => void;
    testID?: string;
}>) {
    const summary = useMachineIsolationSummary(props);
    return (
        <ItemGroup title={t('machineDetailPage.isolation.whereTitle')}>
            <Item testID={props.testID ?? 'machine-isolation-summary-row'} title={t('machineDetailPage.isolation.title')}
                subtitle={summary ? summary.join(' ') : undefined} icon={<Icon name="cube" />} showChevron onPress={props.onOpen} />
        </ItemGroup>
    );
});
