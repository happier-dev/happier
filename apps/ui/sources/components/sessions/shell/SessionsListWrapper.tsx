import { useIsFocused } from '@react-navigation/native';
import { usePathname } from 'expo-router';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useSessionListStorageKind } from '@/components/sessions/model/useSessionListStorageKind';
import { SessionsListStorageChrome } from '@/components/sessions/shell/SessionsListStorageChrome';
import { SessionsListPaneContent } from '@/components/sessions/shell/SessionsListPaneContent';
import {
    resolvePhoneRootSessionListSurfaceDataActive,
    resolveSessionListSurfaceOwnership,
    SESSION_LIST_SURFACE_OWNER_PHONE_ROOT,
} from '@/components/sessions/shell/surface/sessionListSurfaceOwnership';

const stylesheet = StyleSheet.create(() => ({
    container: {
        flex: 1,
    },
}));

export function SessionsListWrapper(props: Readonly<{
    pathname?: string;
}> = {}) {
    const { externalSessionsEnabled, storageKind, setStorageKind } = useSessionListStorageKind();
    const isFocused = useIsFocused();
    const routePathname = usePathname();
    const surfaceOwnership = resolveSessionListSurfaceOwnership({
        ownerKey: SESSION_LIST_SURFACE_OWNER_PHONE_ROOT,
        interactiveOwnerKey: SESSION_LIST_SURFACE_OWNER_PHONE_ROOT,
        visible: true,
        dataActive: isFocused && resolvePhoneRootSessionListSurfaceDataActive(routePathname),
    });
    const styles = stylesheet;

    return (
        <View style={styles.container}>
            <SessionsListStorageChrome
                externalSessionsEnabled={externalSessionsEnabled}
                storageKind={storageKind}
                onSelectStorageKind={setStorageKind}
            />
            <SessionsListPaneContent
                storageKind={storageKind}
                fallbackGuidanceVariant="phone"
                pathname={props.pathname}
                surfaceRoutePathname={routePathname}
                sessionListSurfaceDataActive={surfaceOwnership.dataActive}
                surfaceOwnership={surfaceOwnership}
            />
        </View>
    );
}
