import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { PlanOutputV1 } from '@happier-dev/protocol';
import { sync } from '@/sync/sync';
import { fireAndForget } from '@/utils/system/fireAndForget';

export function PlanOutputMessageCard(props: Readonly<{ payload: PlanOutputV1; sessionId: string }>) {
    const [error, setError] = React.useState<string | null>(null);
    const [isSending, setIsSending] = React.useState(false);
    const sections = props.payload.sections ?? [];
    const risks = props.payload.risks ?? [];
    const milestones = props.payload.milestones ?? [];

    const handleAdopt = React.useCallback(() => {
        fireAndForget((async () => {
            setError(null);
            setIsSending(true);
            try {
                const wire = {
                    kind: 'plan_output.v1',
                    runRef: props.payload.runRef,
                    summary: props.payload.summary,
                    sections: props.payload.sections,
                    risks: props.payload.risks ?? [],
                    milestones: props.payload.milestones ?? [],
                    recommendedBackendId: props.payload.recommendedBackendId,
                };
                const text = `@happier/plan.adopt\n${JSON.stringify(wire)}`;
                await sync.sendMessage(props.sessionId, text, 'Adopt plan');
            } catch (e) {
                setError(e instanceof Error ? e.message : 'Failed to adopt plan');
            } finally {
                setIsSending(false);
            }
        })(), { tag: 'PlanOutputMessageCard.adoptPlan' });
    }, [props.payload, props.sessionId]);

    return (
        <View style={styles.container}>
            <Text style={styles.headerText}>Plan</Text>
            <Text style={styles.summaryText}>{props.payload.summary}</Text>

            {sections.slice(0, 10).map((section) => (
                <View key={section.title} style={styles.section}>
                    <Text style={styles.sectionTitle}>{section.title}</Text>
                    {section.items.slice(0, 12).map((item, idx) => (
                        <Text key={`${section.title}-${idx}`} style={styles.sectionItem}>
                            {item}
                        </Text>
                    ))}
                </View>
            ))}

            {props.payload.recommendedBackendId ? (
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>Recommended backend</Text>
                    <Text style={styles.sectionItem}>{props.payload.recommendedBackendId}</Text>
                </View>
            ) : null}

            {risks.length > 0 ? (
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>Risks</Text>
                    {risks.slice(0, 12).map((risk, idx) => (
                        <Text key={`risk-${idx}`} style={styles.sectionItem}>
                            {risk}
                        </Text>
                    ))}
                </View>
            ) : null}

            {milestones.length > 0 ? (
                <View style={styles.section}>
                    <Text style={styles.sectionTitle}>Milestones</Text>
                    {milestones.slice(0, 12).map((m, idx) => (
                        <View key={`ms-${idx}`} style={{ gap: 2 }}>
                            <Text style={styles.sectionItem}>{m.title}</Text>
                            {m.details ? <Text style={styles.sectionItem}>{m.details}</Text> : null}
                        </View>
                    ))}
                </View>
            ) : null}

            {error ? <Text style={styles.errorText}>{error}</Text> : null}

            <Pressable
                accessibilityRole="button"
                accessibilityLabel="Adopt plan"
                onPress={handleAdopt}
                disabled={isSending}
                style={[styles.adoptButton, isSending && styles.adoptButtonDisabled]}
            >
                <Text style={styles.adoptButtonText}>{isSending ? 'Sending…' : 'Adopt plan'}</Text>
            </Pressable>
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
        gap: 6,
        paddingTop: 8,
        borderTopWidth: 1,
        borderTopColor: theme.colors.divider,
    },
    sectionTitle: {
        color: theme.colors.text,
        fontSize: 13,
        fontWeight: '600',
    },
    sectionItem: {
        color: theme.colors.textSecondary,
        fontSize: 12,
        fontFamily: 'Menlo',
    },
    adoptButton: {
        marginTop: 2,
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: 10,
        backgroundColor: theme.colors.textLink,
        alignItems: 'center',
    },
    adoptButtonDisabled: {
        opacity: 0.6,
    },
    adoptButtonText: {
        color: '#fff',
        fontSize: 13,
        fontWeight: '600',
    },
    errorText: {
        color: theme.colors.textSecondary,
        fontSize: 12,
    },
}));
