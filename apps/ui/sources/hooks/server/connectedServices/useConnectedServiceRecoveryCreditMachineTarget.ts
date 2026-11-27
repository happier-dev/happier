import * as React from 'react';

import {
    resolveAgentIdFromSessionMetadata,
} from '@happier-dev/agents';
import {
    type AccountProfile} from '@happier-dev/protocol/account/profile';
import {
    type ConnectedServiceBindingSelectionV2,
    type ConnectedServiceId,
    readBuiltInLegacyConnectedServiceIdForQualifiedService,
} from '@happier-dev/protocol/connect/connected-service-bindings';

import {
    readSessionConnectedServiceBindings,
} from '@/sync/domains/connectedServices/readSessionConnectedServiceBindings';
import { resolveQualifiedConnectedAccountServiceKey } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { useActiveServerAccountScope, useProfile, useSessions, useActiveMachineFacts } from '@/sync/domains/state/storage';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { resolveMachineControlTargetForSessionFromState } from '@/sync/ops/sessionMachineTarget';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';
import { isMachineSelectableForFleet } from '@/sync/domains/machines/administration/fleetUnion';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

type AccountProfileConnectedService = AccountProfile['connectedServicesV2'][number];

function buildRecordById<T extends Readonly<{ id: string }>>(items: ReadonlyArray<T>): Record<string, T> {
    const record: Record<string, T> = {};
    for (const item of items) {
        record[item.id] = item;
    }
    return record;
}

/**
 * Whether a session binding runs on this Account's own connected profile.
 *
 * The canonical session binding union is V2, so a `team_resource` selection is
 * reachable here. A Team resource is bound by resource identity — its direct
 * `disclosedMember` is a qualified Team account ref, never this Account's local
 * profile id — so it is decisively not a match for a personal recovery credit,
 * and Team delivery authority stays with its own owner rather than being
 * re-decided here.
 */
function bindingTargetsProfile(params: Readonly<{
    binding: ConnectedServiceBindingSelectionV2 | undefined;
    services: ReadonlyArray<AccountProfileConnectedService>;
    /** Canonical qualified service key of the session bindings. */
    serviceKey: string;
    /** Released scalar id for the V2 account lookup; null for novel external services. */
    legacyServiceId: ConnectedServiceId | null;
    profileId: string;
}>): boolean {
    const { binding, services, serviceKey, legacyServiceId, profileId } = params;
    if (!binding || binding.source !== 'connected') return false;
    if (binding.selection !== 'group') return binding.profileId === profileId;
    if (binding.profileId === profileId) return true;

    // The V2 account lookup still speaks scalar service ids; the conversion
    // stays local and typed after the canonical qualified binding resolution.
    if (!legacyServiceId) return false;
    const service = services.find((candidate) => candidate.serviceId === legacyServiceId) ?? null;
    const group = service?.groups.find((candidate) => candidate.groupId === binding.groupId) ?? null;
    return group?.activeProfileId === profileId;
}

/**
 * Typed reason a live hot-apply machine target could not be resolved, so callers
 * can explain WHY instead of collapsing every miss to a generic "request failed":
 * - `no_bound_session`: no active session is currently bound to this profile/pool,
 *   so there is nothing to hot-apply to right now (it applies on next resume).
 * - `machine_offline`: an active session IS bound, but its controlling machine is
 *   offline/unreachable, so the change cannot reach a running session.
 */
export type ConnectedServiceBindingMachineTargetReason = 'no_bound_session' | 'machine_offline';

export type ConnectedServiceBindingMachineTargetStatus =
    | Readonly<{ machineId: string; reason?: undefined }>
    | Readonly<{ machineId: null; reason: ConnectedServiceBindingMachineTargetReason }>;

