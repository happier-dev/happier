import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import {
    convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
    createAccountScopedCryptoMaterialSnapshotV1,
    PLUGIN_COLLECTION_GET_HTTP_PATH_V1,
    PLUGIN_COLLECTION_MUTATION_HTTP_PATH_V1,
    PLUGIN_COLLECTION_QUERY_HTTP_PATH_V1,
    PluginAccountCollectionContributionV1Schema,
    PluginCollectionGetRequestV1Schema,
    PluginCollectionMutationRequestV1Schema,
    PluginCollectionQueryRequestV1Schema,
    measurePluginCollectionMutationRequestEncodedBytesV1,
    normalizePluginAccountCollectionContractV1,
    type PluginCollectionMutationRequestV1,
    type PluginCollectionRowV1,
} from '@happier-dev/protocol';
import {
    normalizePluginAccountCollectionMigrationRuntimeProjection,
    type JsonValue,
    type PluginInvocationContext,
    type PluginServices,
} from '@happier-dev/plugin-sdk';
import type { PluginAccountCollectionDefinition } from '@happier-dev/plugin-sdk/collections';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import type { ConversationProviderObservationIngestInputV1 } from '@happier-dev/channels-protocol/v1';

import type { StoredCredentials } from '@/persistence';

import { createAccountPluginDataStorageHost } from './accountPluginDataStorage';

const CHANNELS_PLUGIN_ID = 'happier.channels';
const CHANNEL_STATE_COLLECTION_ID = 'channel-state';
/** The shipped deployment policy every unpublished-capability client assumes. */
const INGRESS_PREPARATION_BATCH_LIMIT_BYTES = 16 * 1024 * 1024;
const INGRESS_PREPARATION_OPERATION_LIMIT = 100;
const ACCOUNT_SCOPE_KEY = 'channels-c3-physical-account';
const E2EE_MACHINE_KEY = new Uint8Array(32).fill(7);
const E2EE_CREDENTIALS = {
    token: 'channels-c3-e2ee-token',
    encryption: {
        type: 'dataKey' as const,
        publicKey: tweetnacl.box.keyPair.fromSecretKey(E2EE_MACHINE_KEY).publicKey,
        machineKey: E2EE_MACHINE_KEY,
    },
} satisfies StoredCredentials;

function e2eeCurrentness() {
    const snapshot = createAccountScopedCryptoMaterialSnapshotV1({
        accountEncryptionMode: 'e2ee',
        material: {
            type: 'dataKey',
            machineKey: E2EE_CREDENTIALS.encryption.machineKey,
        },
        dataKeyPublicKey: E2EE_CREDENTIALS.encryption.publicKey,
    });
    return {
        mode: 'e2ee' as const,
        version: 1,
        signingKeyFingerprint: null,
        contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
            snapshot.contentPublicKeyFingerprint,
        ),
        updatedAt: 1,
    };
}

