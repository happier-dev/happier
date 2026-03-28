import {
    buildCodexAgentRuntimeDescriptor,
    buildOpenCodeAgentRuntimeDescriptor,
    normalizeCodexBackendMode,
} from '@happier-dev/agents';
import type { AgentRuntimeDescriptorV1, DirectSessionsSource } from '@happier-dev/protocol';
import {
    readCanonicalAgentRuntimeDescriptorV1ForProvider,
    readAgentRuntimeDescriptorV1ForProvider,
} from '@happier-dev/protocol';

import { writeAgentVendorResumeIdToMetadata } from '@/agents/catalog/catalog';

import type { Metadata } from '../domains/state/storageTypes';

type MetadataRecord = Metadata;
type SessionHandoffStorageMode = 'direct' | 'persisted';
type SessionHandoffTransportStrategy = 'direct_peer' | 'server_routed_stream';

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function normalizeTrimmedString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
}

function normalizeOpenCodeBackendMode(value: unknown): 'server' | 'acp' | null {
    return value === 'server' || value === 'acp' ? value : null;
}

function clearClaudeMachineLocalMetadata(metadata: MetadataRecord): void {
    delete metadata.claudeTranscriptPath;
    delete metadata.claudeLastCheckpointId;
    delete metadata.claudeLastAssistantUuid;
}

function resolveCodexRuntimeSourceAffinity(
    targetDirectSource: DirectSessionsSource | Record<string, unknown>,
): Readonly<{
    home?: 'user' | 'connectedService';
    connectedServiceId?: string;
    connectedServiceProfileId?: string;
    homePath?: string;
}> {
    const directSourceRecord = asRecord(targetDirectSource);
    if (directSourceRecord?.kind !== 'codexHome') {
        return {};
    }

    return directSourceRecord.home === 'connectedService'
        ? {
            home: 'connectedService',
            connectedServiceId: normalizeTrimmedString(directSourceRecord.connectedServiceId) ?? undefined,
            connectedServiceProfileId: normalizeTrimmedString(directSourceRecord.connectedServiceProfileId) ?? undefined,
            homePath: normalizeTrimmedString(directSourceRecord.homePath) ?? undefined,
        }
        : {
            home: 'user',
            homePath: normalizeTrimmedString(directSourceRecord.homePath) ?? undefined,
        };
}

function readTargetOpenCodeServerBaseUrl(
    metadata: MetadataRecord,
    targetDirectSource: DirectSessionsSource | Record<string, unknown>,
): string | null {
    const directSourceRecord = asRecord(targetDirectSource);
    if (directSourceRecord?.kind === 'opencodeServer') {
        return normalizeTrimmedString(directSourceRecord.baseUrl);
    }

    if (metadata.opencodeServerBaseUrlExplicit === true) {
        return normalizeTrimmedString(metadata.opencodeServerBaseUrl);
    }

    return null;
}

function resolveTargetOpenCodeBackendMode(
    metadata: MetadataRecord,
    targetDirectSource: DirectSessionsSource | Record<string, unknown>,
): 'server' | 'acp' | null {
    const directSourceRecord = asRecord(targetDirectSource);
    if (directSourceRecord?.kind === 'opencodeServer') {
        return 'server';
    }

    return normalizeOpenCodeBackendMode(metadata.opencodeBackendMode);
}

