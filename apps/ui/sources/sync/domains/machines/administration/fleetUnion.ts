import { resolveMachinePickerPresence } from '@/sync/domains/machines/identity/resolveMachinePickerPresence';
import type { ServerMachineInventorySnapshotV1 } from '@/sync/domains/machines/machineInventorySnapshots';
import type { MachineReachabilityScope } from '@/sync/domains/machines/reachability/machineReachability';
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ProfileScopeResolver } from '@/sync/domains/server/serverProfiles';

type FleetMachine = Parameters<typeof resolveMachinePickerPresence>[0] & Readonly<{
    availability?: Readonly<{ kind: string }>;
}>;

/** Normalized Administration rows retain their census without admitting stale or unavailable members. */
export function isFleetMemberCurrent(member: Readonly<{ observation: 'live' | 'stale'; availability: string }>): boolean {
    return member.observation === 'live' && member.availability === 'online';
}

export function resolveFleetMachineAvailability(
    scope: MachineReachabilityScope | null | undefined,
    machine: FleetMachine,
    nowMs?: number,
    resolveScopeId?: ProfileScopeResolver,
): 'locked' | ReturnType<typeof resolveMachinePickerPresence>['status'] {
    return machine.availability?.kind === 'locked' ? 'locked' as const : resolveMachinePickerPresence(machine, nowMs, scope, resolveScopeId).status;
}

/** Administration's machine membership policy; retained inventory is not execution authority. */
export function isMachineSelectableForFleet(
    scope: MachineReachabilityScope | null | undefined,
    machine: FleetMachine,
    nowMs?: number,
    resolveScopeId?: ProfileScopeResolver,
): boolean {
    return isFleetMemberCurrent({ observation: 'live', availability: resolveFleetMachineAvailability(scope, machine, nowMs, resolveScopeId) });
}

/** Exact snapshot admission shared by all plugin supplies, without interpreting release facts. */
export function resolveFleetMachineRejection(params: Readonly<{
    serverIdentityId: string;
    machineId: string;
    machineSnapshots: readonly ServerMachineInventorySnapshotV1[];
}>): 'unknown' | 'missing' | 'stale' | 'offline' | 'home_unreachable' | 'revoked' | 'replaced' | null {
    const snapshot = params.machineSnapshots.find((candidate) => candidate.kind === 'resolved'
        && candidate.serverIdentityId === params.serverIdentityId);
    return resolveFleetSnapshotMachineRejection({
        snapshot: snapshot?.kind === 'resolved' ? snapshot : undefined,
        machine: snapshot?.machines.find((candidate) => candidate.id === params.machineId),
    });
}

/** The same Fleet policy for inventory producers that already looked up the exact row. */
export function resolveFleetSnapshotMachineRejection(params: Readonly<{
    snapshot: Extract<ServerMachineInventorySnapshotV1, { kind: 'resolved' }> | undefined;
    machine: FleetMachine | undefined;
    executionEligible?: boolean;
}>): ReturnType<typeof resolveFleetMachineRejection> {
    const { snapshot, machine } = params;
    if (!snapshot) return 'unknown';
    if (!machine) return snapshot.settled === true ? 'missing' : 'unknown';
    const presence = resolveMachinePickerPresence(machine, undefined, createServerAccountScope(snapshot.serverIdentityId, snapshot.accountId));
    // Retained inventory cannot hide a refusal already known by the transport owner.
    if (presence.status !== 'online' && presence.status !== 'unknown') {
        return presence.status === 'offline' ? presence.reason : presence.status;
    }
    if (snapshot.observation === 'stale') return 'stale';
    if (machine.availability?.kind === 'locked') return 'unknown';
    // Presence shells can look online before their scoped content is opened.
    // Consume the inventory owner's qualification rather than re-deriving it.
    if (presence.status === 'online' && snapshot.executionEligibleMachineIds
        && !(params.executionEligible ?? snapshot.executionEligibleMachineIds.includes(machine.id))) return 'unknown';
    return presence.status === 'online' ? null : presence.status;
}

export type FleetReadState = 'current' | 'resolving' | 'transportFailure' | 'failed';

/** A retry beside a healthy supply is unresolved coverage, not a fleet failure. */
export function resolveFleetReadState(states: readonly FleetReadState[]): 'current' | 'resolving' | 'failed' {
    if (states.includes('failed')) return 'failed';
    if (states.includes('resolving')
        || (states.includes('current') && states.includes('transportFailure'))) return 'resolving';
    return states.includes('transportFailure') ? 'failed' : 'current';
}

export { resolveFleetSupplyAgreement } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