type CurrentChannelsSources = Readonly<{
    /** Parsed static identity used for admission and exact contract normalization. */
    channelStateCollectionDeclaration: ReturnType<typeof PluginAccountCollectionContributionV1Schema.parse>;
    /** Current-source executable definition, including its migration callback. */
    channelStateCollection: PluginAccountCollectionDefinition;
    createCurrentConnectionFixture: (input: unknown) => unknown;
    ingest: (
        input: ConversationProviderObservationIngestInputV1,
        context: PluginInvocationContext,
    ) => Promise<void>;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonRecord(value: unknown): Readonly<Record<string, JsonValue>> {
    if (!isRecord(value)) throw new Error('Expected a JSON record.');
    return value as Readonly<Record<string, JsonValue>>;
}

async function loadCurrentChannelsSources(): Promise<CurrentChannelsSources> {
    const sourceRoot = '../../../../../../packages/plugins/channels/src/';
    const [manifestNamespace, ingressNamespace, fixtureNamespace] = await Promise.all([
        import(/* @vite-ignore */ new URL(`${sourceRoot}manifest.ts`, import.meta.url).href),
        import(/* @vite-ignore */ new URL(`${sourceRoot}ingress.ts`, import.meta.url).href),
        import(/* @vite-ignore */ new URL(`${sourceRoot}testkit/currentConnectionFixture.ts`, import.meta.url).href),
    ]);
    if (
        !isRecord(manifestNamespace)
        || !isRecord(ingressNamespace)
        || !isRecord(fixtureNamespace)
    ) {
        throw new Error('Expected the current Channels source modules.');
    }
    const createCurrentConnectionFixture = fixtureNamespace.createCurrentConversationConnectionFixture;
    const ingest = ingressNamespace.ingestConversationProviderObservationForInvocation;
    if (typeof createCurrentConnectionFixture !== 'function' || typeof ingest !== 'function') {
        throw new Error('Expected the current Channels ingress fixtures and handler.');
    }
    const parsedManifest = parsePluginManifest(manifestNamespace.PLUGIN_MANIFEST);
    if (!parsedManifest.ok) throw new Error('Expected the current Channels manifest to parse.');
    const rawChannelStateCollectionDeclaration = parsedManifest.manifest.contributes.accountCollections.find(
        (collection) => collection.id === CHANNEL_STATE_COLLECTION_ID,
    );
    if (!rawChannelStateCollectionDeclaration) {
        throw new Error('Expected the current Channels Collection declaration.');
    }
    const channelStateCollectionDeclaration = PluginAccountCollectionContributionV1Schema.parse(
        rawChannelStateCollectionDeclaration,
    );
    // The executable migration half now comes from the same `definePlugin`
    // owner as the declaration above, not from a second map beside the
    // Collection definitions.
    const channelStateMigrations = normalizePluginAccountCollectionMigrationRuntimeProjection(
        manifestNamespace.collectionMigrations,
        parsedManifest.manifest.contributes.accountCollections,
    )[channelStateCollectionDeclaration.id];
    if (!channelStateMigrations) {
        throw new Error('Expected the current Channels Collection migration callbacks.');
    }
    const channelStateCollection = {
        ...channelStateCollectionDeclaration,
        migrations: channelStateMigrations,
    } satisfies PluginAccountCollectionDefinition;
    return Object.freeze({
        channelStateCollectionDeclaration,
        channelStateCollection,
        // These are dynamically loaded current-source test boundaries; validate
        // their exported symbols before narrowing them to the exercised contract.
        createCurrentConnectionFixture: createCurrentConnectionFixture as (input: unknown) => unknown,
        ingest: ingest as CurrentChannelsSources['ingest'],
    });
}

function createCurrentConnection(
    createFixture: CurrentChannelsSources['createCurrentConnectionFixture'],
): Readonly<Record<string, JsonValue>> {
    return jsonRecord(createFixture({
        connectionId: 'connection-1',
        authority: {
            providerPluginId: 'happier.channel.telegram',
            providerContributionSelection: {
                contributionId: 'telegram-test-provider',
                immutableGenerationId: 'telegram-test-generation',
            },
            providerSetupInput: { source: 'channels-c3-physical' },
            credentialRef: {
                service: { pluginId: 'happier.channel.telegram', localId: 'telegram-bot' },
                accountId: 'telegram-account-1',
            },
            transportOrigin: {
                serverIdentityId: 'srv_account_one',
                materializationRef: {
                    machineId: 'machine-1',
                    materializationId: 'telegram-install-1',
                    pluginId: 'happier.channel.telegram',
                },
            },
            providerConnectionKey: 'telegram-bot:12345',
            providerConfig: { botUsername: 'happier_bot' },
            routingIdentityKey: 'r'.repeat(43),
            integrationPrincipal: { id: 'telegram:bot:12345', label: 'Happier' },
            authorityEpoch: 4,
        },
        transport: { kind: 'checkpointedPull' },
        overlapSafety: 'providerExclusive',
        replayContinuity: 'checkpointed',
        outboundTextLimit: { maximum: 4_096, unit: 'utf8Bytes' },
    }));
}

function createCurrentBinding(bindingId: string): Readonly<Record<string, JsonValue>> {
    return {
        id: bindingId,
        'record-kind': 'binding',
        v: 1,
        'connection-id': 'connection-1',
        'binding-id': bindingId,
        'created-at': 1,
        'updated-at': 1,
        payload: {
            endpoint: { kind: 'direct', audience: 'direct', id: 'telegram:chat:100' },
            target: {
                kind: 'session',
                sessionId: 'session-1',
                policy: {
                    deliveryMode: 'repliesOnly',
                    permissionCeiling: 'read-only',
                    approvals: { kind: 'off' },
                    newSession: { kind: 'off' },
                },
            },
            allowedPrincipalIds: ['telegram:user:42'],
            allowBotSenders: false,
            inputMode: 'directMentionsOnly',
            inboundDebounceMs: 0,
            linkPreviewPolicy: 'suppress',
            senderFeedback: 'off',
            authorityEpoch: 7,
            enabled: true,
            deletionState: 'none',
        },
    };
}

function createIngress(now: number): ConversationProviderObservationIngestInputV1 {
    return {
        connectionId: 'connection-1',
        observation: {
            kind: 'fullText',
            observation: {
                v: 1,
                occurrenceId: 'telegram:update:channels-c3-physical',
                occurredAt: now,
                transport: { kind: 'poll' },
                endpoint: { kind: 'direct', audience: 'direct', id: 'telegram:chat:100' },
                actor: {
                    principalId: 'telegram:user:999',
                    label: 'Ada',
                    kind: 'human',
                    isIntegrationSelf: false,
                },
                message: {
                    id: 'telegram:message:channels-c3-physical',
                    revision: 'channels-c3-physical:1',
                    text: 'x'.repeat(64 * 1024),
                    addressingEvidence: 'none',
                    contentProvenance: 'original',
                    providerTimestamp: now,
                },
            },
        },
    };
}

function currentRevision(row: PluginCollectionRowV1 | undefined): number | null {
    return row?.revision ?? null;
}

function matchesExpectedRevision(
    row: PluginCollectionRowV1 | undefined,
    expectedRevision: number | 'absent',
): boolean {
    return expectedRevision === 'absent'
        ? row === undefined
        : row?.revision === expectedRevision;
}

function createHttpCollectionBoundary() {
    const rows = new Map<string, PluginCollectionRowV1>();
    const capturedMutationRequests: PluginCollectionMutationRequestV1[] = [];
    let changeCursor = 0;

    return {
        capturedMutationRequests,
        http: {
            async get(url: string) {
                if (!url.endsWith('/v1/account/encryption')) {
                    throw new Error(`Unexpected Account Data GET ${url}`);
                }
                return { status: 200, data: { mode: 'e2ee' as const, updatedAt: 1 } };
            },
            async post(url: string, body: unknown) {
                if (url.endsWith(PLUGIN_COLLECTION_GET_HTTP_PATH_V1)) {
                    const request = PluginCollectionGetRequestV1Schema.parse(body);
                    return { status: 200, data: { row: rows.get(request.rowId) ?? null } };
                }
                if (url.endsWith(PLUGIN_COLLECTION_QUERY_HTTP_PATH_V1)) {
                    const request = PluginCollectionQueryRequestV1Schema.parse(body);
                    if (request.indexId !== 'by-kind') {
                        throw new Error(`Unexpected Channel Collection query index ${request.indexId}`);
                    }
                    const recordKind = request.prefix[0];
                    const matched = [...rows.values()]
                        .filter((row) => row.projection['record-kind'] === recordKind)
                        .sort((left, right) => left.rowId.localeCompare(right.rowId));
                    const offset = request.cursor === undefined ? 0 : Number.parseInt(request.cursor, 10);
                    if (!Number.isSafeInteger(offset) || offset < 0) {
                        throw new Error('Invalid test Collection cursor.');
                    }
                    const page = matched.slice(offset, offset + request.limit);
                    const nextOffset = offset + page.length;
                    return {
                        status: 200,
                        data: {
                            rows: page,
                            ...(nextOffset < matched.length ? { nextCursor: String(nextOffset) } : {}),
                            changeCursor,
                        },
                    };
                }
                if (!url.endsWith(PLUGIN_COLLECTION_MUTATION_HTTP_PATH_V1)) {
                    throw new Error(`Unexpected Account Data POST ${url}`);
                }
                const request = PluginCollectionMutationRequestV1Schema.parse(body);
                capturedMutationRequests.push(request);
                const nextRows = new Map(rows);
                const results: Array<Readonly<{ rowId: string; revision: number; deleted: boolean }>> = [];
                for (const operation of request.operations) {
                    const existing = nextRows.get(operation.rowId);
                    if (!matchesExpectedRevision(existing, operation.expectedRevision)) {
                        return {
                            status: 200,
                            data: {
                                status: 'conflict' as const,
                                conflicts: [{
                                    rowId: operation.rowId,
                                    revision: currentRevision(existing),
                                    deleted: false,
                                }],
                            },
                        };
                    }
                    if (operation.kind === 'assert') continue;
                    if (operation.kind === 'delete') {
                        nextRows.delete(operation.rowId);
                        results.push({
                            rowId: operation.rowId,
                            revision: (existing?.revision ?? 0) + 1,
                            deleted: true,
                        });
                        continue;
                    }
                    const row: PluginCollectionRowV1 = {
                        rowId: operation.rowId,
                        revision: (existing?.revision ?? 0) + 1,
                        content: operation.content,
                        projection: operation.projection,
                    };
                    nextRows.set(row.rowId, row);
                    results.push({ rowId: row.rowId, revision: row.revision, deleted: false });
                }
                rows.clear();
                for (const [rowId, row] of nextRows) rows.set(rowId, row);
                changeCursor += 1;
                return {
                    status: 200,
                    data: { status: 'updated' as const, results, changeCursor },
                };
            },
        },
    };
}

async function readEveryRowOfKind(input: Readonly<{
    collection: ReturnType<ReturnType<typeof createAccountPluginDataStorageHost>['bind']> extends infer TBound
        ? TBound extends { collection: (definition: infer TDefinition) => infer TCollection }
            ? TCollection
            : never
        : never;
    recordKind: string;
}>): Promise<readonly Readonly<{ rowId: string; revision: number; value: JsonValue }>[] > {
    const rows: Array<Readonly<{ rowId: string; revision: number; value: JsonValue }>> = [];
    let cursor: string | undefined;
    do {
        const page = await input.collection.query({
            index: 'by-kind',
            prefix: [input.recordKind],
            order: 'asc',
            limit: 200,
            ...(cursor === undefined ? {} : { cursor }),
        });
        rows.push(...page.rows);
        cursor = page.nextCursor;
    } while (cursor !== undefined);
    return rows;
}

describe('Channels C3 physical E2EE ingress batches', () => {
    it('fills every sealed 256-binding, 64 KiB ingress batch to the deployment operation bound', async () => {
        const channels = await loadCurrentChannelsSources();
        const boundary = createHttpCollectionBoundary();
        const admittedContract = normalizePluginAccountCollectionContractV1({
            pluginId: CHANNELS_PLUGIN_ID,
            contribution: channels.channelStateCollectionDeclaration,
        });
        const host = createAccountPluginDataStorageHost({
            contracts: [admittedContract],
            readCredentials: async () => E2EE_CREDENTIALS,
            isCurrentAccount: () => true,
            resolveAccountScopeKey: () => ACCOUNT_SCOPE_KEY,
            resolveBaseUrl: () => 'https://channels-c3-physical.example.test',
            resolveAccountEncryptionCurrentness: async () => e2eeCurrentness(),
            http: boundary.http,
            randomBytes: (length) => new Uint8Array(length).fill(19),
        });
        const account = host.bind({
            pluginId: CHANNELS_PLUGIN_ID,
            generation: 'channels-c3-physical',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        if (!account) throw new Error('Expected the real Account Collection host binding.');
        const collection = account.collection(channels.channelStateCollection);
        const bindingIds = Array.from(
            { length: 256 },
            (_, index) => `binding-${String(index).padStart(3, '0')}`,
        );
        const seedRows = [
            createCurrentConnection(channels.createCurrentConnectionFixture),
            ...bindingIds.map(createCurrentBinding),
        ];
        for (let offset = 0; offset < seedRows.length; offset += INGRESS_PREPARATION_OPERATION_LIMIT) {
            await collection.batch(seedRows.slice(offset, offset + INGRESS_PREPARATION_OPERATION_LIMIT).map((value) => ({
                kind: 'put' as const,
                value,
                expectedRevision: 'absent' as const,
            })));
        }
        const ingressMutationStart = boundary.capturedMutationRequests.length;
        const context = {
            plugin: { id: CHANNELS_PLUGIN_ID, version: '0.0.0' },
            contribution: {
                id: 'provider/observation-ingest-v1',
                qualifiedId: 'happier.channels/actions/provider/observation-ingest-v1',
            },
            surface: 'plugin' as const,
            caller: {
                kind: 'plugin' as const,
                pluginId: 'happier.channel.telegram',
                contribution: {
                    id: 'channel-poller',
                    qualifiedId: 'happier.channel.telegram/background/channel-poller',
                },
                materialization: {
                    machineId: 'machine-1',
                    materializationId: 'telegram-install-1',
                    pluginId: 'happier.channel.telegram',
                },
            },
            signal: new AbortController().signal,
            services: { storage: { account } } as PluginServices,
        } satisfies PluginInvocationContext;
        await channels.ingest(createIngress(Date.now()), context);

        const allRequests = boundary.capturedMutationRequests.map((request) => (
            PluginCollectionMutationRequestV1Schema.parse(request)
        ));
        const ingressRequests = allRequests.slice(ingressMutationStart);
        expect(ingressRequests.length).toBeGreaterThan(0);
        // Preparation batches carry one census fence plus as many obligation
        // puts as the deployment admits. Sizing them from the Account Data
        // owner's own measurement, instead of a private worst-case reservation,
        // is what turns eighteen preparation round trips into three.
        const preparationRequests = ingressRequests.filter((request) => (
            request.operations.length > 2
            && request.operations[0]?.kind === 'assert'
            && request.operations.slice(1).every((operation) => operation.kind === 'put')
        ));
        expect(preparationRequests.map((request) => request.operations.length))
            .toEqual([100, 100, 59]);
        const obligations = await readEveryRowOfKind({
            collection,
            recordKind: 'ingress-obligation',
        });
        expect(obligations).toHaveLength(bindingIds.length);
        expect(new Set(obligations.map((row) => row.rowId)).size).toBe(bindingIds.length);
        const persistedBindingIds = obligations.map((row) => {
            const value = jsonRecord(row.value);
            const bindingId = value['binding-id'];
            if (typeof bindingId !== 'string') throw new Error('Expected a persisted ingress binding identity.');
            expect(row.revision).toBe(1);
            expect(value.v).toBe(1);
            expect(value['record-kind']).toBe('ingress-obligation');
            expect(value['connection-id']).toBe('connection-1');
            expect(value.terminal).toBe(true);
            const payload = jsonRecord(value.payload);
            expect(jsonRecord(payload.sourceAuthority)).toMatchObject({
                connectionAuthorityEpoch: 4,
                bindingRevision: 1,
                bindingAuthorityEpoch: 7,
            });
            expect(jsonRecord(payload.lifecycle)).toMatchObject({ phase: 'terminal', dueAt: null });
            return bindingId;
        }).sort();
        expect(persistedBindingIds).toEqual(bindingIds);

        const censuses = await readEveryRowOfKind({
            collection,
            recordKind: 'ingress-census',
        });
        expect(censuses).toHaveLength(1);
        const census = jsonRecord(censuses[0]!.value);
        expect(censuses[0]!.revision).toBe(2);
        expect(census.v).toBe(1);
        expect(census['record-kind']).toBe('ingress-census');
        expect(typeof census['created-at']).toBe('number');
        expect(jsonRecord(census.payload).phase).toBe('prepared');
    });
});
