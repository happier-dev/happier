import * as React from 'react';
import { Platform } from 'react-native';

import { ActivityBadgeRuntime } from '@/activity/badges/ActivityBadgeRuntime';
import { SessionAttentionReminderRuntime } from '@/activity/attention/runtime/SessionAttentionReminderRuntime';
import { ActivityLocalNotificationRuntime } from '@/activity/notifications/runtime/ActivityLocalNotificationRuntime';
import { PushNotificationPermissionPrimingRuntime } from '@/activity/notifications/permission/PushNotificationPermissionPrimingRuntime';
import { DesktopActivityOverlayRuntime } from '@/activity/adapters/desktop/runtime/DesktopActivityOverlayRuntime';
import { ReleaseNotesAutoShowMount } from '@/changelog/releaseNotes';
import { OnboardingShowcaseAutoShowMount } from '@/onboarding/showcase';
import { tryRenderWebPortal } from '@/components/ui/popover/portal';
import { DesktopPetOverlayRuntimeMount } from '@/components/pets/runtime/DesktopPetOverlayRuntimeMount';
import { PetAppShellCompanionMount } from '@/components/pets/runtime/PetAppShellCompanionMount';
import { VoicePresenceAppShellMount } from '@/components/voice/presence/VoicePresenceAppShellMount';
import { VoiceKeyboardRuntime } from '@/components/voice/attempt/VoiceKeyboardRuntime';
import { useLocalDaemonControl } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { DesktopBrowserRecordingReverseCaptureRuntime } from '@/sync/domains/browser/recording/DesktopBrowserRecordingReverseCaptureRuntime';
import { resolveVerifiedLocalBrowserRecordingCaptureMachineId } from '@/sync/domains/browser/recording/localReverseCaptureOwnership';
import { storage, useAllMachines } from '@/sync/domains/state/storage';
import { CurrentSessionPresentationRuntime } from '@/components/sessions/presentation/CurrentSessionPresentationRuntime';
import { ActionOperationRuntime } from '@/sync/domains/actionOperations/actionOperationRuntime';
import { UpdateFactsBackgroundRuntime } from '@/updates/UpdateFactsBackgroundRuntime';
import { resolveDesktopWindowContext } from '@/desktop/window/isDesktopAuxiliaryWindowContext';
import { useDesktopHomeResponder } from '@/desktop/window/appWindowRuntime';
import { EntityDragRealmPreview } from './EntityDragRealmPreview';
import { ClientActionReverseRuntime } from './ClientActionReverseRuntime';

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
    const context = resolveDesktopWindowContext();
    const homeResponder = useDesktopHomeResponder();
    if (context.role === 'presenter') return null;
    return <>
        {context.role === 'primary' ? <AppWideRuntimeMounts {...props} /> : null}
        {props.isAuthenticated ? <ActionOperationRuntime /> : null}
        {props.isAuthenticated ? <CurrentSessionPresentationRuntime /> : null}
        {props.isAuthenticated ? <VoiceKeyboardRuntime /> : null}
        {props.isAuthenticated ? <EntityDragRealmPreview /> : null}
        {props.isAuthenticated && homeResponder ? <>
            <ClientActionReverseRuntime />
            <UpdateFactsBackgroundRuntime enabled />
            {props.isDesktopShell ? <DesktopBrowserRecordingReverseCaptureRuntimeMount /> : null}
        </> : null}
    </>;
});

/** One retained primary realm owns OS effects, app ingress and automatic presentations. */
function AppWideRuntimeMounts(props: Readonly<{ isAuthenticated: boolean; isDesktopShell: boolean }>) {
    // The route navigator is retained but display:none while the desktop workspace is
    // active. Global floating companions must render outside that hidden DOM branch;
    // the existing web portal preserves their React context and runtime ownership.
    const floatingCompanions = (
        <>
            <PetAppShellCompanionMount />
            <VoicePresenceAppShellMount />
        </>
    );
    return (
        <>
            <ActivityBadgeRuntime />
            {props.isAuthenticated ? <SessionAttentionReminderRuntime /> : null}
            <IosActivitySurfacesRuntimeMount />
            <ActivityLocalNotificationRuntime />
            <OnboardingShowcaseAutoShowMount />
            {props.isAuthenticated ? <PushNotificationPermissionPrimingRuntime /> : null}
            <DesktopPetOverlayRuntimeMount />
            {/*
              * The app root's one no-drag registry covers routed viewers as well as these
              * floating companions. Portaling preserves that same React context.
              */}
            {tryRenderWebPortal({
                shouldPortalWeb: Platform.OS === 'web',
                portalTargetOnWeb: 'body',
                modalPortalTarget: null,
                getBoundaryDomElement: () => null,
                content: floatingCompanions,
            }) ?? floatingCompanions}
            {props.isAuthenticated ? <ReleaseNotesAutoShowMount /> : null}
            {props.isDesktopShell ? <DesktopActivityOverlayRuntime /> : null}
        </>
    );
}
