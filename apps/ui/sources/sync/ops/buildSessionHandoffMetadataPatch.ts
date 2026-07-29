import { applyRuntimeDescriptorSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';
import {
    buildLinkedExternalSessionMetadataV1,
    readLinkedExternalSessionV1FromMetadata,
    removeLinkedExternalSessionMetadataV1,
    type ExternalSessionsSource,
    type RuntimeDescriptorV1,
} from '@happier-dev/protocol';

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
    agentId: AgentId;
    sourceMachineId: string;
    targetMachineId: string;
    sessionStorageBefore: SessionHandoffStorageMode;
    sessionStorageAfter: SessionHandoffStorageMode;
    targetPath: string;
    transportStrategy: SessionHandoffTransportStrategy;
    completedAtMs: number;
    targetRemoteSessionId: string;
    targetDirectSource: ExternalSessionsSource | Record<string, unknown>;
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
        flavor: input.agentId,
    }, input.agentId, input.targetRemoteSessionId);

    const providerPatch = getAgentBehavior(input.agentId).sessionHandoff?.buildProviderPatch?.({
        agentId: input.agentId,
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

    next = applyRuntimeDescriptorSessionMetadata(
        next,
        providerPatch?.runtimeDescriptor ?? null,
    );
    if (!providerPatch?.runtimeDescriptor) {
        delete next.agentRuntimeDescriptorV1;
    }

    if (input.sessionStorageAfter === 'direct') {
        delete next.externalHistoryImportV1;
        const externalSessionV1 = readLinkedExternalSessionV1FromMetadata({
          externalSessionV1: {
            v: 1,
            agentId: input.agentId,
            machineId: input.targetMachineId,
            remoteSessionId: input.targetRemoteSessionId,
            source: input.targetDirectSource,
            linkedAtMs: input.completedAtMs,
            ...(providerPatch?.externalSessionRuntimeDescriptor
                ? { runtimeDescriptorV1: providerPatch.externalSessionRuntimeDescriptor }
                : {}),
          },
        });
        if (!externalSessionV1) {
            throw new Error(`Invalid external-session handoff link for Agent ${input.agentId}`);
        }
        next = buildLinkedExternalSessionMetadataV1(next, externalSessionV1) as MetadataRecord;
    } else {
        next = removeLinkedExternalSessionMetadataV1(next) as MetadataRecord;
        next.externalHistoryImportV1 = {
            v: 1,
            agentId: input.agentId,
            remoteSessionId: input.targetRemoteSessionId,
            importedAtMs: input.completedAtMs,
            source: input.targetDirectSource,
        };
    }

    next.handoffV1 = {
        v: 1,
        sourceMachineId: input.sourceMachineId,
        targetMachineId: input.targetMachineId,
        agentId: input.agentId,
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
