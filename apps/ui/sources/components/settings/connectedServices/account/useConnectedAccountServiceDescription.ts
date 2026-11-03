import * as React from 'react';

import { describeConnectedAccountAuthenticationService } from '@/sync/ops/connectedAccounts/connectedAccountDaemon';

type DescriptionInput = Parameters<typeof describeConnectedAccountAuthenticationService>[0];
type DescriptionResult = Awaited<ReturnType<typeof describeConnectedAccountAuthenticationService>>;

/** Retains the Account declaration facts independently of a native Machine selection. */
export function useConnectedAccountServiceDescription(input: Readonly<{
    serverId: string;
    expectedAccountId: string | null;
    service: DescriptionInput['service'] | null;
    selectedMachineId?: string;
    modeId: string | null;
    expectedActiveServer?: DescriptionInput['expectedActiveServer'];
    getSignal: () => AbortSignal;
    assertCurrent: () => void;
    isCurrent: () => boolean;
    onError: (error: unknown) => void;
    enabled: boolean;
}>) {
    const { serverId, expectedAccountId, service, selectedMachineId, modeId, expectedActiveServer, getSignal,
        assertCurrent, isCurrent, onError, enabled } = input;
    const [current, setCurrent] = React.useState<Readonly<{
        result: DescriptionResult;
        machineId: string | undefined;
    }> | null>(null);
    const refresh = React.useCallback(async () => {
        if (!enabled || !service || !serverId || !expectedAccountId || !isCurrent()) return;
        const machineId = selectedMachineId;
        const signal = getSignal();
        const result = await describeConnectedAccountAuthenticationService({
            serverId, expectedAccountId, service, ...(machineId ? { machineId } : {}),
            ...(expectedActiveServer ? { expectedActiveServer } : {}), signal, assertCurrent,
        });
        if (!isCurrent() || signal.aborted) return;
        setCurrent({ result, machineId });
        return result.accountAuthenticationModes.status === 'available' && result.description.status === 'described'
            ? result.description : undefined;
    }, [assertCurrent, enabled, expectedAccountId, expectedActiveServer, isCurrent, modeId, selectedMachineId, serverId, service, getSignal]);
    React.useEffect(() => {
        const signal = getSignal();
        void refresh().catch(error => { if (isCurrent() && !signal.aborted) onError(error); });
    }, [getSignal, isCurrent, onError, refresh]);
    return { current, refresh };
}
