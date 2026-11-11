import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';
import type { Href } from 'expo-router';

import { useDestinationFocus } from '@/components/appShell/workspace/destinationInstanceContext';
import { BACK_GLYPH_INK_INSET_PX, DefaultBackButton } from '@/components/navigation/Header';
import { usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useIsAppDestinationRootPath } from '@/components/appShell/destinations/useCompactAppDestinations';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { useDeviceType } from '@/utils/platform/responsive';
import type { NavigationBackControl } from './NavigationBackChrome';
import { useChromeSafeAreaInsets } from './useChromeSafeAreaInsets';

function PageBackControl(props: Readonly<{ style: React.ComponentProps<NavigationBackControl>['style']; testID: string; onBackRef: React.RefObject<() => void> }>) {
    const { theme } = useUnistyles();
    // A retained destination that is not in front must not draw (or publish) a Back of its own.
    const focused = useDestinationFocus();
    return focused ? (
        <View style={props.style}>
            <DefaultBackButton testID={props.testID} tintColor={theme.colors.text.primary} onPress={() => props.onBackRef.current()} />
        </View>
    ) : null;
}

/**
 * The Back a hosted page hands to `NavigationBackChromeProvider`. A web workspace body has no native
 * header, so the page header draws this on the title line (and the phone's retained bar takes it when
 * it shows the title). The control keeps its identity across renders; `onBack` is read when pressed.
 */
export function usePageBackControl(testID: string, onBack: () => void): NavigationBackControl {
    const onBackRef = React.useRef(onBack);
    onBackRef.current = onBack;
    return React.useCallback(
        ({ style }) => <PageBackControl style={style} testID={testID} onBackRef={onBackRef} />,
        [testID],
    );
}

/**
 * The Back of a phone page that hides the native header: its page head is the way out, and a direct load with
 * no history goes to `fallbackHref` (Home unless the page names the thing it belongs to). A main screen (a rail
 * destination's own route: Boards, Discussions, People) has none: the tab bar is its way around (owner 11-10).
 * Null on wider hosts, which keep whatever Back they inherit.
 */
export function usePhoneDestinationBack(testID: string, fallbackHref: Href = '/'): NavigationBackControl | null {
    const router = useRouter();
    const phone = useDeviceType() === 'phone';
    const mainScreen = useIsAppDestinationRootPath(usePathname());
    const control = usePageBackControl(testID, () => safeRouterBack({ router, fallbackHref }));
    return phone && !mainScreen ? control : null;
}

const backLineStyles = StyleSheet.create(() => ({
    // The same line a pushed page's bar gives its Back: the chevron's ink on the page's text edge, its target past it.
    line: {
        flexDirection: 'row',
        alignItems: 'center',
        height: HAPPIER_PAGE_METRICS.paneHeaderUnderNativeChromeHeightPx,
        paddingLeft: HAPPIER_PAGE_METRICS.pageTextInsetPx - BACK_GLYPH_INK_INSET_PX,
    },
}));

/** A phone destination's Back on its own line, above a page that has no page header to carry it. */
export function PhoneDestinationBackLine(props: Readonly<{ control: NavigationBackControl | null }>) {
    const Control = props.control;
    return Control ? <Control style={backLineStyles.line} /> : null;
}

/**
 * The head line of a whole phone page with no native bar above it (Discussions, Boards): it stands under the
 * status bar, in every state the page shows (its list, or a whole-page state in the list's place). A page it pushes
 * carries its Back there. A main screen has no Back, so it keeps no empty line (owner 11-11: the title sits right
 * under the status bar); only the safe area stays. `page` false (a column beside a page) draws nothing.
 */
export function PhonePageBackLine(props: Readonly<{ control: NavigationBackControl | null; page?: boolean }>) {
    const topInset = useChromeSafeAreaInsets().top;
    const phone = useDeviceType() === 'phone';
    if (!props.control && !(props.page && phone)) return null;
    return (
        <View style={{ paddingTop: topInset }}>
            {props.control ? <PhoneDestinationBackLine control={props.control} /> : null}
        </View>
    );
}
