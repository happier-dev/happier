import React from 'react';
import { View, Text } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { useSessionProjectGitSnapshot } from '@/sync/domains/state/storage';
import { useUnistyles } from 'react-native-unistyles';
import { buildGitStatusSummaryFromSnapshot } from './statusSummary';

// Custom hook to check if git status should be shown (always true if git repo exists)
export function useHasMeaningfulGitStatus(sessionId: string): boolean {
    const snapshot = useSessionProjectGitSnapshot(sessionId);
    return buildGitStatusSummaryFromSnapshot(snapshot) !== null;
}

interface GitStatusBadgeProps {
    sessionId: string;
}

export function GitStatusBadge({ sessionId }: GitStatusBadgeProps) {
    const snapshot = useSessionProjectGitSnapshot(sessionId);
    const gitStatus = buildGitStatusSummaryFromSnapshot(snapshot);
    const { theme } = useUnistyles();

    // Always show if git repository exists, even without changes
    if (!gitStatus) {
        return null;
    }

    const hasLineChanges = gitStatus.hasLineChanges;
    const changedFilesLabel = `${gitStatus.changedFiles} ${gitStatus.changedFiles === 1 ? 'file' : 'files'}`;

    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, overflow: 'hidden' }}>
            {/* Git icon - always shown */}
            <Octicons
                name="git-branch"
                size={16}
                color={theme.colors.button.secondary.tint}
            />

            {/* Line changes only */}
            {hasLineChanges && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                    {gitStatus.linesAdded > 0 && (
                        <Text
                            style={{
                                fontSize: 12,
                                color: theme.colors.gitAddedText,
                                fontWeight: '600',
                            }}
                            numberOfLines={1}
                        >
                            +{gitStatus.linesAdded}
                        </Text>
                    )}
                    {gitStatus.linesRemoved > 0 && (
                        <Text
                            style={{
                                fontSize: 12,
                                color: theme.colors.gitRemovedText,
                                fontWeight: '600',
                            }}
                            numberOfLines={1}
                        >
                            -{gitStatus.linesRemoved}
                        </Text>
                    )}
                </View>
            )}
            {!hasLineChanges && gitStatus.hasAnyChanges && (
                <Text
                    style={{
                        fontSize: 12,
                        color: theme.colors.textSecondary,
                        fontWeight: '600',
                    }}
                    numberOfLines={1}
                >
                    {changedFilesLabel}
                </Text>
            )}
        </View>
    );
}
