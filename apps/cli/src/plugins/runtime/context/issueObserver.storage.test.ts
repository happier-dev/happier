import tweetnacl from 'tweetnacl';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
    createAccountScopedCryptoMaterialSnapshotV1, normalizePluginAccountCollectionContractV1,
    PluginAccountCollectionContributionV1Schema } from '@happier-dev/protocol';
import { projectPluginAccountCollectionDeclaration } from '@happier-dev/plugin-sdk/collections';
import { TRIAGE_ISSUE_CHECKPOINT_COLLECTION_V1 } from '@happier-dev/triage-sources/runtime';
import { createHttpCollectionBoundary } from './accountPluginDataStorage.testkit';
import { describe, expect, it } from 'vitest';
import { createTriageIssueEventSourceAdapterV1, TriageIssueEventSourceConfigV1Schema } from '@happier-dev/triage-sources/runtime';
import { createPluginHttpFixture } from '@happier-dev/plugin-sdk/testing';
import type { BackgroundServiceContext, PluginCheckpointedEventSourceDefinitionV1 } from '@happier-dev/plugin-sdk/background-services';
import { createAccountPluginDataStorageHost } from './accountPluginDataStorage';
import { scanSentrySource } from '../../../../../../packages/plugins/sentry/src/source/operations';
import { encodeSentryInstanceConfiguration } from '../../../../../../packages/plugins/sentry/src/instances/sentryInstanceConfiguration';
import { SENTRY_CONNECTED_ACCOUNT_PURPOSE, SENTRY_SCOPE_SEPARATOR } from '../../../../../../packages/plugins/sentry/src/sentryContracts';
import recorded from '../../../../../../packages/plugins/sentry/src/fixtures/issuesListPage2.json' with { type: 'json' };

const PLUGIN_ID = 'happier.sentry';
const SOURCE_INSTANCE_ID = '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05';
const instance = {
    v: 1,
    instance: { source: { pluginId: PLUGIN_ID, localId: 'sentry-issues' }, sourceInstanceId: SOURCE_INSTANCE_ID },
    binding: { purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE, account: { service: { pluginId: PLUGIN_ID, localId: 'sentry-account' }, accountId: 'account-1' } },
    localInstanceKey: `https://us.sentry.io${SENTRY_SCOPE_SEPARATOR}7701`,
    configuration: { v: 1, token: encodeSentryInstanceConfiguration({ v: 1, organizationId: '7701',
        projectScope: { kind: 'allAccessible' }, environmentScope: { kind: 'all' } }) },
} as const;
const source = TriageIssueEventSourceConfigV1Schema.parse({
    v: 1, instance, checkPeriodMs: 120_000, investigation: { mode: 'inbox' },
});
const definition = {
    automationId: 'automation-1', triggerId: 'trigger-1', triggerRevision: 1,
    eventRef: { pluginId: PLUGIN_ID, localId: 'issue-transition' }, sourceInstanceId: SOURCE_INSTANCE_ID,
    sourceSelectorId: '00000000-0000-4000-8000-000000000001', sourceContractVersion: 1, sourceConfig: source,
    observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: {
        pluginId: PLUGIN_ID, machineId: 'machine-1', materializationId: 'materialization-1',
    } }, filter: null, maximumObservationAgeMs: null,
} satisfies PluginCheckpointedEventSourceDefinitionV1;


