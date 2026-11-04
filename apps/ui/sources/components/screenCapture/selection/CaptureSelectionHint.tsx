import * as React from 'react';
import { View, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { GLASS_BLUR_RADIUS_PX } from '@/components/ui/glass/glassMaterial';
import { KeyHint } from '@/components/ui/keyboard/KeyHint';
import { WordCrossFade } from '@/components/ui/motion/WordCrossFade';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { createBackdropWebStyle } from '@/components/ui/overlays/createBackdropLayerStyle';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import type { CaptureSelectionMode } from './CaptureSelectionLayer';

/** The hint pill (MIS §1): which capture this is, what to do, and the way out. */
export const CaptureSelectionHint = React.memo(function CaptureSelectionHint(props: Readonly<{
    mode: CaptureSelectionMode;
    onModeChange: (mode: CaptureSelectionMode) => void;
    shortcutLabel?: string;
    dragging: boolean;
    keyboardStage?: 'position' | 'region';
    onCancel: () => void;
}>) {
    const { theme } = useUnistyles();
    const pillBackdrop = React.useMemo(() => createBackdropWebStyle({
        backgroundColor: theme.colors.overlay.scrimStrong,
        surfaceGroup: 'floating',
        blurPx: GLASS_BLUR_RADIUS_PX.strong,
    }), [theme.colors.overlay.scrimStrong]);
    const instruction = props.keyboardStage === 'position' ? t('screenCapture.selection.keyboardPosition')
        : props.keyboardStage === 'region' ? t('screenCapture.selection.keyboardRegion')
        : !props.dragging ? t('screenCapture.selection.instruction')
        : props.mode === 'recording' ? t('screenCapture.selection.releaseRecording') : t('screenCapture.selection.release');
    return (
        <View style={[styles.pill, pillBackdrop as ViewStyle]} testID="capture-selection-hint">
            <SegmentedTabBar<CaptureSelectionMode>
                compact
                segmentSizing="content"
                accessibilityLabel={t('screenCapture.selection.modeLabel')}
                tabs={[
                    { id: 'still', label: t('screenCapture.selection.screenshot'), shortcut: props.shortcutLabel },
                    { id: 'recording', label: t('screenCapture.selection.recording') },
                ]}
                activeTabId={props.mode}
                onSelectTab={props.onModeChange}
                testIDPrefix="capture-selection-mode"
            />
            <WordCrossFade wordKey={instruction}>
                <Text variant="body" numberOfLines={1} style={styles.ink}>{instruction}</Text>
            </WordCrossFade>
            <HappierPressable accessibilityRole="button" accessibilityLabel={t('common.cancel')} onPress={props.onCancel}>
                <View style={styles.cancel}>
                    <KeyHint label="esc" />
                    <Text variant="body" style={styles.ink}>{t('common.cancel')}</Text>
                </View>
            </HappierPressable>
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    pill: {
        borderRadius: 999,
        boxShadow: theme.colors.glass.castShadow,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s12,
        paddingVertical: theme.space.s4,
        paddingLeft: theme.space.s4,
        paddingRight: theme.space.s12,
    },
    ink: {
        color: theme.colors.text.primary,
    },
    cancel: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
    },
}));
