import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';
import type { Href } from 'expo-router';

import { useDestinationFocus } from '@/components/appShell/workspace/destinationInstanceContext';
import { DefaultBackButton } from '@/components/navigation/Header';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';
import { useDeviceType } from '@/utils/platform/responsive';
import type { NavigationBackControl } from './NavigationBackChrome';

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
 * The Back of a phone page that a tab bar does not follow to and that hides the native header (a More
 * destination): its page head is the only way out, and a direct load with no history goes to `fallbackHref`
 * (Home unless the page names the thing it belongs to). Null on wider hosts, which keep whatever Back they inherit.
 */
export function usePhoneDestinationBack(testID: string, fallbackHref: Href = '/'): NavigationBackControl | null {
    const router = useRouter();
    const phone = useDeviceType() === 'phone';
    const control = usePageBackControl(testID, () => safeRouterBack({ router, fallbackHref }));
    return phone ? control : null;
}

const backLineStyles = StyleSheet.create((theme) => ({
    // The same line a pushed page's bar gives its Back: the glyph on the page's edge, its target past it.
    line: {
        flexDirection: 'row',
        alignItems: 'center',
        height: HAPPIER_PAGE_METRICS.paneHeaderUnderNativeChromeHeightPx,
        paddingLeft: theme.space.s16,
    },
}));

/** A phone destination's Back on its own line, above a page that has no page header to carry it. */
export function PhoneDestinationBackLine(props: Readonly<{ control: NavigationBackControl | null }>) {
    const Control = props.control;
    return Control ? <Control style={backLineStyles.line} /> : null;
}