function resolveConnectedServiceMachineTargetStatusForBinding(params: Readonly<{
    accountScope: ServerAccountScope | null;
    /** Canonical qualified Connected Account service key of the session bindings. */
    serviceKey: string;
    /** Released scalar id for the V2 account lookup; null for novel external services. */
    legacyServiceId: ConnectedServiceId | null;
    sessions: ReadonlyArray<Session> | null;
    machines: ReadonlyArray<Machine>;
    matches: (binding: ConnectedServiceBindingSelectionV2 | undefined) => boolean;
}>): ConnectedServiceBindingMachineTargetStatus {
    if (!params.sessions || params.sessions.length === 0) {
        return { machineId: null, reason: 'no_bound_session' };
    }

    const machineById = buildRecordById(params.machines);
    const state = {
        sessions: buildRecordById(params.sessions),
        machines: machineById,
    };

    let hadMatchingBinding = false;
    for (const session of params.sessions) {
        if (!session.active) continue;

        const metadata = readSessionOwnerMetadataView(session);
        const agentId = resolveAgentIdFromSessionMetadata(metadata);
        if (!agentId) continue;

        const bindings = readSessionConnectedServiceBindings({
            metadata,
            agentId,
        });
        if (!params.matches(bindings?.bindingsByServiceId[params.serviceKey])) continue;
        hadMatchingBinding = true;

        const target = resolveMachineControlTargetForSessionFromState(state, session.id);
        const machineId = target?.machineId ?? null;
        if (!machineId) continue;

        const machine = machineById[machineId];
        if (machine && isMachineSelectableForFleet(params.accountScope, machine)) return { machineId: machine.id };
    }

    return { machineId: null, reason: hadMatchingBinding ? 'machine_offline' : 'no_bound_session' };
}

function resolveConnectedServiceMachineTargetForBinding(params: Readonly<{
    accountScope: ServerAccountScope | null;
    serviceKey: string;
    legacyServiceId: ConnectedServiceId | null;
    sessions: ReadonlyArray<Session> | null;
    machines: ReadonlyArray<Machine>;
    matches: (binding: ConnectedServiceBindingSelectionV2 | undefined) => boolean;
}>): string | null {
    return resolveConnectedServiceMachineTargetStatusForBinding(params).machineId;
}

export function resolveConnectedServiceRecoveryCreditMachineTarget(params: Readonly<{
    accountScope: ServerAccountScope | null;
    serviceId: string;
    profileId: string;
    sessions: ReadonlyArray<Session> | null;
    machines: ReadonlyArray<Machine>;
    connectedServicesV2: ReadonlyArray<AccountProfileConnectedService>;
}>): string | null {
    const serviceKey = resolveQualifiedConnectedAccountServiceKey(params.serviceId);
    const service = serviceKey && parseQualifiedPluginContributionKey(serviceKey);
    if (!serviceKey || !service) return null;
    const legacyServiceId = readBuiltInLegacyConnectedServiceIdForQualifiedService(service);
    return resolveConnectedServiceMachineTargetForBinding({
        accountScope: params.accountScope,
        serviceKey,
        legacyServiceId,
        sessions: params.sessions,
        machines: params.machines,
        matches: (binding) => bindingTargetsProfile({
            binding,
            services: params.connectedServicesV2,
            serviceKey,
            legacyServiceId,
            profileId: params.profileId,
        }),
    });
}

export function useConnectedServiceRecoveryCreditMachineTarget(params: Readonly<{
    serviceId: string;
    profileId: string;
}>): string | null {
    const sessions = useSessions();
    const machines = useActiveMachineFacts();
    const connectedServicesV2 = useProfile(profile => profile.connectedServicesV2, ['connectedServicesV2']);
    const activeServer = useActiveServerSnapshot();
    const activeScope = useActiveServerAccountScope();
    const accountScope = selectActiveServerAccountScopeForServer(activeScope, activeServer.serverId);
    const reachabilityRevision = useMachineReachabilityRevision();

    return React.useMemo(() => resolveConnectedServiceRecoveryCreditMachineTarget({
        accountScope,
        serviceId: params.serviceId,
        profileId: params.profileId,
        sessions,
        machines,
        connectedServicesV2: connectedServicesV2 ?? [],
    }), [accountScope, machines, params.profileId, params.serviceId, connectedServicesV2, reachabilityRevision, sessions]);
}
