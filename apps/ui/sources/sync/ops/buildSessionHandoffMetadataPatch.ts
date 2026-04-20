import { writeRuntimeDescriptorV1ToMetadata, type DirectSessionsSource, type RuntimeDescriptorV1 } from '@happier-dev/protocol';

import { getAgentBehavior, writeAgentVendorResumeIdToMetadata, type AgentId } from '@/agents/catalog/catalog';

import type { Metadata } from '../domains/state/storageTypes';

type MetadataRecord = Metadata;
type SessionHandoffStorageMode = 'direct' | 'persisted';
type SessionHandoffTransportStrategy = 'direct_peer' | 'server_routed_stream';

function normalizeWorkspaceRootPath(raw: unknown): string | null {
    const candidate = typeof raw === 'string' ? raw.trim() : '';
    if (!candidate.startsWith('/')) return null;
    if (candidate.includes('\0')) return null;
    const segments = candidate.split('/').filter(Boolean);
    if (segments.length === 0) return null;
    if (segments.some((segment) => segment === '..')) return null;
    return `/${segments.join('/')}`;
}

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
    targetRuntimeDescriptor?: RuntimeDescriptorV1;
}>): MetadataRecord {
    const sourceWorkspaceRootPath = normalizeWorkspaceRootPath(
        (input.sourceMetadataForHandoff ?? input.metadata).path,
    );
    const targetWorkspaceRootPath = normalizeWorkspaceRootPath(input.targetPath);

    let next: MetadataRecord = writeAgentVendorResumeIdToMetadata({
        ...input.metadata,
        machineId: input.targetMachineId,
        path: input.targetPath,
        flavor: input.providerId,
    }, input.providerId, input.targetRemoteSessionId);

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

    if (providerPatch?.metadataPatch) {
        Object.assign(next, providerPatch.metadataPatch);
    }

    next = writeRuntimeDescriptorV1ToMetadata(next, providerPatch?.runtimeDescriptor ?? null) as MetadataRecord;

    if (input.sessionStorageAfter === 'direct') {
        delete next.externalHistoryImportV1;
        next.directSessionV1 = {
            v: 1,
            providerId: input.providerId,
            machineId: input.targetMachineId,
            remoteSessionId: input.targetRemoteSessionId,
            source: input.targetDirectSource,
            linkedAtMs: input.completedAtMs,
            ...(providerPatch?.directSessionRuntimeDescriptor
                ? { runtimeDescriptorV1: providerPatch.directSessionRuntimeDescriptor }
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
