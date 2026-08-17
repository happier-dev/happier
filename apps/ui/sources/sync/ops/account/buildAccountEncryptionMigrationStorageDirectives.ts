import {
    ARTIFACT_PLAIN_DATA_KEY_MARKER,
    MACHINE_PLAIN_DATA_KEY_MARKER,
    computeContentPublicKeyFingerprint,
    decodePlainArtifactStoredContent,
    decodePlainMachineStoredContent,
    createPlainSessionOwnerMetadataEnvelopeV1,
    encodeSessionOwnerMetadataEnvelopeV1,
    encodePlainArtifactStoredContent,
    encodePlainMachineStoredContent,
    isPlainArtifactDataKeyMarker,
    isPlainMachineDataKeyMarker,
    openSessionOwnerMetadataEnvelopeV1,
    sealSessionOwnerMetadataEnvelopeV1,
    ACCOUNT_ENCRYPTION_MIGRATE_SESSIONS_MAX_ITEMS,
    AccountEncryptionMigrateReviewCommentsDirectiveSchema,
    type AccountEncryptionMigrateArtifactsDirective,
    type AccountEncryptionMigrateMachinesDirective,
    type AccountEncryptionMigrateReviewCommentsDirective,
    type AccountEncryptionMigrateSessionsDirective,
    type AccountEncryptionMigrateSessionOrganizationDirective,
    type AccountEncryptionMigrateTodosDirective,
    type ReviewCommentAccountEncryptionMigrationInventoryResponseV1,
    type SessionOrganizationAccountEncryptionMigrationInventory,
} from '@happier-dev/protocol';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { encodeBase64 } from '@/encryption/base64';
import { getRandomBytes } from '@/platform/cryptoRandom';
import type {
    ArtifactBody,
    ArtifactHeader,
} from '@/sync/domains/artifacts/artifactTypes';
import {
    MachineMetadataSchema,
    type MachineMetadata,
} from '@/sync/domains/state/storageTypes';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import {
    decodeTodoStoredContent,
    encodeTodoStoredContent,
} from '@/sync/domains/todos/todoStoredContent';
import type { Encryption } from '@/sync/encryption/encryption';
import { readSessionLayout1OwnerMetadata } from '@/sync/engine/sessions/readSessionLayout1OwnerProjection';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { buildReviewCommentAccountEncryptionMigrationDirective } from '@/sync/domains/reviews/comments/accountEncryptionMigration';
import { buildSessionOrganizationAccountEncryptionMigrationDirective } from '@/sync/ops/sessionOrganization/sessionOrganizationDisplayEnvelope';

export type AccountEncryptionMigrationMachineRow = Readonly<{
    id: string;
    metadata: string;
    metadataVersion: number;
    daemonState?: string | null;
    daemonStateVersion?: number;
    dataEncryptionKey?: string | null;
}>;

export type AccountEncryptionMigrationTodoRow = Readonly<{
    key: string;
    value: string;
    version: number;
}>;

export type AccountEncryptionMigrationArtifactRow = Readonly<{
    id: string;
    header: string;
    headerVersion: number;
    body: string;
    bodyVersion: number;
    dataEncryptionKey: string;
}>;

export type AccountEncryptionMigrationSessionRow = Readonly<{
    id: string;
    metadataLayoutVersion: 1;
    metadataVersion: number;
    agentStateVersion: number;
    ownerMetadata: unknown;
}>;

export type AccountEncryptionMigrationStorageDirectives = Readonly<{
    machines: AccountEncryptionMigrateMachinesDirective;
    todos: AccountEncryptionMigrateTodosDirective;
    artifacts: AccountEncryptionMigrateArtifactsDirective;
    sessions: AccountEncryptionMigrateSessionsDirective;
    reviewComments: AccountEncryptionMigrateReviewCommentsDirective;
    sessionOrganization:
        AccountEncryptionMigrateSessionOrganizationDirective;
    pets: Readonly<{ action: 'assert_empty' }>;
}>;

function requireEncryption(
    encryption: Encryption | null,
    domain: string,
): Encryption {
    if (!encryption) {
        throw new Error(
            `Account encryption material is unavailable for ${domain}`,
        );
    }
    return encryption;
}

