import { randomBytes } from 'node:crypto';

import {
    SESSION_METADATA_LAYOUT_VERSION_V1,
    SessionOwnerMetadataEnvelopeV1Schema,
    createPlainSessionOwnerMetadataEnvelopeV1,
    createSessionOwnerMetadataV1,
    openEncryptedDataKeyEnvelopeV1,
    openSessionOwnerMetadataEnvelopeV1,
    projectSessionOwnerCompatibilityViewV1,
    projectSessionSharedMetadataV1,
    readRuntimeDescriptorV1FromMetadata,
    normalizeSessionHandoffWorkspaceRootPath,
    sealSessionOwnerMetadataEnvelopeV1,
    writeRuntimeDescriptorV1ToMetadata,
    type AccountScopedCryptoMaterial,
} from '@happier-dev/protocol';

import { decryptDataKeyBase64, encryptDataKeyBase64 } from './rpcCrypto';
import { decryptLegacyBase64, encryptLegacyBase64 } from './messageCrypto';
import {
    fetchSessionV2,
    fetchSessionsV2,
    patchSessionMetadataEnvelopeTupleV1,
    patchSessionMetadataWithRetry,
} from './sessions';
import { unwrapSerializedJsonValue } from './unwrapSerializedJsonValue';

type SessionHandoffTransportStrategy = 'direct_peer' | 'server_routed_stream';
type SessionStorageMode = 'persisted' | 'direct';
type ProviderId = 'claude' | 'codex' | 'opencode';

type SessionMetadataAccountAccess =
    | Readonly<{
        accountEncryptionMode?: 'e2ee';
        machineKeys: readonly Uint8Array[];
        accountEncryptionMaterials?: readonly AccountScopedCryptoMaterial[];
    }>
    | Readonly<{
        accountEncryptionMode: 'plain';
        machineKeys?: never;
        accountEncryptionMaterials?: never;
    }>;

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
    const hintedTargetRootPath = normalizeSessionHandoffWorkspaceRootPath(
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

    return normalizeSessionHandoffWorkspaceRootPath(handoff.sourceWorkspaceRootPath);
}

