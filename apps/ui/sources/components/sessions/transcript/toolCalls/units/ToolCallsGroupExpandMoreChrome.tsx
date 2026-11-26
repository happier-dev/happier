import * as React from 'react';
import { Platform } from 'react-native';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet } from 'react-native-unistyles';

import { useCoarsePrimaryPointer } from '@/components/sessions/transcript/messageActions/rowActionRevealHost';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/**
 * The "+N more" pressable shown while a group of tool calls is collapsed with hidden calls.
 * Shared between the whole-card ToolCallsGroupView, the per-unit expand row and a Script card's
 * inner-call rail. A leaf module, so a tool renderer can use it without importing the group chrome.
 */
export const ToolCallsGroupExpandMoreChrome = React.memo(function ToolCallsGroupExpandMoreChrome(props: Readonly<{
    hiddenCount: number;
    onExpand: () => void;
}>) {
    const coarsePrimaryPointer = useCoarsePrimaryPointer();
    return (
        <HappierPressable
            testID="transcript-tool-calls-preview-more"
            onPress={props.onExpand}
            style={({ pressed }) => [
                styles.previewMore,
                Platform.OS === 'web' && !coarsePrimaryPointer ? styles.previewMoreDesktop : null,
                pressed && styles.previewMorePressed,
            ]}
        >
            <Text style={styles.previewMoreText}>
                {t('session.toolCallsCollapsedPreviewMore', { count: props.hiddenCount })}
            </Text>
        </HappierPressable>
    );
});

const styles = StyleSheet.create((theme) => ({
    previewMore: {
        paddingHorizontal: 0,
        paddingTop: theme.space.s6,
        paddingBottom: theme.space.s6,
        alignSelf: 'flex-start',
    },
    previewMoreDesktop: {
        paddingTop: theme.space.s2,
    },
    previewMorePressed: {
        opacity: motionTokens.press.opacitySubtle,
    },
    previewMoreText: {
        color: theme.colors.text.secondary,
        ...Typography.variant('body'),
    },
}));
