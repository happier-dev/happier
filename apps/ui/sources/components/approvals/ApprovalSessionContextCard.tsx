import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { getSessionName, getSessionSubtitle } from '@/utils/sessions/sessionUtils';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { SessionContextChips } from '@/components/sessions/context/SessionContextChips';

export const ApprovalSessionContextCard = React.memo(function ApprovalSessionContextCard(props: Readonly<{
    session: Session | null;
    machine: Machine | null;
    requesterAgentId: string | null;
    requesterSurface: string;
}>) {
    const router = useRouter();
    const { theme } = useUnistyles();
    const sessionTitle = props.session ? getSessionName(props.session) : null;
    const pathLabel = props.session?.metadata?.path ? getSessionSubtitle(props.session) : null;
    const machineLabel = getMachineDisplayName(props.machine);

    if (!sessionTitle && !pathLabel && !machineLabel && !props.requesterAgentId && !props.requesterSurface) {
        return null;
    }

    return (
        <View style={styles.card}>
            <View style={styles.headerRow}>
                <View style={styles.titleColumn}>
                    {sessionTitle ? <Text style={styles.title}>{sessionTitle}</Text> : null}
                    <View style={styles.contextChips}>
                        <SessionContextChips machineLabel={machineLabel} pathLabel={pathLabel} />
                    </View>
                </View>

                {props.session?.id ? (
                    <Pressable
                        testID="approvals.open-session"
                        accessibilityRole="button"
                        accessibilityLabel={t('runs.openSession')}
                        onPress={() => router.push(`/session/${props.session!.id}`)}
                        style={({ pressed }) => [styles.openButton, pressed && styles.openButtonPressed]}
                    >
                        <Ionicons name="open-outline" size={16} color={theme.colors.text} />
                    </Pressable>
                ) : null}
            </View>

            <View style={styles.requesterRow}>
                {props.requesterAgentId ? (
                    <View style={styles.requesterChip}>
                        <Ionicons name="sparkles-outline" size={12} color={theme.colors.textSecondary} />
                        <Text style={styles.metaText}>{props.requesterAgentId}</Text>
                    </View>
                ) : null}
                <View style={styles.requesterChip}>
                    <Ionicons name="git-branch-outline" size={12} color={theme.colors.textSecondary} />
                    <Text style={styles.metaText}>{props.requesterSurface}</Text>
                </View>
            </View>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    card: {
        borderRadius: 16,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHighest,
        padding: 16,
        gap: 12,
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
    },
    titleColumn: {
        flex: 1,
        minWidth: 0,
    },
    title: {
        fontSize: 16,
        fontWeight: '700',
        color: theme.colors.text,
    },
    contextChips: {
        marginTop: 8,
    },
    metaText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        lineHeight: 18,
    },
    openButton: {
        width: 32,
        height: 32,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    openButtonPressed: {
        backgroundColor: theme.colors.surfacePressedOverlay,
    },
    requesterRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    requesterChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
}));
