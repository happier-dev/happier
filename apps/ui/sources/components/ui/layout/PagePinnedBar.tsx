import * as React from 'react';
import { View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { FloatingChromeClearanceReservedContext, useFloatingChromeClearanceReservation } from '@/components/ui/layout/useFloatingChromeClearance';
import { PageBarFoldedChrome, useClaimPhoneBottomForPageBar } from '@/components/navigation/mobile/chrome/PageBarFoldedChrome';
import { resolveTabBarMetrics } from '@/components/ui/navigation/tabBarMetrics';
import { useSetting } from '@/sync/domains/state/storage';

/**
 * The page gutter a pinned bar stands in (a plugin page's frame pads its content by it): the bar spans it, so it
 * meets the window edges like a core page's bar, and its contents keep the bar's own inset.
 */
export const PagePinnedBarGutterContext = React.createContext(0);

/**
 * A page's pinned action bar: a sibling below the page's scroll, never scrolled off, on the page's
 * material under a hairline. It owns how that bar clears the bottom of the screen, so no page does the
 * arithmetic itself:
 * - the phone's floating tab bar overlays the page, so the bar reserves its measured height (the same
 *   reservation `ItemList` makes for its last rows), unless the bar is inside a modal that covers it;
 * - with no such chrome the bar clears the system safe area instead.
 * Consumers pass the bar's contents, and `style` for a horizontal inset their surface calls for.
 * On a phone it is the one bottom chrome while on screen: the shell's bar folds, and a detail page's way
 * between its pages comes along as one More beside the contents.
 */
export function PagePinnedBar(props: Readonly<Pick<ViewProps, 'testID' | 'children'> & { style?: StyleProp<ViewStyle> }>) {
    const { theme } = useUnistyles();
    // The bar stands on the page's material: clear under glass, the page surface without it (never its own band).
    const materialColor = useHappierMaterialColorResolver();
    const insets = useChromeSafeAreaInsets();
    const { clearance, reserved } = useFloatingChromeClearanceReservation();
    const claimsBottom = useClaimPhoneBottomForPageBar();
    const gutter = React.useContext(PagePinnedBarGutterContext);
    // The folded tab's widest ink (its label, "Overview") starts on the page gutter, as the contents' own inset does:
    // the tab's padding is taken back from that gutter, so a label wider than its tab's floor never reaches the edge.
    const foldedTabPadding = resolveTabBarMetrics(useSetting('tabBarSize'), false).tabPaddingHorizontal;
    const paddingBottom = reserved
        ? theme.space.s12 + clearance
        : Math.max(theme.space.s12, insets.bottom);
    return (
        <View testID={props.testID} style={[styles.bar, { paddingBottom, backgroundColor: materialColor(theme.colors.surface.base, 'transparent') },
            gutter === 0 ? null : { marginHorizontal: -gutter }]}>
            <View style={styles.row}>
                {claimsBottom ? <PageBarFoldedChrome style={[styles.folded, { paddingLeft: theme.space.s16 - foldedTabPadding }]} /> : null}
                <View style={[styles.content, props.style]}>
                    <FloatingChromeClearanceReservedContext.Provider value={reserved}>
                        {props.children}
                    </FloatingChromeClearanceReservedContext.Provider>
                </View>
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    bar: {
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.subtle,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    // The folded More stands one gap from the contents, not that gap plus their own leading inset: it reaches into
    // that inset, so a phone's primary keeps its whole label beside it (360, owner 2026-11-11). Its leading inset is
    // set where it is drawn, from the tab's own padding.
    folded: {
        paddingTop: theme.space.s12,
        marginRight: -theme.space.s8,
    },
    // The bar's own insets sit with its contents, where a consumer's `style` can change them.
    content: {
        flex: 1,
        minWidth: 0,
        paddingTop: theme.space.s12,
        paddingHorizontal: theme.space.s16,
    },
}));
