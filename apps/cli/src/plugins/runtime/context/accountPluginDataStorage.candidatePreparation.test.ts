import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tweetnacl from 'tweetnacl';
import { PLUGIN_MANIFEST as CHANNELS_MANIFEST, collectionMigrations as channelsMigrations } from '@happier-dev/plugins-channels/manifest';
import {
    accountSettingsParse,
    FeaturesResponseSchema,
    PLUGIN_COLLECTION_CANDIDATE_PREPARATION_RETIRE_HTTP_PATH_V1,
    PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1,
    PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1,
    PLUGIN_COLLECTION_DEFAULT_DEPLOYMENT_LIMITS_V1,
    measurePluginCollectionCandidatePreparationStageRequestEncodedBytesV1,
    normalizePluginAccountCollectionContractV1,
    resolvePluginCollectionContractAccessV1,
    PluginAccountCollectionContributionV1Schema,
    isPluginCollectionSchemaWideningV1,
    PluginCollectionContractReadResultV1Schema,
    PluginCollectionCandidatePreparationStageRequestV1Schema,
    type PluginAccountCollectionContributionV1,
    type PluginDataCollectionsCapabilities,
    PluginManifestV2Schema,
    compilePluginJsonSchema,
    isValidPluginJsonSchemaValue,
    encodePluginCollectionLogicalValueV1,
    decodePluginCollectionLogicalRowV1,
    createAccountScopedCryptoMaterialSnapshotV1,
    convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
} from '@happier-dev/protocol';
import { computeCanonicalDomainSeparatedDigest, PluginError, type JsonValue } from '@happier-dev/plugin-sdk';

import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type { StoredCredentials } from '@/persistence';
import {
    resetActiveAccountSettingsSnapshotForTests,
    setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { logger } from '@/ui/logger';

import { createAccountPluginDataStorageHost } from './accountPluginDataStorage';
import { PluginAvailabilityCollectionWritersClaimActionInputV1Schema } from '@happier-dev/protocol/plugins/availability/actions';
import { computePluginManifestDigestV2 } from '@happier-dev/protocol/plugins/manifest/digest';
import { loadPluginModule } from '../loadPluginModule';
import { compileUniversalPluginUiCommonJs } from '../../../../../../packages/plugin-sdk/src/ui/build/universalCommonJsCompiler';

const pluginId = 'example.collection-migration';
const collectionId = 'tasks';
const credentials = {
    token: 'candidate-preparation-token',
    encryption: null,
} satisfies StoredCredentials;

const sourceContribution = {
    id: collectionId,
    schemaVersion: 1,
    schema: {
        type: 'object',
        properties: {
            id: { type: 'string', maxLength: 256 },
            title: { type: 'string', maxLength: 256 },
        },
        required: ['id', 'title'],
        additionalProperties: false,
    },
    rowIdField: 'id',
    serverReadable: ['id', 'title'],
    indexes: [],
    uiQueries: [],
    relations: [],
    identityFields: [],
    migrations: [],
} satisfies PluginAccountCollectionContributionV1;

const targetContribution = {
    id: collectionId,
    schemaVersion: 2,
    readableSchemaVersions: [1],
    schema: {
        type: 'object',
        properties: {
            id: { type: 'string', maxLength: 256 },
            title: { type: 'string', maxLength: 256 },
            status: { type: 'string', enum: ['open', 'closed'] },
        },
        required: ['id', 'title', 'status'],
        additionalProperties: false,
    },
    rowIdField: 'id',
    serverReadable: ['id', 'title', 'status'],
    indexes: [],
    uiQueries: [],
    relations: [],
    identityFields: [],
    migrations: [{
        id: 'upgrade-v1-to-v2',
        fromSchemaVersion: 1,
        toSchemaVersion: 2,
    }],
} satisfies PluginAccountCollectionContributionV1;

const sourceContract = normalizePluginAccountCollectionContractV1({
    pluginId,
    contribution: sourceContribution,
});
const targetContract = normalizePluginAccountCollectionContractV1({
    pluginId,
    contribution: targetContribution,
});
const binding = Object.freeze({
    source: Object.freeze({
        pluginId,
        collectionId,
        schemaVersion: sourceContract.schemaVersion,
        contractDigest: sourceContract.contractDigest,
    }),
    target: Object.freeze({
        pluginId,
        collectionId,
        schemaVersion: targetContract.schemaVersion,
        contractDigest: targetContract.contractDigest,
    }),
    candidate: Object.freeze({
        releaseVersion: '2.0.0',
        artifactDigest: `sha256:${'c'.repeat(64)}`,
    }),
});

const currentEncryption = async () => Object.freeze({
    mode: 'plain' as const,
    version: 1,
    signingKeyFingerprint: null,
    contentKeyFingerprint: null,
    updatedAt: 1,
    recipientEnvelopeReadiness: { status: 'unavailable' as const, reason: 'plain_account' as const },
});

function sourceRow(rowId: string, revision: number, title: string, alreadyStaged: boolean) {
    return {
        rowId,
        revision,
        content: { t: 'plain' as const, v: {} },
        projection: { id: rowId, title },
        alreadyStaged,
    };
}

function collectionFeatures(
    limits: PluginDataCollectionsCapabilities,
): CliServerFeaturesSnapshot {
    return {
        status: 'ready',
        features: FeaturesResponseSchema.parse({
            features: {},
            capabilities: { pluginDataCollections: limits },
        }),
    };
}

function createCandidateHost(
    post: (url: string, body: string) => Promise<Readonly<{
        status: number;
        data: unknown;
    }>>,
    options: Readonly<{
        resolveServerFeaturesSnapshot?: () => CliServerFeaturesSnapshot | undefined;
        resolveAccountEncryptionCurrentness?: Parameters<typeof createAccountPluginDataStorageHost>[0]['resolveAccountEncryptionCurrentness'];
        credentials?: StoredCredentials;
    }> = {},
) {
    return createAccountPluginDataStorageHost({
        contracts: [targetContract],
        readCredentials: async () => options.credentials ?? credentials,
        isCurrentAccount: () => true,
        resolveAccountScopeKey: () => 'candidate-preparation-account',
        resolveBaseUrl: () => 'https://data.example.test',
        resolveAccountEncryptionCurrentness: options.resolveAccountEncryptionCurrentness ?? currentEncryption,
        http: {
            get: async () => ({ status: 200, data: { mode: 'plain', updatedAt: 1 } }),
            post,
        },
        randomBytes: (length) => new Uint8Array(length).fill(7),
        resolveServerFeaturesSnapshot: options.resolveServerFeaturesSnapshot,
    });
}

function createCandidate(params: Readonly<{
    post: (url: string, body: string) => Promise<Readonly<{ status: number; data: unknown }>>;
    migrate: (value: Readonly<Record<string, JsonValue>>, context: Readonly<{ currentRevision: number }>) => Readonly<Record<string, JsonValue>> | Promise<Readonly<Record<string, JsonValue>>>;
    signal?: AbortSignal;
    resolveServerFeaturesSnapshot?: () => CliServerFeaturesSnapshot | undefined;
    resolveAccountEncryptionCurrentness?: Parameters<typeof createAccountPluginDataStorageHost>[0]['resolveAccountEncryptionCurrentness'];
    credentials?: StoredCredentials;
}>) {
    const host = createCandidateHost(params.post, {
        resolveServerFeaturesSnapshot: params.resolveServerFeaturesSnapshot,
        resolveAccountEncryptionCurrentness: params.resolveAccountEncryptionCurrentness,
        credentials: params.credentials,
    });
    return host.createCollectionMigrationCandidate({
        binding,
        sourceContract,
        targetContract,
        declarations: [targetContribution],
        runtime: {
            [collectionId]: [{
                id: 'upgrade-v1-to-v2',
                fromSchemaVersion: 1,
                toSchemaVersion: 2,
                migrate: params.migrate,
            }],
        },
        signal: params.signal ?? new AbortController().signal,
        isOccurrenceCurrent: () => true,
    });
}

it('stages a retained Collection row through a compiler-produced portable migration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-portable-collection-'));
    const entryPath = join(root, 'entry.ts');
    const artifactPath = join(root, 'entry.cjs.bundle');
    try {
        await writeFile(entryPath, [
            "import { z } from 'zod';",
            'const row = z.object({ id: z.string(), title: z.string() });',
            'export const migrate = value => ({ ...row.parse(value), status: "open" });',
        ].join('\n'));
        const compiled = await compileUniversalPluginUiCommonJs({ projectRoot: root, entryPath,
            artifactId: 'collection-runtime', requestedExports: ['migrate'] });
        await writeFile(artifactPath, compiled.bytes);
        const loaded = await loadPluginModule({ source: { kind: 'file_backed', entryPath: artifactPath,
            committedAuthorization: { pluginId, immutableGenerationId: artifactPath } } });
        const migrate = loaded.migrate;
        if (typeof migrate !== 'function') throw new Error('Missing authored Collection migration');
        const staged: unknown[] = [];
        const candidate = createCandidate({ migrate: (value, context) => migrate(value, context),
            post: async (url, body) => {
                if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1)) {
                    return { status: 200, data: { rows: [sourceRow('task-1', 7, 'Retained task', false)] } };
                }
                const request = PluginCollectionCandidatePreparationStageRequestV1Schema.parse(JSON.parse(body));
                staged.push(...request.items.map(item => item.target));
                return { status: 200, data: { results: request.items.map(() => ({ status: 'staged' })) } };
            } });
        await expect(candidate.prepare()).resolves.toBeUndefined();
        expect(staged).toEqual([{ content: { t: 'plain', v: {} },
            projection: { id: 'task-1', title: 'Retained task', status: 'open' } }]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

describe.each([7, 8])('Channels V%s to current through Account Data candidate preparation', version => {
    const retained = JSON.parse(readFileSync(new URL(`../../../../../../packages/plugins/channels/src/testkit/fixtures/channelStateV${version}.json`, import.meta.url), 'utf8'));
    const targetManifest = PluginManifestV2Schema.parse(CHANNELS_MANIFEST);
    const sourceManifest = PluginManifestV2Schema.parse({ ...CHANNELS_MANIFEST, contributes: {
        ...CHANNELS_MANIFEST.contributes, accountCollections: [retained.collection],
    } });
    const sourceDeclaration = sourceManifest.contributes.accountCollections![0]!;
    const targetDeclaration = targetManifest.contributes.accountCollections!.find(item => item.id === 'channel-state')!;
    const source = normalizePluginAccountCollectionContractV1({ pluginId: 'happier.channels', contribution: sourceDeclaration });
    const target = normalizePluginAccountCollectionContractV1({ pluginId: 'happier.channels', contribution: targetDeclaration });
    const sourceValidator = compilePluginJsonSchema(sourceDeclaration.schema);
    const targetValidator = compilePluginJsonSchema(targetDeclaration.schema);
    const machineKey = new Uint8Array(32).fill(7);
    const encryptedCredentials = { token: 'channels-candidate-encrypted', encryption: {
        type: 'dataKey' as const, machineKey, publicKey: tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey,
    } } satisfies StoredCredentials;

    it.each(['plain', 'e2ee'] as const)('preserves physical revision and retained custody in %s', async mode => {
        const selectedCredentials = mode === 'plain' ? credentials : encryptedCredentials;
        const material = mode === 'plain' ? null : { type: 'dataKey' as const, machineKey };
        const snapshot = material === null ? null : createAccountScopedCryptoMaterialSnapshotV1({
            accountEncryptionMode: 'e2ee', material, dataKeyPublicKey: encryptedCredentials.encryption.publicKey,
        });
        const vector = retained.retainedEndpointVectors;
        const logical = version === 8 ? retained.connection : { ...retained.connection, payload: { ...retained.connection.payload,
            authorityEpoch: vector.acceptedCurrentAuthorityEpoch, transport: vector.transport,
            replayContinuity: 'none',
            pendingOldTransportStop: vector.pendingOldTransportStop,
        } };
        let currentLogical = logical;
        const staged: JsonValue[] = [];
        const host = createAccountPluginDataStorageHost({
            contracts: [target], readCredentials: async () => selectedCredentials,
            isCurrentAccount: () => true, resolveAccountScopeKey: () => `channels-preparation-${mode}`,
            resolveBaseUrl: () => 'https://data.example.test',
            resolveAccountEncryptionCurrentness: async () => mode === 'plain' ? currentEncryption() : {
                mode: 'e2ee' as const, version: 1, signingKeyFingerprint: null,
                contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(snapshot!.contentPublicKeyFingerprint),
                updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' as const },
            },
            randomBytes: length => new Uint8Array(length).fill(3),
            http: {
                get: async () => ({ status: 200, data: { mode, updatedAt: 1 } }),
                post: async (url, body) => {
                    if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1)) {
                        const rows = [currentLogical, ...(version === 7 ? [retained.eventObligation] : []), retained.checkpoint].map(value => {
                            const encoded = encodePluginCollectionLogicalValueV1({ contract: source,
                                isValidLogicalValue: candidate => isValidPluginJsonSchemaValue(sourceValidator, candidate),
                                value, encryptionMode: mode, material, randomBytes: length => new Uint8Array(length).fill(4),
                            });
                            if (encoded.status !== 'encoded') throw new Error(`Pinned source fixture failed encoding: ${encoded.reason}`);
                            return { rowId: encoded.rowId, revision: 12, content: encoded.content, projection: encoded.projection, alreadyStaged: false };
                        });
                        return { status: 200, data: { rows } };
                    }
                    const request = PluginCollectionCandidatePreparationStageRequestV1Schema.parse(JSON.parse(body));
                    for (const item of request.items) {
                        const decoded = decodePluginCollectionLogicalRowV1({ contract: target,
                            parseStoredLogicalValue: value => isValidPluginJsonSchemaValue(targetValidator, value) ? value : null,
                            row: { rowId: item.source.rowId, revision: 12, ...item.target }, encryptionMode: mode, material,
                        });
                        if (decoded.status !== 'decoded') throw new Error(`Staged target failed decoding: ${decoded.reason}`);
                        staged.push(decoded.value);
                        expect(item.target.content.t).toBe(mode === 'plain' ? 'plain' : 'encrypted');
                    }
                    return { status: 200, data: { results: request.items.map(() => ({ status: 'staged' })) } };
                },
            },
        });
        const candidate = host.createCollectionMigrationCandidate({
            binding: { source: { pluginId: 'happier.channels', collectionId: source.collectionId,
                schemaVersion: source.schemaVersion, contractDigest: source.contractDigest },
                target: { pluginId: 'happier.channels', collectionId: target.collectionId,
                    schemaVersion: target.schemaVersion, contractDigest: target.contractDigest },
                candidate: { releaseVersion: '0.0.0', artifactDigest: `sha256:${'c'.repeat(64)}` } },
            sourceContract: source, targetContract: target, declarations: targetManifest.contributes.accountCollections!, runtime: channelsMigrations,
            signal: new AbortController().signal, isOccurrenceCurrent: () => true,
        });
        await expect(candidate.prepare()).resolves.toBeUndefined();
        if (version === 8) {
            expect(staged).toEqual([{ ...logical, payload: { ...logical.payload, configurationRevision: 12 } }, retained.checkpoint]);
            return;
        }
        const { kind: _transportKind, ...endpoint } = vector.transport;
        expect(staged).toEqual([{ ...logical, payload: { ...logical.payload,
            configurationRevision: 12,
            transportOrigin: { serverIdentityId: 'srv_v7fixture', machineId: 'machine-v7' },
            pendingOldTransportStop: { kind: 'endpointRetarget', ...endpoint,
                targetMaterialization: logical.payload.transportOrigin.materializationRef,
                transferAuthorityEpoch: vector.acceptedCurrentAuthorityEpoch },
        } }, { ...retained.eventObligation, payload: { ...retained.eventObligation.payload, target: {
            ...retained.eventObligation.payload.target, executionOrigin: { serverIdentityId: 'srv_v7fixture', machineId: 'machine-v7' },
        } } }, retained.checkpoint]);
        currentLogical = { ...logical, payload: { ...logical.payload, pendingOldTransportStop: {
            ...logical.payload.pendingOldTransportStop, predecessorCheckpointedPollInvocation: {
                ...logical.payload.pendingOldTransportStop.predecessorCheckpointedPollInvocation,
                transportOrigin: { ...logical.payload.pendingOldTransportStop.transportOrigin,
                    materializationRef: { ...logical.payload.pendingOldTransportStop.transportOrigin.materializationRef, materializationId: 'mismatched-custody' } },
            },
        } } };
        await expect(candidate.prepare()).rejects.toMatchObject({ code: 'plugin_collection_invalid_value' });
        expect(staged).toHaveLength(3);
    });
});

