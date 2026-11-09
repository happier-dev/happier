import { GuardStopWarningPushDataV1Schema, isGuardStopWarningCurrentV1 } from '@happier-dev/protocol/activity/webhookPayload';
import type { GuardStopWarningPushDataV1 } from '@happier-dev/protocol/activity/webhookPayload';
import type { MachineGuardViewV1 } from '@happier-dev/protocol/machines/guard/guardRpcV1';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActivityInteractionCommand } from '@/activity/actions/resolveActivityInteractionCommand';
import { fetchMachineGuardViewViaAction } from '@/sync/domains/machines/guard/machineGuardRpc';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { loadExpoNotifications } from '@/utils/platform/loadExpoNotifications';
import { resolveNotificationSavedHome } from './resolveNotificationSavedHome';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { machineGuardStore } from '@/sync/domains/machines/guard/machineGuardStore';
import { desktopHostKind, isDesktopHost } from '@/utils/platform/desktopHost';
import { desktopGuardNotificationTransport } from './channels/tauriNotificationPlugin';

type PresentedGuardNotification = Readonly<{ request: Readonly<{
    identifier: string; content: Readonly<{ data?: unknown; accountId?: string }>;
}> }>;
type GuardNotificationTransport = Readonly<{
    getPresentedNotificationsAsync: () => Promise<readonly PresentedGuardNotification[]>;
    dismissNotificationAsync: (identifier: string) => Promise<void>;
}>;

/** A successful Guard read owns absence; a missing terminal projection remains unknown. */
function warningCurrent(warning: GuardStopWarningPushDataV1, view: MachineGuardViewV1): boolean | null {
    if (warning.rule === 'idle_terminals') {
        if (!view.idleTerminals) return null;
        const row = view.idleTerminals.find(item => item.terminalId === warning.terminalId && item.terminalKey === warning.terminalKey);
        return isGuardStopWarningCurrentV1(warning, { machineId: warning.machineId,
            terminalId: row?.terminalId, terminalKey: row?.terminalKey,
            state: row?.status === 'stops_at' ? { v: 1, kind: 'stopping', stopAt: row.stopAt, rule: 'idle_terminals' } : undefined });
    }
    const row = view.idle.find(item => item.sessionRef === warning.sessionId);
    return isGuardStopWarningCurrentV1(warning, { machineId: warning.machineId, sessionId: row?.sessionRef,
        state: row?.status === 'stops_at' ? { v: 1, kind: 'stopping', stopAt: row.stopAt, rule: warning.rule } : undefined });
}

/** Direct controls never replay a withdrawn or replaced warning on the same Session/terminal. */
export async function executeGuardStopWarningAction(command: Extract<ActivityInteractionCommand, { kind: 'executeAction' }>, signal?: AbortSignal, expectedAccountId?: string): Promise<ActionExecuteResult | null> {
    const warning = command.guardWarning;
    const serverId = command.target.serverId;
    if (!warning || !serverId || signal?.aborted) return null;
    const binding = await resolveServerCredentialAccountScope(serverId);
    if (binding.kind !== 'bound' || expectedAccountId && binding.scope.accountId !== expectedAccountId || signal?.aborted) return null;
    const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
    if (signal?.aborted) return null;
    const key = { serverId, expectedAccountId: binding.scope.accountId, machineId: warning.machineId, ...(signal ? { signal } : {}) };
    const current = await fetchMachineGuardViewViaAction(key);
    if (!current.ok || warningCurrent(warning, current.value) !== true || signal?.aborted) return null;
    return createFrontDoorActionExecute()(command.actionId, command.payload, {
        surface: 'ui', serverId, expectedAccountId: binding.scope.accountId,
        ...(command.defaultSessionId ? { defaultSessionId: command.defaultSessionId } : {}), ...(signal ? { signal } : {}),
    });
}

/** Reuse the delivered OS request id; the payload occurrence id is not Expo's dismissal handle. */
export async function reconcileGuardStopWarningNotifications(params: Readonly<{
    notifications?: GuardNotificationTransport;
    session?: Readonly<{ serverId: string; sessionId: string }>;
}> = {}): Promise<void> {
    const notifications: GuardNotificationTransport = params.notifications ?? (isDesktopHost() && desktopHostKind() === 'tauri'
        ? desktopGuardNotificationTransport : await loadExpoNotifications());
    const presented = await notifications.getPresentedNotificationsAsync();
    for (const notification of presented) {
        const parsed = GuardStopWarningPushDataV1Schema.safeParse(notification.request.content.data);
        if (!parsed.success) continue;
        const warning = parsed.data;
        const home = resolveNotificationSavedHome({ serverId: warning.serverId, serverUrl: warning.serverUrl ?? '' });
        if (!home || params.session && (!areServerProfileIdentifiersEquivalent(params.session.serverId, home.id) || warning.rule === 'idle_terminals'
            || warning.sessionId !== params.session.sessionId)) continue;
        const binding = await resolveServerCredentialAccountScope(home.id);
        if (binding.kind !== 'bound' || notification.request.content.accountId
            && binding.scope.accountId !== notification.request.content.accountId) continue;
        const current = await fetchMachineGuardViewViaAction({ serverId: home.id, expectedAccountId: binding.scope.accountId, machineId: warning.machineId });
        if (!current.ok || warningCurrent(warning, current.value) !== false) continue;
        const admitted = await resolveServerCredentialAccountScope(home.id);
        if (admitted.kind !== 'bound' || admitted.scope.accountId !== binding.scope.accountId) continue;
        await notifications.dismissNotificationAsync(notification.request.identifier);
    }
}

