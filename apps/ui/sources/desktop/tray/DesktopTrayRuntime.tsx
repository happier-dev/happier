import * as React from 'react';

import { useRouter } from 'expo-router';

import { useConnectionHealth } from '@/components/navigation/connectionStatus/useConnectionHealth';
import { buildLocalDaemonServiceSystemTaskSpec } from '@/components/settings/machines/localControl/buildLocalDaemonServiceSystemTaskSpec';
import { describeUpdatesTrayItem } from '@/components/updates/describeUpdatesSummary';
import { UPDATES_ROUTE } from '@/components/updates/updatesRoute';
import { useRelayDriftSummary } from '@/components/settings/server/useRelayDriftSummary';
import { desktopSetupCoordinator } from '@/setup/desktopSetupCoordinator';
import { readManagedLoginStartMode } from '@/setup/deriveDesktopLocalSetupSnapshot';
import { selectRelayDirectly } from '@/setup/directRelaySelectionIntent';
import { countActiveLocalAgentSessions, resolveVisibleSessionMachineId } from '@/setup/resolveDesktopCloseDaemonDecision';
import { listThisComputerRelayRows } from '@/setup/thisComputerRelayRows';
import { getStorage } from '@/sync/domains/state/storageStore';
import { useApplySettings } from '@/sync/store/settingsWriters';
import { useDesktopLocalInspection } from '@/setup/useDesktopLocalInspection';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerSnapshot, resolveServerProfileScopeId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';
import { isTauriDesktop, listenTauriEvent } from '@/utils/platform/tauri';
import { useSharedUpdatesSummary } from '@/updates/useUpdatesSummary';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { lockAppLock, useAppLockSnapshot } from '@/auth/appLock/appLockRuntime';

import { applyTauriTrayState, type DesktopTrayDestination } from './applyTauriTrayState';
import { buildDesktopTrayState } from './buildDesktopTrayState';

/** Emitted by the native tray router (`menu.rs`). */
const DESKTOP_OPEN_UPDATES_REQUESTED_EVENT = 'desktop_open_updates_requested';
const DESKTOP_OPEN_SETTINGS_REQUESTED_EVENT = 'desktop_open_settings_requested';
const DESKTOP_LOCK_NOW_REQUESTED_EVENT = 'desktop_lock_now_requested';
/** Emitted by `menu_bar.rs` after a tray action changed this computer's services. */
const DESKTOP_BACKGROUND_SERVICES_CHANGED_EVENT = 'desktop_background_services_changed';
/** Emitted by the native tray when it is pointed at or opened while this window exists (A12-03). */
const DESKTOP_TRAY_REFRESH_REQUESTED_EVENT = 'desktop_tray_refresh_requested';
/** Emitted by the native tray when a relay row's Open is chosen while this window exists (D11-3). */
const DESKTOP_OPEN_RELAY_REQUESTED_EVENT = 'desktop_open_relay_requested';
const SETTINGS_ROUTE = '/settings';

const DESTINATION_ROUTES: Record<Extract<DesktopTrayDestination, string>, string> = {
    updates: UPDATES_ROUTE,
    settings: SETTINGS_ROUTE,
};

/**
 * A12-02 — the relay a tray row names, as one of this app's relays: the saved profile for it, or a
 * new one registered through the one profile owner (`upsertServerProfile` finds an equivalent URL
 * first). The row is a relay this computer already serves, so picking it never silently does
 * nothing because the app had not saved it yet.
 */
function resolveOrRegisterRelayServerId(relayUrl: string): string | null {
    try {
        return resolveServerProfileScopeId(upsertServerProfile({ serverUrl: relayUrl }));
    } catch {
        // Not a relay URL the profile owner accepts: nothing to pick.
        return null;
    }
}

function readRelayUrl(payload: unknown): string | null {
    const relayUrl = payload && typeof payload === 'object' ? (payload as { relayUrl?: unknown }).relayUrl : null;
    return typeof relayUrl === 'string' && relayUrl.trim() ? relayUrl.trim() : null;
}

function useTauriEvent(event: string, onEvent: (payload: unknown) => void): void {
    React.useEffect(() => {
        let unlisten: (() => void) | null = null;
        let disposed = false;
        void listenTauriEvent<unknown>(event, onEvent).then((stop) => {
            if (disposed) stop();
            else unlisten = stop;
        }).catch(() => {});
        return () => {
            disposed = true;
            unlisten?.();
        };
    }, [event, onEvent]);
}

