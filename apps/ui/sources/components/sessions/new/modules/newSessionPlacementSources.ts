import { resolveServerScopedMachines } from '@/sync/domains/machines/resolveServerScopedMachines';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { Machine } from '@/sync/domains/state/storageTypes';

/**
 * What New Session places a draft among on its target Home: that Home's machines, and the
 * Account's recent folders and sessions only when they belong to that same Home.
 */
export function resolveNewSessionTargetMachines(input: Readonly<{
    targetServerId: string | null;
    activeServerId: string | null;
    activeMachines: ReadonlyArray<Machine>;
    machineListByServerId: Readonly<Record<string, ReadonlyArray<Machine> | null | undefined>>;
    machineListStatusByServerId?: Readonly<Record<string, 'idle' | 'loading' | 'signedOut' | 'error' | undefined>>;
}>): Machine[] {
    const targetServerId = String(input.targetServerId ?? '').trim();
    if (!targetServerId) return [];
    const scopedMachines = resolveServerScopedMachines({
        serverId: targetServerId,
        activeServerId: String(input.activeServerId ?? '').trim(),
        activeMachines: input.activeMachines,
        machineListByServerId: input.machineListByServerId,
        machineListStatusByServerId: input.machineListStatusByServerId,
    });
    return scopedMachines ? [...scopedMachines] : [];
}

/** The Account's recent machine folders, which describe only the Account's own Home. */
export function resolveNewSessionTargetRecentMachinePaths<T>(input: Readonly<{
    targetServerId: string | null;
    accountSettingsServerId: string | null | undefined;
    recentMachinePaths: T;
}>): T | [] {
    return areServerProfileIdentifiersEquivalent(input.targetServerId, input.accountSettingsServerId)
        ? input.recentMachinePaths
        : [];
}

/** The loaded sessions, which describe only the draft's own Home. */
export function resolveNewSessionTargetSessions<T>(input: Readonly<{
    targetServerId: string | null;
    draftScopeServerId: string | null | undefined;
    sessions: T;
}>): T | [] {
    return areServerProfileIdentifiersEquivalent(input.targetServerId, input.draftScopeServerId)
        ? input.sessions
        : [];
}
