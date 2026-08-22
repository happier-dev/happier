import {
    isBundledAgentId,
    projectSessionMetadataForAgentHandoff,
} from '@happier-dev/agents';
import {
    applyRuntimeDescriptorSessionMetadata,
    clearSessionStateFieldFromMetadata,
    projectCurrentAgentSessionView,
} from '@happier-dev/agents/session/state/metadataWriters';
import {
    buildLinkedExternalSessionMetadataV1,
    readLinkedExternalSessionV1FromMetadata,
    removeLinkedExternalSessionMetadataV1,
    normalizeSessionHandoffWorkspaceRootPath,
    type ExternalSessionAgentId,
    type ExternalSessionsSource,
    type RuntimeDescriptorV1,
} from '@happier-dev/protocol';

import { getAgentBehavior } from '@/agents/catalog/catalog';

import type { Metadata } from '../domains/state/storageTypes';

type MetadataRecord = Metadata;
type SessionHandoffStorageMode = 'direct' | 'persisted';
type SessionHandoffTransportStrategy = 'direct_peer' | 'server_routed_stream';

export function buildSessionHandoffMetadataPatch(input: Readonly<{
    metadata: MetadataRecord;
    sourceMetadataForHandoff?: MetadataRecord;
    agentId: ExternalSessionAgentId;
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
    const sourceWorkspaceRootPath = normalizeSessionHandoffWorkspaceRootPath(
        (input.sourceMetadataForHandoff ?? input.metadata).path,
    );
    const targetWorkspaceRootPath = normalizeSessionHandoffWorkspaceRootPath(input.targetPath);

    const builtInAgentId = isBundledAgentId(input.agentId) ? input.agentId : null;
    const targetMetadata = {
        ...input.metadata,
        machineId: input.targetMachineId,
        path: input.targetPath,
    };
    // Bundled Agents retain their existing projector and provider-owned patch.
    // An installed Agent has no bundled behavior to consult: preserve the daemon
    // result's declared identity and descriptor while clearing stale flat resume
    // state through the same canonical metadata writer.
    let next: MetadataRecord = builtInAgentId
        ? projectCurrentAgentSessionView(targetMetadata, {
            agentId: builtInAgentId,
            nativeResumeIdentity: {
                v: 1,
                vendorResumeId: input.targetRemoteSessionId,
            },
            // The provider patch below is the authoritative descriptor writer for a
            // handoff, so the projector leaves the slot empty rather than round-tripping
            // the source descriptor through a second normalization.
            agentScopedCurrentState: 'carry',
        }) as MetadataRecord
        : clearSessionStateFieldFromMetadata(
            { ...targetMetadata, flavor: input.agentId },
            'identity.providerSessionId',
        ) as MetadataRecord;

    const providerPatch = builtInAgentId
        ? getAgentBehavior(builtInAgentId).sessionHandoff?.buildProviderPatch?.({
            agentId: builtInAgentId,
            metadata: projectSessionMetadataForAgentHandoff(next),
            sourceMetadataForHandoff: input.sourceMetadataForHandoff
                ? projectSessionMetadataForAgentHandoff(input.sourceMetadataForHandoff)
                : undefined,
            targetRemoteSessionId: input.targetRemoteSessionId,
            targetDirectSource: input.targetDirectSource,
            targetRuntimeDescriptor: input.targetRuntimeDescriptor,
        }) ?? null
        : null;

    for (const key of providerPatch?.clearMetadataKeys ?? []) {
        delete next[key];
    }

    if (providerPatch?.metadataPatch) {
        Object.assign(next, providerPatch.metadataPatch);
    }

    const runtimeDescriptor = providerPatch?.runtimeDescriptor
        ?? (!builtInAgentId ? input.targetRuntimeDescriptor ?? null : null);
    const externalSessionRuntimeDescriptor = providerPatch?.externalSessionRuntimeDescriptor
        ?? (!builtInAgentId ? input.targetRuntimeDescriptor : undefined);
    next = applyRuntimeDescriptorSessionMetadata(next, runtimeDescriptor);
    if (!runtimeDescriptor) {
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
            ...(externalSessionRuntimeDescriptor
                ? { runtimeDescriptorV1: externalSessionRuntimeDescriptor }
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
