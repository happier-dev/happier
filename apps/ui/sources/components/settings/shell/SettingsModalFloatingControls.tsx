import * as React from 'react';
import { Platform, Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { usePathname } from '@/components/appShell/workspace/destinationRoute';
import { useDestinationFocus, useDestinationInstanceKey } from '@/components/appShell/workspace/DestinationInstanceHost';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';
import {
    shouldShowSettingsParentBackButton,
    useSettingsParentBack,
} from '@/components/settings/navigation/settingsRouteRegistry';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { DefaultBackButton } from '@/components/navigation/Header';
import { NavigationBackChromeProvider } from '@/components/ui/layout/NavigationBackChrome';
import { useSettingsRailVisible } from './settingsRailVisibility';
import { useNavigationTitleChromePublisher, useNavigationTitleChromeShowsTitle } from '@/components/ui/layout/navigationTitleChrome';

/**
 * The settings back affordance on tablet/desktop, where the settings modal has no navigator header.
 *
 * `PageHeader` places it (`SettingsInlineBackControl`, handed over through `NavigationBackChromeProvider`):
 * in the gutter left of the content column on wide panes, on the title row when the gutter is too
 * narrow (`resolvePageBackPlacement`). A sub-page that has no page header yet gets
 * the same control floating at the content's top-left instead. Top-level categories are reached from
 * the rail, so they get none, and the modal is dismissed through its backdrop or gesture, so there is
 * no close icon. Phones keep the native stack header's back.
 */
function useSettingsBackControl(collectionRootPathname: string | undefined) {
    const pathname = usePathname();
    const hosted = useDestinationInstanceKey() !== null;
    const railVisible = useSettingsRailVisible();
    const { parentPathname, goToParent: handleBack } = useSettingsParentBack('SettingsModalFloatingControls.back');
    // In a list-detail section's split layout, neither the section's own page (landing, loading or
    // empty) nor a detail whose parent is that list gets a back control: the list or the settings
    // sidebar is already beside it. Once the section is pushed (stacked), its page keeps the back.
    const besideCollection = collectionRootPathname !== undefined
        && pathname.replace(/\/+$/, '') === collectionRootPathname;
    const visible = shouldShowSettingsParentBackButton({ pathname, hideOnTopLevel: !hosted || railVisible })
        && parentPathname !== null
        && parentPathname !== collectionRootPathname
        && !besideCollection;
    return { visible, handleBack };
}

const SettingsBackButton = React.memo(function SettingsBackButton(props: Readonly<{
    onPress: () => void;
    iconSize: number;
    style?: StyleProp<ViewStyle>;
}>) {
    const { theme } = useUnistyles();
    return (
        <Pressable
            testID="settings-modal-back"
            accessibilityRole="button"
            accessibilityLabel={t('common.back')}
            hitSlop={10}
            onPress={props.onPress}
            style={[styles.backButton, props.style]}
        >
            <Icon
                name={Platform.OS === 'ios' ? 'caret-left' : 'arrow-left'}
                size={props.iconSize}
                color={theme.colors.chrome.header.foreground}
            />
        </Pressable>
    );
});

/** Back in a phone's navigation bar is the bar's one Back, so a Settings page's arrow sits where every page's does. */
const SettingsBarBackButton = React.memo(function SettingsBarBackButton(props: Readonly<{ onPress: () => void }>) {
    const { theme } = useUnistyles();
    return <DefaultBackButton testID="settings-modal-back" tintColor={theme.colors.chrome.header.foreground} onPress={props.onPress} />;
});

/** The floating back control, for a sub-page that has no page header to carry it. */
export const SettingsModalFloatingControls = React.memo(function SettingsModalFloatingControls(props: Readonly<{
    /**
     * A list-detail section's own path (e.g. `/settings/agents`) when these controls sit in that
     * section's detail pane: its list is already beside the detail, so a detail whose parent is
     * the list gets no back control.
     */
    collectionRootPathname?: string;
}>) {
    const back = useSettingsBackControl(props.collectionRootPathname);
    if (!back.visible) return null;
    return (
        <View pointerEvents="box-none" style={styles.overlay}>
            <SettingsBackButton onPress={back.handleBack} iconSize={ICON_SIZE.lg} />
        </View>
    );
});

type SettingsBackHost = Readonly<{
    setClaimed: (claimed: boolean) => void;
    collectionRootPathname: string | undefined;
}>;

const SettingsFloatingControlsHostContext = React.createContext<SettingsBackHost | null>(null);

/**
 * The back control on a page header's title line. Settings screens stay mounted under the one they
 * pushed, so only the focused screen's header shows it; while it does, the host's floating control
 * steps aside.
 */
const SettingsInlineBackControl = React.memo(function SettingsInlineBackControl(props: Readonly<{
    style: StyleProp<ViewStyle>;
}>) {
    const host = React.useContext(SettingsFloatingControlsHostContext);
    const back = useSettingsBackControl(host?.collectionRootPathname);
    const shown = useClaimSettingsBack(back.visible);
    if (!shown) return null;
    return <NavigationInlineBackButton onPress={back.handleBack} style={props.style} />;
});

/**
 * One Back per page: a page head that draws its own way back (the page header's title-line glyph, or
 * a head with a crumb named for where it returns, such as a machine's pushed pages) takes the settings
 * host's back while it shows, so the floating control steps aside. Only the focused screen claims,
 * since settings screens stay mounted under the one they pushed. Outside a settings host it is a no-op.
 * Returns whether the claim holds (the caller's own back is the page's one Back).
 */
export function useClaimSettingsBack(drawsBack: boolean): boolean {
    const host = React.useContext(SettingsFloatingControlsHostContext);
    const focused = useDestinationFocus();
    const shown = host !== null && drawsBack && focused;
    const setClaimed = host?.setClaimed;
    React.useLayoutEffect(() => {
        if (!shown || !setClaimed) return;
        setClaimed(true);
        return () => setClaimed(false);
    }, [setClaimed, shown]);
    return shown;
}

/**
 * The back glyph on a page header's title line, for any navigation chrome that gives the header its
 * back (`NavigationBackChromeProvider`): Settings pages, and the rail door's machine sub-pages.
 */
export const NavigationInlineBackButton = React.memo(function NavigationInlineBackButton(props: Readonly<{
    onPress: () => void;
    style: StyleProp<ViewStyle>;
}>) {
    return <SettingsBackButton onPress={props.onPress} iconSize={ICON_SIZE.md} style={[styles.inlineBackButton, props.style]} />;
});

const styles = StyleSheet.create(() => ({
    overlay: {
        position: 'absolute',
        top: 4,
        left: 4,
        zIndex: 10,
    },
    backButton: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 8,
        paddingVertical: 6,
    },
    // On the title line the glyph's left edge sits on the page's text edge, like the title it leads.
    inlineBackButton: {
        paddingHorizontal: 4,
        paddingVertical: 0,
        marginLeft: -4,
    },
}));

