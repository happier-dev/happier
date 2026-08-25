import * as React from 'react';
import { Platform } from 'react-native';

import { ActivityBadgeRuntime } from '@/activity/badges/ActivityBadgeRuntime';
import { ActivityLocalNotificationRuntime } from '@/activity/notifications/runtime/ActivityLocalNotificationRuntime';
import { PushNotificationPermissionPrimingRuntime } from '@/activity/notifications/permission/PushNotificationPermissionPrimingRuntime';
import { DesktopActivityOverlayRuntime } from '@/activity/adapters/desktop/runtime/DesktopActivityOverlayRuntime';
import { ReleaseNotesAutoShowMount } from '@/changelog/releaseNotes';
import { OnboardingShowcaseAutoShowMount } from '@/onboarding/showcase';
import { DesktopTrayRuntime } from '@/desktop/tray/DesktopTrayRuntime';
import { DesktopTrayDaemonLifecycleRuntime } from '@/desktop/tray/DesktopTrayDaemonLifecycleRuntime';
import { CompanionNoDragRegionProvider } from '@/components/companion/interaction/CompanionNoDragRegion';
import { DesktopPetOverlayRuntimeMount } from '@/components/pets/runtime/DesktopPetOverlayRuntimeMount';
import { PetAppShellCompanionMount } from '@/components/pets/runtime/PetAppShellCompanionMount';
import { VoiceOrbAppShellMount } from '@/components/voice/orb/VoiceOrbAppShellMount';
import { useLocalDaemonControl } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { DesktopBrowserRecordingReverseCaptureRuntime } from '@/sync/domains/browser/recording/DesktopBrowserRecordingReverseCaptureRuntime';
import { resolveVerifiedLocalBrowserRecordingCaptureMachineId } from '@/sync/domains/browser/recording/localReverseCaptureOwnership';
import { storage, useAllMachines } from '@/sync/domains/state/storage';
import { CurrentSessionPresentationRuntime } from '@/components/sessions/presentation/CurrentSessionPresentationRuntime';
import { ActionOperationRuntime } from '@/sync/domains/actionOperations/actionOperationRuntime';

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

function DesktopBrowserRecordingReverseCaptureRuntimeMount(): React.ReactElement {
    const localDaemonControl = useLocalDaemonControl();
    const activeServerSnapshot = useActiveServerSnapshot();
    const uiAccountId = storage((state) => state.profile?.id ?? null);
    const activeServerMachines = useAllMachines();
    const daemonMachineId = localDaemonControl.status?.machineId?.trim() ?? '';
    const isMachineVisibleOnActiveServer = React.useMemo(
        () => Boolean(
            daemonMachineId
            && activeServerMachines.some((machine) => machine.id.trim() === daemonMachineId),
        ),
        [activeServerMachines, daemonMachineId],
    );
    const verifiedMachineId = React.useMemo(
        () => resolveVerifiedLocalBrowserRecordingCaptureMachineId({
            daemonStatus: localDaemonControl.status,
            activeRelayUrl: activeServerSnapshot.serverUrl,
            activeLocalRelayUrl: activeServerSnapshot.activeLocalRelayUrl,
            uiAccountId,
            isMachineVisibleOnActiveServer,
        }),
        [
            activeServerSnapshot.activeLocalRelayUrl,
            activeServerSnapshot.serverUrl,
            isMachineVisibleOnActiveServer,
            localDaemonControl.status,
            uiAccountId,
        ],
    );
    return (
        <DesktopBrowserRecordingReverseCaptureRuntime
            machineId={verifiedMachineId}
        />
    );
}

export const AuthenticatedAppRuntimeMounts = React.memo(function AuthenticatedAppRuntimeMounts(props: Readonly<{
    isAuthenticated: boolean;
    isDesktopShell: boolean;
}>) {
    return (
        <>
            <ActivityBadgeRuntime />
            <IosActivitySurfacesRuntimeMount />
            <ActivityLocalNotificationRuntime />
            <OnboardingShowcaseAutoShowMount />
            {props.isAuthenticated ? <ActionOperationRuntime /> : null}
            {props.isAuthenticated ? <PushNotificationPermissionPrimingRuntime /> : null}
            {props.isAuthenticated ? <CurrentSessionPresentationRuntime /> : null}
            <DesktopPetOverlayRuntimeMount />
            {/*
              * One no-drag registry for every floating companion in the app shell. The pet and the
              * Voice orb both start drags from measured rects, and a provider per companion would
              * mean each one only sees its own subtree's regions.
              */}
            <CompanionNoDragRegionProvider>
                <PetAppShellCompanionMount />
                <VoiceOrbAppShellMount />
            </CompanionNoDragRegionProvider>
            {props.isAuthenticated ? <ReleaseNotesAutoShowMount /> : null}
            {props.isAuthenticated && props.isDesktopShell ? (
                <DesktopBrowserRecordingReverseCaptureRuntimeMount />
            ) : null}
            {props.isDesktopShell ? (
                <>
                    <DesktopTrayRuntime />
                    <DesktopTrayDaemonLifecycleRuntime />
                    <DesktopActivityOverlayRuntime />
                </>
            ) : null}
        </>
    );
});
