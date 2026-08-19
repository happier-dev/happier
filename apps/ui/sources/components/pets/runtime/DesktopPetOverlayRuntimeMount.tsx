import * as React from 'react';
import { Platform } from 'react-native';

import {
    resolveDesktopPetOverlayGeometry,
} from '@/components/pets/desktop/desktopPetOverlayGeometry';
import {
    listenDesktopPetOverlayShowMainWindowRequested,
} from '@/components/pets/desktop/bridge/desktopPetOverlayBridge';
import { DesktopPetOverlayRuntime } from '@/components/pets/desktop/runtime/DesktopPetOverlayRuntime';
import { isDesktopPetOverlayWindowContext } from '@/components/pets/desktop/runtime/isDesktopPetOverlayWindowContext';
import { resolveDesktopPetOverlayPolicy } from '@/components/pets/desktop/policy/resolveDesktopPetOverlayPolicy';
import { buildPetCompanionActivityState } from '@/components/pets/state/buildPetCompanionActivityState';
import {
    usePetCompanionActivityState,
    type PetCompanionActivityState,
} from '@/components/pets/state/usePetCompanionActivityState';
import { useSelectedPetPackage } from '@/components/pets/source/useSelectedPetPackage';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { useLocalSettings, useSettings } from '@/sync/domains/state/storage';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { isTauriDesktop } from '@/utils/platform/tauri';

const EMPTY_DESKTOP_PET_ACTIVITY: PetCompanionActivityState = {
    state: 'idle',
    reason: 'idle',
    sessionId: null,
    trayItems: [],
};

function shouldShowDesktopPetOverlay(params: Readonly<{
    policy: ReturnType<typeof resolveDesktopPetOverlayPolicy>;
    activity: ReturnType<typeof buildPetCompanionActivityState>;
}>): boolean {
    if (!params.policy.enabled) return false;
    if (params.policy.visibilityMode === 'alwaysWhenEnabled') return true;
    if (params.policy.visibilityMode === 'attentionOnly') {
        return params.activity.state === 'waiting' || params.activity.state === 'failed' || params.activity.state === 'review';
    }
    return params.activity.state !== 'idle' || params.activity.sessionId !== null;
}

function useDesktopPetOverlayMainWindowRequests(): void {
    const navigateToSession = useNavigateToSession();
    const actionExecutor = React.useMemo(
        () => createDefaultActionExecutor({
            resolveServerIdForSessionId: resolveServerIdForSessionIdFromLocalCache,
            openSession: (sessionId) => navigateToSession(sessionId),
        }),
        [navigateToSession],
    );

    React.useEffect(() => {
        let active = true;
        let unsubscribe: (() => void) | null = null;

        listenDesktopPetOverlayShowMainWindowRequested((payload) => {
            const sessionId = typeof payload.targetSessionId === 'string' ? payload.targetSessionId.trim() : '';
            if (!sessionId) return;

            fireAndForget(actionExecutor.execute(
                'session.open',
                { sessionId },
                { defaultSessionId: sessionId },
            ), {
                tag: 'DesktopPetOverlayRuntimeMount.openRequestedSession',
            });
        }).then((nextUnsubscribe) => {
            if (!active) {
                nextUnsubscribe();
                return;
            }
            unsubscribe = nextUnsubscribe;
        }).catch(() => undefined);

        return () => {
            active = false;
            unsubscribe?.();
        };
    }, [actionExecutor]);
}

export function DesktopPetOverlayRuntimeMount(): React.ReactElement | null {
    if (Platform.OS !== 'web' || !isTauriDesktop() || isDesktopPetOverlayWindowContext()) {
        return null;
    }

    return <TauriDesktopPetOverlayRuntimeMount />;
}

function TauriDesktopPetOverlayRuntimeMount(): React.ReactElement {
    const settings = useSettings();
    const localSettings = useLocalSettings();
    const companionEnabled = useFeatureEnabled('pets.companion');
    const selectedPetPackage = useSelectedPetPackage();
    const policy = React.useMemo(() => resolveDesktopPetOverlayPolicy({
        companionFeatureState: companionEnabled ? 'enabled' : 'disabled',
        accountSettings: settings,
        localSettings,
    }), [companionEnabled, localSettings, settings]);
    const compactGeometry = React.useMemo(
        () => resolveDesktopPetOverlayGeometry(localSettings.petsCompanionSizeScale),
        [localSettings.petsCompanionSizeScale],
    );
    const compactWindow = React.useMemo(() => ({
        width: compactGeometry.windowWidth,
        height: compactGeometry.windowHeight,
    }), [compactGeometry.windowHeight, compactGeometry.windowWidth]);

    if (!policy.enabled || !selectedPetPackage.enabled || !selectedPetPackage.source) {
        return (
            <DesktopPetOverlayRuntime
                visible={false}
                expanded={false}
                window={compactWindow}
                nativeMouseTrackingEnabled={false}
                activity={EMPTY_DESKTOP_PET_ACTIVITY}
                policy={policy}
            />
        );
    }

    return (
        <TauriDesktopPetOverlayActivityRuntimeMount
            localSettings={localSettings}
            policy={policy}
        />
    );
}

function TauriDesktopPetOverlayActivityRuntimeMount(props: Readonly<{
    localSettings: ReturnType<typeof useLocalSettings>;
    policy: ReturnType<typeof resolveDesktopPetOverlayPolicy>;
}>): React.ReactElement {
    const activity = usePetCompanionActivityState();
    useDesktopPetOverlayMainWindowRequests();
    const visible = shouldShowDesktopPetOverlay({ policy: props.policy, activity });
    const expanded = activity.trayItems.length > 0;
    const nativeMouseTrackingEnabled =
        visible
        && props.policy.enabled
        && !props.policy.inputLocked
        && activity.trayItems.length > 0;
    const geometry = React.useMemo(
        () => resolveDesktopPetOverlayGeometry(props.localSettings.petsCompanionSizeScale),
        [props.localSettings.petsCompanionSizeScale],
    );
    const window = expanded
        ? {
            width: geometry.expandedWindowWidth,
            height: geometry.expandedWindowHeight,
        }
        : {
            width: geometry.windowWidth,
            height: geometry.windowHeight,
        };

    return (
        <DesktopPetOverlayRuntime
            visible={visible}
            expanded={expanded}
            window={window}
            nativeMouseTrackingEnabled={nativeMouseTrackingEnabled}
            activity={activity}
            policy={props.policy}
        />
    );
}
