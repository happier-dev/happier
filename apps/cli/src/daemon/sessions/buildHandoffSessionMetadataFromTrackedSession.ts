import { inferAgentIdFromSessionMetadata } from '@happier-dev/agents';

import type { Metadata } from '@/api/types';
import {
    createSessionHandoffMetadataSplit,
    pickSessionHandoffRuntimeLocalMetadata,
    type SessionHandoffLocalMetadataSource,
} from '@/session/handoff/metadata/runtimeLocalSessionHandoffMetadata';
import { buildConfiguredAcpBackendSessionMetadata } from '@/agent/acp/catalog/configured/buildConfiguredAcpBackendSessionMetadata';
import type { TrackedSession } from '../types';
import { resolveConfiguredClaudeConfigDir } from '@/backends/claude/directSessions/resolveClaudeConfigDir';
import { resolveClaudeProjectId } from '@/backends/claude/utils/path';

function asMetadataRecord(value: unknown): Metadata | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    return value as Metadata;
}

function normalizeOptionalString(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function resolveFallbackFlavorFromBackendTarget(trackedSession: TrackedSession): string {
    const backendTarget = trackedSession.spawnOptions?.backendTarget;
    if (backendTarget?.kind === 'configuredAcpBackend') {
        const backendId = backendTarget.backendId.trim();
        return backendId ? `acp:${backendId}` : '';
    }
    if (backendTarget?.kind === 'builtInAgent') {
        return typeof backendTarget.agentId === 'string' ? backendTarget.agentId.trim() : '';
    }
    return '';
}

function buildConfiguredAcpFallbackMetadata(trackedSession: TrackedSession): Record<string, unknown> | null {
    const backendTarget = trackedSession.spawnOptions?.backendTarget;
    if (backendTarget?.kind !== 'configuredAcpBackend') {
        return null;
    }
    const backendId = backendTarget.backendId.trim();
    if (!backendId) {
        return null;
    }
    return {
        ...buildConfiguredAcpBackendSessionMetadata({
            backendId,
            title: backendId,
        }),
    };
}

function resolveTrackedSessionFallbackMetadata(params: Readonly<{
    trackedSession: TrackedSession;
    machineId?: string;
    fallbackHomeDir?: string;
}>): Record<string, unknown> | null {
    const sourcePath =
        typeof params.trackedSession.spawnOptions?.directory === 'string'
            ? params.trackedSession.spawnOptions.directory.trim()
            : '';
    const machineId = typeof params.machineId === 'string' ? params.machineId.trim() : '';
    const fallbackHomeDir = typeof params.fallbackHomeDir === 'string' ? params.fallbackHomeDir.trim() : '';
    const environmentVariables = params.trackedSession.spawnOptions?.environmentVariables;
    const homeDir = typeof environmentVariables?.HOME === 'string' && environmentVariables.HOME.trim().length > 0
        ? environmentVariables.HOME.trim()
        : fallbackHomeDir;
    const flavor = resolveFallbackFlavorFromBackendTarget(params.trackedSession);
    if (!sourcePath || !machineId || !homeDir || !flavor) {
        return null;
    }
    const configuredAcpFallbackMetadata = buildConfiguredAcpFallbackMetadata(params.trackedSession);
    return {
        machineId,
        path: sourcePath,
        homeDir,
        flavor,
        ...(configuredAcpFallbackMetadata ?? {}),
    };
}

export function buildHandoffSessionMetadataFromTrackedSession(params: Readonly<{
    trackedSession: TrackedSession;
    machineId?: string;
    fallbackHomeDir?: string;
    localExportMetadataOverlay?: Record<string, unknown> | null;
}>): SessionHandoffLocalMetadataSource | null {
    const localExportMetadataOverlay = asMetadataRecord(params.localExportMetadataOverlay);
    const baseMetadata =
        asMetadataRecord(params.trackedSession.happySessionMetadataFromLocalWebhook)
        ?? resolveTrackedSessionFallbackMetadata(params);
    const metadata = baseMetadata
        ? {
            ...baseMetadata,
            ...(localExportMetadataOverlay ?? {}),
        }
        : localExportMetadataOverlay
            ? { ...localExportMetadataOverlay }
        : null;
    if (!metadata) {
        return null;
    }

    const runtimeLocalMetadata: Partial<Pick<
        Metadata,
        'claudeSessionId' | 'codexSessionId' | 'opencodeSessionId' | 'directSessionV1'
    >> = {
        ...(pickSessionHandoffRuntimeLocalMetadata(metadata) ?? {}),
    };
    const vendorResumeId = normalizeOptionalString(params.trackedSession.vendorResumeId)
        ?? normalizeOptionalString(params.trackedSession.spawnOptions?.resume)
        ?? '';
    if (!vendorResumeId) {
        return createSessionHandoffMetadataSplit({
            exportMetadata: metadata,
            ...(Object.keys(runtimeLocalMetadata).length > 0 ? { runtimeLocalMetadata } : {}),
        });
    }

    const agentId = inferAgentIdFromSessionMetadata(metadata);

    switch (agentId) {
        case 'claude': {
            if (!runtimeLocalMetadata.claudeSessionId) {
                runtimeLocalMetadata.claudeSessionId = vendorResumeId;
            }
            if (!runtimeLocalMetadata.directSessionV1 && params.trackedSession.spawnOptions?.transcriptStorage === 'direct') {
                const configDir = resolveConfiguredClaudeConfigDir({
                    env: {
                        ...process.env,
                        ...(params.trackedSession.spawnOptions.environmentVariables ?? {}),
                    },
                });
                const machineId = typeof metadata.machineId === 'string' ? metadata.machineId.trim() : '';
                runtimeLocalMetadata.directSessionV1 = {
                    v: 1,
                    providerId: 'claude',
                    machineId,
                    remoteSessionId: vendorResumeId,
                    source: {
                        kind: 'claudeConfig',
                        configDir,
                        ...(typeof metadata.path === 'string' && metadata.path.trim()
                            ? { projectId: resolveClaudeProjectId(metadata.path.trim()) }
                            : {}),
                    },
                    linkedAtMs: Date.now(),
                };
            }
            break;
        }
        case 'codex':
            if (!runtimeLocalMetadata.codexSessionId) {
                runtimeLocalMetadata.codexSessionId = vendorResumeId;
            }
            break;
        case 'opencode':
            if (!runtimeLocalMetadata.opencodeSessionId) {
                runtimeLocalMetadata.opencodeSessionId = vendorResumeId;
            }
            break;
        default:
            break;
    }

    return createSessionHandoffMetadataSplit({
        exportMetadata: metadata,
        ...(Object.keys(runtimeLocalMetadata).length > 0 ? { runtimeLocalMetadata } : {}),
    });
}
