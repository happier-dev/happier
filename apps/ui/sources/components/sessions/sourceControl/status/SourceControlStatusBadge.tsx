import { Typography } from '@/constants/Typography';
import React from 'react';
import { View } from 'react-native';
import { useSessionProjectScmSummarySnapshot } from '@/sync/domains/state/storage';
import { useUnistyles } from 'react-native-unistyles';
import { buildSessionScmSummary } from './statusSummary';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import { AGENT_INPUT_CHIP_ICON_SIZE_PX, AGENT_INPUT_CHIP_ICON_STYLE } from '@/components/sessions/agentInput/definitions/agentInputChipIconMetrics';

const LINE_ADDED_PREFIX = '+';
const LINE_REMOVED_PREFIX = '-';


// Custom hook to check if a source-control status badge should be shown.
export function useHasMeaningfulScmStatus(sessionId: string): boolean {
    const snapshot = useSessionProjectScmSummarySnapshot(sessionId);
    return buildSessionScmSummary(snapshot) !== null;
}

interface SourceControlStatusBadgeProps {
    sessionId: string;
}

export function SourceControlStatusBadge({ sessionId }: SourceControlStatusBadgeProps) {
    const snapshot = useSessionProjectScmSummarySnapshot(sessionId);
    const scmStatusSummary = buildSessionScmSummary(snapshot);
    const { theme } = useUnistyles();

    if (!scmStatusSummary) {
        return null;
    }

    const hasLineChanges = scmStatusSummary.isComplete !== false && scmStatusSummary.hasLineChanges;
    const changedFilesLabel = t('files.sourceControlStatus.changedFilesLabel', { count: scmStatusSummary.changedFiles });

    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s8, flex: 1, overflow: 'hidden' }}>
            {/* Source-control icon */}
            <Icon
                name="git-branch"
                size={AGENT_INPUT_CHIP_ICON_SIZE_PX}
                color={theme.colors.button.secondary.tint} style={AGENT_INPUT_CHIP_ICON_STYLE} />

            {/* Line changes only */}
            {hasLineChanges && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s2, flexShrink: 0 }}>
                    {scmStatusSummary.linesAdded > 0 && (
                        <Text
                            style={{
                                ...Typography.variant('meta', 'semiBold'),
                                color: theme.colors.versionControl.added.foreground,
                            }}
                            numberOfLines={1}
                          >
                              {`${LINE_ADDED_PREFIX}${scmStatusSummary.linesAdded}`}
                          </Text>
                      )}
                    {scmStatusSummary.linesRemoved > 0 && (
                        <Text
                            style={{
                                ...Typography.variant('meta', 'semiBold'),
                                color: theme.colors.versionControl.removed.foreground,
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
                        ...Typography.variant('meta', 'semiBold'),
                        color: theme.colors.text.secondary,
                    }}
                    numberOfLines={1}
                >
                    {changedFilesLabel}
                </Text>
            )}
        </View>
    );
}
