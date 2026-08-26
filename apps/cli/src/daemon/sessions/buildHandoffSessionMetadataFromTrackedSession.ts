import { resolveSessionRuntimeIdentityFallback } from '@/agent/runtime/identity';

import type { Metadata } from '@/api/types';
import {
    createSessionHandoffMetadataSplit,
    pickSessionHandoffRuntimeLocalMetadata,
    type SessionHandoffLocalMetadataSource,
} from '@/session/handoff/metadata/runtimeLocalSessionHandoffMetadata';
import { buildConfiguredAcpBackendSessionMetadata } from '@/agent/acp/catalog/configured/sessionMetadata';
import { isCatalogAgentId } from '@/agent/catalog/resolution';
import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import type { TrackedSession } from '../types';
import { resolveConcreteBackendTargetRefV2 } from '@/session/backendTargets/resolveConcreteBackendTargetRefs';
import {
    getAgentResumeConfig,
    readAgentSurfaceRuntimeDescriptorV1FromSessionMetadata,
} from '@happier-dev/agents';
import { ExternalSessionsSourceSchema } from '@happier-dev/protocol';
import { buildProviderSessionIdSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';

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

function normalizeTranscriptStorage(value: unknown): 'direct' | 'persisted' | null {
    return value === 'direct' || value === 'persisted' ? value : null;
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

export async function buildHandoffSessionMetadataFromTrackedSession(params: Readonly<{
    trackedSession: TrackedSession;
    machineId?: string;
    fallbackHomeDir?: string;
    localExportMetadataOverlay?: Record<string, unknown> | null;
}>): Promise<SessionHandoffLocalMetadataSource | null> {
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

    const agentResumeConfig = agentId ? getAgentResumeConfig(agentId) : null;
    if (agentResumeConfig) {
        const vendorResumeIdField = agentResumeConfig.vendorResumeIdField;
        if (vendorResumeIdField && !(runtimeLocalMetadata as Record<string, unknown>)[vendorResumeIdField]) {
            Object.assign(
                runtimeLocalMetadata,
                buildProviderSessionIdSessionMetadata({
                    metadataKey: vendorResumeIdField,
                    value: vendorResumeId,
                }),
            );
        }
    }

    // Catalog membership, rather than the generated built-in ID set, decides
    // whether a runtime identity owns a handoff metadata hook. This keeps an
    // installed external Agent exact while leaving configured ACP identities
    // without a catalog Agent unmodified.
    const runtimeDescriptorV1 = readAgentSurfaceRuntimeDescriptorV1FromSessionMetadata(metadata);
    if (agentId && runtimeDescriptorV1 && isCatalogAgentId(agentId)) {
        const currentRuntime = await getSessionHostBridge()
            .resolveCurrentExecutionSurfacesForCatalogAgent(agentId);
        const buildRuntimeLocalMetadata = currentRuntime?.agentId === agentId
            ? currentRuntime.executionSurfaces.handoff?.buildRuntimeLocalMetadata
            : null;
        const identity = {
            machineId: normalizeOptionalString(metadata.machineId),
            workingDirectory: normalizeOptionalString(metadata.path),
            transcriptStorage: normalizeTranscriptStorage(
                params.trackedSession.spawnOptions?.transcriptStorage,
            ),
            vendorResumeId,
        } as const;
        const providerRuntimeLocalMetadata = buildRuntimeLocalMetadata
            ? await buildRuntimeLocalMetadata({ identity, runtimeDescriptorV1 })
            : null;
        const externalSessionSource = ExternalSessionsSourceSchema.safeParse(
            providerRuntimeLocalMetadata?.externalSessionSource,
        );
        if (
            externalSessionSource.success
            && identity.machineId
            && identity.transcriptStorage === 'direct'
        ) {
            runtimeLocalMetadata.externalSessionV1 = {
                v: 1,
                agentId,
                machineId: identity.machineId,
                remoteSessionId: vendorResumeId,
                source: externalSessionSource.data,
                linkedAtMs: Date.now(),
            };
        }
    }

    return createSessionHandoffMetadataSplit({
        exportMetadata: metadata,
        ...(Object.keys(runtimeLocalMetadata).length > 0 ? { runtimeLocalMetadata } : {}),
    });
}
