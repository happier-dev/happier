import type { AgentRuntimeDescriptorV1, DirectSessionsSource } from '@happier-dev/protocol';

import { projectCurrentAgentSessionView } from '@happier-dev/agents';

import { getAgentBehavior, type AgentId } from '@/agents/catalog/catalog';

import type { Metadata } from '../domains/state/storageTypes';

type MetadataRecord = Metadata;
type SessionHandoffStorageMode = 'direct' | 'persisted';
type SessionHandoffTransportStrategy = 'direct_peer' | 'server_routed_stream';

export function buildSessionHandoffMetadataPatch(input: Readonly<{
    metadata: MetadataRecord;
    sourceMetadataForHandoff?: MetadataRecord;
    providerId: AgentId;
    sourceMachineId: string;
    targetMachineId: string;
    sessionStorageBefore: SessionHandoffStorageMode;
    sessionStorageAfter: SessionHandoffStorageMode;
    targetPath: string;
    transportStrategy: SessionHandoffTransportStrategy;
    completedAtMs: number;
    targetRemoteSessionId: string;
    targetDirectSource: DirectSessionsSource | Record<string, unknown>;
    targetRuntimeDescriptor?: AgentRuntimeDescriptorV1;
}>): MetadataRecord {
    const normalizeWorkspaceRootPath = (raw: unknown): string | null => {
        const candidate = typeof raw === 'string' ? raw.trim() : '';
        if (!candidate.startsWith('/')) return null;
        if (candidate.includes('\0')) return null;
        const segments = candidate.split('/').filter(Boolean);
        if (segments.length === 0) return null;
        if (segments.some((segment) => segment === '..')) return null;
        return `/${segments.join('/')}`;
    };

    const sourceWorkspaceRootPath = normalizeWorkspaceRootPath(
        (input.sourceMetadataForHandoff ?? input.metadata).path,
    );
    const targetWorkspaceRootPath = normalizeWorkspaceRootPath(input.targetPath);

    // Handoff moves the SAME Agent to another machine, so its current
    // projections stay true and are carried. The projector remains the single
    // owner of the identity rewrite: it drops every other Agent's stale flat
    // resume key before writing the target's. A handoff-local writer cannot do
    // that without becoming a second identity mutator, and a Session left
    // holding two flat keys cannot be resumed from its own committed metadata.
    const next: MetadataRecord = projectCurrentAgentSessionView({
        metadata: {
            ...input.metadata,
            machineId: input.targetMachineId,
            path: input.targetPath,
        },
        target: { agentId: input.providerId, updatedAtMs: input.completedAtMs },
        nativeResumeId: input.targetRemoteSessionId,
        agentScopedCurrentState: 'carry',
    }) as MetadataRecord;

    const providerPatch = getAgentBehavior(input.providerId).sessionHandoff?.buildProviderPatch?.({
        agentId: input.providerId,
        metadata: next,
        sourceMetadataForHandoff: input.sourceMetadataForHandoff,
        targetRemoteSessionId: input.targetRemoteSessionId,
        targetDirectSource: input.targetDirectSource,
        targetRuntimeDescriptor: input.targetRuntimeDescriptor,
    }) ?? null;

    for (const key of providerPatch?.clearMetadataKeys ?? []) {
        delete next[key];
    }

    for (const [key, value] of Object.entries(providerPatch?.metadataPatch ?? {})) {
        if (value === undefined) {
            delete next[key];
        } else {
            next[key] = value;
        }
    }

    if (providerPatch?.agentRuntimeDescriptor) {
        next.agentRuntimeDescriptorV1 = providerPatch.agentRuntimeDescriptor;
    } else {
        delete next.agentRuntimeDescriptorV1;
    }

    if (input.sessionStorageAfter === 'direct') {
        delete next.externalHistoryImportV1;
        next.directSessionV1 = {
            v: 1,
            providerId: input.providerId,
            machineId: input.targetMachineId,
            remoteSessionId: input.targetRemoteSessionId,
            source: input.targetDirectSource,
            linkedAtMs: input.completedAtMs,
            ...(providerPatch?.directSessionAgentRuntimeDescriptor
                ? { agentRuntimeDescriptorV1: providerPatch.directSessionAgentRuntimeDescriptor }
                : {}),
        };
    } else {
        delete next.directSessionV1;
        next.externalHistoryImportV1 = {
            v: 1,
            providerId: input.providerId,
            remoteSessionId: input.targetRemoteSessionId,
            importedAtMs: input.completedAtMs,
            source: input.targetDirectSource,
        };
    }

    next.handoffV1 = {
        v: 1,
        sourceMachineId: input.sourceMachineId,
        targetMachineId: input.targetMachineId,
        providerId: input.providerId,
        sessionStorageBefore: input.sessionStorageBefore,
        sessionStorageAfter: input.sessionStorageAfter,
        transportStrategy: input.transportStrategy,
        completedAtMs: input.completedAtMs,
        ...(sourceWorkspaceRootPath && targetWorkspaceRootPath
            ? {
                sourceWorkspaceRootPath,
                targetWorkspaceRootPath,
            }
            : {}),
    };

    return next;
}
