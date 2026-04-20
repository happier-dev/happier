import type { RelayDriftBanner } from '@/components/settings/server/relayDriftTypes';

export type ThisComputerSetupPreflight = Readonly<{
    activeRelayUrl: string | null;
    activeWebappUrl: string | null;
    activeLocalRelayUrl: string | null;
    localCliReady?: boolean;
    serviceInstalled: boolean;
    daemonRunning: boolean;
    machineId: string | null;
    needsAuth: boolean;
    daemonServerUrl: string | null;
    daemonComparableKey: string | null;
    daemonAccountId: string | null;
    daemonMachineRegistered: boolean | null;
    uiAccountId: string | null;
    serverMismatch: boolean;
    accountMismatch: boolean;
    pairingRequired: boolean;
    relayDriftBanner: RelayDriftBanner | null;
}>;
