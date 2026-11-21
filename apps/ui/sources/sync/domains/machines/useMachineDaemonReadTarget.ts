import * as React from 'react';

import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { useServerCredentialAccountScopeStates, type ServerCredentialAccountScopeBinding, type ServerCredentialAccountScopeResolution } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { storage } from '@/sync/domains/state/storageStore';
import { useMachinePresenceSummary, useMachinePresenceSummaries } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';

export type MachineDaemonReadKey = Readonly<{ machineId: string; serverId: string | null; expectedAccountId: string | null }>;
export type MachineDaemonReadTargetInput = Readonly<{
    machineId: string;
    serverId?: string | null;
    expectedAccountId?: string | null;
    daemonStateVersion?: number | null;
    /** Readers driven by their own watch do not need daemon publication invalidations. */
    observeDaemonStateVersion?: boolean;
    enabled?: boolean;
    online?: boolean | null;
}>;

type MachineDaemonReadIdentity = Readonly<{
    key: MachineDaemonReadKey;
    accountBinding: ServerCredentialAccountScopeBinding | null;
    credentialResolution: ServerCredentialAccountScopeResolution['kind'];
    accountMatches: boolean;
    enabled: boolean;
}>;

/** Recovery owners receive daemon revisions without making the revision a React render input. */
export function useMachineDaemonRevisionObserver(
    key: MachineDaemonReadKey,
    report: (version: number | undefined) => void,
): void {
    const { expectedAccountId, machineId, serverId } = key;
    React.useEffect(() => {
        if (!expectedAccountId || !machineId) return;
        const publish = () => report(resolveServerScopedMachine(storage.getState(), serverId, machineId)?.daemonStateVersion);
        publish();
        return storage.subscribe(publish, { machines: true, machineListByServerId: true, machineRecordsByServerId: true });
    }, [expectedAccountId, machineId, report, serverId]);
}

/** Mounted and one-shot reads use the same explicit-or-active Home placement. */
export function resolveMachineDaemonReadServerId(serverId: string | null | undefined): string {
    return resolveServerProfileScopeIdForIdentifier(serverId?.trim() || getActiveServerSnapshot().serverId);
}

/** Resolve the same credential-owned identities for a fleet spanning several Homes. */
export function useMachineDaemonReadIdentities(inputs: readonly MachineDaemonReadTargetInput[]): readonly MachineDaemonReadIdentity[] {
    const inputsKey = JSON.stringify(inputs.map(input => ({ machineId: input.machineId,
        serverId: resolveMachineDaemonReadServerId(input.serverId),
        expectedAccountId: input.expectedAccountId ?? null, enabled: input.enabled !== false })));
    const targets = React.useMemo(() => JSON.parse(inputsKey) as Array<Readonly<{
        machineId: string; serverId: string; expectedAccountId: string | null; enabled: boolean;
    }>>, [inputsKey]);
    const states = useServerCredentialAccountScopeStates(targets.map(input => input.serverId));
    const hostViewed = useHostActivelyViewed();
    const presented = useLayoutPresentationActive();
    const viewed = hostViewed && presented;
    return React.useMemo(() => targets.map(input => {
        const state = states.get(input.serverId);
        const binding = state?.binding ?? null;
        const scope = state?.resolution.kind === 'bound' ? state.resolution.scope : null;
        const expectedAccountId = input.expectedAccountId ?? binding?.accountId ?? scope?.accountId ?? null;
        return { key: { machineId: input.machineId, serverId: input.serverId || null, expectedAccountId },
            accountBinding: binding, credentialResolution: state?.resolution.kind ?? 'resolving',
            accountMatches: !!scope && scope.accountId === expectedAccountId,
            enabled: viewed && input.enabled && !!binding
                && binding.accountId === expectedAccountId && binding.isCurrent() };
    }), [states, targets, viewed]);
}

/**
 * Who a daemon read for one machine is made as, and whether it may run now: the exact Home/Account
 * identity from the existing credential owner (including other Homes), the machine's presence, and
 * whether the app is being looked at. One target for every daemon-backed machine read (storage,
 * guard, processes), so they never disagree about which Account is asking.
 */
export function useMachineDaemonReadTarget(input: MachineDaemonReadTargetInput): Readonly<{
    key: MachineDaemonReadKey;
    enabled: boolean;
    offline: boolean;
    accountBinding: ServerCredentialAccountScopeBinding | null;
    /** Settled identity may retain content during a profile recheck, never across credential mutation. */
    accountMatches: boolean;
    daemonStateVersion: number | null | undefined;
}> {
    const identity = useMachineDaemonReadIdentities([input])[0]!;
    const { key, accountBinding: binding } = identity;
    const serverId = key.serverId;
    const presence = useMachinePresenceSummary(serverId, input.machineId);
    const selectVersion = React.useCallback((state: Parameters<typeof resolveServerScopedMachine>[0]) => input.observeDaemonStateVersion === false
        ? undefined : resolveServerScopedMachine(state, serverId, input.machineId)?.daemonStateVersion,
    [input.machineId, input.observeDaemonStateVersion, serverId]);
    const reportedVersion = storage(selectVersion);
    const online = input.online !== false && input.online !== null && presence.reachability === 'reachable';
    const enabled = identity.enabled && online;
    return { key, enabled, offline: presence.reachability === 'unreachable', accountBinding: binding, accountMatches: identity.accountMatches,
        daemonStateVersion: input.daemonStateVersion ?? reportedVersion };
}

export type MachineDaemonReadTargetEntry = Readonly<{ key: MachineDaemonReadKey; enabled: boolean; offline: boolean }>;

/**
 * The same read target for several machines of one Home (an all-machines widget): one credential identity,
 * each machine's own presence. A daemon read stays per machine; this only names the targets together.
 */
export function useMachineDaemonReadTargets(input: Readonly<{ serverId?: string | null; machineIds: readonly string[]; enabled?: boolean }>): readonly MachineDaemonReadTargetEntry[] {
    const identities = useMachineDaemonReadIdentities(input.machineIds.map(machineId => ({ ...input, machineId })));
    const presence = useMachinePresenceSummaries(input.serverId, input.machineIds);
    const presenceKey = JSON.stringify(presence.map(machine => machine.reachability));
    return React.useMemo(() => {
        const reachability = JSON.parse(presenceKey) as Array<typeof presence[number]['reachability']>;
        return identities.map((identity, index) => ({
            key: identity.key,
            enabled: identity.enabled && reachability[index] === 'reachable',
            offline: reachability[index] === 'unreachable',
        }));
    }, [identities, presenceKey]);
}
