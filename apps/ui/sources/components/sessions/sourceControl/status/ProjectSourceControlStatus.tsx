import { Typography } from '@/constants/Typography';
import React from 'react';
import { View } from 'react-native';
import { useSessionProjectScmSummarySnapshot } from '@/sync/domains/state/storage';
import { StyleSheet } from 'react-native-unistyles';
import { buildSessionScmSummary } from './statusSummary';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

const LINE_ADDED_PREFIX = '+';
const LINE_REMOVED_PREFIX = '-';


const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
        maxWidth: 150,
    },
    branchContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 1,
        minWidth: 0,
    },
    branchIcon: {
        marginRight: theme.space.s4,
        flexShrink: 0,
    },
    branchText: {
        ...Typography.variant('body', 'medium'),
        color: theme.colors.text.secondary,
        flexShrink: 1,
        minWidth: 0,
    },
    changesContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        marginLeft: theme.space.s6,
        flexShrink: 0,
    },
    filesText: {
        ...Typography.variant('micro', 'medium'),
        color: theme.colors.text.secondary,
        marginRight: theme.space.s4,
    },
    lineChanges: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s2,
    },
    addedText: {
        ...Typography.variant('micro', 'semiBold'),
        color: theme.colors.versionControl.added.foreground,
    },
    removedText: {
        ...Typography.variant('micro', 'semiBold'),
        color: theme.colors.versionControl.removed.foreground,
    },
}));

interface ProjectSourceControlStatusProps {
    /** Any session ID from the project (used to find the project source-control status) */
    sessionId: string;
}

export function ProjectSourceControlStatus({ sessionId }: ProjectSourceControlStatusProps) {
    const styles = stylesheet;
    const snapshot = useSessionProjectScmSummarySnapshot(sessionId);
    const scmStatusSummary = buildSessionScmSummary(snapshot);

    if (!scmStatusSummary) {
        return null;
    }

    const hasLineChanges = scmStatusSummary.isComplete !== false && scmStatusSummary.hasLineChanges;
    const changedFilesLabel = t('files.sourceControlStatus.changedFilesLabel', { count: scmStatusSummary.changedFiles });

    return (
        <View style={styles.container}>
            {!hasLineChanges && scmStatusSummary.hasAnyChanges && (
                <Text style={styles.filesText}>{changedFilesLabel}</Text>
            )}
            {hasLineChanges && (
                <View style={styles.lineChanges}>
                    {scmStatusSummary.linesAdded > 0 && (
                        <Text style={styles.addedText}>
                            {`${LINE_ADDED_PREFIX}${scmStatusSummary.linesAdded}`}
                        </Text>
                    )}
                    {scmStatusSummary.linesRemoved > 0 && (
                        <Text style={styles.removedText}>
                            {`${LINE_REMOVED_PREFIX}${scmStatusSummary.linesRemoved}`}
                        </Text>
                    )}
                </View>
            )}
        </View>
    );
}
