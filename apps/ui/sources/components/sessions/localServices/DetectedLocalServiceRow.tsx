import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/Text';
import type { LocalServiceInventoryRow } from '@/sync/domains/local/services/inventory/store';
import type { ManagedLocalServiceRow as ManagedLocalServiceStoreRow } from '@/sync/domains/local/services/managed/store';

import { LocalServiceFactList } from './LocalServiceFactList';
import { ManagedLocalServiceStatus } from './ManagedLocalServiceStatus';
import {
    resolveInventoryStatusLabel,
    resolveLocalServiceFactLines,
    resolveLocalServiceTitle,
} from './presentation';

const stylesheet = StyleSheet.create((theme) => ({
    pill: {
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
    },
    text: {
        color: theme.colors.text.secondary,
        fontWeight: '700',
    },
    right: {
        alignItems: 'flex-end',
        gap: 6,
    },
}));

function InventoryStatus(props: Readonly<{
    state: LocalServiceInventoryRow['state'];
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    return (
        <View testID={`${props.testID}-status-${props.state}`} style={styles.pill}>
            <Text style={styles.text}>{resolveInventoryStatusLabel(props.state)}</Text>
        </View>
    );
}

export function DetectedLocalServiceRow(props: Readonly<{
    row: LocalServiceInventoryRow;
    managed?: ManagedLocalServiceStoreRow | null;
    testID: string;
}>): React.ReactElement {
    const facts = React.useMemo(() => resolveLocalServiceFactLines(props.row), [props.row]);
    const title = React.useMemo(() => resolveLocalServiceTitle(props.row), [props.row]);
    const styles = stylesheet;

    return (
        <Item
            testID={props.testID}
            title={title}
            subtitle={<LocalServiceFactList lines={facts} testID={`${props.testID}-facts`} />}
            subtitleLines={0}
            mode="info"
            showChevron={false}
            rightElement={(
                <View style={styles.right}>
                    <InventoryStatus state={props.row.state} testID={props.testID} />
                    {props.managed ? <ManagedLocalServiceStatus phase={props.managed.phase} testID={`${props.testID}-managed`} /> : null}
                </View>
            )}
        />
    );
}
