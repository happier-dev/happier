import type { Metadata } from '@/api/types';
import type { TrackedSession } from '@/daemon/types';

import { resolveConfiguredClaudeConfigDir } from '../externalSessions/resolveClaudeConfigDir';
import { resolveClaudeProjectId } from '../utils/path';

function normalizeOptionalString(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function buildClaudeRuntimeLocalHandoffMetadata(params: Readonly<{
    metadata: Record<string, unknown>;
    trackedSession: TrackedSession;
    vendorResumeId?: string | null;
    nowMs?: number;
    processEnv?: NodeJS.ProcessEnv;
}>): Partial<Pick<Metadata, 'claudeSessionId' | 'directSessionV1'>> {
    const runtimeLocalMetadata: Partial<Pick<Metadata, 'claudeSessionId' | 'directSessionV1'>> = {};
    const vendorResumeId =
        normalizeOptionalString(params.vendorResumeId)
        ?? normalizeOptionalString(params.trackedSession.vendorResumeId)
        ?? normalizeOptionalString(params.trackedSession.spawnOptions?.resume)
        ?? '';
    if (!vendorResumeId) {
        return runtimeLocalMetadata;
    }

    runtimeLocalMetadata.claudeSessionId = vendorResumeId;

    if (params.trackedSession.spawnOptions?.transcriptStorage !== 'direct') {
        return runtimeLocalMetadata;
    }

    const configDir = resolveConfiguredClaudeConfigDir({
        env: {
            ...(params.processEnv ?? process.env),
            ...(params.trackedSession.spawnOptions.environmentVariables ?? {}),
        },
    });
    const machineId = typeof params.metadata.machineId === 'string' ? params.metadata.machineId.trim() : '';
    runtimeLocalMetadata.directSessionV1 = {
        v: 1,
        providerId: 'claude',
        machineId,
        remoteSessionId: vendorResumeId,
        source: {
            kind: 'claudeConfig',
            configDir,
            ...(typeof params.metadata.path === 'string' && params.metadata.path.trim()
                ? { projectId: resolveClaudeProjectId(params.metadata.path.trim()) }
                : {}),
        },
        linkedAtMs: params.nowMs ?? Date.now(),
    };

    return runtimeLocalMetadata;
}