function buildHandoffAgentRuntimeDescriptor(input: Readonly<{
    metadata: MetadataRecord;
    providerId: 'claude' | 'codex' | 'opencode';
    targetRemoteSessionId: string;
    targetDirectSource: DirectSessionsSource | Record<string, unknown>;
    targetRuntimeDescriptor?: AgentRuntimeDescriptorV1;
}>): AgentRuntimeDescriptorV1 | null {
    if (input.providerId === 'codex') {
        const importedRuntimeDescriptor = readCanonicalAgentRuntimeDescriptorV1ForProvider(input.targetRuntimeDescriptor, 'codex');
        if (importedRuntimeDescriptor) {
            return buildCodexAgentRuntimeDescriptor({
                backendMode: importedRuntimeDescriptor.backendMode ?? 'appServer',
                vendorSessionId: importedRuntimeDescriptor.vendorSessionId,
                home: importedRuntimeDescriptor.home,
                connectedServiceId: importedRuntimeDescriptor.connectedServiceId,
                connectedServiceProfileId: importedRuntimeDescriptor.connectedServiceProfileId,
                homePath: importedRuntimeDescriptor.homePath,
            });
        }

        const backendMode = normalizeCodexBackendMode(input.metadata.codexBackendMode);
        if (!backendMode) return null;
        return buildCodexAgentRuntimeDescriptor({
            backendMode,
            vendorSessionId: input.targetRemoteSessionId,
            ...resolveCodexRuntimeSourceAffinity(input.targetDirectSource),
        });
    }

    if (input.providerId === 'opencode') {
        const importedRuntimeDescriptor = readCanonicalAgentRuntimeDescriptorV1ForProvider(input.targetRuntimeDescriptor, 'opencode');
        if (importedRuntimeDescriptor) {
            return buildOpenCodeAgentRuntimeDescriptor({
                backendMode: importedRuntimeDescriptor.backendMode ?? 'server',
                vendorSessionId: importedRuntimeDescriptor.vendorSessionId,
                ...(importedRuntimeDescriptor.serverBaseUrl ? { serverBaseUrl: importedRuntimeDescriptor.serverBaseUrl } : {}),
                ...(importedRuntimeDescriptor.serverBaseUrlExplicit ? { serverBaseUrlExplicit: true } : {}),
            });
        }

        const backendMode = resolveTargetOpenCodeBackendMode(input.metadata, input.targetDirectSource);
        if (!backendMode) return null;
        const serverBaseUrl = readTargetOpenCodeServerBaseUrl(input.metadata, input.targetDirectSource);
        return buildOpenCodeAgentRuntimeDescriptor({
            backendMode,
            vendorSessionId: input.targetRemoteSessionId,
            ...(serverBaseUrl ? { serverBaseUrl } : {}),
            ...(serverBaseUrl ? { serverBaseUrlExplicit: true } : {}),
        });
    }

    return null;
}

export function buildSessionHandoffMetadataPatch(input: Readonly<{
    metadata: MetadataRecord;
    sourceMetadataForHandoff?: MetadataRecord;
    providerId: 'claude' | 'codex' | 'opencode';
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

    const next: MetadataRecord = writeAgentVendorResumeIdToMetadata({
        ...input.metadata,
        machineId: input.targetMachineId,
        path: input.targetPath,
        flavor: input.providerId,
    }, input.providerId, input.targetRemoteSessionId);
    const runtimeDescriptor = buildHandoffAgentRuntimeDescriptor(input);

    if (input.providerId === 'claude') {
        clearClaudeMachineLocalMetadata(next);
    }

    if (input.providerId === 'codex') {
        const importedRuntimeDescriptor = readCanonicalAgentRuntimeDescriptorV1ForProvider(input.targetRuntimeDescriptor, 'codex');
        const backendMode = importedRuntimeDescriptor?.backendMode ?? normalizeCodexBackendMode(next.codexBackendMode);
        if (backendMode) {
            next.codexBackendMode = backendMode;
        }
    }

    if (input.providerId === 'opencode') {
        const importedRuntimeDescriptor = readCanonicalAgentRuntimeDescriptorV1ForProvider(input.targetRuntimeDescriptor, 'opencode');
        const backendMode = importedRuntimeDescriptor?.backendMode
            ?? resolveTargetOpenCodeBackendMode(next, input.targetDirectSource);
        if (backendMode) {
            next.opencodeBackendMode = backendMode;
        }

        const serverBaseUrl = importedRuntimeDescriptor?.serverBaseUrl ?? readTargetOpenCodeServerBaseUrl(next, input.targetDirectSource);
        if (serverBaseUrl) {
            next.opencodeServerBaseUrl = serverBaseUrl;
            next.opencodeServerBaseUrlExplicit = true;
        } else {
            delete next.opencodeServerBaseUrl;
            delete next.opencodeServerBaseUrlExplicit;
        }
    }

    if (runtimeDescriptor) {
        next.agentRuntimeDescriptorV1 = runtimeDescriptor;
    } else {
        delete next.agentRuntimeDescriptorV1;
    }

    if (input.sessionStorageAfter === 'direct') {
        delete next.externalHistoryImportV1;
        const nestedRuntimeDescriptor = input.providerId === 'codex'
            ? readAgentRuntimeDescriptorV1ForProvider(runtimeDescriptor, 'codex')
            : input.providerId === 'opencode'
                ? readAgentRuntimeDescriptorV1ForProvider(runtimeDescriptor, 'opencode')
                : null;
        next.directSessionV1 = {
            v: 1,
            providerId: input.providerId,
            machineId: input.targetMachineId,
            remoteSessionId: input.targetRemoteSessionId,
            source: input.targetDirectSource,
            linkedAtMs: input.completedAtMs,
            ...(nestedRuntimeDescriptor ? { agentRuntimeDescriptorV1: nestedRuntimeDescriptor } : {}),
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