it('pins the captured Channels writer versions and normalized contracts', () => {
    const retained = JSON.parse(readFileSync(new URL(
        '../../../../../../packages/plugins/channels/src/testkit/fixtures/channelContractsV19V5.json', import.meta.url,
    ), 'utf8'));
    expect(retained.contracts.map((value: unknown) => {
        const contract = PluginCollectionContractReadResultV1Schema.parse({ access: 'writable', contract: value }).contract;
        return { collectionId: contract.collectionId, schemaVersion: contract.schemaVersion, contractDigest: contract.contractDigest };
    })).toEqual([
        { collectionId: 'channel-deliveries', schemaVersion: 5, contractDigest: 'GXlZR7BbKZ2iUM-7MrE6boxLkizDle-1a15m7J9ML6w' },
        { collectionId: 'channel-state', schemaVersion: 19, contractDigest: '6srg63ot59m_ZDUk79dqQsQTA0HOFk6cJ-pfdEzNaks' },
    ]);
});

it.each(['channel-state', 'channel-deliveries'])('publishes the exact authored %s writer contract to bundled readers', id => {
    // The source reader and bundled Account writer must use one identity,
    // including the digest: equal version numbers alone do not admit reads.
    const bundled = PluginManifestV2Schema.parse(JSON.parse(readFileSync(
        new URL('../../../../assets/bundled-plugin-manifests/channels.json', import.meta.url), 'utf8',
    )));
    const sourceDeclaration = bundled.contributes.accountCollections!.find(item => item.id === id)!;
    const targetDeclaration = PluginManifestV2Schema.parse(CHANNELS_MANIFEST).contributes.accountCollections!.find(item => item.id === id)!;
    const source = normalizePluginAccountCollectionContractV1({ pluginId: bundled.id, contribution: sourceDeclaration });
    const target = normalizePluginAccountCollectionContractV1({ pluginId: bundled.id, contribution: targetDeclaration });
    expect(source).toEqual(target);
});