/** Delivered warnings demand the existing daemon watch only for their lifetime. */
export function observeGuardStopWarningNotifications(notifications: GuardNotificationTransport & Readonly<{
    addNotificationReceivedListener: (listener: () => void) => { remove: () => void };
}>, onError: (error: unknown) => void) {
    let disposed = false;
    let refreshing = false;
    let refreshRequested = false;
    let sourceRefreshRequested = false;
    const demands = new Map<string, () => void>();
    const refresh = (refreshSource = false) => {
        if (disposed) return;
        sourceRefreshRequested ||= refreshSource;
        refreshRequested = true;
        if (refreshing) return;
        refreshing = true;
        void (async () => {
            try {
                while (refreshRequested && !disposed) {
                    refreshRequested = false;
                    const refreshSource = sourceRefreshRequested;
                    sourceRefreshRequested = false;
                    const wanted = new Set<string>();
                    const refreshed = new Set<string>();
                    const presented = await notifications.getPresentedNotificationsAsync();
                    for (const notification of presented) {
                        if (disposed) return;
                        const parsed = GuardStopWarningPushDataV1Schema.safeParse(notification.request.content.data);
                        if (!parsed.success) continue;
                        const warning = parsed.data;
                        const home = resolveNotificationSavedHome({ serverId: warning.serverId, serverUrl: warning.serverUrl ?? '' });
                        if (!home) continue;
                        const binding = await resolveServerCredentialAccountScope(home.id);
                        if (binding.kind !== 'bound' || notification.request.content.accountId
                            && binding.scope.accountId !== notification.request.content.accountId || disposed) continue;
                        const key = { serverId: binding.scope.serverId, expectedAccountId: binding.scope.accountId, machineId: warning.machineId };
                        const id = JSON.stringify([key.serverId, key.expectedAccountId, key.machineId]);
                        // A push can precede an already-open view's watch answer. Invalidate before
                        // demanding so a cold view reads once, and an in-flight old read is followed
                        // by the shared owner's fresh read before absence becomes authoritative.
                        if ((refreshSource || !demands.has(id)) && !refreshed.has(id)) {
                            refreshed.add(id);
                            machineGuardStore.refreshMachine(key);
                        }
                        if (!demands.has(id)) {
                            const stopObserving = machineGuardStore.observeView(key, () => refresh());
                            const stopDemanding = machineGuardStore.demandView(key);
                            demands.set(id, () => { stopObserving(); stopDemanding(); });
                        }
                        const current = machineGuardStore.getView(key);
                        if (current.status === 'ready' && !current.pending && current.view && warningCurrent(warning, current.view) === false) {
                            // The async OS operation must still belong to the saved Home and Account.
                            const admittedHome = resolveNotificationSavedHome({ serverId: warning.serverId, serverUrl: warning.serverUrl ?? '' });
                            const admitted = await resolveServerCredentialAccountScope(home.id);
                            if (disposed) return;
                            const latest = machineGuardStore.getView(key);
                            if (admittedHome?.id === home.id && admittedHome.serverUrl === home.serverUrl
                                && admitted.kind === 'bound' && admitted.scope.accountId === key.expectedAccountId
                                && latest.status === 'ready' && !latest.pending && latest.view && warningCurrent(warning, latest.view) === false) {
                                await notifications.dismissNotificationAsync(notification.request.identifier);
                                continue;
                            }
                        }
                        wanted.add(id);
                    }
                    for (const [id, release] of demands) if (!wanted.has(id)) { release(); demands.delete(id); }
                }
            } catch (error) { onError(error); }
            finally { refreshing = false; }
        })();
    };
    const arrival = notifications.addNotificationReceivedListener(() => refresh(true));
    refresh(true);
    return { refresh: () => refresh(true), dispose: () => {
        disposed = true;
        arrival.remove();
        for (const release of demands.values()) release();
        demands.clear();
    } };
}