/**
 * Owns the settings back control for the content it wraps: a page header on the title line claims
 * it, otherwise it floats at the top-left. A list-detail section nests a host (with its own path as
 * `collectionRootPathname`) around its detail while the list is beside it; the nested host takes the
 * control from the outer one, so nothing ever floats over the list. A disabled nested host passes the
 * outer host through, and the tree keeps its shape either way so the wrapped navigator never remounts.
 */
export function SettingsFloatingControlsHost(props: Readonly<{
    enabled: boolean;
    collectionRootPathname?: string;
    children: React.ReactNode;
}>) {
    const parent = React.useContext(SettingsFloatingControlsHostContext);
    const chromeShowsTitle = useNavigationTitleChromeShowsTitle();
    const publisher = useNavigationTitleChromePublisher();
    const back = useSettingsBackControl(undefined);
    const setChromeBack = publisher?.setBack;
    const rootPhoneHost = chromeShowsTitle && props.collectionRootPathname === undefined;
    const navigationBack = React.useMemo(() => back.visible
        ? <SettingsBarBackButton onPress={back.handleBack} /> : null, [back.handleBack, back.visible]);
    React.useEffect(() => {
        if (!rootPhoneHost || !setChromeBack) return;
        setChromeBack(navigationBack);
        return () => setChromeBack(null);
    }, [navigationBack, rootPhoneHost, setChromeBack]);
    const [claims, setClaims] = React.useState(0);
    const setClaimed = React.useCallback((claimed: boolean) => {
        setClaims((count) => Math.max(0, count + (claimed ? 1 : -1)));
    }, []);
    const own = React.useMemo<SettingsBackHost>(() => ({
        setClaimed,
        collectionRootPathname: props.collectionRootPathname,
    }), [props.collectionRootPathname, setClaimed]);
    const active = props.enabled && !chromeShowsTitle;
    const parentSetClaimed = parent?.setClaimed;
    React.useLayoutEffect(() => {
        if (!active || !parentSetClaimed) return;
        parentSetClaimed(true);
        return () => parentSetClaimed(false);
    }, [active, parentSetClaimed]);
    const host = active ? own : parent;
    // A header is handed a back control only when the one visibility rule shows it: a detail whose
    // parent is the collection's root (the list beside it) gets none, so its header keeps no room for one.
    const hostBack = useSettingsBackControl(host?.collectionRootPathname);
    return (
        <SettingsFloatingControlsHostContext.Provider value={host}>
            <NavigationBackChromeProvider control={host && hostBack.visible ? SettingsInlineBackControl : null}>
                {props.children}
            </NavigationBackChromeProvider>
            {active && claims === 0 ? <SettingsModalFloatingControls collectionRootPathname={props.collectionRootPathname} /> : null}
        </SettingsFloatingControlsHostContext.Provider>
    );
}