it.each(['channel-state', 'channel-deliveries'])('adopts the observed retained %s writer through its declared path without row rewriting', id => {
    // Actual immutable contract identities captured from the serving Data
    // owner, rather than historical schemas reconstructed from current types.
    const retained: unknown = JSON.parse(readFileSync(new URL(
        '../../../../../../packages/plugins/channels/src/testkit/fixtures/channelContractsV19V5.json', import.meta.url,
    ), 'utf8'));
    if (!retained || typeof retained !== 'object' || !('contracts' in retained) || !Array.isArray(retained.contracts)) {
        throw new Error('Missing captured public Collection contracts');
    }
    const records: readonly unknown[] = retained.contracts;
    const source = records.map(contract => PluginCollectionContractReadResultV1Schema.parse({ access: 'writable', contract }).contract)
        .find(contract => contract.collectionId === id);
    if (!source) throw new Error('Missing exact retained writer contract');
    const targetDeclaration = PluginManifestV2Schema.parse(CHANNELS_MANIFEST).contributes.accountCollections!.find(item => item.id === id)!;
    const target = normalizePluginAccountCollectionContractV1({ pluginId: source.pluginId, contribution: targetDeclaration });
    const identity = JSON.stringify({ retained: source.contractDigest, source: target.contractDigest });
    if (id === 'channel-deliveries') {
        // V6 adds an age index. The existing candidate owner must promote its
        // declaration before that reader can issue an indexed query.
        expect(resolvePluginCollectionContractAccessV1({ currentWriter: source, requested: target }), identity).toBeNull();
        expect(target.migrations).toContainEqual({ id: 'channel-deliveries-v5-to-v6', fromSchemaVersion: 5, toSchemaVersion: 6 });
        return;
    }
    expect(resolvePluginCollectionContractAccessV1({ currentWriter: source, requested: target }), identity).not.toBeNull();
    // V20 remains readable from V19, but adopts its current writer through the
    // declared identity migration rather than schema-widening admission.
    expect(isPluginCollectionSchemaWideningV1({ source, target }), identity).toBe(false);
    expect(target.migrations).toContainEqual({ id: 'channel-state-v19-to-v20', fromSchemaVersion: 19, toSchemaVersion: 20 });
});

it('publishes the V6 delivery reader and promotes a stored V5 row through a real Account Collection read', async () => {
    const bundled = PluginManifestV2Schema.parse(JSON.parse(readFileSync(
        new URL('../../../../assets/bundled-plugin-manifests/channels.json', import.meta.url), 'utf8',
    )));
    const manifest = PluginManifestV2Schema.parse(CHANNELS_MANIFEST);
    const declaration = manifest.contributes.accountCollections!.find(item => item.id === 'channel-deliveries')!;
    const readerDeclaration = bundled.contributes.accountCollections!.find(item => item.id === declaration.id)!;
    const target = normalizePluginAccountCollectionContractV1({ pluginId: manifest.id, contribution: declaration });
    const reader = normalizePluginAccountCollectionContractV1({ pluginId: bundled.id, contribution: readerDeclaration });

    const retained = JSON.parse(readFileSync(new URL(
        '../../../../../../packages/plugins/channels/src/testkit/fixtures/channelContractsV19V5.json', import.meta.url,
    ), 'utf8'));
    const source = retained.contracts.map((contract: unknown) =>
        PluginCollectionContractReadResultV1Schema.parse({ access: 'writable', contract }).contract)
        .find((contract: typeof target) => contract.collectionId === declaration.id)!;
    expect(source.schemaVersion).toBe(5);
    const { pluginId: _sourcePluginId, collectionId: sourceCollectionId, contractDigest: _sourceDigest,
        ...sourceDefinition } = source;
    const sourceDeclaration = PluginAccountCollectionContributionV1Schema.parse({ ...sourceDefinition, id: sourceCollectionId });
    const value = { id: 'a'.repeat(43), 'record-kind': 'outward-delivery', v: 1,
        'connection-id': 'connection-1', 'binding-id': 'binding-1', terminal: true, attention: false,
        'created-at': 100, 'updated-at': 100,
        payload: { source: { kind: 'sessionProjection', sessionId: 'session-1', semanticItemId: 'semantic-1' },
            routeAuthority: { connectionAuthorityEpoch: 4, bindingRevision: 1, bindingAuthorityEpoch: 7 },
            endpoint: { kind: 'direct', audience: 'direct', id: 'chat-1' }, content: null,
            contentFingerprint: 'b'.repeat(43), deliveryKey: 'channels:delivery:v1:session-1:semantic-1',
            replyContext: null, mentionPolicy: 'suppress', linkPreviewPolicy: 'suppress', state: 'delivered',
            attemptCount: 1, attemptId: null, startedAt: null, providerMessageIds: ['message-1'],
            failedChunk: null, archiveRecovery: null } } satisfies Readonly<Record<string, JsonValue>>;
    const sourceValidator = compilePluginJsonSchema(source.schema);
    const encoded = encodePluginCollectionLogicalValueV1({ contract: source,
        isValidLogicalValue: candidate => isValidPluginJsonSchemaValue(sourceValidator, candidate),
        value, encryptionMode: 'plain', material: null, randomBytes: length => new Uint8Array(length).fill(4) });
    if (encoded.status !== 'encoded') throw new Error(`Stored V5 row is invalid: ${encoded.reason}`);
    let stored = { rowId: encoded.rowId, revision: 22, content: encoded.content, projection: encoded.projection };
    let promoted = false;
    let staged = false;
    const ref = (contract: typeof target) => ({ pluginId: contract.pluginId, collectionId: contract.collectionId,
        schemaVersion: contract.schemaVersion, contractDigest: contract.contractDigest });
    const host = createAccountPluginDataStorageHost({
        contracts: [reader], readCredentials: async () => credentials, isCurrentAccount: () => true,
        resolveAccountScopeKey: () => 'delivery-v5-upgrade', resolveBaseUrl: () => 'https://data.example.test',
        resolveAccountEncryptionCurrentness: currentEncryption,
        resolveReleaseLessDeclaration: id => id === manifest.id ? manifest : null,
        resolveReleaseLessCollectionMigrations: async () => channelsMigrations,
        // HTTP is the persistent Data boundary; parsing, migration, declaration
        // admission and the final Collection reader all remain real.
        http: { get: async () => ({ status: 200, data: { mode: 'plain', updatedAt: 1 } }),
            post: async (url, body) => {
                const request = JSON.parse(body);
                if (url.endsWith('/collection-writers/claim')) {
                    if (request.prepare) return { status: 200, data: {
                        intent: { pluginId: manifest.id, desiredVersion: null, enabled: true,
                            offlineUiHosting: 'disabled', writableCollections: [ref(source)], revision: '0' },
                        preparation: [{ source: sourceDeclaration, binding: {
                            source: ref(source), target: ref(target), candidate: { releaseVersion: manifest.version,
                                artifactDigest: `sha256:${'a'.repeat(64)}`, releaseLessManifest: manifest } } }],
                    } };
                    if (!staged) return { status: 409, data: { error: 'plugin_intent_writable_collections_not_ready' } };
                    promoted = true;
                    return { status: 200, data: {} };
                }
                if (url.endsWith('/candidate-preparation/source-page')) return {
                    status: 200, data: { rows: [{ ...stored, alreadyStaged: false }] },
                };
                if (url.endsWith('/candidate-preparation/stage')) {
                    const stage = PluginCollectionCandidatePreparationStageRequestV1Schema.parse(request);
                    expect(stage.binding.source).toEqual(ref(source));
                    expect(stage.binding.target).toEqual(ref(reader));
                    expect(stage.items).toHaveLength(1);
                    stored = { rowId: stored.rowId, revision: stored.revision, ...stage.items[0]!.target };
                    staged = true;
                    return { status: 200, data: { results: [{ status: 'staged' }] } };
                }
                expect(url).toMatch(/\/get$/);
                expect(promoted).toBe(true);
                expect(request.readerContext).toEqual(ref(reader));
                return { status: 200, data: { row: stored, absenceEpoch: 0 } };
            } },
    });
    const account = host.bind({ pluginId: manifest.id, occurrenceId: 'delivery-upgrade-reader',
        signal: new AbortController().signal, isOccurrenceCurrent: () => true });
    await expect(account.collection(readerDeclaration).get(value.id)).resolves.toEqual({
        rowId: value.id, revision: 22, value,
    });
    expect(reader).toEqual(target);
    expect(reader.schemaVersion).toBe(6);
    expect(promoted).toBe(true);
});