async function readDecryptedSessionMetadataV2(params: Readonly<{
    baseUrl: string;
    token: string;
    sessionId: string;
    includeAgentState?: boolean;
}> & SessionMetadataAccountAccess): Promise<Readonly<{
    sessionBefore: Awaited<ReturnType<typeof fetchSessionV2>>;
    metadata: Record<string, unknown>;
    storedMetadata: Record<string, unknown>;
    selectedSecret: Uint8Array | null;
    selectedUsesDataKeyVariant: boolean;
    accountEncryptionMaterial: AccountScopedCryptoMaterial | null;
    agentState: unknown | null;
}>> {
    const sessionBefore = await fetchSessionV2(params.baseUrl, params.token, params.sessionId);
    const metadataLayoutVersion = sessionBefore.metadataLayoutVersion === 1 ? 1 : 0;
    const accountEncryptionMode = params.accountEncryptionMode ?? 'e2ee';
    const machineKeys = params.machineKeys ?? [];
    const accountEncryptionMaterials = [
        ...('accountEncryptionMaterials' in params
            ? params.accountEncryptionMaterials ?? []
            : []),
        ...machineKeys.map((machineKey) => ({
            type: 'dataKey' as const,
            machineKey,
        })),
    ];

    const projectLayoutOneMetadata = (sharedMetadata: unknown): Readonly<{
        metadata: Record<string, unknown>;
        accountEncryptionMaterial: AccountScopedCryptoMaterial | null;
    }> => {
        const openedOwner = accountEncryptionMode === 'plain'
            ? {
                result: openSessionOwnerMetadataEnvelopeV1({
                    accountMode: 'plain',
                    envelope: sessionBefore.ownerMetadata,
                }),
                material: null,
            }
            : (() => {
                let lastFailure = openSessionOwnerMetadataEnvelopeV1({
                    accountMode: 'e2ee',
                    envelope: sessionBefore.ownerMetadata,
                });
                for (const material of accountEncryptionMaterials) {
                    const opened = openSessionOwnerMetadataEnvelopeV1({
                        accountMode: 'e2ee',
                        envelope: sessionBefore.ownerMetadata,
                        material,
                    });
                    if (opened.ok) {
                        return { result: opened, material };
                    }
                    lastFailure = opened;
                }
                return { result: lastFailure, material: null };
            })();
        if (!openedOwner.result.ok) {
            throw new Error(
                `Failed to open Session owner metadata (${params.sessionId}; reason=${openedOwner.result.reason})`,
            );
        }
        return {
            metadata: projectSessionOwnerCompatibilityViewV1({
                sharedMetadata,
                ownerMetadata: openedOwner.result.ownerMetadata,
            }) as Record<string, unknown>,
            accountEncryptionMaterial: openedOwner.material,
        };
    };

    if (metadataLayoutVersion === 1 && sessionBefore.encryptionMode === 'plain') {
        let sharedMetadata: unknown;
        let agentState: unknown | null = null;
        try {
            sharedMetadata = JSON.parse(sessionBefore.metadata) as unknown;
            agentState = !params.includeAgentState || sessionBefore.agentState === null
                ? null
                : JSON.parse(sessionBefore.agentState) as unknown;
        } catch {
            throw new Error(`Expected valid plain Session metadata tuple (${params.sessionId})`);
        }
        const projected = projectLayoutOneMetadata(sharedMetadata);
        return {
            sessionBefore,
            metadata: projected.metadata,
            storedMetadata: sharedMetadata as Record<string, unknown>,
            selectedSecret: null,
            selectedUsesDataKeyVariant: false,
            accountEncryptionMaterial: projected.accountEncryptionMaterial,
            agentState,
        };
    }

    if (metadataLayoutVersion === 1 && sessionBefore.encryptionMode !== 'e2ee') {
        throw new Error(`Expected explicit Session content mode for layout-one metadata (${params.sessionId})`);
    }

    const sessionList = await fetchSessionsV2(params.baseUrl, params.token, { limit: 200 });
    const sessionRow = sessionList.sessions.find((session) => session.id === params.sessionId) ?? null;
    if (!sessionRow?.dataEncryptionKey) {
        throw new Error(`Expected encrypted session data key for handoff metadata read (${params.sessionId})`);
    }

    const encryptedDataKeyEnvelope = new Uint8Array(Buffer.from(sessionRow.dataEncryptionKey, 'base64'));
    const candidateSecrets: Uint8Array[] = [];
    if (encryptedDataKeyEnvelope.length === 32) {
        candidateSecrets.push(encryptedDataKeyEnvelope);
    }
    for (const machineKey of machineKeys) {
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
        const selectedUsesDataKeyVariant = Boolean(decryptedDataKeyMetadata);
        const agentState = !params.includeAgentState || metadataLayoutVersion === 0 || sessionBefore.agentState === null
            ? null
            : selectedUsesDataKeyVariant
                ? decryptDataKeyBase64(sessionBefore.agentState, secret)
                : decryptLegacyBase64(sessionBefore.agentState, secret);
        if (
            params.includeAgentState
            && metadataLayoutVersion === 1
            && sessionBefore.agentState !== null
            && agentState === null
        ) {
            continue;
        }

        const projected = metadataLayoutVersion === 1
            ? projectLayoutOneMetadata(metadataBefore)
            : null;
        return {
            sessionBefore,
            metadata: projected?.metadata ?? metadataBefore as Record<string, unknown>,
            storedMetadata: metadataBefore as Record<string, unknown>,
            selectedSecret: secret,
            selectedUsesDataKeyVariant,
            accountEncryptionMaterial: projected?.accountEncryptionMaterial ?? null,
            agentState,
        };
    }

    throw new Error(`Expected decryptable session data key and metadata for handoff metadata read (${params.sessionId})`);
}