describe('issue observer through real Account storage', () => {
    it.each(['plain', 'e2ee'] as const)('settles 257 %s checkpoints with set reads, quiet repeats and one genuine transition', async mode => {
        const collectionDefinition = TRIAGE_ISSUE_CHECKPOINT_COLLECTION_V1;
        const boundary = createHttpCollectionBoundary(collectionDefinition.indexes, mode);
        const machineKey = new Uint8Array(32).fill(7);
        const publicKey = tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey;
        const snapshot = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
            material: { type: 'dataKey', machineKey }, dataKeyPublicKey: publicKey });
        const host = createAccountPluginDataStorageHost({
            contracts: [normalizePluginAccountCollectionContractV1({ pluginId: PLUGIN_ID,
                contribution: PluginAccountCollectionContributionV1Schema.parse(projectPluginAccountCollectionDeclaration(collectionDefinition.id, collectionDefinition)) })],
            readCredentials: async () => ({ token: 'storage-fixture', encryption: mode === 'plain' ? null : {
                type: 'dataKey' as const, machineKey, publicKey } }),
            isCurrentAccount: () => true,
            resolveAccountScopeKey: () => 'triage-storage-fixture',
            resolveBaseUrl: () => 'https://triage-storage.example.test',
            resolveAccountEncryptionCurrentness: async () => mode === 'plain'
                ? { mode, version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
                    recipientEnvelopeReadiness: { status: 'unavailable' as const, reason: 'plain_account' as const } }
                : { mode, version: 1, signingKeyFingerprint: null, updatedAt: 1,
                    contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(snapshot.contentPublicKeyFingerprint),
                    recipientEnvelopeReadiness: { status: 'available' as const } },
            http: boundary.http,
        });
        const signal = new AbortController().signal;
        const account = host.bind({ pluginId: PLUGIN_ID, occurrenceId: 'storage-fixture', signal, isOccurrenceCurrent: () => true });
        if (!account) throw new Error('Expected Account storage binding.');
        const nativeRows = Array.from({ length: 257 }, (_, index) => ({
            ...recorded.body[0]!, id: String(5501001 + index), shortId: 'EXAMPLE-PROJECT-' + index,
            permalink: 'https://example-org.sentry.io/issues/' + (5501001 + index) + '/', status: 'resolved',
        }));
        let configuredSourceState: 'current' | 'removed' | 'changed' = 'current';
        let sourceReads = 0;
        let scanRequests = 0;
        const notices: string[] = [];
        // Only native HTTP, the Account HTTP transport and the cross-plugin
        // configured-source/notice boundaries are supplied. The scanner, codecs,
        // crypto, CAS, query encoding and batch measurement remain production code.
        const context = { surface: 'background', signal, materialization: definition.observationTransport.watcherMaterializationRef,
            plugin: { id: PLUGIN_ID, version: '0.0.0' },
            contribution: { id: 'issue-observer', qualifiedId: PLUGIN_ID + '/backgroundServices/issue-observer' },
            services: { storage: { account },
                http: createPluginHttpFixture({ request: async input => {
                    scanRequests++;
                    const url = new URL(input.url);
                    const offset = Number(url.searchParams.get('cursor')?.split(':')[1] ?? 0);
                    const cursor = '1754000000000:' + (offset + 100) + ':0';
                    url.searchParams.set('cursor', cursor);
                    return { status: 200, finalUrl: input.url,
                        headers: { link: '<' + url.href + '>; rel="next"; results="' + (offset + 100 < nativeRows.length) + '"; cursor="' + cursor + '"' },
                        body: new TextEncoder().encode(JSON.stringify(nativeRows.slice(offset, offset + 100))) };
                } }),
                connectedAccounts: {
                    listAccounts: async () => ({ status: 'complete', accounts: [{ account: instance.binding.account,
                        state: 'connected', connectedAccountOrigins: ['https://us.sentry.io'], connectedAccountBases: ['https://us.sentry.io'] }] }),
                    materializeListedAccount: async () => ({ kind: 'httpHeaders', headers: { authorization: 'Bearer fixture-token' } }),
                },
                actions: { execute: async () => {
                    sourceReads++;
                    return { kind: 'read', status: 'complete',
                        instances: configuredSourceState === 'removed' ? [] : [{ v: 1, lifecycle: 'active',
                            configured: configuredSourceState === 'changed'
                                ? { ...instance, localInstanceKey: `${instance.localInstanceKey}-changed` } : instance }] };
                } },
                notifications: { send: async (input: { clientRequestId: string }) => {
                    notices.push(input.clientRequestId);
                    return { deliveries: [], replayed: false, notice: { artifactId: 'notice-1', opened: true, changed: true } };
                } },
            },
        } as unknown as BackgroundServiceContext;
        const adapter = createTriageIssueEventSourceAdapterV1({ pluginId: PLUGIN_ID,
            sourceLocalId: 'sentry-issues', displayName: 'Sentry', scanLimit: 100, scan: scanSentrySource });
        const input = { context, definition, definitions: [definition], source, isCurrent: async () => true };
        const baseline = await adapter.observe(input);
        expect(baseline.complete).toBe(true);
        expect(baseline.observations).toHaveLength(0);
        expect(boundary.capturedReadPaths).toHaveLength(2);
        expect(boundary.capturedMutationRequests).toHaveLength(0);
        if (!baseline.checkpoint) throw new Error('Expected resolved baseline checkpoint.');
        const sourceReadsBeforeSave = sourceReads;
        await adapter.save({ ...input, checkpoint: baseline.checkpoint });
        expect(boundary.retainedRowCount()).toBe(257);
        expect(boundary.capturedMutationRequests).toHaveLength(3);
        // One finite save admission covers the whole set. Collection CAS and
        // request admission remain authoritative for each actual batch.
        expect(sourceReads - sourceReadsBeforeSave).toBe(1);
        for (let repeat = 0; repeat < 3; repeat++) {
            boundary.capturedReadPaths.length = 0;
            const unchanged = await adapter.observe(input);
            expect(unchanged.complete).toBe(true);
            expect(unchanged.observations).toHaveLength(0);
            expect(unchanged.checkpoint).toBeUndefined();
            expect(boundary.capturedReadPaths).toHaveLength(2);
            expect(boundary.capturedMutationRequests).toHaveLength(3);
        }
        nativeRows[256] = { ...nativeRows[256]!, status: 'unresolved' };
        const changed = await adapter.observe(input);
        expect(changed.observations).toHaveLength(1);
        expect(boundary.capturedMutationRequests).toHaveLength(4);
        expect(notices).toHaveLength(0);
        if (!changed.checkpoint) throw new Error('Expected transition checkpoint.');
        const retry = await adapter.observe(input);
        expect(retry.observations).toHaveLength(1);
        expect(retry.observations[0]).toMatchObject({ occurrenceId: changed.observations[0]!.occurrenceId,
            occurredAt: changed.observations[0]!.occurredAt, observedDelta: 0 });
        expect(boundary.capturedMutationRequests).toHaveLength(4);
        for (const unavailableSource of ['removed', 'changed'] as const) {
            configuredSourceState = unavailableSource;
            const scansBeforeNextCycle = scanRequests;
            const readsBeforeNextCycle = boundary.capturedReadPaths.length;
            expect(await adapter.observe(input)).toMatchObject({ observations: [], complete: false, nextEligibleAt: null });
            await adapter.save({ ...input, checkpoint: changed.checkpoint });
            expect(scanRequests).toBe(scansBeforeNextCycle);
            expect(boundary.capturedReadPaths).toHaveLength(readsBeforeNextCycle);
            expect(notices).toHaveLength(0);
            expect(boundary.capturedMutationRequests).toHaveLength(4);
        }
        configuredSourceState = 'current';
        await adapter.save({ ...input, checkpoint: changed.checkpoint });
        expect(notices).toEqual([changed.observations[0]!.occurrenceId]);
        expect(boundary.capturedMutationRequests).toHaveLength(5);
        expect((await adapter.observe(input)).observations).toHaveLength(0);
        expect(boundary.capturedMutationRequests).toHaveLength(5);
        // Reusing a stale revision cannot advance the effective cursor.
        const collection = account.collection(collectionDefinition);
        const row = (await collection.query({ index: 'by-source', prefix: [SOURCE_INSTANCE_ID], order: 'asc', limit: 1 })).rows[0]!;
        expect(await collection.batch([{ kind: 'put', value: row.value, expectedRevision: 'absent' }]))
            .toMatchObject({ status: 'conflict' });
    });
});
