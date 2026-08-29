import { resolveModelSelectionIntentFromSessionMetadata, resolvePermissionIntentFromSessionMetadata } from '@happier-dev/agents';
import {
    buildBackendTargetKeyV2,
    parseBackendTargetKeyV2,
    readRuntimeDescriptorV1FromMetadata,
    SessionMcpSelectionV1Schema,
} from '@happier-dev/protocol';

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
} from './sessionAuthoringNormalization';
import type { SessionAuthoringSnapshot } from './sessionAuthoringSnapshot';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { resolveAgentExecutionTargetForBackendTarget } from '@/agents/backendCatalog/resolveAgentExecutionTargetForBackendTarget';

function resolvePersistedModelTargetKey(metadata: Record<string, unknown> | null, canonicalTargetKey: string): string {
    const rawIntent = metadata?.modelSelectionIntentV1;
    if (!rawIntent || typeof rawIntent !== 'object' || Array.isArray(rawIntent)) return canonicalTargetKey;
    const rawSelection = (rawIntent as Record<string, unknown>).selection;
    if (!rawSelection || typeof rawSelection !== 'object' || Array.isArray(rawSelection)) return canonicalTargetKey;
    const rawTargetKey = (rawSelection as Record<string, unknown>).agentTargetKey;
    if (typeof rawTargetKey !== 'string' || !rawTargetKey.startsWith('backend:')) return canonicalTargetKey;
    try {
        const compatibilityAgentTarget = resolveAgentExecutionTargetForBackendTarget({
            backendTarget: parseBackendTargetKeyV2(rawTargetKey),
        });
        return compatibilityAgentTarget
            && buildBackendTargetKeyV2(compatibilityAgentTarget) === canonicalTargetKey
            ? rawTargetKey
            : canonicalTargetKey;
    } catch {
        return canonicalTargetKey;
    }
}

export function deriveSessionAuthoringSnapshot(params: Readonly<{
    session: Pick<
        Session,
        'id' | 'encryptionMode' | 'metadata' | 'metadataLayoutVersion' | 'ownerMetadataView' | 'permissionMode' | 'permissionModeUpdatedAt' | 'modelMode' | 'modelModeUpdatedAt'
    >;
    sessionDekBase64?: string | null;
}>): SessionAuthoringSnapshot {
    const metadata = readSessionOwnerMetadataView(params.session as Session);
    const runtimeDescriptorV1 = readRuntimeDescriptorV1FromMetadata(metadata);
    const defaultBackend = resolveSessionActionDefaultBackend({
        session: params.session as Session,
    });
    const backendTarget = defaultBackend?.backendTarget ?? null;
    const agentTarget = defaultBackend?.agentTarget ?? null;
    const canonicalAgentTargetKey = agentTarget
        ? buildBackendTargetKeyV2(agentTarget)
        : backendTarget
            ? buildBackendTargetKeyV2(backendTarget)
            : null;
    // Released Sessions may carry the predecessor backend-key spelling. Read
    // that exact admitted key only when it canonicalizes to the current Agent
    // target; new authoring output is re-keyed by its owning adapter below.
    const agentTargetKey = canonicalAgentTargetKey
        ? resolvePersistedModelTargetKey(metadata, canonicalAgentTargetKey)
        : null;
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
        agentId: defaultBackend?.defaultAgentId ?? null,
        agentTarget,
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
        runtimeDescriptorV1,
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
