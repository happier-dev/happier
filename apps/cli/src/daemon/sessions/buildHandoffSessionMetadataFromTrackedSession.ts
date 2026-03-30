import { inferAgentIdFromSessionMetadata } from '@happier-dev/agents';

import type { Metadata } from '@/api/types';
import {
    createSessionHandoffMetadataSplit,
    pickSessionHandoffRuntimeLocalMetadata,
    type SessionHandoffLocalMetadataSource,
} from '@/session/handoff/metadata/runtimeLocalSessionHandoffMetadata';
import type { TrackedSession } from '../types';
import { resolveConfiguredClaudeConfigDir } from '@/backends/claude/directSessions/resolveClaudeConfigDir';
import { resolveClaudeProjectId } from '@/backends/claude/utils/path';

function asMetadataRecord(value: unknown): Metadata | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    return value as Metadata;
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
    const backendTarget = params.trackedSession.spawnOptions?.backendTarget;
    const flavor =
        backendTarget?.kind === 'builtInAgent'
        && typeof backendTarget.agentId === 'string'
        && ['claude', 'codex', 'opencode'].includes(backendTarget.agentId)
            ? backendTarget.agentId
            : '';
    if (!sourcePath || !machineId || !homeDir || !flavor) {
        return null;
    }
    return {
        machineId,
        path: sourcePath,
        homeDir,
        flavor,
    };
}

export function buildHandoffSessionMetadataFromTrackedSession(params: Readonly<{
    trackedSession: TrackedSession;
    machineId?: string;
    fallbackHomeDir?: string;
}>): SessionHandoffLocalMetadataSource | null {
    const metadata =
        asMetadataRecord(params.trackedSession.happySessionMetadataFromLocalWebhook)
        ?? resolveTrackedSessionFallbackMetadata(params);
    if (!metadata) {
        return null;
    }

    const runtimeLocalMetadata: Partial<Pick<
        Metadata,
        'claudeSessionId' | 'codexSessionId' | 'opencodeSessionId' | 'directSessionV1'
    >> = {
        ...(pickSessionHandoffRuntimeLocalMetadata(metadata) ?? {}),
    };
    const vendorResumeId =
        typeof params.trackedSession.vendorResumeId === 'string' && params.trackedSession.vendorResumeId.trim().length > 0
            ? params.trackedSession.vendorResumeId.trim()
            : '';
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