export async function fetchSessionMetadataV2(params: Readonly<{
    baseUrl: string;
    token: string;
    sessionId: string;
}> & SessionMetadataAccountAccess): Promise<Record<string, unknown>> {
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
    providerId: ProviderId;
    sourceMachineId: string;
    targetMachineId: string;
    sourceWorkspaceRootPath: string;
    targetWorkspaceRootPath: string;
    sessionStorageBefore: SessionStorageMode;
    sessionStorageAfter: SessionStorageMode;
    transportStrategy: SessionHandoffTransportStrategy;
    completedAtMs?: number;
}> & SessionMetadataAccountAccess): Promise<void> {
    const {
        sessionBefore,
        metadata,
        storedMetadata,
        selectedSecret,
        selectedUsesDataKeyVariant,
        accountEncryptionMaterial,
        agentState,
    } = await readDecryptedSessionMetadataV2({
        baseUrl: params.baseUrl,
        token: params.token,
        sessionId: params.sessionId,
        includeAgentState: true,
        ...(params.accountEncryptionMode === 'plain'
            ? { accountEncryptionMode: 'plain' as const }
            : {
                machineKeys: params.machineKeys,
                accountEncryptionMaterials: params.accountEncryptionMaterials,
            }),
    });
    const completedAtMs = params.completedAtMs ?? Date.now();
    const metadataBefore = sessionBefore.metadataLayoutVersion === 1
        ? metadata
        : storedMetadata;
    const nextMetadata = buildPatchedSessionHandoffMetadata(metadataBefore, {
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

    if (sessionBefore.metadataLayoutVersion === 1) {
        const ownerMetadata = createSessionOwnerMetadataV1({ metadata: nextMetadata });
        if (!ownerMetadata.ok) {
            throw new Error(
                `Cannot patch unsupported Session owner metadata (${params.sessionId}; fields=${ownerMetadata.unsupportedFields.join(',')})`,
            );
        }
        const sharedMetadata = projectSessionSharedMetadataV1({
            metadata: nextMetadata,
            agentState,
        });
        const accountEncryptionMode = params.accountEncryptionMode ?? 'e2ee';
        const ownerMetadataEnvelope = accountEncryptionMode === 'plain'
            ? createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata.ownerMetadata)
            : accountEncryptionMaterial
                ? sealSessionOwnerMetadataEnvelopeV1({
                    material: accountEncryptionMaterial,
                    ownerMetadata: ownerMetadata.ownerMetadata,
                    randomBytes: (length) => Uint8Array.from(randomBytes(length)),
                })
                : null;
        if (!ownerMetadataEnvelope) {
            throw new Error(`Cannot patch Session owner metadata without Account E2EE material (${params.sessionId})`);
        }

        const sealSessionContent = (value: unknown): string => {
            if (sessionBefore.encryptionMode === 'plain') {
                return JSON.stringify(value);
            }
            if (!selectedSecret) {
                throw new Error(`Cannot patch handoff metadata without an encrypted Session data key (${params.sessionId})`);
            }
            return selectedUsesDataKeyVariant
                ? encryptDataKeyBase64(value, selectedSecret)
                : encryptLegacyBase64(value, selectedSecret);
        };
        await patchSessionMetadataEnvelopeTupleV1({
            baseUrl: params.baseUrl,
            token: params.token,
            sessionId: params.sessionId,
            patch: {
                mode: 'owner',
                metadataLayoutVersion: SESSION_METADATA_LAYOUT_VERSION_V1,
                expectedOwnerMetadata: SessionOwnerMetadataEnvelopeV1Schema.parse(sessionBefore.ownerMetadata),
                sharedMetadata: {
                    ciphertext: sealSessionContent(sharedMetadata),
                    expectedVersion: sessionBefore.metadataVersion,
                },
                ownerMetadata: ownerMetadataEnvelope,
                agentState: {
                    ciphertext: agentState === null ? null : sealSessionContent(agentState),
                    expectedVersion: sessionBefore.agentStateVersion,
                },
            },
        });
        return;
    }

    if (!selectedSecret) {
        throw new Error(`Cannot patch handoff metadata without an encrypted Session data key (${params.sessionId})`);
    }

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
