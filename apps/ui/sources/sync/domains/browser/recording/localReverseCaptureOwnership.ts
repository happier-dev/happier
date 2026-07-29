import { createRelayUrlComparableKeySafe } from '@/sync/domains/server/relayDrift/relayDriftModel';
import { normalizeNonEmptyString } from '@/utils/strings/normalizeNonEmptyString';

export type LocalBrowserRecordingReverseCaptureDaemonStatus = Readonly<{
    serviceInstalled?: boolean | null;
    daemonRunning?: boolean | null;
    needsAuth?: boolean | null;
    machineId?: string | null;
    daemonServerUrl?: string | null;
    daemonComparableKey?: string | null;
    daemonAccountId?: string | null;
    daemonMachineRegistered?: boolean | null;
}>;

export function resolveVerifiedLocalBrowserRecordingCaptureMachineId(params: Readonly<{
    daemonStatus: LocalBrowserRecordingReverseCaptureDaemonStatus | null;
    activeRelayUrl: string | null | undefined;
    activeLocalRelayUrl: string | null | undefined;
    uiAccountId: string | null | undefined;
    isMachineVisibleOnActiveServer: boolean;
}>): string | null {
    const status = params.daemonStatus;
    const machineId = normalizeNonEmptyString(status?.machineId);
    if (!status || !machineId) return null;
    if (status.serviceInstalled !== true) return null;
    if (status.daemonRunning !== true) return null;
    if (status.needsAuth === true) return null;
    if (status.daemonMachineRegistered !== true) return null;
    if (params.isMachineVisibleOnActiveServer !== true) return null;

    const daemonRelayKey = createRelayUrlComparableKeySafe(status.daemonComparableKey ?? status.daemonServerUrl);
    const activeRelayKey = createRelayUrlComparableKeySafe(params.activeRelayUrl);
    const activeLocalRelayKey = createRelayUrlComparableKeySafe(params.activeLocalRelayUrl);
    if (!daemonRelayKey || !activeRelayKey) return null;
    if (daemonRelayKey !== activeRelayKey && daemonRelayKey !== activeLocalRelayKey) return null;

    const daemonAccountId = normalizeNonEmptyString(status.daemonAccountId);
    const uiAccountId = normalizeNonEmptyString(params.uiAccountId);
    if (!daemonAccountId || !uiAccountId || daemonAccountId !== uiAccountId) return null;

    return machineId;
}