describe.each([
    { id: 'channel-state', version: 14, fixture: 'channelStateV14.json' },
    { id: 'channel-deliveries', version: 3, fixture: 'channelDeliveriesV3.json' },
])('Channels pinned $id V$version preparation', ({ id, version, fixture }) => {
    it.each(['plain', 'e2ee'] as const)('stages valid lifecycle boundary inputs in %s without manual repair', async mode => {
        const targetDeclaration = PluginManifestV2Schema.parse(CHANNELS_MANIFEST).contributes.accountCollections!.find(item => item.id === id)!;
        // The declaration comes verbatim from the fixture's immutable bundled
        // manifest, never by removing fields from the current target schema.
        const historical = JSON.parse(readFileSync(new URL(
            `../../../../../../packages/plugins/channels/src/testkit/fixtures/${fixture}`, import.meta.url,
        ), 'utf8'));
        const sourceDeclaration = PluginAccountCollectionContributionV1Schema.parse(historical.collection);
        expect(sourceDeclaration).toMatchObject({ id, schemaVersion: version });
        const source = normalizePluginAccountCollectionContractV1({ pluginId: 'happier.channels', contribution: sourceDeclaration });
        const target = normalizePluginAccountCollectionContractV1({ pluginId: 'happier.channels', contribution: targetDeclaration });

        const retained: { connection: Readonly<Record<string, JsonValue>>; checkpoint: Readonly<Record<string, JsonValue>> } =
            JSON.parse(readFileSync(new URL('../../../../../../packages/plugins/channels/src/testkit/fixtures/channelStateV8.json', import.meta.url), 'utf8'));
        let connection = retained.connection;
        for (const edge of channelsMigrations['channel-state']!.filter(edge => edge.fromSchemaVersion >= 8 && edge.toSchemaVersion <= version)) {
            connection = await edge.migrate(connection, { currentRevision: 22 });
        }
        const payload = connection.payload;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Expected retained connection payload');
        const binding = {
            id: 'binding-retained', v: 1, 'record-kind': 'binding', 'connection-id': connection.id,
            'binding-id': 'binding-retained', 'created-at': 1, 'updated-at': 23,
            payload: { endpoint: { kind: 'direct', audience: 'direct', id: 'chat-1' },
                target: { kind: 'session', sessionId: 'session-1', policy: { deliveryMode: 'repliesOnly', permissionCeiling: 'read-only', approvals: { kind: 'off' }, newSession: { kind: 'off' } } },
                allowedPrincipalIds: ['person-1'], allowBotSenders: false, inputMode: 'allAllowedMessages', inboundDebounceMs: 0,
                linkPreviewPolicy: 'suppress', senderFeedback: 'off', authorityEpoch: 1, enabled: true, deletionState: 'none' },
        } satisfies Readonly<Record<string, JsonValue>>;
        const finalizingConnection = { ...connection, id: 'connection-finalizing', 'connection-id': 'connection-finalizing',
            payload: { ...payload, enabled: false, deletionState: 'finalizingDelete' },
        };
        const finalizingBinding = { ...binding, id: 'binding-finalizing', 'binding-id': 'binding-finalizing',
            payload: { ...binding.payload, enabled: false, deletionState: 'finalizingDelete' },
        };
        const rows: readonly Readonly<Record<string, JsonValue>>[] = id === 'channel-state'
            ? [connection, binding, finalizingConnection, finalizingBinding, retained.checkpoint]
            : [{ id: 'a'.repeat(43), 'record-kind': 'outward-delivery', v: 1, 'connection-id': 'connection-1', 'binding-id': 'binding-1',
                terminal: true, attention: false, 'created-at': 100, 'updated-at': 100,
                payload: { source: { kind: 'sessionProjection', sessionId: 'session-1', semanticItemId: 'semantic-1' },
                    routeAuthority: { connectionAuthorityEpoch: 4, bindingRevision: 1, bindingAuthorityEpoch: 7 },
                    endpoint: { kind: 'direct', audience: 'direct', id: 'chat-1' }, content: null, contentFingerprint: 'b'.repeat(43),
                    deliveryKey: 'channels:delivery:v1:session-1:semantic-1', replyContext: null, mentionPolicy: 'suppress', linkPreviewPolicy: 'suppress',
                    state: 'delivered', attemptCount: 1, attemptId: null, startedAt: null, providerMessageIds: ['message-1'], failedChunk: null, archiveRecovery: null } }];
        const before = JSON.stringify(rows);
        const machineKey = new Uint8Array(32).fill(7);
        const material = mode === 'plain' ? null : { type: 'dataKey' as const, machineKey };
        const selectedCredentials: StoredCredentials = { token: 'retained-preparation-test', encryption: material ? {
            ...material, publicKey: tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey,
        } : null };
        const snapshot = material === null ? null : createAccountScopedCryptoMaterialSnapshotV1({
            accountEncryptionMode: 'e2ee', material, dataKeyPublicKey: tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey,
        });
        const sourceValidator = compilePluginJsonSchema(source.schema);
        const targetValidator = compilePluginJsonSchema(target.schema);
        if (id === 'channel-deliveries') {
            for (const value of rows) {
                const encoded = encodePluginCollectionLogicalValueV1({ contract: source,
                    isValidLogicalValue: value => isValidPluginJsonSchemaValue(sourceValidator, value),
                    value, encryptionMode: mode, material, randomBytes: length => new Uint8Array(length).fill(4) });
                if (encoded.status !== 'encoded') throw new Error(`Retained delivery invalid: ${encoded.reason}`);
                const decoded = decodePluginCollectionLogicalRowV1({ contract: target,
                    parseStoredLogicalValue: value => isValidPluginJsonSchemaValue(targetValidator, value) ? value : null,
                    row: { rowId: encoded.rowId, revision: 22, content: encoded.content, projection: encoded.projection }, encryptionMode: mode, material });
                expect(decoded).toMatchObject({ status: 'decoded', value });
            }
        }
        const staged: JsonValue[] = [];
        const host = createAccountPluginDataStorageHost({
            contracts: [target], readCredentials: async () => selectedCredentials,
            isCurrentAccount: () => true, resolveAccountScopeKey: () => `retained-${id}-${mode}`,
            resolveBaseUrl: () => 'https://data.example.test',
            resolveAccountEncryptionCurrentness: async () => mode === 'plain' ? currentEncryption() : {
                mode: 'e2ee' as const, version: 1, signingKeyFingerprint: null,
                contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(snapshot!.contentPublicKeyFingerprint),
                updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' as const },
            },
            http: { get: async () => ({ status: 200, data: { mode, updatedAt: 1 } }),
                post: async (url, body) => {
                    if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1)) {
                        return { status: 200, data: { rows: rows.map(value => {
                            const encoded = encodePluginCollectionLogicalValueV1({ contract: source,
                                isValidLogicalValue: value => isValidPluginJsonSchemaValue(sourceValidator, value),
                                value, encryptionMode: mode, material, randomBytes: length => new Uint8Array(length).fill(4) });
                            if (encoded.status !== 'encoded') throw new Error(`Retained source invalid: ${encoded.reason}`);
                            return { rowId: encoded.rowId, revision: 22, content: encoded.content, projection: encoded.projection, alreadyStaged: false };
                        }) } };
                    }
                    const request = PluginCollectionCandidatePreparationStageRequestV1Schema.parse(JSON.parse(body));
                    for (const item of request.items) {
                        const decoded = decodePluginCollectionLogicalRowV1({ contract: target,
                            parseStoredLogicalValue: value => isValidPluginJsonSchemaValue(targetValidator, value) ? value : null,
                            row: { rowId: item.source.rowId, revision: 22, ...item.target }, encryptionMode: mode, material });
                        if (decoded.status !== 'decoded') throw new Error(`Prepared target invalid: ${decoded.reason}`);
                        staged.push(decoded.value);
                    }
                    return { status: 200, data: { results: request.items.map(() => ({ status: 'staged' })) } };
                } },
        });
        const candidate = host.createCollectionMigrationCandidate({
            binding: { source: { pluginId: source.pluginId, collectionId: id, schemaVersion: version, contractDigest: source.contractDigest },
                target: { pluginId: target.pluginId, collectionId: id, schemaVersion: target.schemaVersion, contractDigest: target.contractDigest },
                candidate: { releaseVersion: '0.0.0', artifactDigest: `sha256:${'c'.repeat(64)}` } },
            sourceContract: source, targetContract: target, declarations: [targetDeclaration], runtime: { [id]: channelsMigrations[id]! },
            signal: new AbortController().signal, isOccurrenceCurrent: () => true,
        });
        await expect(candidate.prepare()).resolves.toBeUndefined();
        expect(staged).toEqual(rows.map(row => {
            if (version === 14 && (row === finalizingConnection || row === finalizingBinding)) return { ...row, 'due-at': row['updated-at'] };
            return row;
        }));
        expect(JSON.stringify(rows)).toBe(before);
    });
});

describe('Channels configured-Fix migration boundary', () => {
    it.each(['plain', 'e2ee'] as const)('preserves reviewed-head custody through migration and current %s encoding', async mode => {
        // No authentic V16 declaration is available. These are explicit owner
        // inputs, not a fabricated historical contract or captured private rows.
        const edge = channelsMigrations['channel-state']!.find(item => item.fromSchemaVersion === 16);
        if (!edge) throw new Error('Missing configured-Fix migration');
        const declaration = PluginManifestV2Schema.parse(CHANNELS_MANIFEST).contributes.accountCollections!.find(item => item.id === 'channel-state')!;
        const target = normalizePluginAccountCollectionContractV1({ pluginId: 'happier.channels', contribution: declaration });
        const validator = compilePluginJsonSchema(target.schema);
        const machineKey = new Uint8Array(32).fill(7);
        const material = mode === 'plain' ? null : { type: 'dataKey' as const, machineKey };
        const outcomes = [undefined, { status: 'accepted', localId: 'original-input' },
            { status: 'outcomeUnknown', localId: 'uncertain-input', code: 'session_input_admission_outcome_unknown' }] as const;
        for (const [index, result] of outcomes.entries()) {
            const request = { kind: 'deliverConfiguredFix', sessionId: 'session-1', bindingId: 'binding-retained',
                expectedRevision: 7, pullRequest: { repository: 'acme/widgets', number: 12 },
                head: { ref: 'feature', sha: 'reviewed-head' },
                delivery: { idempotencyKey: `original-delivery-${index}`, text: 'Retained fix request.',
                    forgeEvidence: { v: 1, items: [{ source: { kind: 'hostedCi', label: 'CI' }, author: { kind: 'process' }, text: 'A check failed.' }] } } };
            const row = { id: computeCanonicalDomainSeparatedDigest('happier:channels:configured-fix:v1',
                [request.bindingId, request.sessionId, request.delivery.idempotencyKey]),
                v: 1, 'record-kind': 'ingress-obligation', 'connection-id': 'connection-1',
                'binding-id': request.bindingId, 'session-id': request.sessionId,
                terminal: result !== undefined && result.status !== 'outcomeUnknown', attention: false,
                'created-at': 10, 'updated-at': 20,
                payload: { kind: 'configuredFix', request, ...(result ? { result } : {}) } } satisfies Readonly<Record<string, JsonValue>>;
            const before = JSON.stringify(row);
            const { head, ...retainedRequest } = request;
            const expected = { ...row, payload: { ...row.payload, request: { ...retainedRequest, expectedHeadSha: head.sha } } };
            const migrated = await edge.migrate(row, { currentRevision: 22 });
            expect(migrated).toEqual(expected);
            const encoded = encodePluginCollectionLogicalValueV1({ contract: target,
                isValidLogicalValue: value => isValidPluginJsonSchemaValue(validator, value),
                value: migrated, encryptionMode: mode, material, randomBytes: length => new Uint8Array(length).fill(4) });
            if (encoded.status !== 'encoded') throw new Error(`Migrated configured-Fix invalid: ${encoded.reason}`);
            expect(encoded.content.t).toBe(mode === 'plain' ? 'plain' : 'encrypted');
            expect(decodePluginCollectionLogicalRowV1({ contract: target,
                parseStoredLogicalValue: value => isValidPluginJsonSchemaValue(validator, value) ? value : null,
                row: { rowId: encoded.rowId, revision: 22, content: encoded.content, projection: encoded.projection },
                encryptionMode: mode, material })).toMatchObject({ status: 'decoded', value: expected });
            expect(await edge.migrate(migrated, { currentRevision: 23 })).toBe(migrated);
            expect(JSON.stringify(row)).toBe(before);
            const { sha: _reviewedSha, ...headWithoutSha } = head;
            await expect(Promise.resolve().then(() => edge.migrate({ ...row, payload: { ...row.payload,
                request: { ...request, head: headWithoutSha } } }, { currentRevision: 22 }))).rejects.toThrow();
        }
    });
});

