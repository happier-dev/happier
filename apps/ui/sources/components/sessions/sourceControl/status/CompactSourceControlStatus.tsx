import React from 'react';
import { View, Text } from 'react-native';
import { useSessionProjectScmSnapshot } from '@/sync/domains/state/storage';
import { StyleSheet } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import { buildScmStatusSummaryFromSnapshot } from './statusSummary';

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

interface CompactSourceControlStatusProps {
    sessionId: string;
}

export function CompactSourceControlStatus({ sessionId }: CompactSourceControlStatusProps) {
    const styles = stylesheet;
    const snapshot = useSessionProjectScmSnapshot(sessionId);
    const scmStatusSummary = buildScmStatusSummaryFromSnapshot(snapshot);

    if (!scmStatusSummary || !scmStatusSummary.hasAnyChanges) {
        return null;
    }

    const hasLineChanges = scmStatusSummary.hasLineChanges;
    const changedFilesLabel = `${scmStatusSummary.changedFiles}`;

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
