import * as React from 'react';

import {
    resolveAgentIdFromSessionMetadata,
} from '@happier-dev/agents';
import {
    type AccountProfile,
    type ConnectedServiceBindingSelectionV1,
    type ConnectedServiceId,
} from '@happier-dev/protocol';

import {
    readSessionConnectedServiceBindings,
} from '@/sync/domains/connectedServices/readSessionConnectedServiceBindings';
import {
    resolveQualifiedConnectedAccountServiceKey,
} from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { useAllMachines, useProfile, useSessions } from '@/sync/domains/state/storage';
import { resolveMachineControlTargetForSessionFromState } from '@/sync/ops/sessionMachineTarget';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

type AccountProfileConnectedService = AccountProfile['connectedServicesV2'][number];

function buildRecordById<T extends Readonly<{ id: string }>>(items: ReadonlyArray<T>): Record<string, T> {
    const record: Record<string, T> = {};
    for (const item of items) {
        record[item.id] = item;
    }
    return record;
}

function bindingTargetsProfile(params: Readonly<{
    binding: ConnectedServiceBindingSelectionV1 | undefined;
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
    /** Canonical qualified Connected Account service key of the session bindings. */
    serviceKey: string;
    /** Released scalar id for the V2 account lookup; null for novel external services. */
    legacyServiceId: ConnectedServiceId | null;
    sessions: ReadonlyArray<Session> | null;
    machines: ReadonlyArray<Machine>;
    matches: (binding: ConnectedServiceBindingSelectionV1 | undefined) => boolean;
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
        if (machine && isMachineOnline(machine)) return { machineId: machine.id };
    }

    return { machineId: null, reason: hadMatchingBinding ? 'machine_offline' : 'no_bound_session' };
}

function resolveConnectedServiceMachineTargetForBinding(params: Readonly<{
    serviceKey: string;
    legacyServiceId: ConnectedServiceId | null;
    sessions: ReadonlyArray<Session> | null;
    machines: ReadonlyArray<Machine>;
    matches: (binding: ConnectedServiceBindingSelectionV1 | undefined) => boolean;
}>): string | null {
    return resolveConnectedServiceMachineTargetStatusForBinding(params).machineId;
}

export function resolveConnectedServiceRecoveryCreditMachineTarget(params: Readonly<{
    /** Released V3 account-surface scalar id; translated through the provenance-named legacy ingress. */
    serviceId: ConnectedServiceId;
    profileId: string;
    sessions: ReadonlyArray<Session> | null;
    machines: ReadonlyArray<Machine>;
    connectedServicesV2: ReadonlyArray<AccountProfileConnectedService>;
}>): string | null {
    // Session bindings are canonical qualified; the released V3 account surface
    // speaks scalar ids. Translate once at this named seam and fail closed for
    // an unknown service — never index canonical bindings with a bare id.
    const serviceKey = resolveQualifiedConnectedAccountServiceKey(params.serviceId);
    if (!serviceKey) return null;
    return resolveConnectedServiceMachineTargetForBinding({
        serviceKey,
        // The V2 account lookup keeps the released scalar identity of this
        // released V3 surface fact.
        legacyServiceId: params.serviceId,
        sessions: params.sessions,
        machines: params.machines,
        matches: (binding) => bindingTargetsProfile({
            binding,
            services: params.connectedServicesV2,
            serviceKey,
            legacyServiceId: params.serviceId,
            profileId: params.profileId,
        }),
    });
}

export function useConnectedServiceRecoveryCreditMachineTarget(params: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
}>): string | null {
    const sessions = useSessions();
    const machines = useAllMachines();
    const profile = useProfile();

    return React.useMemo(() => resolveConnectedServiceRecoveryCreditMachineTarget({
        serviceId: params.serviceId,
        profileId: params.profileId,
        sessions,
        machines,
        connectedServicesV2: profile.connectedServicesV2 ?? [],
    }), [machines, params.profileId, params.serviceId, profile.connectedServicesV2, sessions]);
}
