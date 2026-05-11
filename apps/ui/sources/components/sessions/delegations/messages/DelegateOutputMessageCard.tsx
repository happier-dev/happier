import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { DelegateOutputV1 } from '@happier-dev/protocol';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';


export function DelegateOutputMessageCard(props: Readonly<{ payload: DelegateOutputV1 }>) {
    const deliverables = props.payload.deliverables ?? [];

    return (
        <View style={styles.container}>
            <Text selectable style={styles.headerText}>{t('delegation.output.title')}</Text>
            <Text selectable style={styles.summaryText}>{props.payload.summary}</Text>

            {deliverables.length > 0 ? (
                <View style={styles.section}>
                    <Text selectable style={styles.sectionTitle}>{t('delegation.output.deliverablesTitle')}</Text>
                    {deliverables.slice(0, 30).map((d) => (
                        <View key={d.id} style={styles.deliverableRow}>
                            <Text selectable style={styles.deliverableTitle}>{d.title}</Text>
                            {d.details ? <Text selectable style={styles.deliverableDetails}>{d.details}</Text> : null}
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
        backgroundColor: theme.colors.surface.elevated,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        gap: 10,
    },
    headerText: {
        color: theme.colors.text.primary,
        fontSize: 15,
        fontWeight: '600',
    },
    summaryText: {
        color: theme.colors.text.secondary,
        fontSize: 13,
    },
    section: {
        gap: 10,
        paddingTop: 8,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.default,
    },
    sectionTitle: {
        color: theme.colors.text.primary,
        fontSize: 13,
        fontWeight: '600',
    },
    deliverableRow: {
        gap: 4,
    },
    deliverableTitle: {
        color: theme.colors.text.primary,
        fontSize: 13,
        fontWeight: '600',
    },
    deliverableDetails: {
        color: theme.colors.text.secondary,
        fontSize: 12,
        fontFamily: 'Menlo',
    },
}));
