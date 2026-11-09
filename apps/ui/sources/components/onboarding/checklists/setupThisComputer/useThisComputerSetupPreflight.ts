import * as React from 'react';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { storage as syncStorage } from '@/sync/domains/state/storageStore';
import { resolveWebappUrlFromServerUrl } from '@/sync/domains/server/url/resolveWebappUrlFromServerUrl';
import { useLocalDaemonControl } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import { useRelayDriftBannerFromLocalControl } from '@/components/settings/server/useRelayDriftBanner';
import { useThisComputerConnection } from '@/components/settings/machines/localControl/useThisComputerConnection';

import { computeThisComputerMismatches } from './computeThisComputerMismatches';
import type { ThisComputerSetupPreflight } from './types';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { getSystemTasksRunner } from '@/components/systemTasks/systemTasksRuntime';

export function useThisComputerSetupPreflight(options: Readonly<{ runner?: SystemTaskRunner; enabled?: boolean }> = {}): ThisComputerSetupPreflight {
    const uiAccountId = syncStorage((state) => state.profile?.id ?? null);
    const runner = options.runner ?? getSystemTasksRunner();
    const daemon = useLocalDaemonControl({ ...options, runner });
    const relayDriftBanner = useRelayDriftBannerFromLocalControl(daemon, runner);
    const activeServerSnapshot = useActiveServerSnapshot();
    const thisComputerConnection = useThisComputerConnection(daemon.status);

    return React.useMemo(() => ({
        activeRelayUrl: typeof activeServerSnapshot.serverUrl === 'string' && activeServerSnapshot.serverUrl.trim().length > 0
            ? activeServerSnapshot.serverUrl.trim()
            : null,
        activeWebappUrl: typeof activeServerSnapshot.serverUrl === 'string' && activeServerSnapshot.serverUrl.trim().length > 0
            ? resolveWebappUrlFromServerUrl(activeServerSnapshot.serverUrl.trim())
            : null,
        activeLocalRelayUrl: typeof activeServerSnapshot.activeLocalRelayUrl === 'string' && activeServerSnapshot.activeLocalRelayUrl.trim().length > 0
            ? activeServerSnapshot.activeLocalRelayUrl.trim()
            : null,
        activeServerId: typeof activeServerSnapshot.serverId === 'string' && activeServerSnapshot.serverId.trim().length > 0
            ? activeServerSnapshot.serverId.trim()
            : null,
        localCliReady: daemon.status != null,
        checking: daemon.status == null && !daemon.isUnavailable && !daemon.lastErrorMessage
            && !daemon.statusTaskSnapshot?.result,
        serviceInstalled: daemon.status?.serviceInstalled === true,
        daemonRunning: daemon.status?.daemonRunning === true,
        machineId: daemon.status?.machineId ?? null,
        needsAuth: daemon.status?.needsAuth === true,
        daemonServerUrl: typeof daemon.status?.daemonServerUrl === 'string' && daemon.status.daemonServerUrl.trim().length > 0
            ? daemon.status.daemonServerUrl.trim()
            : null,
        daemonComparableKey: typeof daemon.status?.daemonComparableKey === 'string' && daemon.status.daemonComparableKey.trim().length > 0
            ? daemon.status.daemonComparableKey.trim()
            : null,
        daemonAccountId: typeof daemon.status?.daemonAccountId === 'string' && daemon.status.daemonAccountId.trim().length > 0
            ? daemon.status.daemonAccountId.trim()
            : null,
        daemonMachineRegistered: typeof daemon.status?.daemonMachineRegistered === 'boolean'
            ? daemon.status.daemonMachineRegistered
            : null,
        uiAccountId,
        ...computeThisComputerMismatches({
            activeRelayUrl: typeof activeServerSnapshot.serverUrl === 'string' && activeServerSnapshot.serverUrl.trim().length > 0
                ? activeServerSnapshot.serverUrl.trim()
                : null,
            activeLocalRelayUrl: typeof activeServerSnapshot.activeLocalRelayUrl === 'string' && activeServerSnapshot.activeLocalRelayUrl.trim().length > 0
                ? activeServerSnapshot.activeLocalRelayUrl.trim()
                : null,
            daemonComparableKey: typeof daemon.status?.daemonComparableKey === 'string' && daemon.status.daemonComparableKey.trim().length > 0
                ? daemon.status.daemonComparableKey.trim()
                : null,
            daemonAccountId: typeof daemon.status?.daemonAccountId === 'string' && daemon.status.daemonAccountId.trim().length > 0
                ? daemon.status.daemonAccountId.trim()
                : null,
            uiAccountId,
            needsAuth: daemon.status?.needsAuth === true,
            machineId: daemon.status?.machineId ?? null,
            machineRegistered: typeof daemon.status?.daemonMachineRegistered === 'boolean'
                ? daemon.status.daemonMachineRegistered
                : null,
        }),
        relayDriftBanner,
        thisComputerConnection,
    }), [
        activeServerSnapshot.serverUrl,
        activeServerSnapshot.serverId,
        activeServerSnapshot.activeLocalRelayUrl,
        daemon.status,
        daemon.isUnavailable,
        daemon.lastErrorMessage,
        daemon.statusTaskSnapshot,
        daemon.status?.daemonRunning,
        daemon.status?.daemonServerUrl,
        daemon.status?.daemonComparableKey,
        daemon.status?.daemonAccountId,
        daemon.status?.daemonMachineRegistered,
        daemon.status?.machineId,
        daemon.status?.needsAuth,
        daemon.status?.serviceInstalled,
        relayDriftBanner,
        thisComputerConnection,
        uiAccountId,
    ]);
}
