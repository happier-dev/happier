import { resolveModelSelectionIntentFromSessionMetadata, resolvePermissionIntentFromSessionMetadata } from '@happier-dev/agents';
import { buildBackendTargetKeyV2, SessionMcpSelectionV1Schema } from '@happier-dev/protocol';

import { isAgentId } from '@/agents/catalog/catalog';
import { getModelOverrideForSpawn } from '@/sync/domains/models/modelOverride';
import { getPermissionModeOverrideForSpawn } from '@/sync/domains/permissions/permissionModeOverride';
import { resolveSessionActionDefaultBackend } from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import type { Session } from '@/sync/domains/state/storageTypes';

import {
    normalizeSessionAuthoringConnectedServices,
    normalizeOptionalRecord,
    normalizeOptionalString,
    normalizeRequiredString,
    normalizeTerminalFromSessionMetadata,
    normalizeTranscriptStorage,
    resolveCanonicalCodexBackendMode,
} from './sessionAuthoringNormalization';
import type { SessionAuthoringSnapshot } from './sessionAuthoringSnapshot';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

export function deriveSessionAuthoringSnapshot(params: Readonly<{
    session: Pick<
        Session,
        'id' | 'encryptionMode' | 'metadata' | 'metadataLayoutVersion' | 'ownerMetadataView' | 'permissionMode' | 'permissionModeUpdatedAt' | 'modelMode' | 'modelModeUpdatedAt'
    >;
    sessionDekBase64?: string | null;
}>): SessionAuthoringSnapshot {
    const metadata = readSessionOwnerMetadataView(params.session as Session);
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
    const agentTargetKey = backendTarget ? buildBackendTargetKeyV2(backendTarget) : null;
    const permissionOverride = getPermissionModeOverrideForSpawn(params.session as Session);
    const metadataPermission = resolvePermissionIntentFromSessionMetadata(metadata);
    const metadataPermissionMode = metadataPermission?.intent ?? null;
    const metadataPermissionModeUpdatedAt = metadataPermission?.updatedAt ?? null;
    const metadataModelIntent = agentTargetKey
        ? resolveModelSelectionIntentFromSessionMetadata(metadata, agentTargetKey)
        : null;
    const modelSelection = agentTargetKey
        ? getModelOverrideForSpawn(params.session as Session, agentTargetKey)?.modelSelection ?? null
        : null;
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
        agentId: backendTarget && isAgentId(backendTarget.backendId) && !backendTarget.configuredBackendId
            ? backendTarget.backendId
            : null,
        backendTarget,
        transcriptStorage: normalizeTranscriptStorage((metadata as Record<string, unknown> | null)?.transcriptStorage),
        profileId: normalizeOptionalString(metadata?.profileId),
        permissionMode: permissionOverride?.permissionMode ?? metadataPermissionMode,
        permissionModeUpdatedAt: permissionOverride?.permissionModeUpdatedAt ?? metadataPermissionModeUpdatedAt,
        modelSelection,
        modelId: modelSelection?.ref.modelId ?? null,
        modelUpdatedAt: modelSelection?.updatedAt ?? metadataModelIntent?.updatedAt ?? null,
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
