import * as React from 'react';
import { Octicons } from '@expo/vector-icons';
import { Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { AnimatedNumber } from '@/components/instrument';
import { hapticsLight } from '@/components/ui/theme/haptics';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Text } from '@/components/ui/text/Text';
import type { ScmStatusSummary } from '@/components/sessions/sourceControl/status/statusSummary';
import { t } from '@/text';

import { instrumentStripStyles } from './instrumentStripStyles';

const GIT_HIT_SLOP = { top: 12, bottom: 12, left: 8, right: 8 } as const;

const formatAdded = (value: number) => `+${Math.trunc(value)}`;
const formatRemoved = (value: number) => `−${Math.trunc(value)}`;

export type GitDeltaInstrumentProps = Readonly<{
    git: ScmStatusSummary;
    /** Narrow layout (<360px): drop the branch icon, keep the numbers. */
    compact: boolean;
    onPress?: () => void;
    testID?: string;
}>;

/**
 * Session git ± instrument (relocated from the composer action row, F-UI-12).
 * Reuses the canonical `buildScmStatusSummaryFromSnapshot` data (via the model)
 * and `versionControl` theme colors; the odometer presentation is new.
 */
export const GitDeltaInstrument = React.memo(function GitDeltaInstrument(props: GitDeltaInstrumentProps) {
    const { theme } = useUnistyles();
    const { git } = props;

    const addedColor = theme.colors.versionControl.added.foreground;
    const removedColor = theme.colors.versionControl.removed.foreground;

    const handlePress = React.useCallback(() => {
        hapticsLight();
        props.onPress?.();
    }, [props]);

    // Clean repo (T3.1 gate = "is a repo"): a lone branch icon, matching the old
    // composer chip — no numbers/labels for zero changes, and never empty.
    const isCleanRepo = !git.hasLineChanges && !git.hasAnyChanges;

    const accessibilityLabel = git.hasLineChanges
        ? t('instrument.git.linesLabel', { added: git.linesAdded, removed: git.linesRemoved })
        : isCleanRepo
            ? t('settings.sourceControl')
            : t('files.sourceControlStatus.changedFilesLabel', { count: git.changedFiles });

    const showBranchIcon = !props.compact || isCleanRepo;

    const body = (
        <View style={instrumentStripStyles.instrumentSlot}>
            {showBranchIcon ? normalizeNodeForView(
                <Octicons name="git-branch" size={12} color={theme.colors.text.secondary} />,
            ) : null}
            {isCleanRepo ? null : git.hasLineChanges ? (
                <View style={instrumentStripStyles.instrumentSlot}>
                    {git.linesAdded > 0 ? (
                        <AnimatedNumber
                            value={git.linesAdded}
                            format={formatAdded}
                            emphasisPulse
                            emphasisColor={addedColor}
                            textStyle={{ fontSize: 12, fontWeight: '600', color: addedColor }}
                            testID="session-instrument-git-added"
                        />
                    ) : null}
                    {git.linesRemoved > 0 ? (
                        <AnimatedNumber
                            value={git.linesRemoved}
                            format={formatRemoved}
                            emphasisPulse
                            emphasisColor={removedColor}
                            textStyle={{ fontSize: 12, fontWeight: '600', color: removedColor }}
                            testID="session-instrument-git-removed"
                        />
                    ) : null}
                </View>
            ) : (
                <Text
                    style={[instrumentStripStyles.instrumentValueText, { color: theme.colors.text.secondary, fontWeight: '600' }]}
                    numberOfLines={1}
                >
                    {t('files.sourceControlStatus.changedFilesLabel', { count: git.changedFiles })}
                </Text>
            )}
        </View>
    );

    if (!props.onPress) {
        return (
            <View
                testID={props.testID ?? 'session-instrument-git'}
                accessible
                accessibilityLabel={accessibilityLabel}
            >
                {body}
            </View>
        );
    }

    return (
        <Pressable
            testID={props.testID ?? 'session-instrument-git'}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            hitSlop={GIT_HIT_SLOP}
            onPress={handlePress}
            style={({ pressed }) => (pressed ? { opacity: 0.7 } : null)}
        >
            {body}
        </Pressable>
    );
});
