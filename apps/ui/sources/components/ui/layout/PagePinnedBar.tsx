import * as React from 'react';
import { View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import { FloatingChromeClearanceReservedContext, useFloatingChromeClearanceReservation } from '@/components/ui/layout/useFloatingChromeClearance';
import { PageBarFoldedChrome, useClaimPhoneBottomForPageBar } from '@/components/navigation/mobile/chrome/PageBarFoldedChrome';

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
    const paddingBottom = reserved
        ? theme.space.s12 + clearance
        : Math.max(theme.space.s12, insets.bottom);
    return (
        <View testID={props.testID} style={[styles.bar, { paddingBottom, backgroundColor: materialColor(theme.colors.surface.base, 'transparent') }]}>
            <View style={styles.row}>
                {claimsBottom ? <PageBarFoldedChrome style={styles.folded} /> : null}
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
    folded: {
        paddingTop: theme.space.s12,
        paddingLeft: theme.space.s8,
    },
    // The bar's own insets sit with its contents, where a consumer's `style` can change them.
    content: {
        flex: 1,
        minWidth: 0,
        paddingTop: theme.space.s12,
        paddingHorizontal: theme.space.s16,
    },
}));
