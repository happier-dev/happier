import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent, isPlainArtifactDataKeyMarker } from '@happier-dev/protocol/storage/artifactStoredContent';
import { MACHINE_PLAIN_DATA_KEY_MARKER, decodePlainMachineStoredContent, encodePlainMachineStoredContent, isPlainMachineDataKeyMarker } from '@happier-dev/protocol/machines/machineStoredContent';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { StoredMachinePublishedDaemonStateV1Schema, parseMachinePublishedMetadataV1, parseMachinePublishedDaemonStateV1 } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { createPlainSessionOwnerMetadataEnvelopeV1, encodeSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { prepareArtifactRecipientKeyEnvelopesV1 } from '@happier-dev/protocol/artifacts/artifactRecipientKeyPreparationV1';
import { retargetWorkflowDefinitionArtifactHeaderV1 } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import { workflowDefinitionArtifactSharingAdapterV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import { openSessionOwnerMetadataEnvelopeV1, sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { AccountEncryptionMigrateReviewCommentsDirectiveSchema, type AccountEncryptionMigrateArtifactsDirective, type AccountEncryptionMigrateMachinesDirective, type AccountEncryptionMigrateReviewCommentsDirective, type AccountEncryptionMigrateSessionsDirective, type AccountEncryptionMigrateSessionOrganizationDirective, type AccountEncryptionMigrateTodosDirective, type AccountEncryptionMigrateWorkspaceDirective, type AccountEncryptionMigrateAutomationsDirective, type AccountEncryptionMigrateAutomationsInventoryResponse } from '@happier-dev/protocol/account/encryptionMigrate';
import { WorkspaceTabsV1StoredSchema } from '@happier-dev/protocol/workspace/workspaceTabsV1';
import { classifyAccountJsonKvKey } from '@happier-dev/protocol/account/accountJsonKv';
import type { ReviewCommentAccountEncryptionMigrationInventoryResponseV1 } from '@happier-dev/protocol/reviews/comments/content';
import type { SessionOrganizationAccountEncryptionMigrationInventory } from '@happier-dev/protocol/sessions/organization/accountEncryptionMigrationInventory';
import type { ArtifactAccessRecipientCensusResponseV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { ArtifactBodyEnvelopeV1StoredSchema, type ArtifactBlobReadResponseV1, type ArtifactBlobStoredContentV1, ArtifactBlobAccountEncryptionStageV1Schema, type ArtifactBlobAccountEncryptionStageV1, type ArtifactRevisionProvenanceV1 } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import type { ArtifactAccountEncryptionMigrationOwnershipV1 } from '@happier-dev/protocol/artifacts/artifactAccountEncryptionMigrationV1';
import { decodePackageAssetArchiveBodyV1, openPackageAssetArchiveV1 } from '@happier-dev/protocol/plugins/availability';
import { decodePluginUiArtifactArchiveBodyV1, openPluginUiArtifactArchiveV1 } from '@happier-dev/protocol/plugins/ui';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { hashArtifactBinaryContent, openArtifactBinaryContent, sealArtifactBinaryContent } from '@/sync/domains/artifacts/artifactBinaryContent';
import { getRandomBytes } from '@/platform/cryptoRandom';
import type {
    ArtifactBody,
} from '@/sync/domains/artifacts/artifactTypes';
import {
    MachineMetadataSchema,
    type MachineMetadata,
} from '@/sync/domains/state/storageTypes';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import { openArtifactPrivateRevisionMetadata, sealArtifactPrivateRevisionMetadata } from '@/sync/domains/artifacts/accountArtifactEnvelope';
import {
    decodeTodoStoredContent,
    encodeTodoStoredContent,
} from '@/sync/domains/todos/todoStoredContent';
import type { Encryption } from '@/sync/encryption/encryption';
import { normalizeSessionAccessProjection } from '@/sync/engine/sessions/normalizeSessionAccessProjection';
import { readSessionLayout1OwnerMetadata } from '@/sync/engine/sessions/readSessionLayout1OwnerProjection';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import {
    assertAccountEncryptionMigrationScopeCurrent,
    type AccountEncryptionMigrationScope,
} from '@/sync/domains/settings/scope/accountSettingsScope';
import { buildReviewCommentAccountEncryptionMigrationDirective } from '@/sync/domains/reviews/comments/accountEncryptionMigration';
import { buildSessionOrganizationAccountEncryptionMigrationDirective } from '@/sync/ops/sessionOrganization/sessionOrganizationDisplayEnvelope';
import { buildAccountEncryptionMigrationAutomations } from './buildAccountEncryptionMigrationAutomations';
import { decodeAccountStoredJsonContent, encodeAccountStoredJsonContent } from '@/sync/encryption/accountStoredJsonContent';

export type AccountEncryptionMigrationMachineRow = Readonly<{
    id: string;
    metadata: string;
    metadataVersion: number;
    daemonState?: string | null;
    daemonStateVersion?: number;
    dataEncryptionKey?: string | null;
}>;

export type AccountEncryptionMigrationKvRow = Readonly<{
    key: string;
    value: string;
    version: number;
}>;

export type AccountEncryptionMigrationArtifactRow = Readonly<{
    id: string;
    ownership: ArtifactAccountEncryptionMigrationOwnershipV1;
    header: string;
    headerVersion: number;
    body: string;
    bodyVersion: number;
    dataEncryptionKey: string;
    provenance?: string | null;
    provenanceDataEncryptionKey?: string | null;
    revisions: readonly Readonly<{ bodyVersion: number; body: string; provenance?: string | null }>[];
}>;

export type AccountEncryptionMigrationSessionRow = Readonly<{
    id: string;
    metadataLayoutVersion: 1;
    metadataVersion: number;
    agentStateVersion: number;
    ownerMetadata: unknown;
}>;

export type AccountEncryptionMigrationStorageDirectives = Readonly<{
    automations?: AccountEncryptionMigrateAutomationsDirective;
    machines: AccountEncryptionMigrateMachinesDirective;
    todos: AccountEncryptionMigrateTodosDirective;
    workspace?: AccountEncryptionMigrateWorkspaceDirective;
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
    const parsed = ArtifactBodyEnvelopeV1StoredSchema.safeParse(value);
    if (!parsed.success) {
        throw new Error(`Invalid Artifact body (${artifactId})`);
    }
    return parsed.data;
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
        const contexts = new Map(encryptedRows.map((row) => [row.id, encryption.captureMachineEncryptionContext(row.id, {
            dataEncryptionKey: row.dataEncryptionKey ?? null,
            expectedDataEncryptionKey: row.dataEncryptionKey ?? null,
        })] as const));
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
        await encryption.initializeMachines(keys, undefined, { isMachineCurrent: (machineId) => contexts.get(machineId)?.isCurrent() === true });
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
                    ? StoredMachinePublishedDaemonStateV1Schema.parse(decodePlainMachineStoredContent(row.daemonState))
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
        if (row.daemonState && daemonState === null) {
            throw new Error(`Failed to open Machine daemon state (${row.id})`);
        }
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
                metadata: encodePlainMachineStoredContent(parseMachinePublishedMetadataV1(metadata)),
                daemonState: daemonState === null
                    ? null
                    : encodePlainMachineStoredContent(parseMachinePublishedDaemonStateV1(daemonState)),
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
    rows: readonly AccountEncryptionMigrationKvRow[];
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

async function buildWorkspaceDirective(params: Readonly<{
    fromMode: 'plain' | 'e2ee';
    toMode: 'plain' | 'e2ee';
    rows: readonly AccountEncryptionMigrationKvRow[];
    sourceEncryption: Encryption | null;
    targetEncryption: Encryption | null;
}>): Promise<AccountEncryptionMigrateWorkspaceDirective> {
    if (params.rows.length === 0) return { action: 'assert_empty' };
    const items = [];
    for (const row of params.rows) {
        if (classifyAccountJsonKvKey(row.key) !== 'workspace') throw new Error('Invalid Workspace migration key');
        const decoded = await decodeAccountStoredJsonContent({ encoded: row.value, expectedMode: params.fromMode, encryption: params.sourceEncryption });
        const value = row.key === 'workspace:tabs:v1' || row.key.startsWith('workspace:handoff-tabs:v1:')
            ? WorkspaceTabsV1StoredSchema.parse(decoded) : decoded;
        items.push({ key: row.key, expectedVersion: row.version,
            value: await encodeAccountStoredJsonContent({ mode: params.toMode, value, encryption: params.targetEncryption }),
        });
    }
    return { action: 'migrate', items };
}

async function openArtifactRow(params: Readonly<{
    fromMode: 'plain' | 'e2ee';
    row: AccountEncryptionMigrationArtifactRow;
    sourceEncryption: Encryption | null;
}>): Promise<Readonly<{
    header: Readonly<Record<string, unknown>>;
    body: ArtifactBody;
    provenance: ArtifactRevisionProvenanceV1 | undefined;
    revisions: readonly Readonly<{ bodyVersion: number; expectedBody: string; body: ArtifactBody;
        expectedProvenance: string | null; provenance: ArtifactRevisionProvenanceV1 | undefined }>[];
    encryption: ArtifactEncryption | null;
}>> {
    if ((params.fromMode === 'plain') !== isPlainArtifactDataKeyMarker(params.row.dataEncryptionKey)) {
        throw new Error(`Artifact content does not match the source Account mode (${params.row.id})`);
    }
    if (params.fromMode === 'plain' && params.row.provenanceDataEncryptionKey != null) {
        throw new Error(`Plain Artifact has client private metadata key (${params.row.id})`);
    }
    const hasPrivateMetadata = params.row.provenance != null || params.row.revisions.some(revision => revision.provenance != null);
    const provenanceDataKey = params.fromMode === 'e2ee' && hasPrivateMetadata && params.row.provenanceDataEncryptionKey
        ? await requireEncryption(params.sourceEncryption, 'encrypted Artifact private metadata')
            .decryptEncryptionKey(params.row.provenanceDataEncryptionKey)
        : null;
    const openProvenance = (bodyVersion: number, provenance?: string | null) => openArtifactPrivateRevisionMetadata({
        mode: params.fromMode, artifactId: params.row.id, bodyVersion, provenance, dataKey: provenanceDataKey,
    });
    const provenance = await openProvenance(params.row.bodyVersion, params.row.provenance);
    if (params.fromMode === 'plain') {
        return {
            encryption: null,
            provenance,
            header: requireObject(
                decodePlainArtifactStoredContent(params.row.header),
                `Artifact header (${params.row.id})`,
            ),
            body: requireArtifactBody(
                decodePlainArtifactStoredContent(params.row.body),
                params.row.id,
            ),
            revisions: await Promise.all(params.row.revisions.map(async revision => ({
                bodyVersion: revision.bodyVersion,
                expectedBody: revision.body,
                body: requireArtifactBody(decodePlainArtifactStoredContent(revision.body), params.row.id),
                expectedProvenance: revision.provenance ?? null,
                provenance: await openProvenance(revision.bodyVersion, revision.provenance),
            }))),
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
        artifactEncryption.decryptHeaderRaw(params.row.header),
        artifactEncryption.decryptBody(params.row.body),
    ]);
    if (!header || !body) {
        throw new Error(`Failed to open Artifact (${params.row.id})`);
    }
    const revisions = await Promise.all(params.row.revisions.map(async revision => {
        const body = await artifactEncryption.decryptBody(revision.body);
        if (!body) throw new Error(`Failed to open Artifact revision (${params.row.id}/${revision.bodyVersion})`);
        return { bodyVersion: revision.bodyVersion, expectedBody: revision.body, body,
            expectedProvenance: revision.provenance ?? null,
            provenance: await openProvenance(revision.bodyVersion, revision.provenance) };
    }));
    return { header, body, provenance, revisions, encryption: artifactEncryption };
}

async function buildArtifactDirective(params: Readonly<{
    fromMode: 'plain' | 'e2ee';
    toMode: 'plain' | 'e2ee';
    rows: readonly AccountEncryptionMigrationArtifactRow[];
    sourceEncryption: Encryption | null;
    targetEncryption: Encryption | null;
    readRecipients?: (artifactId: string) => Promise<ArtifactAccessRecipientCensusResponseV1>;
    readBlob?: (artifactId: string, blobId: string) => Promise<ArtifactBlobReadResponseV1>;
    stageBlob?: (artifactId: string, blobId: string, content: ArtifactBlobStoredContentV1) => Promise<ArtifactBlobAccountEncryptionStageV1>;
    scope: AccountEncryptionMigrationScope;
}>): Promise<AccountEncryptionMigrateArtifactsDirective> {
    if (params.rows.length === 0) return { action: 'assert_empty' };
    const items = [];
    for (const row of params.rows) {
        const opened = await openArtifactRow({
            fromMode: params.fromMode,
            row,
            sourceEncryption: params.sourceEncryption,
        });
        const ownership = row.ownership;
        if (ownership.kind !== 'ordinary') {
            // Release-owned proof comes only from the qualified migration reader.
            // Opened E2EE bytes receive the same archive verification as plain bytes.
            for (const body of [opened.body, ...opened.revisions.map(revision => revision.body)]) {
                const archiveBody = typeof body.body === 'string' ? body.body : null;
                const valid = ownership.kind === 'packageAsset'
                    ? archiveBody !== null && openPackageAssetArchiveV1({ expectedDescriptor: ownership.descriptor,
                        header: opened.header, body: decodePackageAssetArchiveBodyV1(archiveBody) }) !== null
                    : (() => {
                        const archive = archiveBody !== null ? openPluginUiArtifactArchiveV1({ pluginId: ownership.pluginId,
                            expectedArtifactDigest: ownership.slot.artifactDigest, header: opened.header,
                            body: decodePluginUiArtifactArchiveBodyV1(archiveBody) }) : null;
                        return archive !== null && archive.artifactGraph.artifactId === ownership.slot.artifactId
                            && archive.artifactGraph.tier === ownership.slot.tier && archive.artifactGraph.hostUiApiRange === ownership.slot.hostUiApiRange;
                    })();
                if (!valid) throw new Error(`Invalid qualified Artifact migration archive (${row.id})`);
            }
        }
        const expectedRevision = { headerVersion: row.headerVersion, bodyVersion: row.bodyVersion };
        const header = workflowDefinitionArtifactSharingAdapterV1.canShare({
            artifactId: row.id, header: opened.header, revision: expectedRevision,
        }) ? retargetWorkflowDefinitionArtifactHeaderV1({
            artifactId: row.id, header: opened.header, expectedRevision,
            nextRevision: { headerVersion: row.headerVersion + 1, bodyVersion: row.bodyVersion + 1 },
        }) : opened.header;
        const binaryBodies = [opened.body, ...opened.revisions.map(revision => revision.body)]
            .map(body => body.body).filter(body => body !== null && typeof body === 'object');
        const sourceBlobs = new Map<string, (typeof binaryBodies)[number]>();
        for (const reference of binaryBodies) {
            const existing = sourceBlobs.get(reference.blobId);
            if (existing) {
                if (reference.sizeBytes !== existing.sizeBytes || reference.sha256 !== existing.sha256) {
                    throw new Error('Artifact retained file reference is inconsistent');
                }
                continue;
            }
            sourceBlobs.set(reference.blobId, reference);
        }
        const convertBlobs = async (encryption: ArtifactEncryption | null) => {
            const blobs = [];
            // Retain only references across uploads, not every historical file's opened bytes.
            for (const [blobId, reference] of sourceBlobs) {
                if (!params.readBlob) throw new Error('Artifact migration binary reader is unavailable');
                if (!params.stageBlob) throw new Error('Artifact migration binary uploader is unavailable');
                const stored = await params.readBlob(row.id, blobId);
                assertAccountEncryptionMigrationScopeCurrent(params.scope);
                if (stored.blobId !== blobId) throw new Error('Artifact migration binary identity changed');
                const bytes = await openArtifactBinaryContent({ reference, content: stored.content, mode: params.fromMode, encryption: opened.encryption });
                const sourceBytes = decodeBase64(stored.content.t === 'plain' ? stored.content.v : stored.content.c);
                const expectedContentSha256 = hashArtifactBinaryContent(sourceBytes);
                const content = await sealArtifactBinaryContent(bytes, params.toMode, encryption);
                const staged = ArtifactBlobAccountEncryptionStageV1Schema.parse(await params.stageBlob(row.id, blobId, content));
                assertAccountEncryptionMigrationScopeCurrent(params.scope);
                const encoded = content.t === 'plain' ? content.v : content.c;
                if (staged.t !== content.t || staged.contentSha256 !== hashArtifactBinaryContent(decodeBase64(encoded))) {
                    throw new Error('Artifact migration binary upload integrity changed');
                }
                blobs.push({ blobId, expectedContentSha256, content: staged });
            }
            return blobs;
        };
        if (params.toMode === 'plain') {
            items.push({
                artifactId: row.id,
                expectedHeaderVersion: row.headerVersion,
                expectedBodyVersion: row.bodyVersion,
                expectedDataEncryptionKey: row.dataEncryptionKey,
                expectedProvenance: row.provenance ?? null,
                expectedProvenanceDataEncryptionKey: row.provenanceDataEncryptionKey ?? null,
                provenance: opened.provenance === undefined ? null : await sealArtifactPrivateRevisionMetadata({
                    mode: 'plain', artifactId: row.id, bodyVersion: row.bodyVersion + 1, provenance: opened.provenance }),
                provenanceDataEncryptionKey: null,
                recipientKeyEnvelopes: [],
                blobs: await convertBlobs(null),
                header: encodePlainArtifactStoredContent(header),
                body: encodePlainArtifactStoredContent(opened.body),
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                revisions: await Promise.all(opened.revisions.map(async revision => ({
                    bodyVersion: revision.bodyVersion, expectedBody: revision.expectedBody,
                    body: encodePlainArtifactStoredContent(revision.body),
                    expectedProvenance: revision.expectedProvenance,
                    provenance: revision.provenance === undefined ? null : await sealArtifactPrivateRevisionMetadata({
                        mode: 'plain', artifactId: row.id, bodyVersion: revision.bodyVersion, provenance: revision.provenance }),
                }))),
            });
            continue;
        }
        const targetEncryption = requireEncryption(
            params.targetEncryption,
            'target Artifact storage',
        );
        if (ownership.kind === 'ordinary' && !params.readRecipients) throw new Error('Artifact migration recipient census is unavailable');
        const census = ownership.kind === 'ordinary' ? await params.readRecipients!(row.id) : null;
        assertAccountEncryptionMigrationScopeCurrent(params.scope);
        if (census && (census.artifactId !== row.id || census.ownerAccountId !== params.scope.scope.accountId
            || census.access !== 'owner' || census.encryptionMode !== params.fromMode
            || (census.dataEncryptionKey ?? ARTIFACT_PLAIN_DATA_KEY_MARKER) !== row.dataEncryptionKey)) {
            throw new Error('Artifact migration recipient census changed');
        }
        const dataKey = ArtifactEncryption.generateDataEncryptionKey();
        const provenanceDataKey = opened.provenance !== undefined || opened.revisions.some(revision => revision.provenance !== undefined)
            ? ArtifactEncryption.generateDataEncryptionKey() : null;
        const artifactEncryption = new ArtifactEncryption(dataKey);
        items.push({
            artifactId: row.id,
            blobs: await convertBlobs(artifactEncryption),
            expectedHeaderVersion: row.headerVersion,
            expectedBodyVersion: row.bodyVersion,
            expectedDataEncryptionKey: row.dataEncryptionKey,
            expectedProvenance: row.provenance ?? null,
            expectedProvenanceDataEncryptionKey: row.provenanceDataEncryptionKey ?? null,
            provenance: opened.provenance === undefined ? null : await sealArtifactPrivateRevisionMetadata({
                mode: 'e2ee', artifactId: row.id, bodyVersion: row.bodyVersion + 1, provenance: opened.provenance, dataKey: provenanceDataKey }),
            provenanceDataEncryptionKey: provenanceDataKey === null ? null : encodeBase64(
                await targetEncryption.encryptEncryptionKey(provenanceDataKey), 'base64'),
            recipientKeyEnvelopes: prepareArtifactRecipientKeyEnvelopesV1({ dataKey, provenanceDataKey: provenanceDataKey ?? undefined,
                recipients: census ? census.recipients.filter(recipient => recipient.recipientAccountId !== census.ownerAccountId) : [],
                randomBytes: getRandomBytes, replaceExisting: true }),
            header: await artifactEncryption.encryptHeader(header),
            body: await artifactEncryption.encryptBody(opened.body),
            dataEncryptionKey: encodeBase64(
                await targetEncryption.encryptEncryptionKey(dataKey),
                'base64',
            ),
            revisions: await Promise.all(opened.revisions.map(async revision => ({
                bodyVersion: revision.bodyVersion, expectedBody: revision.expectedBody,
                body: await artifactEncryption.encryptBody(revision.body),
                expectedProvenance: revision.expectedProvenance,
                provenance: revision.provenance === undefined ? null : await sealArtifactPrivateRevisionMetadata({
                    mode: 'e2ee', artifactId: row.id, bodyVersion: revision.bodyVersion, provenance: revision.provenance, dataKey: provenanceDataKey }),
            }))),
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
            // This owner-only inventory is the Account migration endpoint, not a Session list.
            access: normalizeSessionAccessProjection({ share: null }, { allowLegacy: true }),
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
        todos: readonly AccountEncryptionMigrationKvRow[];
        workspace?: readonly AccountEncryptionMigrationKvRow[];
        artifacts: readonly AccountEncryptionMigrationArtifactRow[];
        sessions: readonly AccountEncryptionMigrationSessionRow[];
        reviewCommentsInventory:
            ReviewCommentAccountEncryptionMigrationInventoryResponseV1;
        sessionOrganizationInventory:
            SessionOrganizationAccountEncryptionMigrationInventory;
        automationsInventory?: AccountEncryptionMigrateAutomationsInventoryResponse;
        resolveSession?: Parameters<typeof buildAccountEncryptionMigrationAutomations>[0]['resolveSession'];
        sessionSourceCredentials: AuthCredentials;
        sessionTargetCredentials: AuthCredentials | null;
        scope: AccountEncryptionMigrationScope;
        /** The network reader captured for this exact Home/Account transition. */
        readArtifactRecipients?: (artifactId: string) => Promise<ArtifactAccessRecipientCensusResponseV1>;
        readArtifactBlob?: (artifactId: string, blobId: string) => Promise<ArtifactBlobReadResponseV1>;
        stageArtifactBlob?: (artifactId: string, blobId: string, content: ArtifactBlobStoredContentV1) => Promise<ArtifactBlobAccountEncryptionStageV1>;
    }>,
): Promise<AccountEncryptionMigrationStorageDirectives> {
    assertAccountEncryptionMigrationScopeCurrent(params.scope);
    const machines = await buildMachineDirective({
        toMode: params.toMode,
        rows: params.machines,
        sourceEncryption: params.sourceEncryption,
        targetEncryption: params.targetEncryption,
    });
    assertAccountEncryptionMigrationScopeCurrent(params.scope);
    const todos = await buildTodoDirective({
        fromMode: params.fromMode,
        toMode: params.toMode,
        rows: params.todos,
        sourceEncryption: params.sourceEncryption,
        targetEncryption: params.targetEncryption,
    });
    assertAccountEncryptionMigrationScopeCurrent(params.scope);
    const workspace = params.workspace === undefined ? undefined : await buildWorkspaceDirective({
        fromMode: params.fromMode, toMode: params.toMode, rows: params.workspace,
        sourceEncryption: params.sourceEncryption, targetEncryption: params.targetEncryption,
    });
    assertAccountEncryptionMigrationScopeCurrent(params.scope);
    const artifacts = await buildArtifactDirective({
        fromMode: params.fromMode,
        toMode: params.toMode,
        rows: params.artifacts,
        sourceEncryption: params.sourceEncryption,
        targetEncryption: params.targetEncryption,
        readRecipients: params.readArtifactRecipients,
        readBlob: params.readArtifactBlob,
        stageBlob: params.stageArtifactBlob,
        scope: params.scope,
    });
    assertAccountEncryptionMigrationScopeCurrent(params.scope);
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
    assertAccountEncryptionMigrationScopeCurrent(params.scope);
    const sessionOrganization =
        await buildSessionOrganizationAccountEncryptionMigrationDirective({
            toMode: params.toMode,
            inventory: params.sessionOrganizationInventory,
            sourceCredentials: params.sessionSourceCredentials,
            targetCredentials: params.sessionTargetCredentials,
        });
    assertAccountEncryptionMigrationScopeCurrent(params.scope);
    const automations = params.automationsInventory
        ? await buildAccountEncryptionMigrationAutomations({ accountId: params.scope.scope.accountId,
            fromMode: params.fromMode, toMode: params.toMode, inventory: params.automationsInventory,
            sourceCredentials: params.sessionSourceCredentials, targetCredentials: params.sessionTargetCredentials,
            sourceEncryption: params.sourceEncryption, targetEncryption: params.targetEncryption,
            resolveSession: params.resolveSession })
        : undefined;
    assertAccountEncryptionMigrationScopeCurrent(params.scope);
    return {
        ...(automations ? { automations } : {}),
        machines,
        todos,
        ...(workspace ? { workspace } : {}),
        artifacts,
        sessions,
        reviewComments,
        sessionOrganization,
        pets: { action: 'assert_empty' },
    };
}
