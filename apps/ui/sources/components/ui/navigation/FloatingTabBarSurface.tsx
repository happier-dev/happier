import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { GlassPanel } from '@/components/ui/glass/GlassPanel';
import { layout } from '@/components/ui/layout/layout';
import { resolveTrustedWebSafeAreaBottomInset } from '@/utils/platform/webSafeAreaInset';
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
const FLOATING_TOP_GAP = 6;
// Capsule inner padding. Combined with the active-highlight inset (CockpitTabBar/
// TabBar `activePill`: left/right 4, top/bottom 3) this sets the gap from the
// capsule rim to a selected tab at the edge: H = 2 + 4 = 6, V = 1 + 3 = 4.
const PILL_PADDING_VERTICAL = 1;
const PILL_PADDING_HORIZONTAL = 2;
// Breathing room between the bar and a sibling capsule. iOS 26 sets its search
// button off the tab bar by roughly this much, and it matches the widest tab gap
// so the two capsules read as one system rather than one control cut in half.
const ACCESSORY_GAP = 8;
// Extra breathing room at the row's edges, on top of `FLOATING_SIDE_GUTTER`. Applied to BOTH sides,
// never just the trailing one: the leading spacer mirrors the accessory to keep the bar centred, so
// an asymmetric inset would walk the bar off-centre by exactly this much.
const ACCESSORY_EDGE_INSET = 8;

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
    accessoryRow: {
        flexDirection: 'row',
        // `stretch` is load-bearing, not cosmetic: the chrome host publishes this
        // row's measured height into `SessionCockpitChromeRegistry`, and the session
        // list padding, settings footer, composer reservation and selection action
        // bar all pad by it. The accessory is sized BY the bar height here, so it can
        // never become the tallest child and silently move those four surfaces.
        alignItems: 'stretch',
        alignSelf: 'stretch',
        paddingHorizontal: ACCESSORY_EDGE_INSET,
    },
    // A mirror of the accessory's footprint on the leading edge. Sized the same way it is
    // (square, stretched to the row height) rather than by a flex weight, so the two edges
    // stay equal at every tab-bar size WITHOUT measuring anything — which is what keeps the
    // bar centred on the SCREEN instead of centred in the space the accessory leaves over.
    // Flexible side cells were the first attempt and clip the "+" on a narrow phone, because
    // a 4-tab bar leaves each side less than the accessory's own width.
    accessoryLeadingSpacer: {
        aspectRatio: 1,
    },
    accessoryRowBar: {
        // The bar is the only cell that absorbs a narrow viewport (its tabs already shrink);
        // the accessory keeps its square footprint so the "+" never squashes.
        flex: 1,
        flexShrink: 1,
        alignItems: 'center',
        justifyContent: 'center',
        marginHorizontal: ACCESSORY_GAP,
    },
});

export type FloatingTabBarSurfaceProps = Readonly<{
    children: React.ReactNode;
    bottomInset: number;
    /**
     * Gap between the capsule top and the content above the bar. Defaults to the
     * standard float gap; a bar that docks directly beneath fixed content (the
     * session composer's status row) passes a tighter gap.
     */
    topGap?: number;
    /**
     * The bar sits on an opaque reserved band (in-flow cockpit chrome). The band
     * itself is painted by the chrome host so it can fade independently; this flag
     * only softens the cast shadow, which reads too strong over the opaque band.
     */
    opaqueBand?: boolean;
    /**
     * Optional sibling capsule rendered to the right of the bar — the iOS 26 shape,
     * where the search button is its own capsule next to the tab bar rather than a
     * tab inside it. Omitted by default: every other bottom bar renders the bar
     * alone, and the tree stays flat for them.
     */
    trailingAccessory?: React.ReactNode;
    testID?: string;
}>;

export const FloatingTabBarSurface = React.memo(function FloatingTabBarSurface(props: FloatingTabBarSurfaceProps) {
    // On web the bottom safe-area inset is only trustworthy on iOS browsers (see
    // webSafeAreaInset.ts): Firefox Android reports the on-screen nav bar as the bottom inset
    // even though the viewport never extends under it, which used to leave a dead band under
    // the floating capsule.
    const trustedBottomInset = Platform.OS === 'web'
        ? resolveTrustedWebSafeAreaBottomInset(props.bottomInset)
        : props.bottomInset;
    const bottomPadding = resolveFloatingTabBarBottomPadding(trustedBottomInset, Platform.OS === 'ios');

    const bar = (
        <GlassPanel
            testID={props.testID}
            radius={TAB_BAR_RADIUS}
            maxWidth={layout.maxWidth}
            softShadow={props.opaqueBand === true}
            style={styles.pill}
        >
            {props.children}
        </GlassPanel>
    );

    return (
        <View
            pointerEvents="box-none"
            style={[styles.positioner, { paddingTop: props.topGap ?? FLOATING_TOP_GAP, paddingBottom: bottomPadding }]}
        >
            {props.trailingAccessory == null ? bar : (
                // Three cells: two equal flexible sides with the bar between them, so the bar stays
                // centred on the SCREEN while the accessory rides the trailing cell's far edge.
                // Centring the row as a whole (the first attempt) pushed the bar left by half the
                // accessory — the bar is the thing the eye centres on, not the row.
                <View style={styles.accessoryRow}>
                    <View pointerEvents="none" style={styles.accessoryLeadingSpacer} />
                    <View style={styles.accessoryRowBar}>
                        {bar}
                    </View>
                    {props.trailingAccessory}
                </View>
            )}
        </View>
    );
});
