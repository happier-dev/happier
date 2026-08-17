import React from 'react';
import { View } from 'react-native';
import { useSessionProjectScmSnapshot } from '@/sync/domains/state/storage';
import { useUnistyles } from 'react-native-unistyles';
import { buildScmStatusSummaryFromSnapshot } from './statusSummary';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import { AGENT_INPUT_CHIP_ICON_SIZE_PX, AGENT_INPUT_CHIP_ICON_STYLE } from '@/components/sessions/agentInput/definitions/agentInputChipIconMetrics';

const LINE_ADDED_PREFIX = '+';
const LINE_REMOVED_PREFIX = '-';


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
    const changedFilesLabel = t('files.sourceControlStatus.changedFilesLabel', { count: scmStatusSummary.changedFiles });

    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, overflow: 'hidden' }}>
            {/* Source-control icon */}
            <Icon
                name="git-branch"
                size={AGENT_INPUT_CHIP_ICON_SIZE_PX}
                color={theme.colors.button.secondary.tint} style={AGENT_INPUT_CHIP_ICON_STYLE} />

            {/* Line changes only */}
            {hasLineChanges && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                    {scmStatusSummary.linesAdded > 0 && (
                        <Text
                            style={{
                                fontSize: 12,
                                color: theme.colors.versionControl.added.foreground,
                                fontWeight: '600',
                            }}
                            numberOfLines={1}
                          >
                              {`${LINE_ADDED_PREFIX}${scmStatusSummary.linesAdded}`}
                          </Text>
                      )}
                    {scmStatusSummary.linesRemoved > 0 && (
                        <Text
                            style={{
                                fontSize: 12,
                                color: theme.colors.versionControl.removed.foreground,
                                fontWeight: '600',
                            }}
                            numberOfLines={1}
                          >
                              {`${LINE_REMOVED_PREFIX}${scmStatusSummary.linesRemoved}`}
                          </Text>
                      )}
                </View>
            )}
            {!hasLineChanges && scmStatusSummary.hasAnyChanges && (
                <Text
                    style={{
                        fontSize: 12,
                        color: theme.colors.text.secondary,
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
