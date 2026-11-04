import * as React from 'react';
import { useWindowDimensions, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import {
    AGENT_INPUT_ACTION_CHIP_PRESSED_STYLE,
    AGENT_INPUT_ACTION_CHIP_STYLE,
    resolveAgentInputActionChipTextStyle,
} from '@/components/sessions/agentInput/components/agentInputChromeStyles';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { WordCrossFade } from '@/components/ui/motion/WordCrossFade';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS, Popover } from '@/components/ui/popover';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { CaptureWindowTextAsk } from './CaptureWindowTextAsk';
import type { CaptureWindowTextSurface } from './CaptureWindowScreen';
import { CaptureWindowTextSheet } from './CaptureWindowTextSheet';
import type { CaptureWindowTextView } from './captureWindowTextView';

const GLYPHS: Readonly<Record<Exclude<CaptureWindowTextView['chip'], 'reading'>, IconName>> = {
    off: 'article', locked: 'lock', on: 'check', amber: 'warning', empty: 'article', unavailable: 'article',
};

/** The chip is a switch (lab `wt`, MIS §5): its label says what would go, View shows it, and every ask rises from it. */
export function CaptureWindowTextChip(props: Readonly<{
    view: CaptureWindowTextView;
    onToggle: () => void;
    /** View opens over the picture at the note's own width, inside the window's paper. */
    surface: CaptureWindowTextSurface;
    onResolveBlurWarning: (include: boolean) => void;
    onOpenPermissionSettings: () => void;
    onDeclinePermission: () => void;
}>) {
    const { theme } = useUnistyles();
    const { view } = props;
    const chipRef = React.useRef<View>(null);
    const [viewing, setViewing] = React.useState(false);
    const on = view.chip === 'on' || view.chip === 'amber' || view.chip === 'reading';
    const chipText = resolveAgentInputActionChipTextStyle(theme);
    const tint = view.chip === 'amber' ? theme.colors.state.attention.foreground : theme.colors.composer.chipTint;
    const preview = viewing ? view.preview : null;
    // The sheet spans the note it rises from; the stage bounds it, so the popover's default cap must not.
    const { width: windowWidth } = useWindowDimensions();
    return (
        <>
            <View ref={chipRef} collapsable={false} style={styles.frame}>
                <HappierPressable
                    accessibilityRole="switch"
                    checked={on}
                    accessibilityLabel={view.label}
                    onPress={props.onToggle}
                    style={({ pressed }) => [styles.chip, on ? styles.chipOn : null, pressed ? AGENT_INPUT_ACTION_CHIP_PRESSED_STYLE : null]}
                    testID="capture-window-text-chip"
                >
                    <WordCrossFade wordKey={`${view.chip}:${view.label}`} style={styles.face}>
                        {view.chip === 'reading'
                            ? <ActivitySpinner size={14} color={tint} />
                            : <Icon name={GLYPHS[view.chip]} size={14} color={tint} />}
                        <Text numberOfLines={1} style={[chipText, styles.label]}>{view.label}</Text>
                    </WordCrossFade>
                </HappierPressable>
            </View>
            {view.preview ? (
                // The link keeps its own start alignment; this frame lets the chip row centre it on the row.
                <View>
                    <TextLinkButton size="meta" verticalReach={0} label={t('screenCapture.windowText.view')} onPress={() => setViewing(true)} testID="capture-window-text-view" />
                </View>
            ) : null}
            <CaptureWindowTextAsk
                ask={view.ask}
                anchorRef={chipRef}
                boundaryRef={props.surface.paperRef}
                onResolveBlurWarning={props.onResolveBlurWarning}
                onOpenPermissionSettings={props.onOpenPermissionSettings}
                onDeclinePermission={props.onDeclinePermission}
            />
            <Popover
                open={preview !== null}
                anchorRef={props.surface.noteRef}
                boundaryRef={props.surface.stageRef}
                placement="top"
                gap={theme.space.s12}
                maxWidthCap={windowWidth}
                portal={{ ...MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS, matchAnchorWidth: true }}
                accessibilityLabel={t('screenCapture.window.wholeWindowText')}
                containerStyle={styles.sheet}
                onRequestClose={() => setViewing(false)}
            >
                {({ maxHeight }) => preview ? (
                    <FloatingOverlay maxHeight={maxHeight} surfaceChrome="theme" scrollEnabled={false}>
                        <CaptureWindowTextSheet
                            preview={preview}
                            maxHeight={maxHeight}
                            onDone={() => setViewing(false)}
                            onExclude={() => { setViewing(false); props.onToggle(); }}
                        />
                    </FloatingOverlay>
                ) : null}
            </Popover>
        </>
    );
}

const styles = StyleSheet.create((theme) => ({
    frame: {
        flexShrink: 1,
        minWidth: 0,
        borderRadius: 16,
    },
    chip: AGENT_INPUT_ACTION_CHIP_STYLE,
    chipOn: {
        backgroundColor: theme.colors.surface.selected,
    },
    face: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        flexShrink: 1,
        minWidth: 0,
    },
    label: {
        flexShrink: 1,
    },
    sheet: {
        paddingHorizontal: 0,
    },
}));
