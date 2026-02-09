import React from 'react';
import { View, Text } from 'react-native';
import { useSessionProjectGitSnapshot } from '@/sync/domains/state/storage';
import { StyleSheet } from 'react-native-unistyles';
import { buildGitStatusSummaryFromSnapshot } from './statusSummary';

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

interface ProjectGitStatusProps {
    /** Any session ID from the project (used to find the project git status) */
    sessionId: string;
}

export function ProjectGitStatus({ sessionId }: ProjectGitStatusProps) {
    const styles = stylesheet;
    const snapshot = useSessionProjectGitSnapshot(sessionId);
    const gitStatus = buildGitStatusSummaryFromSnapshot(snapshot);

    // Don't render if no git status (not a git repository)
    if (!gitStatus) {
        return null;
    }

    const hasLineChanges = gitStatus.hasLineChanges;
    const changedFilesLabel = `${gitStatus.changedFiles} ${gitStatus.changedFiles === 1 ? 'file' : 'files'}`;

    return (
        <View style={styles.container}>
            {!hasLineChanges && gitStatus.hasAnyChanges && (
                <Text style={styles.filesText}>{changedFilesLabel}</Text>
            )}
            {hasLineChanges && (
                <View style={styles.lineChanges}>
                    {gitStatus.linesAdded > 0 && (
                        <Text style={styles.addedText}>
                            +{gitStatus.linesAdded}
                        </Text>
                    )}
                    {gitStatus.linesRemoved > 0 && (
                        <Text style={styles.removedText}>
                            -{gitStatus.linesRemoved}
                        </Text>
                    )}
                </View>
            )}
        </View>
    );
}
