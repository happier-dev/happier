import type { Metadata } from '@/api/types';
import {
    createSessionHandoffMetadataSplit,
    pickSessionHandoffRuntimeLocalMetadata,
    type SessionHandoffLocalMetadataSource,
    type SessionHandoffRuntimeLocalMetadata,
} from '@/session/handoff/metadata/runtimeLocalSessionHandoffMetadata';
import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import type { TrackedSession } from '../types';
import { resolveConcreteBackendTargetRefV2 } from '@/session/backendTargets/resolveConcreteBackendTargetRefs';
import {
    ExternalSessionsSourceSchema,
    readRuntimeDescriptorV1FromMetadata,
} from '@happier-dev/protocol';

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
        return '';
    }
    if (backendTarget.sourceKind === 'built_in') {
        return backendTarget.backendId.trim();
    }
    return '';
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
    const homeDir = fallbackHomeDir;
    const flavor = resolveFallbackFlavorFromBackendTarget(params.trackedSession);
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

    let runtimeLocalMetadata: SessionHandoffRuntimeLocalMetadata = {
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

    // Current writers persist the canonical descriptor. Released flat session
    // ids are read only by pickSessionHandoffRuntimeLocalMetadata above; this
    // path does not synthesize another Agent-specific writer.
    const runtimeDescriptorV1 = readRuntimeDescriptorV1FromMetadata(metadata);
    const agentId = runtimeDescriptorV1?.agentId ?? '';
    const compatibilityBackendTarget = resolveConcreteBackendTargetRefV2(
        params.trackedSession.spawnOptions?.backendTarget,
    );
    if (
        agentId
        && runtimeDescriptorV1
        && compatibilityBackendTarget?.sourceKind !== 'configured'
    ) {
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
            runtimeLocalMetadata = {
                ...runtimeLocalMetadata,
                externalSessionV1: {
                    v: 1,
                    agentId,
                    machineId: identity.machineId,
                    remoteSessionId: vendorResumeId,
                    source: externalSessionSource.data,
                    linkedAtMs: Date.now(),
                    runtimeDescriptorV1,
                },
            };
        }
    }

    return createSessionHandoffMetadataSplit({
        exportMetadata: metadata,
        ...(Object.keys(runtimeLocalMetadata).length > 0 ? { runtimeLocalMetadata } : {}),
    });
}
