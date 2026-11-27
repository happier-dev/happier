import { readIndexedBundledDeclarationManifest } from '../../projection/registry/builtIn/declarationAssetFormat.mjs';
import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import {
    convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
    createAccountScopedCryptoMaterialSnapshotV1,
    PLUGIN_COLLECTION_LIMITS_V1,
    PluginAccountCollectionContributionV1Schema,
    PluginCollectionMutationRequestV1Schema,
    measurePluginCollectionMutationRequestEncodedBytesV1,
    normalizePluginAccountCollectionContractV1,
} from '@happier-dev/protocol';
import {
    type JsonValue,
    type PluginInvocationContext,
    type PluginServices,
} from '@happier-dev/plugin-sdk';
import type { PluginAccountCollectionDefinition } from '@happier-dev/plugin-sdk/collections';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import type { ConversationProviderObservationIngestInputV1 } from '@happier-dev/channels-protocol/v1';

import type { StoredCredentials } from '@/persistence';

import { createAccountPluginDataStorageHost } from './accountPluginDataStorage';
import { createHttpCollectionBoundary } from './accountPluginDataStorage.testkit';

const CHANNELS_PLUGIN_ID = 'happier.channels';
const CHANNEL_STATE_COLLECTION_ID = 'channel-state';
const CONNECTION_AUTHORITY_EPOCH = 4;
/** The shipped deployment policy every unpublished-capability client assumes. */
const INGRESS_PREPARATION_BATCH_LIMIT_BYTES = 16 * 1024 * 1024;
const INGRESS_PREPARATION_OPERATION_LIMIT = 100;
const ACCOUNT_SCOPE_KEY = 'channels-c3-physical-account';
const TELEGRAM_EXECUTION_ORIGIN = {
    serverIdentityId: 'srv_account_one',
    materializationRef: { machineId: 'machine-1', materializationId: 'telegram-install-1', pluginId: 'happier.channel.telegram' },
} as const;
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
        recipientEnvelopeReadiness: { status: 'available' as const },
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
    poll: (input: Readonly<{ connectionId: string; waitMs: number }>, context: PluginInvocationContext) => Promise<unknown>;
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
    const [collectionNamespace, ingressNamespace, fixtureNamespace] = await Promise.all([
        import(/* @vite-ignore */ new URL(`${sourceRoot}collections.ts`, import.meta.url).href),
        import(/* @vite-ignore */ new URL(`${sourceRoot}ingress.ts`, import.meta.url).href),
        import(/* @vite-ignore */ new URL(`${sourceRoot}testkit/currentConnectionFixture.ts`, import.meta.url).href),
    ]);
    if (
        !isRecord(collectionNamespace)
        || !isRecord(ingressNamespace)
        || !isRecord(fixtureNamespace)
    ) {
        throw new Error('Expected the current Channels source modules.');
    }
    const createCurrentConnectionFixture = fixtureNamespace.createCurrentConversationConnectionFixture;
    const ingest = ingressNamespace.ingestConversationProviderObservationForInvocation;
    const poll = ingressNamespace.runConversationCheckpointedPollForInvocation;
    if (typeof createCurrentConnectionFixture !== 'function' || typeof ingest !== 'function'
        || typeof poll !== 'function') {
        throw new Error('Expected the current Channels ingress fixtures and handler.');
    }
    // Source daemon admission reads the published catalog declaration, while
    // the plugin binds its executable definition. Reconstructing both from one
    // source manifest hides declaration drift and plugin_collection_undeclared.
    const parsedManifest = parsePluginManifest(readIndexedBundledDeclarationManifest(new URL(
        '../../../../assets/bundled-plugin-manifests/channels.json', import.meta.url,
    )));
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
    const definition = collectionNamespace.CHANNEL_STATE_COLLECTION;
    if (!isRecord(definition) || definition.id !== CHANNEL_STATE_COLLECTION_ID || !isRecord(definition.schema)) {
        throw new Error('Expected the current executable Channels Collection definition.');
    }
    const channelStateCollection = definition as PluginAccountCollectionDefinition;
    return Object.freeze({
        channelStateCollectionDeclaration,
        channelStateCollection,
        // These are dynamically loaded current-source test boundaries; validate
        // their exported symbols before narrowing them to the exercised contract.
        createCurrentConnectionFixture: createCurrentConnectionFixture as (input: unknown) => unknown,
        ingest: ingest as CurrentChannelsSources['ingest'],
        poll: poll as CurrentChannelsSources['poll'],
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
            },
            providerSetupInput: { source: 'channels-c3-physical' },
            credentialRef: {
                service: { pluginId: 'happier.channel.telegram', localId: 'telegram-bot' },
                accountId: 'telegram-account-1',
            },
            transportOrigin: TELEGRAM_EXECUTION_ORIGIN,
            providerConnectionKey: 'telegram-bot:12345',
            providerConfig: { botUsername: 'happier_bot' },
            routingIdentityKey: 'r'.repeat(43),
            integrationPrincipal: { id: 'telegram:bot:12345', label: 'Happier' },
            authorityEpoch: CONNECTION_AUTHORITY_EPOCH,
        },
        transport: { kind: 'socket' },
        overlapSafety: 'safe',
        replayContinuity: 'none',
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
        authorityEpoch: CONNECTION_AUTHORITY_EPOCH,
        entry: {
            observation: {
                kind: 'fullText',
                observation: {
                    v: 1,
                    occurrenceId: 'telegram:update:channels-c3-physical',
                    occurredAt: now,
                    transport: { kind: 'socket' },
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
            eventCandidate: null,
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
    it.each(['plain', 'e2ee'] as const)('stores checkpoints beyond 48 KiB through the %s Collection owner and preserves its actual size failure', async mode => {
        const channels = await loadCurrentChannelsSources();
        const boundary = createHttpCollectionBoundary(channels.channelStateCollection.indexes, mode);
        const host = createAccountPluginDataStorageHost({
            contracts: [normalizePluginAccountCollectionContractV1({
                pluginId: CHANNELS_PLUGIN_ID, contribution: channels.channelStateCollectionDeclaration,
            })],
            readCredentials: async () => mode === 'plain' ? { token: 'channels-checkpoint-plain', encryption: null } : E2EE_CREDENTIALS,
            isCurrentAccount: () => true,
            resolveAccountScopeKey: () => ACCOUNT_SCOPE_KEY,
            resolveBaseUrl: () => 'https://channels-c3-physical.example.test',
            resolveAccountEncryptionCurrentness: async () => mode === 'plain' ? {
                mode, version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
                recipientEnvelopeReadiness: { status: 'unavailable' as const, reason: 'plain_account' as const },
            } : e2eeCurrentness(),
            http: boundary.http,
            randomBytes: length => new Uint8Array(length).fill(19),
        });
        const signal = new AbortController().signal;
        const account = host.bind({ pluginId: CHANNELS_PLUGIN_ID, occurrenceId: 'empty-poll',
            signal, isOccurrenceCurrent: () => true });
        if (!account) throw new Error('Expected real Account Collection host binding.');
        const collection = account.collection(channels.channelStateCollection);
        const fixture = createCurrentConnection(channels.createCurrentConnectionFixture);
        await collection.put({ ...fixture, payload: { ...jsonRecord(fixture.payload),
            transport: { kind: 'checkpointedPull' }, replayContinuity: 'checkpointed',
        } }, { expectedRevision: 'absent' });
        const operation = { identity: { role: 'observationsPoll' } };
        let checkpointAfterBatch = { uidValidity: '12345', lastUid: 12, nativeRevisions: 'x'.repeat(48 * 1024) };
        // Only the host's admitted contribution and provider Action boundaries
        // are supplied here; ingress, schema admission, crypto and storage stay real.
        const services = {
            storage: { account },
            actions: {
                getCurrentExecutionRouting: async () => ({ serverIdentityId: 'srv_account_one',
                    machineId: 'machine-1', pluginId: CHANNELS_PLUGIN_ID }),
                executeAdmittedTargetedOperationWithExecutionOrigin: async () => ({
                    result: { kind: 'checkpointOnly', checkpointAfterBatch },
                    executionOrigin: TELEGRAM_EXECUTION_ORIGIN,
                }),
            },
            targetedContributions: { observeForSelf: () => ({ dispose() {}, readCurrent: async () => ({
                occurrenceId: 'empty-poll', sourceCustody: { kind: 'development', registeredRootId: 'empty-poll' },
                contributions: [{ contributor: { pluginId: 'happier.channel.telegram',
                    contributionId: 'telegram-test-provider', immutableGenerationId: 'test-generation' },
                    protocol: { id: 'happier.channels/providers', version: 1 }, operations: { observationsPoll: operation } }],
            }) }) },
        } as unknown as PluginServices;
        const context: PluginInvocationContext = { plugin: { id: CHANNELS_PLUGIN_ID, version: '0.0.0' },
            contribution: { id: 'ingress-supervisor', qualifiedId: 'happier.channels/backgroundServices/ingress-supervisor' },
            surface: 'plugin', invokedAtMs: 1, signal, services };
        await expect(channels.poll({ connectionId: 'connection-1', waitMs: 0 }, context))
            .resolves.toMatchObject({ kind: 'committed' });
        const checkpoint = await readEveryRowOfKind({ collection, recordKind: 'checkpoint' });
        expect(checkpoint).toHaveLength(1);
        expect(jsonRecord(jsonRecord(checkpoint[0]!.value).payload).opaqueToken).toEqual(checkpointAfterBatch);
        const writes = boundary.capturedMutationRequests.length;
        for (let index = 0; index < 3; index += 1) {
            await expect(channels.poll({ connectionId: 'connection-1', waitMs: 0 }, context))
                .resolves.toMatchObject({ kind: 'committed' });
        }
        expect(boundary.capturedMutationRequests).toHaveLength(writes);
        expect(await readEveryRowOfKind({ collection, recordKind: 'checkpoint' })).toEqual(checkpoint);
        // A token this large cannot fit inside the actual private envelope in
        // either Account mode. The Collection codec owns framing and refusal.
        checkpointAfterBatch = { ...checkpointAfterBatch,
            nativeRevisions: 'x'.repeat(PLUGIN_COLLECTION_LIMITS_V1.maximumPrivateEnvelopeEncodedBytes) };
        const overflowCheckpoint = { ...jsonRecord(checkpoint[0]!.value),
            payload: { ...jsonRecord(jsonRecord(checkpoint[0]!.value).payload), opaqueToken: checkpointAfterBatch } };
        await expect(collection.put(overflowCheckpoint, { expectedRevision: checkpoint[0]!.revision }))
            .rejects.toMatchObject({ code: 'collection_quota_incompatible',
                details: { dimension: 'maxRowEncodedBytes', effectiveMaximum: PLUGIN_COLLECTION_LIMITS_V1.maximumPrivateEnvelopeEncodedBytes } });
        await expect(channels.poll({ connectionId: 'connection-1', waitMs: 0 }, context))
            .resolves.toMatchObject({ kind: 'blocked' });
        const failedConnection = await collection.get('connection-1');
        expect(jsonRecord(failedConnection!.value).payload).toMatchObject({ pollFailure: {
            phase: 'blocked', evidence: { kind: 'action', code: 'collection_quota_incompatible' },
        } });
        expect(boundary.capturedMutationRequests).toHaveLength(writes + 1);
        expect(await readEveryRowOfKind({ collection, recordKind: 'checkpoint' })).toEqual(checkpoint);
    });

    it.each(['fullText', 'routableNonAdmission'] as const)('retains %s ingress through the strict E2EE Collection host without unnecessary reads', async (kind) => {
        const channels = await loadCurrentChannelsSources();
        const boundary = createHttpCollectionBoundary(channels.channelStateCollection.indexes);
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
            occurrenceId: 'channels-c3-physical',
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
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
                occurrenceId: 'telegram-occurrence-1',
                sourceCustody: {
                    kind: 'managed' as const,
                    immutableGenerationId: 'telegram-generation-1',
                    installSource: 'localPath' as const,
                },
                materialization: {
                    machineId: 'machine-1',
                    materializationId: 'telegram-install-1',
                    pluginId: 'happier.channel.telegram',
                },
                executionOrigin: TELEGRAM_EXECUTION_ORIGIN,
            },
            invokedAtMs: 1,
            signal: new AbortController().signal,
            services: {
                storage: { account },
                // Notification delivery is a separate host boundary from Data custody.
                notifications: { send: async () => ({ deliveries: [], replayed: false }) },
            } as PluginServices,
        } satisfies PluginInvocationContext;
        const now = Date.now();
        const ingress = createIngress(now);
        if (ingress.entry.observation.kind !== 'fullText') throw new Error('Expected the full-text ingress fixture.');
        const { text: _text, ...message } = ingress.entry.observation.observation.message;
        await channels.ingest(kind === 'fullText' ? ingress : {
            ...ingress,
            entry: { ...ingress.entry, observation: { kind: 'routableNonAdmission', reason: 'messageTooLarge',
                shell: { ...ingress.entry.observation.observation, message } } },
        }, context);

        const allRequests = boundary.capturedMutationRequests.map((request) => (
            PluginCollectionMutationRequestV1Schema.parse(request)
        ));
        const ingressRequests = allRequests.slice(ingressMutationStart);
        expect(ingressRequests.length).toBeGreaterThan(0);
        // The Account Data owner measures self-contained obligation writes.
        // Fanout fills each deployment-sized batch without a census fence.
        const preparationRequests = ingressRequests.filter((request) => (
            request.operations.length > 2
            && request.operations.every((operation) => operation.kind === 'put' && jsonRecord(operation.projection)['record-kind'] === 'ingress-obligation')
        ));
        expect(preparationRequests.map((request) => request.operations.length))
            .toEqual([100, 100, 56]);
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
            expect(value.v).toBe(1);
            expect(value['record-kind']).toBe('ingress-obligation');
            expect(value['connection-id']).toBe('connection-1');
            expect(value.terminal).toBe(true);
            const payload = jsonRecord(value.payload);
            expect(jsonRecord(payload.sourceAuthority)).toMatchObject({
                connectionAuthorityEpoch: 4,
                ...(kind === 'fullText' ? { bindingAuthorityEpoch: 7 } : {}),
            });
            expect(jsonRecord(payload.lifecycle)).toMatchObject({ phase: 'terminal', dueAt: null });
            expect(payload.normalizedIngress).toBeNull();
            expect(payload.eventCandidate ?? null).toBeNull();
            expect(payload).not.toHaveProperty('censusId');
            expect(jsonRecord(payload.observationShell)).toMatchObject({ occurrenceId: ingress.entry.observation.kind === 'fullText' ? ingress.entry.observation.observation.occurrenceId : '' });
            return bindingId;
        }).sort();
        expect(persistedBindingIds).toEqual(bindingIds);

        const censuses = await readEveryRowOfKind({
            collection,
            recordKind: 'ingress-census',
        });
        expect(censuses).toEqual([]);

        // The real host schema rejects a query projection's null due-at sentinel
        // before it reaches the HTTP mutation boundary.
        const member = obligations[0]!;
        const beforeInvalidWrite = boundary.capturedMutationRequests.length;
        await expect(collection.batch([{
            kind: 'put',
            value: { ...jsonRecord(member.value), 'due-at': null },
            expectedRevision: member.revision,
        }])).rejects.toMatchObject({ code: 'plugin_collection_invalid_value' });
        expect(boundary.capturedMutationRequests).toHaveLength(beforeInvalidWrite);


    });
});
