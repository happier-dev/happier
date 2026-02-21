import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { DelegateOutputV1 } from '@happier-dev/protocol';
import { Text } from '@/components/ui/text/Text';


export function DelegateOutputMessageCard(props: Readonly<{ payload: DelegateOutputV1 }>) {
    const deliverables = props.payload.deliverables ?? [];

    return (
        <View style={styles.container}>
            <Text style={styles.headerText}>Delegation</Text>
            <Text style={styles.summaryText}>{props.payload.summary}</Text>

            {deliverables.length > 0 ? (
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>Deliverables</Text>
                    {deliverables.slice(0, 30).map((d) => (
                        <View key={d.id} style={styles.deliverableRow}>
                            <Text style={styles.deliverableTitle}>{d.title}</Text>
                            {d.details ? <Text style={styles.deliverableDetails}>{d.details}</Text> : null}
                        </View>
                    ))}
                </View>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        padding: 12,
        borderRadius: 10,
        backgroundColor: theme.colors.surfaceHighest,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        gap: 10,
    },
    headerText: {
        color: theme.colors.text,
        fontSize: 15,
        fontWeight: '600',
    },
    summaryText: {
        color: theme.colors.textSecondary,
        fontSize: 13,
    },
    section: {
        gap: 10,
        paddingTop: 8,
        borderTopWidth: 1,
        borderTopColor: theme.colors.divider,
    },
    sectionTitle: {
        color: theme.colors.text,
        fontSize: 13,
        fontWeight: '600',
    },
    deliverableRow: {
        gap: 4,
    },
    deliverableTitle: {
        color: theme.colors.text,
        fontSize: 13,
        fontWeight: '600',
    },
    deliverableDetails: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        fontFamily: 'Menlo',
    },
}));

