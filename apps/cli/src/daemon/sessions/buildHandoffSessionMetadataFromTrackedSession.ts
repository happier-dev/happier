import { resolveSessionRuntimeIdentityFallback } from '@/agent/runtime/identity';

import type { Metadata } from '@/api/types';
import {
    createSessionHandoffMetadataSplit,
    pickSessionHandoffRuntimeLocalMetadata,
    type SessionHandoffLocalMetadataSource,
} from '@/session/handoff/metadata/runtimeLocalSessionHandoffMetadata';
import { buildConfiguredAcpBackendSessionMetadata } from '@/agent/acp/catalog/configured/sessionMetadata';
import { buildRuntimeLocalHandoffMetadataForAgent } from '@/session/handoff/metadata/catalogHooks';
import type { TrackedSession } from '../types';
import { resolveConcreteBackendTargetRefV2 } from '@/session/backendTargets/resolveConcreteBackendTargetRefs';
import {
    getAgentResumeConfig,
    isAgentId,
} from '@happier-dev/agents';
import { buildProviderSessionIdSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';
import { projectAgentVisibleSessionMetadata } from '@/agent/runtime/sessionMetadataVisibility';

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
    const backendTarget = resolveConcreteBackendTargetRefV2(trackedSession.spawnOptions?.backendTarget);
    if (!backendTarget) {
        return '';
    }
    if (backendTarget.sourceKind === 'configured') {
        const backendId = backendTarget.configuredBackendId?.trim() || backendTarget.backendId.trim();
        return backendId ? `acp:${backendId}` : '';
    }
    if (backendTarget.sourceKind === 'built_in') {
        return backendTarget.backendId.trim();
    }
    return '';
}

function buildConfiguredAcpFallbackMetadata(trackedSession: TrackedSession): Record<string, unknown> | null {
    const backendTarget = resolveConcreteBackendTargetRefV2(trackedSession.spawnOptions?.backendTarget);
    if (backendTarget?.sourceKind !== 'configured') {
        return null;
    }
    const backendId = backendTarget.configuredBackendId?.trim() || backendTarget.backendId.trim();
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
        'claudeSessionId' | 'codexSessionId' | 'opencodeSessionId' | 'externalSessionV1'
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

    const runtimeIdentity = resolveSessionRuntimeIdentityFallback({ metadata });
    const agentId = typeof runtimeIdentity.providerId === 'string' ? runtimeIdentity.providerId.trim() : '';

    if (isAgentId(agentId)) {
        const vendorResumeIdField = getAgentResumeConfig(agentId).vendorResumeIdField;
        if (vendorResumeIdField && !(runtimeLocalMetadata as Record<string, unknown>)[vendorResumeIdField]) {
            Object.assign(
                runtimeLocalMetadata,
                buildProviderSessionIdSessionMetadata({
                    metadataKey: vendorResumeIdField,
                    value: vendorResumeId,
                }),
            );
        }
        const providerRuntimeLocalMetadata = buildRuntimeLocalHandoffMetadataForAgent(agentId, {
            metadata: projectAgentVisibleSessionMetadata(metadata),
            trackedSession: params.trackedSession,
            vendorResumeId,
        });
        if (providerRuntimeLocalMetadata) {
            Object.assign(runtimeLocalMetadata, providerRuntimeLocalMetadata);
        }
    }

    return createSessionHandoffMetadataSplit({
        exportMetadata: metadata,
        ...(Object.keys(runtimeLocalMetadata).length > 0 ? { runtimeLocalMetadata } : {}),
    });
}
