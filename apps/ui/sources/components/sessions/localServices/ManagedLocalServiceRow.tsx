import * as React from 'react';

import { Item } from '@/components/ui/lists/Item';
import type { ManagedLocalServiceRow as ManagedLocalServiceStoreRow } from '@/sync/domains/local/services/managed/store';

import { LocalServiceFactList } from './LocalServiceFactList';
import { ManagedLocalServiceStatus } from './ManagedLocalServiceStatus';
import { resolveManagedFactLines } from './presentation';

export function ManagedLocalServiceRow(props: Readonly<{
    row: ManagedLocalServiceStoreRow;
    testID: string;
}>): React.ReactElement {
    const facts = React.useMemo(() => resolveManagedFactLines(props.row), [props.row]);
    const title = props.row.ownerLabel ?? props.row.routeName ?? props.row.url ?? props.row.id;

    return (
        <Item
            testID={props.testID}
            title={title}
            subtitle={<LocalServiceFactList lines={facts} testID={`${props.testID}-facts`} />}
            subtitleLines={0}
            mode="info"
            showChevron={false}
            rightElement={<ManagedLocalServiceStatus phase={props.row.phase} testID={props.testID} />}
        />
    );
}
