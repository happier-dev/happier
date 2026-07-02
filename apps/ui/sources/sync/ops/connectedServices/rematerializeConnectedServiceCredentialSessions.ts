import {
    readSessionMetadataConnectedServiceBindings,
    resolveAgentIdFromSessionMetadata,
} from '@happier-dev/agents';
import {
    ConnectedServiceBindingsV1Schema,
    type ConnectedServiceBindingSelectionV1,
    type ConnectedServiceBindingsV1,
    type ConnectedServiceId,
} from '@happier-dev/protocol';

import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { resolveMachineControlTargetForSessionFromState } from '@/sync/ops/sessionMachineTarget';

import { setSessionConnectedServiceAuthBinding } from './sessionAuthSwitch';

export type RematerializeConnectedServiceCredentialSessionsResult = Readonly<{
    requestedSessionIds: readonly string[];
    failedSessionIds: readonly string[];
}>;

type ConnectedServiceProfileGroup = Readonly<{
    groupId: string;
    activeProfileId: string | null;
    generation: number;
}>;

function readRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function readSessionConnectedServiceBindings(
    session: Session,
    agentId: string,
): ConnectedServiceBindingsV1 | null {
    const metadata = readRecord(session.metadata);
    const connectedServices = readRecord(metadata?.connectedServices);
    const parsed = ConnectedServiceBindingsV1Schema.safeParse(connectedServices);
    if (parsed.success) return parsed.data;

    const descriptorBindings = readSessionMetadataConnectedServiceBindings(session.metadata, agentId);
    const parsedDescriptorBindings = ConnectedServiceBindingsV1Schema.safeParse({
        v: 1,
        bindingsByServiceId: descriptorBindings,
    });
    return parsedDescriptorBindings.success ? parsedDescriptorBindings.data : null;
}

function findConnectedServiceGroup(
    serviceId: ConnectedServiceId,
    groupId: string,
): ConnectedServiceProfileGroup | null {
    const state = storage.getState();
    const service = state.profile.connectedServicesV2.find((candidate) => candidate.serviceId === serviceId) ?? null;
    return service?.groups.find((candidate) => candidate.groupId === groupId) ?? null;
}

function bindingTargetsProfile(params: Readonly<{
    binding: ConnectedServiceBindingSelectionV1 | undefined;
    serviceId: ConnectedServiceId;
    profileId: string;
}>): boolean {
    const { binding, serviceId, profileId } = params;
    if (!binding || binding.source !== 'connected') return false;
    if (binding.selection !== 'group') return binding.profileId === profileId;

    const group = findConnectedServiceGroup(serviceId, binding.groupId);
    return group?.activeProfileId === profileId || binding.profileId === profileId;
}

function expectedGroupGenerationForBinding(params: Readonly<{
    binding: ConnectedServiceBindingSelectionV1 | undefined;
    serviceId: ConnectedServiceId;
}>): Readonly<Record<string, number>> | undefined {
    const { binding, serviceId } = params;
    if (!binding || binding.source !== 'connected' || binding.selection !== 'group') return undefined;
    const group = findConnectedServiceGroup(serviceId, binding.groupId);
    return typeof group?.generation === 'number'
        ? { [serviceId]: group.generation }
        : undefined;
}

export async function rematerializeActiveSessionsForConnectedServiceProfile(params: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
}>): Promise<RematerializeConnectedServiceCredentialSessionsResult> {
    const state = storage.getState();
    const requestedSessionIds: string[] = [];
    const failedSessionIds: string[] = [];

    for (const session of Object.values(state.sessions ?? {})) {
        if (!session.active) continue;

        const agentId = resolveAgentIdFromSessionMetadata(session.metadata);
        if (!agentId) continue;

        const bindings = readSessionConnectedServiceBindings(session, agentId);
        const binding = bindings?.bindingsByServiceId[params.serviceId];
        if (!bindings || !bindingTargetsProfile({ binding, serviceId: params.serviceId, profileId: params.profileId })) {
            continue;
        }

        const machineTarget = resolveMachineControlTargetForSessionFromState(state, session.id);
        const machineId = machineTarget?.machineId ?? null;
        if (!machineId) continue;

        const result = await setSessionConnectedServiceAuthBinding({
            sessionId: session.id,
            agentId,
            machineId,
            serverId: session.serverId ?? null,
            bindings,
            rematerializeServiceId: params.serviceId,
            expectedGroupGenerationByServiceId: expectedGroupGenerationForBinding({
                binding,
                serviceId: params.serviceId,
            }),
        });

        if (result.ok) {
            requestedSessionIds.push(session.id);
        } else {
            failedSessionIds.push(session.id);
        }
    }

    return { requestedSessionIds, failedSessionIds };
}
