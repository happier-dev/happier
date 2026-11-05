import * as React from 'react';
import { Platform, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { GlassPanel } from '@/components/ui/glass/GlassPanel';
import { GlassLivePictureBackdropContext } from '@/components/ui/glass/livePictureBackdrop';
import { layout } from '@/components/ui/layout/layout';
import { resolveFloatingTabBarBottomPadding } from './floatingTabBarBottomInset';

/**
 * Floating, rounded iOS-26-style chrome shell for the bottom tab bars.
 *
 * Centers a capsule that floats above the safe-area inset and fills it with the
 * shared `GlassPanel` (tiered Liquid Glass / blur / solid material + glass rim +
 * inner shadow + cast shadow). This component owns only the floating *position*:
 * the side gutters, top/bottom gaps, and content max-width. Bars pass their tab
 * row as `children` plus the bottom safe-area inset.
 */
// Tuned to match the iOS 26 Liquid Glass tab bar: a capsule that *sizes to its
// content* and floats centered (deliberate negative space on the sides) rather
// than spanning the full width. `FLOATING_SIDE_GUTTER` is the minimum breathing
// room so a wide bar never touches the screen edges; the bar shrink-wraps its
// tabs and only compresses if it would exceed that bound.
// Large radius → clamps to a full capsule at any bar height (matches the iOS 26 /
// Instagram fully-rounded floating bar).
const TAB_BAR_RADIUS = 999;
const FLOATING_SIDE_GUTTER = 16;
const FLOATING_TOP_GAP = 4;
// Capsule inner padding. Combined with the active-highlight inset (CockpitTabBar/
// TabBar `activePill`: left/right 4, top/bottom 3) this sets the gap from the
// capsule rim to a selected tab at the edge: H = 2 + 4 = 6, V = 0 + 3 = 3.
const PILL_PADDING_VERTICAL = 0;
const PILL_PADDING_HORIZONTAL = 2;
// Breathing room between the bar and a sibling capsule. iOS 26 sets its search button off the tab
// bar by roughly this much, and it matches the widest tab gap so the two capsules read as one
// system rather than as one control cut in half.
const ACCESSORY_GAP = 8;

/**
 * How many tab slots of `tabMinWidth` the floating capsule holds on this window: the window less
 * the side gutters and the capsule's own padding, capped by the content max width. Bars use it
 * to decide what fits before they render, since a capsule that shrink-wraps its tabs cannot be
 * measured for the room it has.
 */
export function resolveFloatingTabBarSlotCount(input: Readonly<{
    windowWidth: number;
    maxWidth: number;
    tabMinWidth: number;
}>): number {
    const room = Math.min(input.windowWidth - FLOATING_SIDE_GUTTER * 2, input.maxWidth) - PILL_PADDING_HORIZONTAL * 2;
    return input.tabMinWidth > 0 ? Math.max(0, Math.floor(room / input.tabMinWidth)) : 0;
}

/**
 * How wide each of `slots` tabs may be in the accessory row, so the bar stays centred on the screen
 * between the accessory and its mirror. Never wider than the tab's own width: a wide phone keeps a
 * content-sized bar with room around it.
 */
export function resolveFloatingTabBarAccessorySlotWidth(input: Readonly<{
    windowWidth: number;
    maxWidth: number;
    accessorySize: number;
    slots: number;
    tabMinWidth: number;
}>): number {
    const room = Math.min(input.windowWidth - FLOATING_SIDE_GUTTER * 2, input.maxWidth)
        - (input.accessorySize + ACCESSORY_GAP) * 2 - PILL_PADDING_HORIZONTAL * 2;
    return Math.min(input.tabMinWidth, Math.floor(room / input.slots));
}

const styles = StyleSheet.create({
    positioner: {
        alignItems: 'center',
        paddingHorizontal: FLOATING_SIDE_GUTTER,
        paddingTop: FLOATING_TOP_GAP,
        backgroundColor: 'transparent',
    },
    pill: {
        paddingHorizontal: PILL_PADDING_HORIZONTAL,
        paddingVertical: PILL_PADDING_VERTICAL,
    },
    // The capsule shrink-wraps its tabs, but never past the gutters: a bar whose tools overflow
    // scrolls inside it (`CockpitTabBar layout="scroll"`) instead of running off the screen.
    pillBounds: {
        maxWidth: '100%',
    },
    pillBoundsStretch: {
        alignSelf: 'stretch',
        alignItems: 'center',
    },
    pillStretch: {
        width: '100%',
    },
    accessoryRow: {
        flexDirection: 'row',
        // `stretch` is load-bearing, not cosmetic: the chrome host publishes this row's measured
        // height into `SessionCockpitChromeRegistry`, and the session list padding, settings
        // footer, composer reservation and selection action bar all pad by it. The accessory is
        // sized BY the bar height here, so it can never become the tallest child and silently move
        // those surfaces.
        alignItems: 'stretch',
        alignSelf: 'stretch',
        justifyContent: 'center',
    },
    // Only the mirror gives way when a labelled bar needs the room; the accessory keeps its square.
    accessoryMirror: {
        flexShrink: 1,
    },
    // The accessory's square footprint, mirrored on the leading edge so the bar stays centred on
    // the SCREEN instead of in the space the accessory leaves over. Both are as wide as the bar is
    // tall (a flex weight would clip the accessory on a narrow phone). Until the bar has been laid
    // out once, `aspectRatio` stands in: Yoga resolves it from the stretched row height, but web
    // does not (the row's height is not definite there, so it drew the mirror 0px wide and the
    // accessory at its content width). The measured width then makes it exact on every platform.
    accessoryFootprintUnmeasured: {
        aspectRatio: 1,
    },
    accessoryRowBar: {
        // The bar keeps its content size, so a wide phone leaves the room outside the row and the bar
        // stays centred. It shrinks only past what the mirror could give.
        flexShrink: 1,
        minWidth: 0,
        alignItems: 'center',
        justifyContent: 'center',
        marginHorizontal: ACCESSORY_GAP,
    },
});

export type FloatingTabBarSurfaceProps = Readonly<{
    children: React.ReactNode;
    bottomInset: number;
    /**
     * The bar sits on an opaque reserved band (in-flow cockpit chrome). The band
     * itself is painted by the chrome host so it can fade independently; this flag
     * only softens the cast shadow, which reads too strong over the opaque band.
     */
    opaqueBand?: boolean;
    /**
     * Optional sibling capsule rendered to the right of the bar — the iOS 26 shape, where the
     * search button is its own capsule next to the tab bar rather than a tab inside it. Omitted by
     * default: every other bottom bar renders the bar alone, and the tree stays flat for them.
     */
    trailingAccessory?: React.ReactNode;
    /**
     * The capsule spans the room between the gutters instead of hugging its content: a bar of controls
     * that sit at both ends (the File page's View | Changes … Find · Edit), not a row of equal tabs.
     */
    stretch?: boolean;
    /**
     * The bar floats over a picture or a document (a PDF page, an image), not over the app's own page: arbitrary
     * pixels, so the default glass takes the live-picture coat and its ink holds over white paper in dark and
     * black footage in light. Over the plain page that coat lands on the same paint; customized glass stays as set.
     */
    overPicture?: boolean;
    testID?: string;
}>;

export const FloatingTabBarSurface = React.memo(function FloatingTabBarSurface(props: FloatingTabBarSurfaceProps) {
    const bottomPadding = resolveFloatingTabBarBottomPadding(props.bottomInset, Platform.OS === 'ios');
    // The bar's height, read from its cell only when there is an accessory to size by it.
    const [barHeightPx, setBarHeightPx] = React.useState<number | null>(null);
    const handleBarCellLayout = React.useCallback((event: LayoutChangeEvent) => {
        const height = Math.round(event.nativeEvent.layout.height);
        if (height > 0) setBarHeightPx((current) => (current === height ? current : height));
    }, []);
    const accessoryFootprint = barHeightPx ? { width: barHeightPx } : styles.accessoryFootprintUnmeasured;

    const panel = (
        <GlassPanel
            testID={props.testID}
            radius={TAB_BAR_RADIUS}
            maxWidth={layout.maxWidth}
            softShadow={props.opaqueBand === true}
            style={styles.pill}
            // The outer box sizes the capsule (GlassPanel `frameStyle`); width on `style` only reached the inner surface.
            frameStyle={props.stretch ? styles.pillStretch : undefined}
        >
            {props.children}
        </GlassPanel>
    );
    const bar = props.overPicture === true
        ? <GlassLivePictureBackdropContext.Provider value>{panel}</GlassLivePictureBackdropContext.Provider>
        : panel;

    return (
        <View
            pointerEvents="box-none"
            style={[styles.positioner, { paddingBottom: bottomPadding }]}
        >
            {props.trailingAccessory == null ? <View style={props.stretch ? [styles.pillBounds, styles.pillBoundsStretch] : styles.pillBounds}>{bar}</View> : (
                // Three cells: a content-sized leading spacer, the bar, then the accessory — so the
                // bar stays centred on the SCREEN while the accessory rides the trailing edge.
                // Centring the row as a whole pushes the bar left by half the accessory; the bar is
                // the thing the eye centres on, not the row.
                <View style={styles.accessoryRow}>
                    <View pointerEvents="none" style={[accessoryFootprint, styles.accessoryMirror]} />
                    <View style={styles.accessoryRowBar} onLayout={handleBarCellLayout}>
                        {bar}
                    </View>
                    <View style={accessoryFootprint}>
                        {props.trailingAccessory}
                    </View>
                </View>
            )}
        </View>
    );
});