describe('Account Data Collection candidate preparation', () => {
    it('attributes candidate HTTP spans to the declared Collection and trigger without row content', async () => {
        vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
        const log = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
        const candidate = createCandidate({
            migrate: value => ({ ...value, status: 'open' }),
            post: async url => url.endsWith('/source-page')
                ? { status: 200, data: { rows: [sourceRow('task-private-row', 1, 'PRIVATE_CONTENT', false)] } }
                : { status: 200, data: { results: [{ status: 'staged' }] } },
        });
        try {
            await candidate.prepare();
            const spans = log.mock.calls.filter(([, value]) => value && typeof value === 'object'
                && 'stage' in value && typeof value.stage === 'string'
                && value.stage.startsWith('collection.http.candidate.'));
            expect(spans).toHaveLength(4);
            for (const [, span] of spans) expect(span).toMatchObject({
                pluginId, collectionId, collectionPreparationTriggerKind: 'explicit-candidate',
            });
            expect(JSON.stringify(spans)).not.toMatch(/PRIVATE_CONTENT|task-private-row|candidate-preparation-token/);
            log.mockClear();
            vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '0');
            await candidate.prepare();
            expect(log).not.toHaveBeenCalled();
        } finally {
            log.mockRestore();
            vi.unstubAllEnvs();
        }
    });

    it('binds 48 undemanded plugins without migration, then shares demanded preparation and preserves background upgrade recovery', async () => {
        const manifests = Array.from({ length: 48 }, (_, index) => PluginManifestV2Schema.parse({
            schemaVersion: 2, id: `example.startup-${index}`, version: '2.0.0',
            displayName: 'Startup Collection', engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
            contributes: { accountCollections: [targetContribution] },
        }));
        const contracts = manifests.map(manifest => normalizePluginAccountCollectionContractV1({
            pluginId: manifest.id, contribution: targetContribution,
        }));
        const staged = new Set<string>();
        const requests: string[] = [];
        const migrations = vi.fn(async () => ({ tasks: [{
            ...targetContribution.migrations[0]!, migrate: (value: Readonly<Record<string, JsonValue>>) => ({ ...value, status: 'open' }),
        }] }));
        const host = createAccountPluginDataStorageHost({
            contracts, readCredentials: async () => credentials, isCurrentAccount: () => true,
            resolveAccountScopeKey: () => 'startup-collections', resolveBaseUrl: () => 'https://data.example.test',
            resolveAccountEncryptionCurrentness: currentEncryption,
            resolveReleaseLessDeclaration: id => manifests.find(manifest => manifest.id === id) ?? null,
            resolveReleaseLessCollectionMigrations: migrations,
            http: { get: async () => { throw new Error('Unexpected GET'); }, post: async (url, encoded) => {
                requests.push(url);
                const request = JSON.parse(encoded);
                if (url.endsWith('/collection-writers/claim')) {
                    const claim = PluginAvailabilityCollectionWritersClaimActionInputV1Schema.parse(request);
                    const manifest = 'manifest' in claim ? claim.manifest : manifests.find(value => value.id === claim.pluginId)!;
                    if (!('manifest' in claim)) expect(claim.manifestDigestSha256).toBe(computePluginManifestDigestV2(manifest));
                    const source = normalizePluginAccountCollectionContractV1({ pluginId: manifest.id, contribution: sourceContribution });
                    const target = contracts.find(contract => contract.pluginId === manifest.id)!;
                    const ref = (contract: typeof source) => ({ pluginId: contract.pluginId, collectionId,
                        schemaVersion: contract.schemaVersion, contractDigest: contract.contractDigest });
                    const intent = { pluginId: manifest.id, desiredVersion: null, enabled: true, offlineUiHosting: 'disabled',
                        writableCollections: [ref(source)], revision: '0' };
                    if (request.prepare) return { status: 200, data: { intent, preparation: [{ source: sourceContribution,
                        binding: { source: ref(source), target: ref(target), candidate: {
                            releaseVersion: manifest.version, artifactDigest: `sha256:${'a'.repeat(64)}`, releaseLessManifest: manifest,
                        } } }] } };
                    return staged.has(manifest.id) ? { status: 200, data: {} }
                        : { status: 409, data: { error: 'plugin_intent_writable_collections_not_ready' } };
                }
                if (url.endsWith('/candidate-preparation/source-page')) return { status: 200, data: {
                    rows: Array.from({ length: 50 }, (_, index) => sourceRow(`task-${index}`, index + 1, 'Retained', false)),
                } };
                if (url.endsWith('/candidate-preparation/stage')) {
                    const stage = PluginCollectionCandidatePreparationStageRequestV1Schema.parse(request);
                    expect(stage.items).toHaveLength(50);
                    staged.add(stage.binding.target.pluginId);
                    return { status: 200, data: { results: stage.items.map(() => ({ status: 'staged' })) } };
                }
                return { status: 200, data: { row: null, absenceEpoch: 0 } };
            } },
        });
        const bind = (id: string) => ({ pluginId: id, occurrenceId: `occurrence-${id}`,
            signal: new AbortController().signal, isOccurrenceCurrent: () => true });
        const accounts = manifests.map(manifest => host.bind(bind(manifest.id)));
        await vi.waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(48));
        expect(migrations).not.toHaveBeenCalled();
        expect(requests).toHaveLength(48);
        const definition = { ...targetContribution, migrations: [{ ...targetContribution.migrations[0]!,
            migrate: (value: Readonly<Record<string, JsonValue>>) => ({ ...value, status: 'open' }),
        }] };
        const account = accounts[0];
        if (!account) throw new Error('Expected Account Collection binding');
        await Promise.all(Array.from({ length: 12 }, () => account.collection(definition).get('task-0')));
        expect(migrations).toHaveBeenCalledTimes(1);
        expect(staged).toEqual(new Set([manifests[0]!.id]));
        expect(requests.filter(url => url.endsWith('/candidate-preparation/source-page'))).toHaveLength(1);
        expect(requests.filter(url => url.endsWith('/candidate-preparation/stage'))).toHaveLength(1);
        expect(requests.filter(url => url.endsWith('/collection-writers/claim')).length).toBeLessThanOrEqual(51);
        // The readiness owner invokes the existing publication lifecycle in
        // the background. Direct UI reads need its upgrade recovery even when
        // no daemon Collection operation ever demands this second plugin.
        await host.claimReleaseLessDeclaration(bind(manifests[1]!.id));
        expect(migrations).toHaveBeenCalledTimes(2);
        expect(staged).toEqual(new Set([manifests[0]!.id, manifests[1]!.id]));

        // A settled Home already admits every target contract. Repeated
        // startup/reconnect publication of dormant declarations must not
        // load callbacks or open source pages, even after binding each one.
        for (const manifest of manifests) staged.add(manifest.id);
        const preparationsBeforeSettlement = requests.filter(url => url.includes('/candidate-preparation/')).length;
        for (let publication = 0; publication < 2; publication += 1) {
            for (const manifest of manifests) await host.claimReleaseLessDeclaration(bind(manifest.id));
        }
        expect(migrations).toHaveBeenCalledTimes(2);
        expect(requests.filter(url => url.includes('/candidate-preparation/'))).toHaveLength(preparationsBeforeSettlement);
    });

    it.each(['transient', 'terminal'] as const)('resumes a transiently failed writer upgrade while retaining terminal cleanup (%s)', async failureKind => {
        vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
        const log = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
        try {
        const manifest = PluginManifestV2Schema.parse({
            schemaVersion: 2, id: pluginId, version: '2.0.0', displayName: 'Resumable Collection',
            engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
            contributes: { accountCollections: [targetContribution] },
        });
        const ref = (contract: typeof sourceContract) => ({ pluginId, collectionId,
            schemaVersion: contract.schemaVersion, contractDigest: contract.contractDigest });
        const staged = new Set<string>();
        const migrated: string[] = [];
        let failed = false;
        let retirements = 0;
        let sourcePages = 0;
        const host = createAccountPluginDataStorageHost({
            contracts: [targetContract], readCredentials: async () => credentials, isCurrentAccount: () => true,
            resolveAccountScopeKey: () => 'resumable-collections', resolveBaseUrl: () => 'https://data.example.test',
            resolveAccountEncryptionCurrentness: currentEncryption,
            resolveReleaseLessDeclaration: id => id === pluginId ? manifest : null,
            resolveReleaseLessCollectionMigrations: async () => ({ tasks: [{ ...targetContribution.migrations[0]!,
                migrate: value => { migrated.push(String(value.id)); return { ...value, status: 'open' }; },
            }] }),
            http: { get: async () => { throw new Error('Unexpected GET'); }, post: async (url, encoded) => {
                const request = JSON.parse(encoded);
                if (url.endsWith('/collection-writers/claim')) {
                    if (request.prepare) return { status: 200, data: {
                        intent: { pluginId, desiredVersion: null, enabled: true, offlineUiHosting: 'disabled',
                            writableCollections: [ref(sourceContract)], revision: '0' },
                        preparation: [{ source: sourceContribution, binding: {
                            source: ref(sourceContract), target: ref(targetContract), candidate: {
                                releaseVersion: manifest.version, artifactDigest: `sha256:${'a'.repeat(64)}`,
                                releaseLessManifest: manifest,
                            },
                        } }],
                    } };
                    return staged.size === 2 ? { status: 200, data: {} }
                        : { status: 409, data: { error: 'plugin_intent_writable_collections_not_ready' } };
                }
                if (url.endsWith('/source-page')) {
                    sourcePages += 1;
                    const rowId = request.cursor ? 'task-second' : 'task-first';
                    return { status: 200, data: {
                        rows: [sourceRow(rowId, 1, 'Retained', staged.has(rowId))],
                        ...(request.cursor ? {} : { nextCursor: 'second-page' }),
                    } };
                }
                if (url.endsWith('/stage')) {
                    const stage = PluginCollectionCandidatePreparationStageRequestV1Schema.parse(request);
                    const rowId = stage.items[0]!.source.rowId;
                    if (rowId === 'task-second' && !failed) {
                        failed = true;
                        return failureKind === 'transient'
                            ? { status: 500, data: { error: 'internal_server_error' } }
                            : { status: 409, data: { error: 'collection_candidate_preparation_source_changed' } };
                    }
                    staged.add(rowId);
                    return { status: 200, data: { results: [{ status: 'staged' }] } };
                }
                if (url.endsWith('/retire')) {
                    retirements += 1;
                    staged.clear();
                    return { status: 200, data: { status: 'retired' } };
                }
                return { status: 200, data: { row: null, absenceEpoch: 0 } };
            } },
        });
        const lifecycle = { pluginId, occurrenceId: 'resumable-upgrade',
            signal: new AbortController().signal, isOccurrenceCurrent: () => true };
        const account = host.bind(lifecycle);
        if (!account) throw new Error('Expected bound Collection');
        await host.claimReleaseLessDeclaration(lifecycle);
        expect(failed).toBe(true);
        expect(migrated).toEqual(['task-first', 'task-second']);
        expect({ staged: [...staged], retirements }).toEqual(failureKind === 'transient'
            ? { staged: ['task-first'], retirements: 0 }
            : { staged: [], retirements: 1 });
        const definition = { ...targetContribution, migrations: [{ ...targetContribution.migrations[0]!,
            migrate: (value: Readonly<Record<string, JsonValue>>) => ({ ...value, status: 'open' }),
        }] };
        await account.collection(definition).get('task-first');
        const resumedMigrations = failureKind === 'transient'
            ? ['task-first', 'task-second', 'task-second']
            : ['task-first', 'task-second', 'task-first', 'task-second'];
        expect(migrated).toEqual(resumedMigrations);
        expect(staged).toEqual(new Set(['task-first', 'task-second']));
        expect(sourcePages).toBe(4);
        await host.claimReleaseLessDeclaration(lifecycle);
        await account.collection(definition).get('task-first');
        expect(migrated).toEqual(resumedMigrations);
        expect(sourcePages).toBe(4);
        expect(retirements).toBe(failureKind === 'transient' ? 0 : 1);
        const spans = log.mock.calls.filter(([, value]) => value && typeof value === 'object'
            && 'stage' in value && value.stage === 'collection.http.candidate.begin');
        expect(spans).toEqual(expect.arrayContaining([
            ['[external-action-stage]', expect.objectContaining({ pluginId, collectionId,
                collectionPreparationTriggerKind: 'declaration-publication' })],
            ['[external-action-stage]', expect.objectContaining({ pluginId, collectionId,
                collectionPreparationTriggerKind: 'collection-operation' })],
        ]));
        expect(JSON.stringify(spans)).not.toMatch(/Retained|task-first|task-second|candidate-preparation-token/);
        } finally {
            log.mockRestore();
            vi.unstubAllEnvs();
        }
    });

    it('admits encryption for the source page and final stage, rather than issuing currentness reads per retained row', async () => {
        const encryption = vi.fn(currentEncryption);
        const requests: string[] = [];
        const migrated: string[] = [];
        const candidate = createCandidate({
            resolveAccountEncryptionCurrentness: encryption,
            post: async (url, body) => {
                requests.push(url);
                if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1)) {
                    return { status: 200, data: { rows: Array.from({ length: 50 }, (_, index) =>
                        sourceRow(`task-${index}`, index + 1, 'Retained', false)) } };
                }
                const request = PluginCollectionCandidatePreparationStageRequestV1Schema.parse(JSON.parse(body));
                expect(request.items).toHaveLength(50);
                expect(migrated).toHaveLength(50);
                return { status: 200, data: { results: request.items.map(() => ({ status: 'staged' })) } };
            },
            migrate: async value => {
                migrated.push(String(value.id));
                return { ...value, status: 'open' };
            },
        });
        await candidate.prepare();
        expect(requests).toEqual([
            `https://data.example.test${PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1}`,
            `https://data.example.test${PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1}`,
        ]);
        expect(encryption).toHaveBeenCalledTimes(2);
    });

    it('seals every target row using the fresh mode after the last asynchronous callback', async () => {
        const machineKey = new Uint8Array(32).fill(8);
        const selectedCredentials: StoredCredentials = { token: 'page-mode-change', encryption: {
            type: 'dataKey', machineKey, publicKey: tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey,
        } };
        const material = { type: 'dataKey' as const, machineKey };
        const snapshot = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material,
            dataKeyPublicKey: tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey });
        let encrypted = false;
        let stages = 0;
        const candidate = createCandidate({
            credentials: selectedCredentials,
            resolveAccountEncryptionCurrentness: async () => encrypted ? {
                mode: 'e2ee', version: 2, signingKeyFingerprint: null, updatedAt: 2,
                contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(snapshot.contentPublicKeyFingerprint),
                recipientEnvelopeReadiness: { status: 'available' },
            } : currentEncryption(),
            migrate: async value => {
                await Promise.resolve();
                if (value.id === 'task-last') encrypted = true;
                return { ...value, status: 'open' };
            },
            post: async (url, encoded) => {
                if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1)) return {
                    status: 200, data: { rows: [sourceRow('task-first', 1, 'First', false), sourceRow('task-last', 2, 'Last', false)] },
                };
                const stage = PluginCollectionCandidatePreparationStageRequestV1Schema.parse(JSON.parse(encoded));
                stages += 1;
                for (const item of stage.items) {
                    expect(item.target.content.t).toBe('encrypted');
                    expect(decodePluginCollectionLogicalRowV1({ contract: targetContract,
                        parseStoredLogicalValue: value => isValidPluginJsonSchemaValue(compilePluginJsonSchema(targetContract.schema), value) ? value : null,
                        row: { rowId: item.source.rowId, revision: item.source.revision, ...item.target },
                        encryptionMode: 'e2ee', material,
                    })).toMatchObject({ status: 'decoded', value: { id: item.source.rowId, status: 'open' } });
                }
                return { status: 200, data: { results: stage.items.map(() => ({ status: 'staged' })) } };
            },
        });
        await candidate.prepare();
        expect(stages).toBe(1);
    });

    it('rechecks encryption authority between advertised stage chunks before issuing another write', async () => {
        let stages = 0;
        const candidate = createCandidate({
            resolveServerFeaturesSnapshot: () => collectionFeatures({
                ...PLUGIN_COLLECTION_DEFAULT_DEPLOYMENT_LIMITS_V1,
                maxBatchRows: 1,
            }),
            resolveAccountEncryptionCurrentness: async () => stages === 0 ? currentEncryption() : {
                mode: 'e2ee', version: 2, signingKeyFingerprint: null, contentKeyFingerprint: 'changed-key', updatedAt: 2,
                recipientEnvelopeReadiness: { status: 'available' },
            },
            migrate: value => ({ ...value, status: 'open' }),
            post: async url => {
                if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1)) return {
                    status: 200, data: { rows: [sourceRow('task-first', 1, 'First', false), sourceRow('task-last', 2, 'Last', false)] },
                };
                stages += 1;
                return { status: 200, data: { results: [{ status: 'staged' }] } };
            },
        });
        await expect(candidate.prepare()).rejects.toMatchObject({ code: 'plugin_account_storage_unavailable' });
        expect(stages).toBe(1);
    });

    it('rejects invalid source revisions before migration callbacks or staging', async () => {
        let migrationRan = false;
        let staged = false;
        const candidate = createCandidate({
            post: async url => {
                if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1)) {
                    return { status: 200, data: { rows: [sourceRow('task-invalid-revision', 0, 'Retained', false)] } };
                }
                staged = true;
                throw new Error('Invalid source revision cannot stage');
            },
            migrate: value => { migrationRan = true; return { ...value, status: 'open' }; },
        });
        await expect(candidate.prepare()).rejects.toMatchObject({ code: 'plugin_collection_protocol_invalid' });
        expect({ migrationRan, staged }).toEqual({ migrationRan: false, staged: false });
    });

    it('supplies the physical retained row revision to the pure migration callback', async () => {
        const staged: unknown[] = [];
        const candidate = createCandidate({
            post: async (url, body) => {
                if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1)) {
                    return { status: 200, data: { rows: [sourceRow('task-revision', 14, 'Retained', false)] } };
                }
                const request = PluginCollectionCandidatePreparationStageRequestV1Schema.parse(JSON.parse(body));
                staged.push(...request.items);
                return { status: 200, data: { results: [{ status: 'staged' }] } };
            },
            migrate: (value, context) => ({ ...value, status: context?.currentRevision === 14 ? 'open' : 'closed' }),
        });
        await expect(candidate.prepare()).resolves.toBeUndefined();
        expect(staged).toMatchObject([{ source: { revision: 14 }, target: { projection: { status: 'open' } } }]);
    });

    it('returns the existing typed invalid-value failure when a declared migration rejects retained data', async () => {
        let staged = false;
        const candidate = createCandidate({
            post: async (url) => {
                if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1)) {
                    return { status: 200, data: { rows: [sourceRow('task-rejected', 4, 'Retained', false)] } };
                }
                staged = true;
                throw new Error('Rejected source data must not be staged');
            },
            migrate: () => { throw new Error('Source authority mismatch'); },
        });
        await expect(candidate.prepare()).rejects.toMatchObject({ code: 'plugin_collection_invalid_value' });
        expect(staged).toBe(false);
    });
    it('retires an exact persisted candidate binding without requiring its target callback or generation', async () => {
        const post = vi.fn(async (url: string, body: string) => {
            expect(url).toBe(`https://data.example.test${PLUGIN_COLLECTION_CANDIDATE_PREPARATION_RETIRE_HTTP_PATH_V1}`);
            expect(JSON.parse(body)).toEqual({ binding });
            return { status: 200, data: { status: 'retired' } };
        });
        const host = createCandidateHost(post);

        await expect(host.retireCollectionMigrationCandidate({
            binding,
            signal: new AbortController().signal,
            isCurrent: () => true,
        })).resolves.toBeUndefined();

        expect(post).toHaveBeenCalledOnce();
    });

    it('does not stage a candidate bound to retired Account A after A→B→A', async () => {
        const credentialsA = { token: 'candidate-preparation-account-a', encryption: null } satisfies StoredCredentials;
        const credentialsB = { token: 'candidate-preparation-account-b', encryption: null } satisfies StoredCredentials;
        const scopeA = resolveAccountSettingsScopeKey(credentialsA);
        const scopeB = resolveAccountSettingsScopeKey(credentialsB);
        const post = vi.fn(async () => {
            throw new Error('A retired candidate must not reach Account Data');
        });

        resetActiveAccountSettingsSnapshotForTests();
        try {
            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({}),
                settingsVersion: 1,
                loadedAtMs: 1,
                settingsSecretsReadKeys: [],
                scopeKey: scopeA,
            });
            const host = createAccountPluginDataStorageHost({
                contracts: [targetContract],
                readCredentials: async () => credentialsA,
                resolveBaseUrl: () => 'https://data.example.test',
                resolveAccountEncryptionCurrentness: currentEncryption,
                http: {
                    get: async () => ({ status: 200, data: { mode: 'plain', updatedAt: 1 } }),
                    post,
                },
                randomBytes: (length) => new Uint8Array(length).fill(7),
            });
            const candidate = host.createCollectionMigrationCandidate({
                binding,
                sourceContract,
                targetContract,
                declarations: [targetContribution],
                runtime: {
                    [collectionId]: [{
                        id: 'upgrade-v1-to-v2',
                        fromSchemaVersion: 1,
                        toSchemaVersion: 2,
                        migrate: (value) => ({ ...value, status: 'open' }),
                    }],
                },
                signal: new AbortController().signal,
                isOccurrenceCurrent: () => true,
            });

            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({}),
                settingsVersion: 1,
                loadedAtMs: 2,
                settingsSecretsReadKeys: [],
                scopeKey: scopeB,
            });
            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({}),
                settingsVersion: 2,
                loadedAtMs: 3,
                settingsSecretsReadKeys: [],
                scopeKey: scopeA,
            });

            await expect(candidate.prepare()).rejects.toMatchObject({
                code: 'plugin_account_storage_unavailable',
            } satisfies Partial<PluginError>);
            expect(post).not.toHaveBeenCalled();
        } finally {
            resetActiveAccountSettingsSnapshotForTests();
        }
    });

    it('uses the one target-bound host operation, skips exact staged revisions, and batches only target material for a source page', async () => {
        const migrate = vi.fn((value: Readonly<Record<string, JsonValue>>) => ({
            ...value,
            status: 'open',
        }));
        const post = vi.fn(async (url: string, body: string) => {
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1)) {
                expect(JSON.parse(body)).toEqual({ binding, limit: 50 });
                return {
                    status: 200,
                    data: {
                        rows: [
                            sourceRow('task-already-staged', 3, 'Already staged', true),
                            sourceRow('task-current', 4, 'Prepare me', false),
                            sourceRow('task-next', 5, 'Prepare this too', false),
                        ],
                    },
                };
            }
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1)) {
                return {
                    status: 200,
                    data: { results: [{ status: 'staged' }, { status: 'staged' }] },
                };
            }
            throw new Error(`Unexpected candidate-preparation request: ${url}`);
        });
        const candidate = createCandidate({ post, migrate });

        await expect(candidate.prepare()).resolves.toBeUndefined();

        expect(migrate).toHaveBeenCalledTimes(2);
        expect(migrate).toHaveBeenNthCalledWith(1, { id: 'task-current', title: 'Prepare me' }, { currentRevision: 4 });
        expect(migrate).toHaveBeenNthCalledWith(2, { id: 'task-next', title: 'Prepare this too' }, { currentRevision: 5 });
        const stageCall = post.mock.calls.find(([url]) => (
            String(url).endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1)
        ));
        expect(JSON.parse(stageCall?.[1] ?? 'null')).toEqual({
            binding,
            items: [
                {
                    source: { rowId: 'task-current', revision: 4 },
                    target: {
                        content: { t: 'plain', v: {} },
                        projection: { id: 'task-current', title: 'Prepare me', status: 'open' },
                    },
                },
                {
                    source: { rowId: 'task-next', revision: 5 },
                    target: {
                        content: { t: 'plain', v: {} },
                        projection: { id: 'task-next', title: 'Prepare this too', status: 'open' },
                    },
                },
            ],
        });
    });

    it('splits one source page at an advertised lower candidate-stage row cap', async () => {
        const maxBatchBytes = measurePluginCollectionCandidatePreparationStageRequestEncodedBytesV1(
            PluginCollectionCandidatePreparationStageRequestV1Schema.parse({
                binding,
                items: [
                    {
                        source: { rowId: 'task-current', revision: 4 },
                        target: {
                            content: { t: 'plain' as const, v: {} },
                            projection: { id: 'task-current', title: 'Prepare me', status: 'open' },
                        },
                    },
                    {
                        source: { rowId: 'task-next', revision: 5 },
                        target: {
                            content: { t: 'plain' as const, v: {} },
                            projection: { id: 'task-next', title: 'Prepare this too', status: 'open' },
                        },
                    },
                ],
            }),
        );
        const post = vi.fn(async (url: string, body: string) => {
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1)) {
                return {
                    status: 200,
                    data: {
                        rows: [
                            sourceRow('task-current', 4, 'Prepare me', false),
                            sourceRow('task-next', 5, 'Prepare this too', false),
                        ],
                    },
                };
            }
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1)) {
                const request = JSON.parse(body) as { items: readonly unknown[] };
                return {
                    status: 200,
                    data: { results: request.items.map(() => ({ status: 'staged' })) },
                };
            }
            throw new Error(`Unexpected candidate-preparation request: ${url}`);
        });
        const candidate = createCandidate({
            post,
            migrate: (value) => ({ ...value, status: 'open' }),
            resolveServerFeaturesSnapshot: () => collectionFeatures({
                maxRowEncodedBytes: maxBatchBytes,
                maxBatchBytes,
                maxBatchRows: 1,
                maxAccountRows: 100,
                maxAccountBytes: maxBatchBytes,
            }),
        });

        await expect(candidate.prepare()).resolves.toBeUndefined();

        const stageBodies = post.mock.calls
            .filter(([url]) => String(url).endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1))
            .map(([, body]) => JSON.parse(body));
        expect(stageBodies).toEqual([
            {
                binding,
                items: [{
                    source: { rowId: 'task-current', revision: 4 },
                    target: {
                        content: { t: 'plain', v: {} },
                        projection: { id: 'task-current', title: 'Prepare me', status: 'open' },
                    },
                }],
            },
            {
                binding,
                items: [{
                    source: { rowId: 'task-next', revision: 5 },
                    target: {
                        content: { t: 'plain', v: {} },
                        projection: { id: 'task-next', title: 'Prepare this too', status: 'open' },
                    },
                }],
            },
        ]);
    });

    it('splits one source page at the advertised canonical candidate-stage byte cap', async () => {
        const firstItem = {
            source: { rowId: 'task-current', revision: 4 },
            target: {
                content: { t: 'plain' as const, v: {} },
                projection: { id: 'task-current', title: 'Prepare me', status: 'open' },
            },
        };
        const secondItem = {
            source: { rowId: 'task-next', revision: 5 },
            target: {
                content: { t: 'plain' as const, v: {} },
                projection: { id: 'task-next', title: 'Prepare this too', status: 'open' },
            },
        };
        const maxBatchBytes = Math.max(
            measurePluginCollectionCandidatePreparationStageRequestEncodedBytesV1(
                PluginCollectionCandidatePreparationStageRequestV1Schema.parse({ binding, items: [firstItem] }),
            ),
            measurePluginCollectionCandidatePreparationStageRequestEncodedBytesV1(
                PluginCollectionCandidatePreparationStageRequestV1Schema.parse({ binding, items: [secondItem] }),
            ),
        );
        const post = vi.fn(async (url: string, body: string) => {
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1)) {
                return {
                    status: 200,
                    data: {
                        rows: [
                            sourceRow('task-current', 4, 'Prepare me', false),
                            sourceRow('task-next', 5, 'Prepare this too', false),
                        ],
                    },
                };
            }
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1)) {
                const request = JSON.parse(body) as { items: readonly unknown[] };
                return {
                    status: 200,
                    data: { results: request.items.map(() => ({ status: 'staged' })) },
                };
            }
            throw new Error(`Unexpected candidate-preparation request: ${url}`);
        });
        const candidate = createCandidate({
            post,
            migrate: (value) => ({ ...value, status: 'open' }),
            resolveServerFeaturesSnapshot: () => collectionFeatures({
                maxRowEncodedBytes: maxBatchBytes,
                maxBatchBytes,
                maxBatchRows: 100,
                maxAccountRows: 100,
                maxAccountBytes: maxBatchBytes,
            }),
        });

        await expect(candidate.prepare()).resolves.toBeUndefined();

        const stageBodies = post.mock.calls
            .filter(([url]) => String(url).endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1))
            .map(([, body]) => JSON.parse(body));
        expect(stageBodies).toHaveLength(2);
        expect(stageBodies.map((body) => (body as { items: readonly unknown[] }).items)).toEqual([
            [firstItem],
            [secondItem],
        ]);
    });

    it('does not replay a callback inside one sourceChanged attempt but may invoke it again on a later preparation attempt', async () => {
        const migrate = vi.fn((value: Readonly<Record<string, JsonValue>>) => ({
            ...value,
            status: 'open',
        }));
        const sourcePage = vi.fn();
        const stage = vi.fn();
        const post = vi.fn(async (url: string, _body: string) => {
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1)) {
                sourcePage();
                return {
                    status: 200,
                    data: {
                        rows: [
                            sourceRow('task-current', 4, 'Prepare me', false),
                            sourceRow('task-next', 5, 'Prepare this too', false),
                        ],
                    },
                };
            }
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1)) {
                stage();
                return stage.mock.calls.length === 1
                    ? { status: 200, data: { results: [{ status: 'sourceChanged' }] } }
                    : { status: 200, data: { results: [{ status: 'staged' }] } };
            }
            throw new Error(`Unexpected candidate-preparation request: ${url}`);
        });
        const candidate = createCandidate({
            post,
            migrate,
            resolveServerFeaturesSnapshot: () => collectionFeatures({
                maxRowEncodedBytes: 2048,
                maxBatchBytes: 4096,
                maxBatchRows: 1,
                maxAccountRows: 100,
                maxAccountBytes: 4096,
            }),
        });

        await expect(candidate.prepare()).rejects.toMatchObject({
            code: 'collection_candidate_preparation_source_changed',
        } satisfies Partial<PluginError>);

        expect(migrate).toHaveBeenCalledTimes(2);
        expect(sourcePage).toHaveBeenCalledOnce();
        expect(stage).toHaveBeenCalledOnce();

        await expect(candidate.prepare()).resolves.toBeUndefined();

        // A callback has at-least-once semantics until its exact output is
        // accepted. The host does not retain a second receipt or suppress a
        // fresh candidate-preparation attempt after the failed stage CAS.
        expect(migrate).toHaveBeenCalledTimes(4);
        expect(sourcePage).toHaveBeenCalledTimes(2);
        expect(stage).toHaveBeenCalledTimes(3);
    });

    it('drains an aborted callback before retiring its exact binding and never stages its output', async () => {
        const pendingMigration = {
            release: null as ((value: Readonly<Record<string, JsonValue>>) => void) | null,
        };
        const migrate = vi.fn((value: Readonly<Record<string, JsonValue>>) => new Promise<Readonly<Record<string, JsonValue>>>((resolve) => {
            pendingMigration.release = () => resolve({ ...value, status: 'open' });
        }));
        const post = vi.fn(async (url: string, _body: string) => {
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1)) {
                return {
                    status: 200,
                    data: { rows: [sourceRow('task-current', 4, 'Prepare me', false)] },
                };
            }
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_RETIRE_HTTP_PATH_V1)) {
                return { status: 200, data: { status: 'retired' } };
            }
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1)) {
                throw new Error('Cancelled candidate preparation must not stage callback output');
            }
            throw new Error(`Unexpected candidate-preparation request: ${url}`);
        });
        const candidate = createCandidate({ post, migrate });
        const preparing = candidate.prepare();

        await vi.waitFor(() => expect(migrate).toHaveBeenCalledOnce());
        const retiring = candidate.retire();
        expect(post.mock.calls.some(([url]) => (
            String(url).endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_RETIRE_HTTP_PATH_V1)
        ))).toBe(false);
        if (!pendingMigration.release) throw new Error('Expected the migration callback to be pending');
        pendingMigration.release({ id: 'task-current', title: 'Prepare me' });

        await expect(preparing).rejects.toMatchObject({
            code: 'plugin_collection_cancelled',
        } satisfies Partial<PluginError>);
        await expect(retiring).resolves.toBeUndefined();
        expect(JSON.parse(post.mock.calls.find(([url]) => (
            String(url).endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_RETIRE_HTTP_PATH_V1)
        ))?.[1] ?? 'null')).toEqual({ binding });
    });

    it('uses the Account-A retirement authority captured before staging after active credentials switch to Account B', async () => {
        const accountA = {
            token: 'candidate-preparation-account-a',
            encryption: null,
        } satisfies StoredCredentials;
        const accountB = {
            token: 'candidate-preparation-account-b',
            encryption: null,
        } satisfies StoredCredentials;
        let activeCredentials: StoredCredentials = accountA;
        const encodedBodies: string[] = [];
        const adapterBodies: unknown[] = [];
        const post = vi.fn(async (
            url: string,
            body: string,
            config: Readonly<Record<string, unknown>>,
        ) => {
            adapterBodies.push(body);
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_SOURCE_PAGE_HTTP_PATH_V1)) {
                return {
                    status: 200,
                    data: { rows: [sourceRow('task-current', 4, 'Prepare me', false)] },
                };
            }
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_STAGE_HTTP_PATH_V1)) {
                return { status: 200, data: { results: [{ status: 'staged' }] } };
            }
            if (url.endsWith(PLUGIN_COLLECTION_CANDIDATE_PREPARATION_RETIRE_HTTP_PATH_V1)) {
                expect(config).toMatchObject({
                    headers: { Authorization: 'Bearer candidate-preparation-account-a' },
                });
                return { status: 200, data: { status: 'retired' } };
            }
            throw new Error(`Unexpected candidate-preparation request: ${url}`);
        });
        const transport = axios.create({
            adapter: async config => {
                if (typeof config.data !== 'string') throw new Error('Expected preencoded Account Data bytes');
                const response = await post(config.url ?? '', config.data, { ...config });
                return { ...response, config, headers: {}, statusText: '' };
            },
        });
        const host = createAccountPluginDataStorageHost({
            contracts: [targetContract],
            readCredentials: async () => activeCredentials,
            isCurrentAccount: (candidate) => candidate === activeCredentials,
            resolveAccountScopeKey: () => 'candidate-preparation-account',
            resolveBaseUrl: () => 'https://data.example.test',
            resolveAccountEncryptionCurrentness: currentEncryption,
            http: {
                get: async () => ({ status: 200, data: { mode: 'plain', updatedAt: 1 } }),
                post: async (url, body, config) => {
                    encodedBodies.push(body);
                    return await transport.post(url, body, config);
                },
            },
            randomBytes: (length) => new Uint8Array(length).fill(7),
        });
        const candidate = host.createCollectionMigrationCandidate({
            binding,
            sourceContract,
            targetContract,
            declarations: [targetContribution],
            runtime: {
                [collectionId]: [{
                    id: 'upgrade-v1-to-v2',
                    fromSchemaVersion: 1,
                    toSchemaVersion: 2,
                    migrate: (value) => ({ ...value, status: 'open' }),
                }],
            },
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
        });

        const parse = vi.spyOn(JSON, 'parse');
        try {
            await expect(candidate.prepare()).resolves.toBeUndefined();
            activeCredentials = accountB;

            await expect(candidate.retire()).resolves.toBeUndefined();
            expect(encodedBodies).toHaveLength(3);
            expect(adapterBodies).toEqual(encodedBodies);
            expect(parse.mock.calls.filter(([value]) => encodedBodies.includes(value))).toHaveLength(0);
        } finally {
            parse.mockRestore();
        }
    });
});
