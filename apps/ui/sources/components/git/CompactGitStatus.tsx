import React from 'react';
import { View, Text } from 'react-native';
import { useSessionProjectGitSnapshot } from '@/sync/domains/state/storage';
import { StyleSheet } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { buildGitStatusSummaryFromSnapshot } from './statusSummary';

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.surfaceHighest,
        paddingHorizontal: 6,
        height: 16,
        borderRadius: 4,
    },
    fileCountText: {
        fontSize: 10,
        fontWeight: '500',
        color: theme.colors.textSecondary,
    },
    lineChanges: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
    },
    addedText: {
        fontSize: 10,
        fontWeight: '600',
        color: theme.colors.gitAddedText,
    },
    removedText: {
        fontSize: 10,
        fontWeight: '600',
        color: theme.colors.gitRemovedText,
    },
}));

interface CompactGitStatusProps {
    sessionId: string;
}

export function CompactGitStatus({ sessionId }: CompactGitStatusProps) {
    const styles = stylesheet;
    const snapshot = useSessionProjectGitSnapshot(sessionId);
    const gitStatus = buildGitStatusSummaryFromSnapshot(snapshot);

    // Don't render if no git status or no meaningful changes
    if (!gitStatus || !gitStatus.hasAnyChanges) {
        return null;
    }

    const hasLineChanges = gitStatus.hasLineChanges;
    const changedFilesLabel = `${gitStatus.changedFiles}`;

    return (
        <View style={styles.container}>
            <Ionicons
                name="git-branch-outline"
                size={10}
                color={styles.fileCountText.color}
                style={{ marginRight: 2 }}
            />
            {!hasLineChanges && (
                <Text style={styles.fileCountText}>{changedFilesLabel}</Text>
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
