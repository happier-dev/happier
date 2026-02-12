import React from 'react';
import { View, Text } from 'react-native';
import { useSessionProjectScmSnapshot } from '@/sync/domains/state/storage';
import { StyleSheet } from 'react-native-unistyles';
import { buildScmStatusSummaryFromSnapshot } from './statusSummary';

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
        marginRight: 4,
        flexShrink: 0,
    },
    branchText: {
        fontSize: 13,
        fontWeight: '500',
        color: theme.colors.groupped.sectionTitle,
        flexShrink: 1,
        minWidth: 0,
    },
    changesContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        marginLeft: 6,
        flexShrink: 0,
    },
    filesText: {
        fontSize: 11,
        fontWeight: '500',
        color: theme.colors.textSecondary,
        marginRight: 4,
    },
    lineChanges: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
    },
    addedText: {
        fontSize: 11,
        fontWeight: '600',
        color: theme.colors.gitAddedText,
    },
    removedText: {
        fontSize: 11,
        fontWeight: '600',
        color: theme.colors.gitRemovedText,
    },
}));

interface ProjectSourceControlStatusProps {
    /** Any session ID from the project (used to find the project source-control status) */
    sessionId: string;
}

export function ProjectSourceControlStatus({ sessionId }: ProjectSourceControlStatusProps) {
    const styles = stylesheet;
    const snapshot = useSessionProjectScmSnapshot(sessionId);
    const scmStatusSummary = buildScmStatusSummaryFromSnapshot(snapshot);

    if (!scmStatusSummary) {
        return null;
    }

    const hasLineChanges = scmStatusSummary.hasLineChanges;
    const changedFilesLabel = `${scmStatusSummary.changedFiles} ${scmStatusSummary.changedFiles === 1 ? 'file' : 'files'}`;

    return (
        <View style={styles.container}>
            {!hasLineChanges && scmStatusSummary.hasAnyChanges && (
                <Text style={styles.filesText}>{changedFilesLabel}</Text>
            )}
            {hasLineChanges && (
                <View style={styles.lineChanges}>
                    {scmStatusSummary.linesAdded > 0 && (
                        <Text style={styles.addedText}>
                            +{scmStatusSummary.linesAdded}
                        </Text>
                    )}
                    {scmStatusSummary.linesRemoved > 0 && (
                        <Text style={styles.removedText}>
                            -{scmStatusSummary.linesRemoved}
                        </Text>
                    )}
                </View>
            )}
        </View>
    );
}
