import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import type { ManagedLocalServiceRow as ManagedLocalServiceStoreRow } from '@/sync/domains/local/services/managed/store';

import { resolveManagedStatusLabel } from './presentation';

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
}));

export function ManagedLocalServiceStatus(props: Readonly<{
    phase: ManagedLocalServiceStoreRow['phase'];
    testID: string;
}>): React.ReactElement {
    const styles = stylesheet;
    return (
        <View testID={`${props.testID}-status-${props.phase}`} style={styles.pill}>
            <Text style={styles.text}>{resolveManagedStatusLabel(props.phase)}</Text>
        </View>
    );
}
