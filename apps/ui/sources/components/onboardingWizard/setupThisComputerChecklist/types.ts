import type { RelayDriftBanner } from '@/components/settings/server/relayDriftTypes';

export type ThisComputerSetupPreflight = Readonly<{
    activeRelayUrl: string | null;
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

export type ThisComputerChecklistItemId =
    | 'setup.thisComputer.resolveRelay'
    | 'setup.thisComputer.checkAuth'
    | 'setup.thisComputer.configureRelay'
    | 'setup.thisComputer.auth.request'
    | 'setup.thisComputer.auth.wait'
    | 'setup.thisComputer.installService'
    | 'setup.thisComputer.startService'
    | 'setup.thisComputer.verifyService';