function requireObject(value: unknown, domain: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Invalid ${domain} content`);
    }
    return value as Record<string, unknown>;
}

function requireArtifactBody(
    value: unknown,
    artifactId: string,
): ArtifactBody {
    const body = requireObject(value, `Artifact body (${artifactId})`).body;
    if (body !== null && typeof body !== 'string') {
        throw new Error(`Invalid Artifact body (${artifactId})`);
    }
    return { body };
}

function requireMachineMetadata(
    value: unknown,
    machineId: string,
): MachineMetadata {
    const parsed = MachineMetadataSchema.safeParse(value);
    if (!parsed.success) {
        throw new Error(`Invalid Machine metadata (${machineId})`);
    }
    return parsed.data;
}

async function openMachineRows(params: Readonly<{
    rows: readonly AccountEncryptionMigrationMachineRow[];
    sourceEncryption: Encryption | null;
}>): Promise<Array<Readonly<{
    row: AccountEncryptionMigrationMachineRow;
    metadata: MachineMetadata;
    daemonState: unknown | null;
}>>> {
    const encryptedRows = params.rows.filter(
        (row) => !isPlainMachineDataKeyMarker(row.dataEncryptionKey),
    );
    if (encryptedRows.length > 0) {
        const encryption = requireEncryption(
            params.sourceEncryption,
            'encrypted Machine storage',
        );
        const keys = new Map<string, Uint8Array | null>();
        for (const row of encryptedRows) {
            const key = row.dataEncryptionKey
                ? await encryption.decryptEncryptionKey(row.dataEncryptionKey)
                : null;
            if (row.dataEncryptionKey && !key) {
                throw new Error(
                    `Failed to open Machine data key (${row.id})`,
                );
            }
            keys.set(row.id, key);
        }
        await encryption.initializeMachines(keys);
    }

    const opened = [];
    for (const row of params.rows) {
        if (isPlainMachineDataKeyMarker(row.dataEncryptionKey)) {
            opened.push({
                row,
                metadata: requireMachineMetadata(
                    decodePlainMachineStoredContent(row.metadata),
                    row.id,
                ),
                daemonState: row.daemonState
                    ? decodePlainMachineStoredContent(row.daemonState)
                    : null,
            });
            continue;
        }
        const machineEncryption = requireEncryption(
            params.sourceEncryption,
            'encrypted Machine storage',
        ).getMachineEncryption(row.id);
        if (!machineEncryption) {
            throw new Error(`Machine encryption is unavailable (${row.id})`);
        }
        const metadata = await machineEncryption.decryptMetadata(
            row.metadataVersion,
            row.metadata,
        );
        if (!metadata) {
            throw new Error(`Failed to open Machine metadata (${row.id})`);
        }
        const daemonState = row.daemonState
            ? await machineEncryption.decryptDaemonState(
                row.daemonStateVersion ?? 0,
                row.daemonState,
            )
            : null;
        opened.push({ row, metadata, daemonState });
    }
    return opened;
}

async function buildMachineDirective(params: Readonly<{
    toMode: 'plain' | 'e2ee';
    rows: readonly AccountEncryptionMigrationMachineRow[];
    sourceEncryption: Encryption | null;
    targetEncryption: Encryption | null;
}>): Promise<AccountEncryptionMigrateMachinesDirective> {
    if (params.rows.length === 0) return { action: 'assert_empty' };
    const opened = await openMachineRows({
        rows: params.rows,
        sourceEncryption: params.sourceEncryption,
    });
    if (params.toMode === 'plain') {
        return {
            action: 'migrate',
            items: opened.map(({ row, metadata, daemonState }) => ({
                machineId: row.id,
                expectedMetadataVersion: row.metadataVersion,
                expectedDaemonStateVersion: row.daemonStateVersion ?? 0,
                metadata: encodePlainMachineStoredContent(metadata),
                daemonState: daemonState === null
                    ? null
                    : encodePlainMachineStoredContent(daemonState),
                dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                contentPublicKeyFingerprint: null,
            })),
        };
    }

    const targetEncryption = requireEncryption(
        params.targetEncryption,
        'target Machine storage',
    );
    const targetKeys = new Map<string, Uint8Array | null>();
    for (const { row } of opened) {
        targetKeys.set(row.id, getRandomBytes(32));
    }
    await targetEncryption.initializeMachines(targetKeys);
    const contentPublicKeyFingerprint =
        computeContentPublicKeyFingerprint(targetEncryption.contentDataKey);
    const items = [];
    for (const { row, metadata, daemonState } of opened) {
        const dataKey = targetKeys.get(row.id);
        const machineEncryption =
            targetEncryption.getMachineEncryption(row.id);
        if (!dataKey || !machineEncryption) {
            throw new Error(
                `Target Machine encryption is unavailable (${row.id})`,
            );
        }
        items.push({
            machineId: row.id,
            expectedMetadataVersion: row.metadataVersion,
            expectedDaemonStateVersion: row.daemonStateVersion ?? 0,
            metadata:
                await machineEncryption.encryptMetadata(metadata),
            daemonState: daemonState === null
                ? null
                : await machineEncryption.encryptDaemonState(daemonState),
            dataEncryptionKey: encodeBase64(
                await targetEncryption.encryptEncryptionKey(dataKey),
                'base64',
            ),
            contentPublicKeyFingerprint,
        });
    }
    return { action: 'migrate', items };
}

async function buildTodoDirective(params: Readonly<{
    fromMode: 'plain' | 'e2ee';
    toMode: 'plain' | 'e2ee';
    rows: readonly AccountEncryptionMigrationTodoRow[];
    sourceEncryption: Encryption | null;
    targetEncryption: Encryption | null;
}>): Promise<AccountEncryptionMigrateTodosDirective> {
    if (params.rows.length === 0) return { action: 'assert_empty' };
    const items = [];
    for (const row of params.rows) {
        const content = await decodeTodoStoredContent({
            key: row.key,
            encoded: row.value,
            expectedMode: params.fromMode,
            encryption: params.sourceEncryption,
        });
        items.push({
            key: row.key,
            expectedVersion: row.version,
            value: await encodeTodoStoredContent({
                key: row.key,
                mode: params.toMode,
                value: content.value,
                encryption: params.targetEncryption,
            }),
        });
    }
    return { action: 'migrate', items };
}

async function openArtifactRow(params: Readonly<{
    row: AccountEncryptionMigrationArtifactRow;
    sourceEncryption: Encryption | null;
}>): Promise<Readonly<{ header: ArtifactHeader; body: ArtifactBody }>> {
    if (isPlainArtifactDataKeyMarker(params.row.dataEncryptionKey)) {
        return {
            header: requireObject(
                decodePlainArtifactStoredContent(params.row.header),
                `Artifact header (${params.row.id})`,
            ) as ArtifactHeader,
            body: requireArtifactBody(
                decodePlainArtifactStoredContent(params.row.body),
                params.row.id,
            ),
        };
    }
    const encryption = requireEncryption(
        params.sourceEncryption,
        'encrypted Artifact storage',
    );
    const dataKey =
        await encryption.decryptEncryptionKey(params.row.dataEncryptionKey);
    if (!dataKey) {
        throw new Error(`Failed to open Artifact data key (${params.row.id})`);
    }
    const artifactEncryption = new ArtifactEncryption(dataKey);
    const [header, body] = await Promise.all([
        artifactEncryption.decryptHeader(params.row.header),
        artifactEncryption.decryptBody(params.row.body),
    ]);
    if (!header || !body) {
        throw new Error(`Failed to open Artifact (${params.row.id})`);
    }
    return { header, body };
}

async function buildArtifactDirective(params: Readonly<{
    toMode: 'plain' | 'e2ee';
    rows: readonly AccountEncryptionMigrationArtifactRow[];
    sourceEncryption: Encryption | null;
    targetEncryption: Encryption | null;
}>): Promise<AccountEncryptionMigrateArtifactsDirective> {
    if (params.rows.length === 0) return { action: 'assert_empty' };
    const items = [];
    for (const row of params.rows) {
        const opened = await openArtifactRow({
            row,
            sourceEncryption: params.sourceEncryption,
        });
        if (params.toMode === 'plain') {
            items.push({
                artifactId: row.id,
                expectedHeaderVersion: row.headerVersion,
                expectedBodyVersion: row.bodyVersion,
                header: encodePlainArtifactStoredContent(opened.header),
                body: encodePlainArtifactStoredContent(opened.body),
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            });
            continue;
        }
        const targetEncryption = requireEncryption(
            params.targetEncryption,
            'target Artifact storage',
        );
        const dataKey = ArtifactEncryption.generateDataEncryptionKey();
        const artifactEncryption = new ArtifactEncryption(dataKey);
        items.push({
            artifactId: row.id,
            expectedHeaderVersion: row.headerVersion,
            expectedBodyVersion: row.bodyVersion,
            header: await artifactEncryption.encryptHeader(opened.header),
            body: await artifactEncryption.encryptBody(opened.body),
            dataEncryptionKey: encodeBase64(
                await targetEncryption.encryptEncryptionKey(dataKey),
                'base64',
            ),
        });
    }
    return { action: 'migrate', items };
}

function buildSessionDirective(params: Readonly<{
    fromMode: 'plain' | 'e2ee';
    toMode: 'plain' | 'e2ee';
    rows: readonly AccountEncryptionMigrationSessionRow[];
    sourceCredentials: AuthCredentials;
    targetCredentials: AuthCredentials | null;
}>): AccountEncryptionMigrateSessionsDirective {
    if (params.rows.length === 0) return { action: 'assert_empty' };
    if (
        params.rows.length
        > ACCOUNT_ENCRYPTION_MIGRATE_SESSIONS_MAX_ITEMS
    ) {
        throw new Error(
            'Session migration inventory exceeds the supported bound',
        );
    }
    const seenSessionIds = new Set<string>();
    const targetCredentials = params.targetCredentials;
    if (params.toMode === 'e2ee' && !targetCredentials) {
        throw new Error(
            'Target Account encryption material is unavailable for Sessions',
        );
    }
    const targetMaterial = params.toMode === 'e2ee'
        ? (() => {
            if (!targetCredentials) {
                throw new Error(
                    'Target Account encryption material is unavailable for Sessions',
                );
            }
            return resolveAccountScopedCryptoMaterialFromCredentials(
                targetCredentials,
            );
        })()
        : null;
    const items = params.rows.map((row) => {
        if (seenSessionIds.has(row.id)) {
            throw new Error(
                `Duplicate Session migration row (${row.id})`,
            );
        }
        seenSessionIds.add(row.id);
        const ownerRead = readSessionLayout1OwnerMetadata({
            share: null,
            accountMode: params.fromMode,
            ownerMetadataEnvelope: row.ownerMetadata,
            credentials: params.sourceCredentials,
        });
        if (ownerRead.kind !== 'owner') {
            if (
                ownerRead.kind === 'unavailable'
                && ownerRead.reason === 'account_mode_mismatch'
            ) {
                throw Object.assign(
                    new Error(
                        `Session owner metadata does not match the source Account mode (${row.id})`,
                    ),
                    {
                        code: 'session_owner_metadata_account_mode_mismatch' as const,
                        reason: ownerRead.reason,
                    },
                );
            }
            throw new Error(
                `Session owner metadata is unavailable (${row.id})`,
            );
        }
        const ownerMetadata = params.toMode === 'plain'
            ? createPlainSessionOwnerMetadataEnvelopeV1(
                ownerRead.ownerMetadata,
            )
            : (() => {
                if (!targetMaterial) {
                    throw new Error(
                        'Target Account encryption material is unavailable for Sessions',
                    );
                }
                return sealSessionOwnerMetadataEnvelopeV1({
                    material: targetMaterial,
                    ownerMetadata: ownerRead.ownerMetadata,
                    randomBytes: getRandomBytes,
                });
            })();
        if (params.toMode === 'e2ee') {
            if (!targetMaterial) {
                throw new Error(
                    'Target Account encryption material is unavailable for Sessions',
                );
            }
            const reopened = openSessionOwnerMetadataEnvelopeV1({
                accountMode: params.toMode,
                envelope: ownerMetadata,
                material: targetMaterial,
            });
            if (
                !reopened.ok
                || encodeSessionOwnerMetadataEnvelopeV1(
                    createPlainSessionOwnerMetadataEnvelopeV1(
                        reopened.ownerMetadata,
                    ),
                )
                    !== encodeSessionOwnerMetadataEnvelopeV1(
                        createPlainSessionOwnerMetadataEnvelopeV1(
                            ownerRead.ownerMetadata,
                        ),
                    )
            ) {
                throw new Error(
                    `Target Session owner metadata verification failed (${row.id})`,
                );
            }
        }
        return {
            sessionId: row.id,
            expectedMetadataLayoutVersion: 1 as const,
            expectedMetadataVersion: row.metadataVersion,
            expectedAgentStateVersion: row.agentStateVersion,
            expectedOwnerMetadata: ownerRead.ownerMetadataEnvelope,
            ownerMetadata,
        };
    });
    return { action: 'migrate', items };
}

export async function buildAccountEncryptionMigrationStorageDirectives(
    params: Readonly<{
        fromMode: 'plain' | 'e2ee';
        toMode: 'plain' | 'e2ee';
        sourceEncryption: Encryption | null;
        targetEncryption: Encryption | null;
        machines: readonly AccountEncryptionMigrationMachineRow[];
        todos: readonly AccountEncryptionMigrationTodoRow[];
        artifacts: readonly AccountEncryptionMigrationArtifactRow[];
        sessions: readonly AccountEncryptionMigrationSessionRow[];
        reviewCommentsInventory:
            ReviewCommentAccountEncryptionMigrationInventoryResponseV1;
        sessionOrganizationInventory:
            SessionOrganizationAccountEncryptionMigrationInventory;
        sessionSourceCredentials: AuthCredentials;
        sessionTargetCredentials: AuthCredentials | null;
    }>,
): Promise<AccountEncryptionMigrationStorageDirectives> {
    const machines = await buildMachineDirective({
        toMode: params.toMode,
        rows: params.machines,
        sourceEncryption: params.sourceEncryption,
        targetEncryption: params.targetEncryption,
    });
    const todos = await buildTodoDirective({
        fromMode: params.fromMode,
        toMode: params.toMode,
        rows: params.todos,
        sourceEncryption: params.sourceEncryption,
        targetEncryption: params.targetEncryption,
    });
    const artifacts = await buildArtifactDirective({
        toMode: params.toMode,
        rows: params.artifacts,
        sourceEncryption: params.sourceEncryption,
        targetEncryption: params.targetEncryption,
    });
    const sessions = buildSessionDirective({
        fromMode: params.fromMode,
        toMode: params.toMode,
        rows: params.sessions,
        sourceCredentials: params.sessionSourceCredentials,
        targetCredentials: params.sessionTargetCredentials,
    });
    const hasReviewComments = params.reviewCommentsInventory.items.length > 0;
    const sourceReviewMaterial = params.toMode === 'plain' && hasReviewComments
        ? resolveAccountScopedCryptoMaterialFromCredentials(
            params.sessionSourceCredentials,
        )
        : undefined;
    const targetReviewMaterial = params.toMode === 'e2ee' && hasReviewComments
        ? resolveAccountScopedCryptoMaterialFromCredentials(
            params.sessionTargetCredentials!,
        )
        : undefined;
    const reviewComments =
        AccountEncryptionMigrateReviewCommentsDirectiveSchema.parse(
            await buildReviewCommentAccountEncryptionMigrationDirective({
                toMode: params.toMode,
                inventory: params.reviewCommentsInventory,
                sourceMaterial: sourceReviewMaterial,
                targetMaterial: targetReviewMaterial,
                openLegacyCiphertext: params.sourceEncryption
                    ? async (ciphertext) =>
                        await params.sourceEncryption!.decryptRaw(
                            ciphertext,
                        )
                    : undefined,
                randomBytes: getRandomBytes,
            }),
        );
    const sessionOrganization =
        await buildSessionOrganizationAccountEncryptionMigrationDirective({
            toMode: params.toMode,
            inventory: params.sessionOrganizationInventory,
            sourceCredentials: params.sessionSourceCredentials,
            targetCredentials: params.sessionTargetCredentials,
        });
    return {
        machines,
        todos,
        artifacts,
        sessions,
        reviewComments,
        sessionOrganization,
        pets: { action: 'assert_empty' },
    };
}
