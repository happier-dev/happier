import { useIsFocused } from '@/components/appShell/workspace/destinationRoute';
import { usePathname } from '@/components/appShell/workspace/destinationRoute';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { SessionsListPaneContent } from '@/components/sessions/shell/SessionsListPaneContent';
import {
    resolvePhoneRootSessionListSurfaceDataActive,
    resolveSessionListSurfaceOwnership,
    SESSION_LIST_SURFACE_OWNER_PHONE_ROOT,
} from '@/components/sessions/shell/surface/sessionListSurfaceOwnership';
import {
    isOverlaySurfaceRoutePathname,
    useSurfaceAnchorPathname,
} from '@/components/sessions/shell/surface/sessionSurfaceAnchorPathname';

const stylesheet = StyleSheet.create(() => ({
    container: {
        flex: 1,
    },
}));

export function SessionsListWrapper(props: Readonly<{
    pathname?: string;
}> = {}) {
    const isFocused = useIsFocused();
    const routePathname = usePathname();
    const anchorPathname = useSurfaceAnchorPathname(routePathname);
    const overlayRouteActive = isOverlaySurfaceRoutePathname(routePathname);
    // An overlay route (the new-session modal and friends) is presented *over* the root list, so the
    // list is still on screen behind it: keep it painted with its last active snapshot instead of
    // blanking, while `dataActive` stays false so it freezes rather than keeping subscriptions live.
    const anchoredToPhoneRoot = resolvePhoneRootSessionListSurfaceDataActive(anchorPathname);
    const surfaceOwnership = resolveSessionListSurfaceOwnership({
        ownerKey: SESSION_LIST_SURFACE_OWNER_PHONE_ROOT,
        interactiveOwnerKey: SESSION_LIST_SURFACE_OWNER_PHONE_ROOT,
        visible: isFocused || (anchoredToPhoneRoot && overlayRouteActive),
        dataActive: isFocused && anchoredToPhoneRoot && !overlayRouteActive,
    });
    const styles = stylesheet;

    return (
        <View style={styles.container}>
            <SessionsListPaneContent
                fallbackGuidanceVariant="phone"
                pathname={props.pathname}
                surfaceRoutePathname={routePathname}
                sessionListSurfaceDataActive={surfaceOwnership.dataActive}
                surfaceOwnership={surfaceOwnership}
            />
        </View>
    );
}
