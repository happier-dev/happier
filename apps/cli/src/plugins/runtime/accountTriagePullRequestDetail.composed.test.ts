import fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
    normalizePluginAccountCollectionContractV1, PLUGIN_COLLECTION_GET_HTTP_PATH_V1, PLUGIN_COLLECTION_QUERY_HTTP_PATH_V1,
    QualifiedConnectedAccountCredentialSnapshotV4Schema, QualifiedConnectedAccountProfileV4Schema,
    sealQualifiedConnectedAccountContentEnvelope,
} from '@happier-dev/protocol';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { encodePluginCollectionLogicalValueV1 } from '@happier-dev/protocol/plugins/data/collectionLogicalCodecV1';
import { SESSION_PULL_REQUEST_RELATIONS_ACTION_ID_V1 } from '@happier-dev/channels-protocol/v1';
import { TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1 } from '@happier-dev/triage-protocol/v1';

import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { registerAccountHomeHttp } from '@/session/actions/widgetApproval.testkit';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import { PLUGIN_MANIFEST as channels } from '../../../../../packages/plugins/channels/src/manifest';
import { CHANNEL_STATE_COLLECTION_ID } from '../../../../../packages/plugins/channels/src/collections';
import { GITHUB_PLUGIN } from '../../../../../packages/plugins/scm-github/src/manifest';
import { GITHUB_CONNECTED_ACCOUNT_PURPOSE, GITHUB_CONNECTED_ACCOUNT_SERVICE } from '../../../../../packages/plugins/scm-github/src/observations/githubProviderContracts';
import { GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1 } from '../../../../../packages/plugins/scm-github/src/triage/contribution';
import { encodeGithubTriageConfiguration, GITHUB_TRIAGE_ACCOUNT_SCOPE_V1 } from '../../../../../packages/plugins/scm-github/src/triage/configuration';
import { TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1 } from '../../../../../packages/plugins/triage/src/actions/entryDetailProtocol';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE, CORPUS_SOURCE_INSTANCES_COLLECTION_ID } from '../../../../../packages/plugins/triage/src/corpus/collections/ids';
import { PLUGIN_MANIFEST as triage } from '../../../../../packages/plugins/triage/src/manifest';
import { registerAuthoredAccountActionRelease } from './accountPluginActions.testkit';

