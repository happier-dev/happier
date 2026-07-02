import * as React from 'react';
import { Platform } from 'react-native';

import { ActivityBadgeRuntime } from '@/activity/badges/ActivityBadgeRuntime';
import { ActivityLocalNotificationRuntime } from '@/activity/notifications/runtime/ActivityLocalNotificationRuntime';
import { DesktopActivityOverlayRuntime } from '@/activity/adapters/desktop/runtime/DesktopActivityOverlayRuntime';
import { ReleaseNotesAutoShowMount } from '@/changelog/releaseNotes';
import { DesktopTrayRuntime } from '@/desktop/tray/DesktopTrayRuntime';
import { DesktopTrayDaemonLifecycleRuntime } from '@/desktop/tray/DesktopTrayDaemonLifecycleRuntime';
import { DesktopPetOverlayRuntimeMount } from '@/components/pets/runtime/DesktopPetOverlayRuntimeMount';
import { PetAppShellCompanionMount } from '@/components/pets/runtime/PetAppShellCompanionMount';

type ActivitySurfacesRuntimeComponent = React.ComponentType;

const IosActivitySurfacesRuntimeMount = React.memo(function IosActivitySurfacesRuntimeMount() {
    const [Runtime, setRuntime] = React.useState<ActivitySurfacesRuntimeComponent | null>(null);

    React.useEffect(() => {
        if (Platform.OS !== 'ios') {
            setRuntime(null);
            return;
        }

        let mounted = true;
        void import('@/activity/adapters/ios/runtime/ActivitySurfacesRuntime').then((module) => {
            if (mounted) setRuntime(() => module.ActivitySurfacesRuntime);
        });
        return () => {
            mounted = false;
        };
    }, []);

    if (Platform.OS !== 'ios' || Runtime === null) return null;
    return <Runtime />;
});

export const AuthenticatedAppRuntimeMounts = React.memo(function AuthenticatedAppRuntimeMounts(props: Readonly<{
    isAuthenticated: boolean;
    isTauriDesktopHost: boolean;
}>) {
    return (
        <>
            <ActivityBadgeRuntime />
            <IosActivitySurfacesRuntimeMount />
            <ActivityLocalNotificationRuntime />
            <DesktopPetOverlayRuntimeMount />
            <PetAppShellCompanionMount />
            {props.isAuthenticated ? <ReleaseNotesAutoShowMount /> : null}
            {props.isTauriDesktopHost ? (
                <>
                    <DesktopTrayRuntime />
                    <DesktopTrayDaemonLifecycleRuntime />
                    <DesktopActivityOverlayRuntime />
                </>
            ) : null}
        </>
    );
});