function TauriDesktopTrayRuntime(): React.ReactElement | null {
    const connectionHealth = useConnectionHealth();
    const appLockEnabled = useAppLockSnapshot().record !== null;
    // The summary projection only: the tray is always mounted, so it must not hold the repair's
    // setup task or prompt handling (`apps/ui/AGENTS.md`).
    const thisComputer = useRelayDriftSummary();
    // The one ambient observation, joined (not started again) — the rows the tray lists (R16 c).
    const { inspection, refresh } = useDesktopLocalInspection(true);
    const updatesItem = describeUpdatesTrayItem(useSharedUpdatesSummary());
    const updatesLabel = updatesItem?.label ?? null;
    const updatesEnabled = updatesItem?.enabled ?? true;
    const router = useRouter();
    const { serverUrl, activeLocalRelayUrl } = getActiveServerSnapshot();
    const appAccountId = getActiveServerAccountScope()?.accountId ?? null;
    // The params the one spec builder produces; the native side replays them in menu-bar mode.
    const taskParams = React.useMemo(() => buildLocalDaemonServiceSystemTaskSpec('daemon.service.status.v1').params as Record<string, unknown>, []);

    const appRelay = React.useMemo(
        () => ({ relayUrl: serverUrl, localRelayUrl: activeLocalRelayUrl ?? null, accountId: appAccountId }),
        [activeLocalRelayUrl, appAccountId, serverUrl],
    );
    const services = React.useMemo(() => listThisComputerRelayRows(inspection, appRelay), [appRelay, inspection]);
    // R16 (c) — the app relay's agent sessions, only when the app can see them (the quit question's
    // one visibility rule). The selector returns a number, so unrelated store changes re-render nothing.
    const visibleMachineId = React.useMemo(() => resolveVisibleSessionMachineId({ inspection, appRelay }), [appRelay, inspection]);
    const appRelaySessionCount = getStorage()((state) => (visibleMachineId && state.isDataReady
        ? countActiveLocalAgentSessions({ sessions: Object.values(state.sessions ?? {}), machineId: visibleMachineId })
        : null));
    // A14-02 — the one login-start setting: every managed service's common mode, from the producer.
    const serviceAutostart = readManagedLoginStartMode(inspection);

    const trayState = React.useMemo(() => buildDesktopTrayState({
        health: {
            kind: connectionHealth.kind,
            machineCount: connectionHealth.machineCount,
            onlineCount: connectionHealth.onlineCount,
            statusLabelKey: connectionHealth.statusLabelKey,
            machineLabelKey: connectionHealth.machineLabelKey,
        },
        thisComputerSentence: thisComputer?.description ?? null,
        updatesItem: updatesLabel ? { label: updatesLabel, enabled: updatesEnabled } : null,
        appLockEnabled,
        services,
        appRelaySessionCount,
        serviceAutostart,
        taskParams,
        t,
    }), [
        appLockEnabled,
        appRelaySessionCount,
        updatesEnabled,
        updatesLabel,
        connectionHealth.kind,
        connectionHealth.machineCount,
        connectionHealth.machineLabelKey,
        connectionHealth.onlineCount,
        connectionHealth.statusLabelKey,
        thisComputer?.description,
        services,
        serviceAutostart,
        taskParams,
    ]);

    // D11-3 — a tray row's Open is the person picking that relay: the one direct-selection owner
    // switches to it (the relay already has its own service here, so nothing asks to move one).
    // The writer applies the selection target without subscribing this always-mounted leaf to it.
    const applySettings = useApplySettings();
    const openRelay = React.useCallback((relayUrl: string) => {
        const serverId = resolveOrRegisterRelayServerId(relayUrl);
        if (!serverId) return;
        fireAndForget(selectRelayDirectly({
            serverId,
            selectionTarget: {
                setServerSelectionActiveTargetKind: (value) => applySettings({ serverSelectionActiveTargetKind: value }),
                setServerSelectionActiveTargetId: (value) => applySettings({ serverSelectionActiveTargetId: value }),
            },
            // The auth provider refreshes on every active-server change.
            refreshAuth: null,
        }), { tag: 'DesktopTrayRuntime.openRelay' });
    }, [applySettings]);

    React.useEffect(() => {
        fireAndForget(applyTauriTrayState(trayState).then((destination) => {
            // A tray item that rebuilt this window (menu-bar mode) asked for this.
            if (!destination) return;
            if (typeof destination === 'string') router.push(DESTINATION_ROUTES[destination]);
            else openRelay(destination.relayUrl);
        }), {
            tag: 'DesktopTrayRuntime.applyTauriTrayState',
        });
    }, [openRelay, router, trayState]);

    // The tray's Updates / Settings items show the window (native side) and ask this webview to open them.
    const openUpdates = React.useCallback(() => router.push(UPDATES_ROUTE), [router]);
    const openSettings = React.useCallback(() => router.push(SETTINGS_ROUTE), [router]);
    useTauriEvent(DESKTOP_OPEN_UPDATES_REQUESTED_EVENT, openUpdates);
    useTauriEvent(DESKTOP_OPEN_SETTINGS_REQUESTED_EVENT, openSettings);
    const lockNow = React.useCallback(() => lockAppLock(), []);
    useTauriEvent(DESKTOP_LOCK_NOW_REQUESTED_EVENT, lockNow);
    // A tray Start / Restart / Stop / "Start at login" changed the services: every reader re-reads.
    useTauriEvent(DESKTOP_BACKGROUND_SERVICES_CHANGED_EVENT, refresh);
    // The menu is about to show these rows: the one inspection owner re-reads (bounded there).
    useTauriEvent(DESKTOP_TRAY_REFRESH_REQUESTED_EVENT, desktopSetupCoordinator.refreshOnTrayPointer);
    const openRequestedRelay = React.useCallback((payload: unknown) => {
        const relayUrl = readRelayUrl(payload);
        if (relayUrl) openRelay(relayUrl);
    }, [openRelay]);
    useTauriEvent(DESKTOP_OPEN_RELAY_REQUESTED_EVENT, openRequestedRelay);

    return null;
}

export function DesktopTrayRuntime(): React.ReactElement | null {
    if (!isTauriDesktop()) return null;
    return <TauriDesktopTrayRuntime />;
}
