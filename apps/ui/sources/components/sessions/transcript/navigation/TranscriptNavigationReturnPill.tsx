import { Typography } from '@/constants/Typography';
import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ComposerKeyboardFloatingInset } from '@/components/sessions/keyboardAvoidance/ComposerKeyboardFloatingInset';
import { resolveTranscriptNavigationPaneJumpRequest } from '@/components/sessions/transcript/viewport/window/useTranscriptTargetWindowHostAdapter';
import { useTranscriptNavigationCurrentAnchorId } from '@/components/sessions/transcript/viewport/visibility/transcriptNavigationVisibilityStore';
import { GlassPanel } from '@/components/ui/glass/GlassPanel';
import { Icon } from '@/components/ui/icons/Icon';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { formatTranscriptNavigationClockTime } from './transcriptNavigationTimeFormat';
import {
    transcriptNavigationReturnStore,
    useTranscriptNavigationReturnTarget,
} from './transcriptNavigationReturnStore';
import type { TranscriptNavigationEntry, TranscriptNavigationJumpRequest } from './transcriptNavigationTypes';

export type TranscriptNavigationReturnPillProps = Readonly<{
    sessionId: string;
    /** The session's navigation entries, oldest first (the transcript host's projection). */
    entries: readonly TranscriptNavigationEntry[];
    onJumpToEntry: (entry: TranscriptNavigationEntry, request: TranscriptNavigationJumpRequest) => unknown;
}>;

/**
 * "Back to 10:18": after a Navigate or trail jump, one pill at the bottom of the transcript returns
 * the reader to where they were. It reads the one return target the jump host records, and it
 * subscribes to the reader's position only while that target exists, so an idle transcript pays
 * nothing for it.
 */
export const TranscriptNavigationReturnPill = React.memo((props: TranscriptNavigationReturnPillProps) => {
    const { theme } = useUnistyles();
    const { sessionId, entries, onJumpToEntry } = props;
    const target = useTranscriptNavigationReturnTarget(sessionId);
    const currentAnchorId = useTranscriptNavigationCurrentAnchorId(sessionId, { enabled: target !== null });
    const newestEntryId = entries[entries.length - 1]?.id ?? null;

    React.useEffect(() => {
        if (target) transcriptNavigationReturnStore.observeAnchor(sessionId, currentAnchorId);
    }, [currentAnchorId, sessionId, target]);
    React.useEffect(() => {
        if (target) transcriptNavigationReturnStore.observeNewestEntry(sessionId, newestEntryId);
    }, [newestEntryId, sessionId, target]);

    const returnEntry = React.useMemo(
        () => (target ? entries.find((entry) => entry.id === target.returnTo.entryId) ?? null : null),
        [entries, target],
    );
    const handlePress = React.useCallback(() => {
        if (!target || !returnEntry) return;
        transcriptNavigationReturnStore.clear(sessionId, target);
        const request = resolveTranscriptNavigationPaneJumpRequest(returnEntry, sessionId);
        if (request) onJumpToEntry(returnEntry, { ...request, source: 'return' });
    }, [onJumpToEntry, returnEntry, sessionId, target]);

    if (!target || !returnEntry) return null;
    const time = target.returnTo.atMs !== null ? formatTranscriptNavigationClockTime(target.returnTo.atMs) : null;
    const label = time
        ? t('session.transcriptNavigation.backToTime', { time })
        : t('session.transcriptNavigation.backToReading');

    return (
        <ComposerKeyboardFloatingInset
            testID="transcript-navigation-return-offset"
            baseBottom={12}
            style={styles.anchor}
        >
            <View style={styles.center} pointerEvents="box-none">
                <GlassPanel shadowLevel={2} innerShadow={false}>
                    <Pressable
                        testID="transcript-navigation-return"
                        onPress={handlePress}
                        accessibilityRole="button"
                        accessibilityLabel={label}
                        style={({ pressed }) => [styles.row, pressed && { opacity: motionTokens.press.opacitySubtle }]}
                    >
                        <Icon name="arrow-arc-left" size={14} color={theme.colors.text.secondary} />
                        <Text style={styles.label} numberOfLines={1}>{label}</Text>
                    </Pressable>
                </GlassPanel>
            </View>
        </ComposerKeyboardFloatingInset>
    );
});

const styles = StyleSheet.create((theme) => ({
    anchor: {
        position: 'absolute',
        left: 0,
        right: 0,
    },
    center: {
        alignItems: 'center',
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        height: 32,
        paddingHorizontal: theme.space.s12,
    },
    label: {
        ...Typography.variant('body', 'semiBold'),
        color: theme.colors.text.primary,
    },
}));
