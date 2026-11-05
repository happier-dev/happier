import * as React from 'react';
import { Platform } from 'react-native';
import { useRouter } from 'expo-router';

import { createActivitySurfaceSessionRoute } from '@/activity/actions/activitySurfaceTargets';
import {
    resolveDesktopPetOverlayGeometry,
} from '@/components/pets/desktop/desktopPetOverlayGeometry';
import {
    listenDesktopPetOverlayShowMainWindowRequested,
} from '@/components/pets/desktop/bridge/desktopPetOverlayBridge';
import { DesktopPetOverlayRuntime } from '@/components/pets/desktop/runtime/DesktopPetOverlayRuntime';
import { isDesktopPetOverlayWindowContext } from '@/components/pets/desktop/runtime/isDesktopPetOverlayWindowContext';
import { resolveDesktopPetOverlayPolicy } from '@/components/pets/desktop/policy/resolveDesktopPetOverlayPolicy';
import { usePetCompanionActivityModel } from '@/components/pets/activity';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { useLocalSetting, useSetting } from '@/sync/domains/state/storage';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useDesktopHostRoleAvailability } from '@/utils/platform/desktopHost';

function useDesktopPetOverlayMainWindowRequests(): void {
    const router = useRouter();
    const actionExecutor = React.useMemo(
        () => createDefaultActionExecutor({
            resolveServerIdForSessionId: resolveServerIdForSessionIdFromLocalCache,
            openSession: (sessionId, options) => {
                router.push(createActivitySurfaceSessionRoute(sessionId, options?.serverId, options?.query) as never);
            },
        }),
        [router],
    );

    React.useEffect(() => {
        let active = true;
        let unsubscribe: (() => void) | null = null;

        listenDesktopPetOverlayShowMainWindowRequested((payload) => {
            const sessionId = typeof payload.targetSessionId === 'string' ? payload.targetSessionId.trim() : '';
            if (!sessionId) return;
            const serverId = typeof payload.targetServerId === 'string' ? payload.targetServerId.trim() : '';

            fireAndForget(actionExecutor.execute(
                'session.open',
                { sessionId },
                {
                    defaultSessionId: sessionId,
                    ...(serverId ? { serverId } : {}),
                },
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
    const host = useDesktopHostRoleAvailability('pet');
    if (Platform.OS !== 'web' || host?.kind !== 'available' || isDesktopPetOverlayWindowContext()) {
        return null;
    }

    return <TauriDesktopPetOverlayRuntimeMount />;
}

function TauriDesktopPetOverlayRuntimeMount(): React.ReactElement | null {
    const petsEnabled = useSetting('petsEnabled');
    const petsDesktopOverlayDefaultEnabled = useSetting('petsDesktopOverlayDefaultEnabled');
    const petsEnabledOverride = useLocalSetting('petsEnabledOverride');
    const desktopPetOverlayEnabledOverride = useLocalSetting('desktopPetOverlayEnabledOverride');
    const desktopPetOverlayAnchor = useLocalSetting('desktopPetOverlayAnchor');
    const desktopPetOverlayLocked = useLocalSetting('desktopPetOverlayLocked');
    const petsCompanionSizeScale = useLocalSetting('petsCompanionSizeScale');
    const companionEnabled = useFeatureEnabled('pets.companion');
    const policy = React.useMemo(() => resolveDesktopPetOverlayPolicy({
        companionFeatureState: companionEnabled ? 'enabled' : 'disabled',
        accountSettings: { petsEnabled, petsDesktopOverlayDefaultEnabled },
        localSettings: {
            petsEnabledOverride,
            desktopPetOverlayEnabledOverride,
            desktopPetOverlayAnchor,
            desktopPetOverlayLocked,
        },
    }), [
        companionEnabled,
        petsEnabled,
        petsDesktopOverlayDefaultEnabled,
        petsEnabledOverride,
        desktopPetOverlayEnabledOverride,
        desktopPetOverlayAnchor,
        desktopPetOverlayLocked,
    ]);
    if (!policy.enabled) {
        return null;
    }

    return (
        <TauriDesktopPetOverlayRuntime
            policy={policy}
            companionSizeScale={petsCompanionSizeScale}
        />
    );
}

function TauriDesktopPetOverlayRuntime({
    policy,
    companionSizeScale,
}: Readonly<{
    policy: ReturnType<typeof resolveDesktopPetOverlayPolicy>;
    companionSizeScale: number;
}>): React.ReactElement {
    const activity = usePetCompanionActivityModel();
    useDesktopPetOverlayMainWindowRequests();
    const visible = policy.enabled;
    const expanded = activity.trayItems.length > 0;
    const nativeMouseTrackingEnabled =
        visible
        && policy.enabled
        && !policy.inputLocked
        && activity.trayItems.length > 0;
    const geometry = React.useMemo(
        () => resolveDesktopPetOverlayGeometry(companionSizeScale),
        [companionSizeScale],
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
            policy={policy}
        />
    );
}
