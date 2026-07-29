import * as React from 'react';
import { View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS, useSharedValue } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { InstrumentCard, instrumentSelectionTick, useMotionPreferences } from '@/components/instrument';

import { clampLensLeft, resolveScrubIndex, scrubCellCenterX, type ScrubRowLayout } from './scrubMath';

/**
 * Long-press crosshair scrub for cell-row charts (trend bars, heatmap rows).
 * Hold ~300ms then drag: a hairline crosshair tracks the cell under the finger
 * and a floating InstrumentCard lens shows that cell's values, with one
 * selection haptic per cell crossing (motion-gated by the kit). A plain tap
 * pins/unpins the lens on the tapped cell. Purely gesture-driven — nothing
 * animates without the user's finger (day-to-day rule).
 */

export type ScrubLensContent = Readonly<{
    title: string;
    rows: ReadonlyArray<Readonly<{ label: string; value: string }>>;
}>;

export type ScrubLensProps = Readonly<{
    layout: ScrubRowLayout;
    resolveContent: (index: number) => ScrubLensContent | null;
    /** Accent for the crosshair, from theme tokens. */
    accentColor: string;
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    testID?: string;
}>;

const LENS_WIDTH = 168;
const LONG_PRESS_MS = 300;

const styles = StyleSheet.create((theme) => ({
    container: {
        position: 'relative',
    },
    crosshair: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        width: 1.5,
        borderRadius: 1,
        opacity: 0.85,
    },
    lens: {
        position: 'absolute',
        top: 4,
        width: LENS_WIDTH,
    },
    lensBody: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        gap: 8,
    },
    lensTitle: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.primary,
    },
    lensRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        gap: 8,
    },
    lensLabel: {
        fontSize: 11,
        lineHeight: 14,
        textTransform: 'uppercase',
        letterSpacing: 0.4,
        color: theme.colors.text.secondary,
    },
    lensValue: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        lineHeight: 14,
        color: theme.colors.text.primary,
        fontVariant: ['tabular-nums'],
    },
}));

export const ScrubLens: React.FC<ScrubLensProps> = ({
    layout,
    resolveContent,
    accentColor,
    children,
    style,
    testID,
}) => {
    useUnistyles();
    const motion = useMotionPreferences();
    const [activeIndex, setActiveIndex] = React.useState<number | null>(null);
    const [pinned, setPinned] = React.useState(false);
    const containerWidthRef = React.useRef(0);
    const lastIndexRef = React.useRef<number | null>(null);
    // Layout in a ref accessible from runOnJS callbacks without re-creating gestures.
    const layoutRef = React.useRef(layout);
    layoutRef.current = layout;

    const onContainerLayout = React.useCallback((event: LayoutChangeEvent) => {
        containerWidthRef.current = event.nativeEvent.layout.width;
    }, []);

    const hapticsEnabled = motion.hapticsEnabled;
    const handleScrub = React.useCallback((x: number, isFirst: boolean) => {
        const index = resolveScrubIndex(x, layoutRef.current);
        if (index === null) return;
        if (index !== lastIndexRef.current) {
            if (!isFirst) {
                instrumentSelectionTick(hapticsEnabled);
            }
            lastIndexRef.current = index;
            setActiveIndex(index);
        }
    }, [hapticsEnabled]);

    // Pin state readable from stable callbacks.
    const pinnedRef = React.useRef(pinned);
    pinnedRef.current = pinned;
    const lastPinnedIndexRef = React.useRef<number | null>(null);

    const endScrub = React.useCallback(() => {
        lastIndexRef.current = null;
        setActiveIndex((current) => (pinnedRef.current ? current : null));
    }, []);

    const handleTap = React.useCallback((x: number) => {
        const index = resolveScrubIndex(x, layoutRef.current);
        if (index === null) return;
        if (pinnedRef.current && index === lastPinnedIndexRef.current) {
            setPinned(false);
            setActiveIndex(null);
            lastPinnedIndexRef.current = null;
            return;
        }
        lastPinnedIndexRef.current = index;
        setPinned(true);
        setActiveIndex(index);
    }, []);

    const isScrubbing = useSharedValue(false);
    const pan = React.useMemo(() => Gesture.Pan()
        .activateAfterLongPress(LONG_PRESS_MS)
        .onStart((event) => {
            isScrubbing.value = true;
            runOnJS(handleScrub)(event.x, true);
        })
        .onUpdate((event) => {
            runOnJS(handleScrub)(event.x, false);
        })
        .onFinalize(() => {
            isScrubbing.value = false;
            runOnJS(endScrub)();
        }), [endScrub, handleScrub, isScrubbing]);

    const tap = React.useMemo(() => Gesture.Tap()
        .maxDuration(220)
        .onEnd((event) => {
            runOnJS(handleTap)(event.x);
        }), [handleTap]);

    const gesture = React.useMemo(() => Gesture.Exclusive(pan, tap), [pan, tap]);

    const content = activeIndex !== null ? resolveContent(activeIndex) : null;
    const anchorX = activeIndex !== null ? scrubCellCenterX(activeIndex, layout) : 0;
    const lensLeft = clampLensLeft(anchorX, LENS_WIDTH, containerWidthRef.current || anchorX + LENS_WIDTH);

    return (
        <GestureDetector gesture={gesture}>
            <View testID={testID} style={[styles.container, style]} onLayout={onContainerLayout}>
                {children}
                {activeIndex !== null && content ? (
                    <>
                        <View
                            pointerEvents="none"
                            style={[styles.crosshair, { left: anchorX - 0.75, backgroundColor: accentColor }]}
                        />
                        <View pointerEvents="none" style={[styles.lens, { left: lensLeft }]}>
                            <InstrumentCard variant="popover" testID={testID ? `${testID}-lens` : undefined}>
                                <View style={styles.lensBody}>
                                    <Text style={styles.lensTitle} numberOfLines={1}>{content.title}</Text>
                                    {content.rows.map((row) => (
                                        <View key={row.label} style={styles.lensRow}>
                                            <Text style={styles.lensLabel} numberOfLines={1}>{row.label}</Text>
                                            <Text style={styles.lensValue} numberOfLines={1}>{row.value}</Text>
                                        </View>
                                    ))}
                                </View>
                            </InstrumentCard>
                        </View>
                    </>
                ) : null}
            </View>
        </GestureDetector>
    );
};
