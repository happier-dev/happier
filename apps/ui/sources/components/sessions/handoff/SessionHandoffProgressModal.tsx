import * as React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { SessionHandoffStatus } from '@happier-dev/protocol';

import type { CustomModalInjectedProps } from '@/modal';
import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { formatByteSize } from '@/utils/files/formatByteSize';

type Props = CustomModalInjectedProps & Readonly<{
    title?: string;
    message?: string;
    status?: SessionHandoffStatus;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: theme.colors.surface,
        borderRadius: 14,
        width: 420,
        maxWidth: '92%',
        overflow: 'hidden',
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 4,
        elevation: 5,
    },
    header: {
        paddingHorizontal: 16,
        paddingTop: 16,
        paddingBottom: 10,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    title: {
        fontSize: 17,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    body: {
        paddingHorizontal: 16,
        paddingVertical: 18,
        gap: 14,
    },
    messageRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
    },
    message: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        ...Typography.default(),
        flex: 1,
    },
    progressSection: {
        gap: 10,
    },
    summaryRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    summaryChip: {
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
    },
    summaryChipText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    progressTrack: {
        height: 8,
        borderRadius: 999,
        backgroundColor: theme.colors.divider,
        overflow: 'hidden',
    },
    progressFill: {
        height: '100%',
        borderRadius: 999,
        backgroundColor: theme.colors.accent.blue,
        minWidth: 6,
    },
    progressMetaRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
    },
    progressMetaText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    currentPath: {
        fontSize: 12,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
        flex: 1,
        textAlign: 'right',
    },
}));

function computeProgressFraction(status: SessionHandoffStatus | undefined): number | null {
    const progress = status?.progress;
    if (!progress) {
        return null;
    }
    if (
        typeof progress.planned.totalBytes === 'number'
        && progress.planned.totalBytes > 0
        && typeof progress.transferred.bytes === 'number'
    ) {
        return Math.max(0, Math.min(1, progress.transferred.bytes / progress.planned.totalBytes));
    }
    if (
        typeof progress.planned.totalFiles === 'number'
        && progress.planned.totalFiles > 0
        && typeof progress.transferred.files === 'number'
    ) {
        return Math.max(0, Math.min(1, progress.transferred.files / progress.planned.totalFiles));
    }
    return null;
}

function buildSummaryChips(status: SessionHandoffStatus | undefined): readonly string[] {
    const summary = status?.workspacePreflightSummary;
    if (!summary) {
        return [];
    }

    const chips = [
        `+${summary.addedPathsCount}`,
        `~${summary.changedPathsCount}`,
        `-${summary.removedPathsCount}`,
    ];
    if (typeof summary.totalBytes === 'number' && summary.totalBytes > 0) {
        chips.push(formatByteSize(summary.totalBytes));
    }
    return chips;
}

export function SessionHandoffProgressModal({ onClose, title, message, status }: Props) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const progressFraction = computeProgressFraction(status);
    const summaryChips = buildSummaryChips(status);
    const progressLabel = progressFraction === null ? null : `${Math.round(progressFraction * 100)}%`;
    const currentPath = status?.progress?.current?.relativePath ?? null;

    return (
        <View testID="session-handoff-progress-modal" style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.title}>{title ?? t('sessionHandoff.progress.title')}</Text>
                <Pressable
                    onPress={onClose}
                    hitSlop={10}
                    style={({ pressed }) => ({ padding: 2, opacity: pressed ? 0.7 : 1 })}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.close')}
                >
                    <Octicons name="x" size={18} color={theme.colors.header.tint} />
                </Pressable>
            </View>
            <View style={styles.body}>
                <View style={styles.messageRow}>
                    <ActivityIndicator size="small" color={theme.colors.accent.blue} />
                    <Text style={styles.message}>{message ?? t('sessionHandoff.progress.message')}</Text>
                </View>
                {status ? (
                    <View style={styles.progressSection}>
                        {summaryChips.length > 0 ? (
                            <View testID="session-handoff-progress-summary" style={styles.summaryRow}>
                                {summaryChips.map((chip) => (
                                    <View key={chip} style={styles.summaryChip}>
                                        <Text style={styles.summaryChipText}>{chip}</Text>
                                    </View>
                                ))}
                            </View>
                        ) : null}
                        {progressFraction !== null ? (
                            <View testID="session-handoff-progress-bar" style={styles.progressTrack}>
                                <View style={[styles.progressFill, { width: `${Math.max(progressFraction * 100, 4)}%` }]} />
                            </View>
                        ) : null}
                        {progressLabel || currentPath ? (
                            <View style={styles.progressMetaRow}>
                                <Text testID="session-handoff-progress-percent" style={styles.progressMetaText}>{progressLabel ?? ''}</Text>
                                {currentPath ? <Text testID="session-handoff-progress-path" style={styles.currentPath}>{currentPath}</Text> : null}
                            </View>
                        ) : null}
                    </View>
                ) : null}
            </View>
        </View>
    );
}

export default SessionHandoffProgressModal;
