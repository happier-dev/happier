import {
    openEncryptedDataKeyEnvelopeV1,
    openSessionOwnerMetadataEnvelopeV1,
    projectSessionOwnerCompatibilityViewV1,
    type AccountScopedCryptoMaterial,
} from '@happier-dev/protocol';

import { decryptDataKeyBase64 } from './rpcCrypto';
import { decryptLegacyBase64 } from './messageCrypto';
import {
    fetchSessionV2,
    fetchSessionsV2,
} from './sessions';
import { unwrapSerializedJsonValue } from './unwrapSerializedJsonValue';

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

export async function readDecryptedSessionMetadataV2(params: Readonly<{
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
