import { createRelayUrlComparableKeySafe } from '@/sync/domains/server/relayDrift/relayDriftModel';

export function computeThisComputerMismatches(params: Readonly<{
    activeRelayUrl: string | null;
    activeLocalRelayUrl: string | null;
    daemonComparableKey: string | null;
    daemonAccountId: string | null;
    uiAccountId: string | null;
    needsAuth: boolean;
    machineId: string | null;
    machineRegistered: boolean | null;
}>): Readonly<{
    serverMismatch: boolean;
    accountMismatch: boolean;
    pairingRequired: boolean;
}> {
    const activeRelayKey = createRelayUrlComparableKeySafe(params.activeRelayUrl);
    const activeLocalKey = createRelayUrlComparableKeySafe(params.activeLocalRelayUrl);
    const daemonKey = createRelayUrlComparableKeySafe(params.daemonComparableKey);

    const serverMismatch = Boolean(
        activeRelayKey
            && daemonKey
            && daemonKey !== activeRelayKey
            && (!activeLocalKey || daemonKey !== activeLocalKey),
    );

    const accountMismatch = Boolean(
        String(params.uiAccountId ?? '').trim()
            && String(params.daemonAccountId ?? '').trim()
            && String(params.uiAccountId ?? '').trim() !== String(params.daemonAccountId ?? '').trim(),
    );

    const pairingRequired = params.needsAuth
        || params.machineRegistered === false
        || !String(params.machineId ?? '').trim();

    return {
        serverMismatch,
        accountMismatch,
        pairingRequired,
    };
}
