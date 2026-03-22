import { SessionMcpSelectionV1Schema, isBuiltInAgentTarget } from '@happier-dev/protocol';

import { getModelOverrideForSpawn } from '@/sync/domains/models/modelOverride';
import { getPermissionModeOverrideForSpawn } from '@/sync/domains/permissions/permissionModeOverride';
import { resolveSessionActionDefaultBackend } from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import type { Session } from '@/sync/domains/state/storageTypes';

import {
    normalizeOptionalNumber,
    normalizeSessionAuthoringConnectedServices,
    normalizeOptionalRecord,
    normalizeOptionalString,
    normalizeRequiredString,
    normalizeTerminalFromSessionMetadata,
    normalizeTranscriptStorage,
    resolveCanonicalCodexBackendMode,
    resolveMetadataModelOverride,
} from './sessionAuthoringNormalization';
import type { SessionAuthoringSnapshot } from './sessionAuthoringSnapshot';

export function deriveSessionAuthoringSnapshot(params: Readonly<{
    session: Pick<
        Session,
        'id' | 'encryptionMode' | 'metadata' | 'permissionMode' | 'permissionModeUpdatedAt' | 'modelMode' | 'modelModeUpdatedAt'
    >;
    sessionDekBase64?: string | null;
}>): SessionAuthoringSnapshot {
    const metadata = params.session.metadata;
    const codexBackendMode = resolveCanonicalCodexBackendMode({
        codexBackendMode: metadata?.codexBackendMode,
        experimentalCodexAcp: metadata && Object.prototype.hasOwnProperty.call(metadata, 'experimentalCodexAcp')
            ? (metadata as Record<string, unknown>).experimentalCodexAcp
            : undefined,
    });
    const defaultBackend = resolveSessionActionDefaultBackend({
        session: params.session as Session,
    });
    const backendTarget = defaultBackend?.backendTarget ?? null;
    const permissionOverride = getPermissionModeOverrideForSpawn(params.session as Session);
    const metadataPermissionMode = normalizeOptionalString(metadata?.permissionMode);
    const metadataPermissionModeUpdatedAt = normalizeOptionalNumber(metadata?.permissionModeUpdatedAt);
    const modelOverride = getModelOverrideForSpawn(params.session as Session);
    const metadataModelOverride = resolveMetadataModelOverride(params.session);
    const rawMcpSelection = metadata && Object.prototype.hasOwnProperty.call(metadata, 'mcpSelection')
        ? (metadata as Record<string, unknown>).mcpSelection
        : undefined;
    const parsedMcpSelection = rawMcpSelection === undefined
        ? null
        : SessionMcpSelectionV1Schema.safeParse(rawMcpSelection);

    return {
        directory: normalizeRequiredString(
            normalizeOptionalString(metadata?.path)
            ?? normalizeOptionalString(metadata?.homeDir)
            ?? '/',
        ),
        agentId: backendTarget && isBuiltInAgentTarget(backendTarget) ? backendTarget.agentId : null,
        backendTarget,
        transcriptStorage: normalizeTranscriptStorage((metadata as Record<string, unknown> | null)?.transcriptStorage),
        profileId: normalizeOptionalString(metadata?.profileId),
        permissionMode: permissionOverride?.permissionMode ?? metadataPermissionMode,
        permissionModeUpdatedAt: permissionOverride?.permissionModeUpdatedAt ?? metadataPermissionModeUpdatedAt,
        modelId: modelOverride?.modelId ?? metadataModelOverride.modelId,
        modelUpdatedAt: modelOverride?.modelUpdatedAt ?? metadataModelOverride.modelUpdatedAt,
        mcpSelection: parsedMcpSelection?.success ? parsedMcpSelection.data : null,
        connectedServices: normalizeSessionAuthoringConnectedServices(
            metadata && Object.prototype.hasOwnProperty.call(metadata, 'connectedServices')
                ? (metadata as Record<string, unknown>).connectedServices
                : null,
        ),
        terminal: normalizeTerminalFromSessionMetadata(params.session),
        codexBackendMode,
        existingSessionId: params.session.id,
        sessionEncryptionMode: params.session.encryptionMode === 'plain' ? 'plain' : 'e2ee',
        sessionEncryptionKeyBase64: params.session.encryptionMode === 'plain'
            ? null
            : normalizeOptionalString(params.sessionDekBase64),
        sessionEncryptionVariant: params.session.encryptionMode === 'plain'
            ? null
            : normalizeOptionalString(params.sessionDekBase64)
                ? 'dataKey'
                : null,
    };
}
