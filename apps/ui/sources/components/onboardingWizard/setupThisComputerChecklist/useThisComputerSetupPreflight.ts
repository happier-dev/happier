import * as React from 'react';

import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { useAuth } from '@/auth/context/AuthContext';
import { useLocalDaemonControl } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import { useRelayDriftBanner } from '@/components/settings/server/useRelayDriftBanner';

import { computeThisComputerMismatches } from './computeThisComputerMismatches';
import type { ThisComputerSetupPreflight } from './types';

export function useThisComputerSetupPreflight(): ThisComputerSetupPreflight {
    const auth = useAuth();
    const daemon = useLocalDaemonControl();
    const relayDriftBanner = useRelayDriftBanner();
    const activeServerSnapshot = getActiveServerSnapshot();

    return React.useMemo(() => ({
        activeRelayUrl: typeof activeServerSnapshot.serverUrl === 'string' && activeServerSnapshot.serverUrl.trim().length > 0
            ? activeServerSnapshot.serverUrl.trim()
            : null,
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
        uiAccountId: auth.profile?.id ?? null,
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
            uiAccountId: auth.profile?.id ?? null,
            needsAuth: daemon.status?.needsAuth === true,
            machineId: daemon.status?.machineId ?? null,
            machineRegistered: typeof daemon.status?.daemonMachineRegistered === 'boolean'
                ? daemon.status.daemonMachineRegistered
                : null,
        }),
        relayDriftBanner,
    }), [
        activeServerSnapshot.serverUrl,
        activeServerSnapshot.activeLocalRelayUrl,
        auth.profile?.id,
        daemon.status?.daemonRunning,
        daemon.status?.daemonServerUrl,
        daemon.status?.daemonComparableKey,
        daemon.status?.daemonAccountId,
        daemon.status?.daemonMachineRegistered,
        daemon.status?.machineId,
        daemon.status?.needsAuth,
        daemon.status?.serviceInstalled,
        relayDriftBanner,
    ]);
}
