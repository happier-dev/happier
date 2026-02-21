import React from 'react';
import { View } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { useSessionProjectScmSnapshot } from '@/sync/domains/state/storage';
import { useUnistyles } from 'react-native-unistyles';
import { buildScmStatusSummaryFromSnapshot } from './statusSummary';
import { Text } from '@/components/ui/text/Text';


// Custom hook to check if a source-control status badge should be shown.
export function useHasMeaningfulScmStatus(sessionId: string): boolean {
    const snapshot = useSessionProjectScmSnapshot(sessionId);
    return buildScmStatusSummaryFromSnapshot(snapshot) !== null;
}

interface SourceControlStatusBadgeProps {
    sessionId: string;
}

export function SourceControlStatusBadge({ sessionId }: SourceControlStatusBadgeProps) {
    const snapshot = useSessionProjectScmSnapshot(sessionId);
    const scmStatusSummary = buildScmStatusSummaryFromSnapshot(snapshot);
    const { theme } = useUnistyles();

    if (!scmStatusSummary) {
        return null;
    }

    const hasLineChanges = scmStatusSummary.hasLineChanges;
    const changedFilesLabel = `${scmStatusSummary.changedFiles} ${scmStatusSummary.changedFiles === 1 ? 'file' : 'files'}`;

    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, overflow: 'hidden' }}>
            {/* Source-control icon */}
            <Octicons
                name="git-branch"
                size={16}
                color={theme.colors.button.secondary.tint}
            />

            {/* Line changes only */}
            {hasLineChanges && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                    {scmStatusSummary.linesAdded > 0 && (
                        <Text
                            style={{
                                fontSize: 12,
                                color: theme.colors.gitAddedText,
                                fontWeight: '600',
                            }}
                            numberOfLines={1}
                        >
                            +{scmStatusSummary.linesAdded}
                        </Text>
                    )}
                    {scmStatusSummary.linesRemoved > 0 && (
                        <Text
                            style={{
                                fontSize: 12,
                                color: theme.colors.gitRemovedText,
                                fontWeight: '600',
                            }}
                            numberOfLines={1}
                        >
                            -{scmStatusSummary.linesRemoved}
                        </Text>
                    )}
                </View>
            )}
            {!hasLineChanges && scmStatusSummary.hasAnyChanges && (
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
