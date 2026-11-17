import type { TerminalPtyCustody } from './sessions';

/** Retained person-terminal custody, shared by terminal transport and service logs. */
export function matchesTerminalRequesterCustody(
    custody: Pick<TerminalPtyCustody, 'serverId' | 'requesterAccountId' | 'machineId' | 'installationId'>,
    requester: Readonly<{ serverId: string; accountId: string; machineId: string; installationId: string }>,
): boolean {
    return custody.serverId === requester.serverId && custody.requesterAccountId === requester.accountId
        && custody.machineId === requester.machineId && custody.installationId === requester.installationId;
}
