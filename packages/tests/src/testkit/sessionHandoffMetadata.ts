import {
    openEncryptedDataKeyEnvelopeV1,
    readRuntimeDescriptorV1FromMetadata,
    writeRuntimeDescriptorV1ToMetadata,
} from '@happier-dev/protocol';

import { decryptDataKeyBase64, encryptDataKeyBase64 } from './rpcCrypto';
import { decryptLegacyBase64, encryptLegacyBase64 } from './messageCrypto';
import { fetchSessionV2, fetchSessionsV2, patchSessionMetadataWithRetry } from './sessions';
import { unwrapSerializedJsonValue } from './unwrapSerializedJsonValue';

type SessionHandoffTransportStrategy = 'direct_peer' | 'server_routed_stream';
type SessionStorageMode = 'persisted' | 'direct';
type ProviderId = 'claude' | 'codex' | 'opencode';

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    return value as Record<string, unknown>;
}

function normalizeTrimmedString(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function normalizeWorkspaceRootPath(value: unknown): string | null {
    const candidate = normalizeTrimmedString(value);
    if (!candidate || !candidate.startsWith('/')) {
        return null;
    }
    if (candidate.includes('\0')) {
        return null;
    }

    const segments = candidate.split('/').filter(Boolean);
    if (segments.length === 0) {
        return null;
    }
    if (segments.some((segment) => segment === '..')) {
        return null;
    }

    return `/${segments.join('/')}`;
}

function resolveVendorResumeIdField(providerId: ProviderId): 'claudeSessionId' | 'codexSessionId' | 'opencodeSessionId' {
    switch (providerId) {
        case 'claude':
            return 'claudeSessionId';
        case 'codex':
            return 'codexSessionId';
        case 'opencode':
            return 'opencodeSessionId';
    }
}

function clearClaudeMachineLocalMetadata(metadata: Record<string, unknown>): void {
    delete metadata.claudeTranscriptPath;
    delete metadata.claudeLastCheckpointId;
    delete metadata.claudeLastAssistantUuid;
}

function resolveRemoteSessionId(metadata: Record<string, unknown>, providerId: ProviderId): string {
    const vendorResumeIdField = resolveVendorResumeIdField(providerId);
    const vendorResumeId = normalizeTrimmedString(metadata[vendorResumeIdField]);
    if (vendorResumeId) {
        return vendorResumeId;
    }

    const directSession = asRecord(metadata.directSessionV1);
    const externalHistoryImport = asRecord(metadata.externalHistoryImportV1);
    return (
        normalizeTrimmedString(directSession?.remoteSessionId)
        ?? normalizeTrimmedString(externalHistoryImport?.remoteSessionId)
        ?? ''
    );
}

export function resolveSessionHandoffBackTargetRootPath(params: Readonly<{
    metadata: Record<string, unknown>;
    requestedTargetMachineId: string;
}>): string | null {
    const hintedTargetRootPath = normalizeWorkspaceRootPath(
        params.metadata.workspaceReplicationHandoffBackTargetRootPath,
    );
    if (hintedTargetRootPath) {
        return hintedTargetRootPath;
    }

    const handoff = asRecord(params.metadata.handoffV1);
    if (!handoff) {
        return null;
    }

    const priorSourceMachineId = normalizeTrimmedString(handoff.sourceMachineId);
    const requestedTargetMachineId = normalizeTrimmedString(params.requestedTargetMachineId);
    if (!priorSourceMachineId || priorSourceMachineId !== requestedTargetMachineId) {
        return null;
    }

    return normalizeWorkspaceRootPath(handoff.sourceWorkspaceRootPath);
}

async function readDecryptedSessionMetadataV2(params: Readonly<{
    baseUrl: string;
    token: string;
    sessionId: string;
    machineKeys: readonly Uint8Array[];
}>): Promise<Readonly<{
    sessionBefore: Awaited<ReturnType<typeof fetchSessionV2>>;
    metadata: Record<string, unknown>;
    selectedSecret: Uint8Array;
    selectedUsesDataKeyVariant: boolean;
}>> {
    const sessionList = await fetchSessionsV2(params.baseUrl, params.token, { limit: 200 });
    const sessionRow = sessionList.sessions.find((session) => session.id === params.sessionId) ?? null;
    if (!sessionRow?.dataEncryptionKey) {
        throw new Error(`Expected encrypted session data key for handoff metadata read (${params.sessionId})`);
    }

    const sessionBefore = await fetchSessionV2(params.baseUrl, params.token, params.sessionId);
    const encryptedDataKeyEnvelope = new Uint8Array(Buffer.from(sessionRow.dataEncryptionKey, 'base64'));
    const candidateSecrets: Uint8Array[] = [];
    if (encryptedDataKeyEnvelope.length === 32) {
        candidateSecrets.push(encryptedDataKeyEnvelope);
    }
    for (const machineKey of params.machineKeys) {
        const opened = openEncryptedDataKeyEnvelopeV1({
            envelope: encryptedDataKeyEnvelope,
            recipientSecretKeyOrSeed: machineKey,
        });
        if (opened && opened.length === 32) {
            candidateSecrets.push(opened);
        }
    }

    for (const secret of candidateSecrets) {
        const decryptedDataKeyMetadata = unwrapSerializedJsonValue(decryptDataKeyBase64(sessionBefore.metadata, secret));
        const metadataBefore = decryptedDataKeyMetadata ?? decryptLegacyBase64(sessionBefore.metadata, secret);
        if (!metadataBefore || typeof metadataBefore !== 'object' || Array.isArray(metadataBefore)) {
            continue;
        }

        return {
            sessionBefore,
            metadata: metadataBefore as Record<string, unknown>,
            selectedSecret: secret,
            selectedUsesDataKeyVariant: Boolean(decryptedDataKeyMetadata),
        };
    }

    throw new Error(`Expected decryptable session data key and metadata for handoff metadata read (${params.sessionId})`);
}

export async function fetchSessionMetadataV2(params: Readonly<{
    baseUrl: string;
    token: string;
    sessionId: string;
    machineKeys: readonly Uint8Array[];
}>): Promise<Record<string, unknown>> {
    const result = await readDecryptedSessionMetadataV2(params);
    return result.metadata;
}

export function buildPatchedSessionHandoffMetadata(metadataBefore: Record<string, unknown>, params: Readonly<{
    targetMachineId: string;
    targetWorkspaceRootPath: string;
    providerId: ProviderId;
    sessionStorageAfter: SessionStorageMode;
    completedAtMs: number;
}>): Record<string, unknown> {
    const nextMetadata: Record<string, unknown> = {
        ...metadataBefore,
        machineId: params.targetMachineId,
        path: params.targetWorkspaceRootPath,
        flavor: params.providerId,
    };

    const vendorResumeIdField = resolveVendorResumeIdField(params.providerId);
    const remoteSessionId = resolveRemoteSessionId(metadataBefore, params.providerId);
    if (remoteSessionId) {
        nextMetadata[vendorResumeIdField] = remoteSessionId;
    }

    if (params.providerId === 'claude') {
        clearClaudeMachineLocalMetadata(nextMetadata);
    }

    const directSessionBefore = asRecord(metadataBefore.directSessionV1);
    const externalHistoryImportBefore = asRecord(metadataBefore.externalHistoryImportV1);
    const directSessionRuntimeDescriptorV1 = readRuntimeDescriptorV1FromMetadata(directSessionBefore);

    if (params.sessionStorageAfter === 'direct') {
        nextMetadata.directSessionV1 = writeRuntimeDescriptorV1ToMetadata({
            v: 1,
            providerId: params.providerId,
            machineId: params.targetMachineId,
            remoteSessionId,
            source: directSessionBefore?.source ?? externalHistoryImportBefore?.source,
            linkedAtMs: params.completedAtMs,
        }, directSessionRuntimeDescriptorV1);
        delete nextMetadata.externalHistoryImportV1;
    } else {
        nextMetadata.externalHistoryImportV1 = {
            v: 1,
            providerId: params.providerId,
            remoteSessionId,
            importedAtMs: params.completedAtMs,
            source: directSessionBefore?.source ?? externalHistoryImportBefore?.source,
        };
        delete nextMetadata.directSessionV1;
    }

    return nextMetadata;
}

export async function patchSessionHandoffMetadataV1(params: Readonly<{
    baseUrl: string;
    token: string;
    sessionId: string;
    machineKeys: readonly Uint8Array[];
    providerId: ProviderId;
    sourceMachineId: string;
    targetMachineId: string;
    sourceWorkspaceRootPath: string;
    targetWorkspaceRootPath: string;
    sessionStorageBefore: SessionStorageMode;
    sessionStorageAfter: SessionStorageMode;
    transportStrategy: SessionHandoffTransportStrategy;
    completedAtMs?: number;
}>): Promise<void> {
    const {
        sessionBefore,
        metadata: selectedMetadataBefore,
        selectedSecret,
        selectedUsesDataKeyVariant,
    } = await readDecryptedSessionMetadataV2({
        baseUrl: params.baseUrl,
        token: params.token,
        sessionId: params.sessionId,
        machineKeys: params.machineKeys,
    });
    const completedAtMs = params.completedAtMs ?? Date.now();

    const nextMetadata = buildPatchedSessionHandoffMetadata(selectedMetadataBefore, {
        targetMachineId: params.targetMachineId,
        targetWorkspaceRootPath: params.targetWorkspaceRootPath,
        providerId: params.providerId,
        sessionStorageAfter: params.sessionStorageAfter,
        completedAtMs,
    });
    nextMetadata.handoffV1 = {
        v: 1,
        sourceMachineId: params.sourceMachineId,
        targetMachineId: params.targetMachineId,
        providerId: params.providerId,
        sessionStorageBefore: params.sessionStorageBefore,
        sessionStorageAfter: params.sessionStorageAfter,
        transportStrategy: params.transportStrategy,
        completedAtMs,
        sourceWorkspaceRootPath: params.sourceWorkspaceRootPath,
        targetWorkspaceRootPath: params.targetWorkspaceRootPath,
    };

    await patchSessionMetadataWithRetry({
        baseUrl: params.baseUrl,
        token: params.token,
        sessionId: params.sessionId,
        ciphertext: selectedUsesDataKeyVariant
            ? encryptDataKeyBase64(nextMetadata, selectedSecret)
            : encryptLegacyBase64(nextMetadata, selectedSecret),
        expectedVersion: sessionBefore.metadataVersion,
    });
}