it('opens a PR with no linked Sessions through the loaded Triage, GitHub and Channels Account Actions', { timeout: 60_000 }, async () => {
    const accountId = 'triage-detail-owner';
    const serverId = 'triage-detail-home';
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
        encryption: null, credentialProvenance: 'stored_session' as const };
    const github = GITHUB_PLUGIN.manifest;
    const source = { pluginId: github.id, localId: GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1 };
    const sourceInstanceId = '00000001-1111-4111-8111-111111111111';
    const credentialRef = { service: GITHUB_CONNECTED_ACCOUNT_SERVICE, accountId: 'fixture-github-account' };
    const contribution = triage.contributes?.accountCollections?.find(({ id }) => id === CORPUS_SOURCE_INSTANCES_COLLECTION_ID);
    if (!contribution) throw new Error('Missing configured-source Collection declaration');
    const contract = normalizePluginAccountCollectionContractV1({ pluginId: triage.id, contribution });
    const encoded = encodePluginCollectionLogicalValueV1({
        contract, isValidLogicalValue: compilePluginJsonSchema(contract.schema),
        encryptionMode: 'plain', material: null, randomBytes: length => new Uint8Array(length),
        value: {
            instanceTag: 't' + '0'.repeat(42), sourceQualifiedId: `${source.pluginId}/${source.localId}`,
            lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1,
            configured: {
                v: 1, instance: { source, sourceInstanceId },
                binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, account: credentialRef },
                localInstanceKey: 'github.com',
                configuration: { v: 1, token: encodeGithubTriageConfiguration(GITHUB_TRIAGE_ACCOUNT_SCOPE_V1) },
                locator: { v: 1, displayLabel: 'Fixture GitHub' },
            },
        },
    });
    if (encoded.status !== 'encoded') throw new Error(`Invalid configured-source fixture: ${encoded.reason}`);
    const row = { rowId: encoded.rowId, revision: 1, projection: encoded.projection, content: encoded.content };
    const pullRequest = { repositoryId: '1234', number: 54 };
    const artifact = (manifest: typeof triage | typeof channels | typeof github, dir: string, artifactId: string) => {
        const projectRoot = resolve(import.meta.dirname, '../../../../../packages/plugins', dir);
        return { manifest, projectRoot, entryPath: resolve(projectRoot, 'src/accountRuntime.ts'),
            artifactId, activateExport: 'activate', manifestExport: null };
    };

    const app = fastify();
    const homeFeatures = registerAccountHomeHttp(app, { accountId, serverId });
    const features = {
        features: { ...homeFeatures.features, connectedServices: { enabled: true } },
        capabilities: { ...homeFeatures.capabilities, connectedServices: { qualifiedAccounts: { protocolVersion: 4 } } },
    };
    app.get('/v1/features', async () => features);
    app.get('/v1/features/authenticated', async () => features);
    const service = credentialRef.service;
    const descriptor = normalizePluginManifestV2(github).contributes.connectedAccountDescriptors.find(({ id }) => id === service.localId);
    if (!descriptor) throw new Error('Missing GitHub Connected Account declaration');
    const credentialVersion = {
        ref: credentialRef, authenticationModeId: descriptor.authentication.defaultModeId,
        revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationRevision: null,
    } as const;
    const account = QualifiedConnectedAccountProfileV4Schema.parse({ ...credentialVersion, status: 'connected',
        configurationReady: true, kind: 'token', expiresAt: null, displayName: 'Fixture GitHub', scopes: [] });
    app.get('/v1/account/entity-rows/connected-accounts/purposes', async () => ({
        status: 'present', revision: 1, content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [] } } },
    }));
    app.get('/v4/connect/qualified/accounts', async () => ({ service, accounts: [account] }));
    app.get('/v4/connect/qualified/credential', async () => QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
        ...credentialVersion, metadata: { scopes: [] }, content: sealQualifiedConnectedAccountContentEnvelope({
            kind: 'credential', accountMode: 'plain', payload: { v: 1, values: { token: 'fixture-github' } },
            randomBytes: length => new Uint8Array(length),
        }),
    }));
    let channelsReads = 0;
    let channelsUnavailable = false;
    app.post(PLUGIN_COLLECTION_GET_HTTP_PATH_V1, async () => ({ row: null, absenceEpoch: 0 }));
    app.post<{ Body: { collectionId: string } }>(PLUGIN_COLLECTION_QUERY_HTTP_PATH_V1, async (request, reply) => {
        if (request.body.collectionId === CHANNEL_STATE_COLLECTION_ID) {
            channelsReads++;
            if (channelsUnavailable) return reply.code(503).send({ error: 'plugin_collection_unavailable' });
        }
        return { rows: request.body.collectionId === CORPUS_SOURCE_INSTANCES_COLLECTION_ID ? [row] : [], changeCursor: 1 };
    });
    const happyHomeDir = await mkdtemp(resolve(tmpdir(), 'happier-triage-detail-'));
    try {
        await registerAuthoredAccountActionRelease(app, accountId, {
            primary: artifact(triage, 'triage', 'triage-account-runtime'),
            additional: [
                artifact(github, 'scm-github', 'github-account-runtime'),
                artifact(channels, 'channels', 'channels-account-runtime'),
            ],
        });
        const origin = await app.listen({ host: '127.0.0.1', port: 0 });
        const executor = createCliActionExecutorFromCredentials({
            credentials, happyHomeDir, serverId, serverIdentityId: serverId, serverApiUrl: origin,
        });
        const invoke = (pluginId: string, localId: string, input: unknown) =>
            executor.execute('action.invoke', { action: { pluginId, localId }, input },
                { surface: 'cli', runtimeAccountId: accountId, serverId, serverIdentityId: serverId });
        const direct = await invoke(channels.id, SESSION_PULL_REQUEST_RELATIONS_ACTION_ID_V1, {
            kind: 'readRelations', credentialRef, pullRequest,
        });
        expect(direct).toMatchObject({ ok: true, result: { kind: 'relations', links: [] } });
        const readsBeforeDetail = channelsReads;
        const selection = {
            v: 1, sourceInstanceId,
            entryRef: { source, kindId: 'pull-request', collisionScope: `github:${pullRequest.repositoryId}`, entryId: String(pullRequest.number) },
        };
        const readDetail = () => invoke(triage.id, TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1, selection);
        const detail = await readDetail();
        expect(detail).toMatchObject({ ok: true, result: { kind: 'read', linkedSessions: [] } });
        if (channelsReads === readsBeforeDetail) {
            const relation = await invoke(triage.id, TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1, selection);
            expect(relation, JSON.stringify(relation)).toMatchObject({ ok: true, result: { kind: 'complete', links: [] } });
        }
        if (detail.ok) expect(detail.result).not.toHaveProperty('linkedSessionsAttention');
        expect(channelsReads).toBeGreaterThan(readsBeforeDetail);
        channelsUnavailable = true;
        expect(await readDetail()).toMatchObject({
            ok: true, result: { kind: 'read', linkedSessions: [], linkedSessionsAttention: true },
        });
    } finally {
        resetActiveAccountSettingsSnapshotForTests();
        await app.close();
        await rm(happyHomeDir, { recursive: true, force: true });
    }
});
