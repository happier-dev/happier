import fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
    normalizePluginAccountCollectionContractV1, PLUGIN_COLLECTION_GET_HTTP_PATH_V1, PLUGIN_COLLECTION_QUERY_HTTP_PATH_V1,
    QualifiedConnectedAccountCredentialSnapshotV4Schema, QualifiedConnectedAccountProfileV4Schema,
    sealQualifiedConnectedAccountContentEnvelope,
} from '@happier-dev/protocol';
import { projectAdmittedTargetedContributionSnapshot } from '@happier-dev/cli-common/plugins/registration';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import type { LoadedPlugin } from '@/plugins/discovery/load/installed';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { compilePluginJsonSchema } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { encodePluginCollectionLogicalValueV1 } from '@happier-dev/protocol/plugins/data/collectionLogicalCodecV1';
import { SESSION_PULL_REQUEST_RELATIONS_ACTION_ID_V1 } from '@happier-dev/channels-protocol/v1';
import { projectTriagePrepareReviewWorkspaceInputV1, TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1 } from '@happier-dev/triage-protocol/v1';

import * as nativeHttp from '@/utils/loadUndici';
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
import { PLUGIN_MANIFEST as triage, TRIAGE_PLUGIN, TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../../../../../packages/plugins/triage/src/manifest';
import { TRIAGE_PREPARE_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1 } from '../../../../../packages/plugins/triage/src/actions/entrySessionProtocol';
import { buildGithubEntryLocator } from '../../../../../packages/plugins/scm-github/src/triage/locator';
import { buildGithubPullRequestComparisonSourceV1, toTriageLocator } from '../../../../../packages/plugins/scm-github/src/triage/mapping/protocol';
import { GITHUB_FIXTURE_OWNER, GITHUB_FIXTURE_REPOSITORY, GITHUB_FIXTURE_REPOSITORY_ID,
    GITHUB_PULL_REQUEST_RESPONSE, GITHUB_REPOSITORY_RESPONSE } from '../../../../../packages/plugins/scm-github/src/triage/__fixtures__/githubResponses';
import { createPluginInvocationActionsService } from './invocation/services/actions';
import { createTargetedContributionsService } from './invocation/services/targetedContributions';
import { registerAuthoredAccountActionRelease } from './accountPluginActions.testkit';

it('reads a PR through Account Actions and reports stale saved Prepare custody through the Machine registry', { timeout: 60_000 }, async () => {
    const accountId = 'triage-detail-owner';
    const serverId = 'srv_triage-detail-home';
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
        encryption: null, credentialProvenance: 'stored_session' as const };
    const github = GITHUB_PLUGIN.manifest;
    const source = { pluginId: github.id, localId: GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1 };
    const sourceInstanceId = '00000001-1111-4111-8111-111111111111';
    const credentialRef = { service: GITHUB_CONNECTED_ACCOUNT_SERVICE, accountId: 'fixture-github-account' };
    const contribution = triage.contributes?.accountCollections?.find(({ id }) => id === CORPUS_SOURCE_INSTANCES_COLLECTION_ID);
    if (!contribution) throw new Error('Missing configured-source Collection declaration');
    const contract = normalizePluginAccountCollectionContractV1({ pluginId: triage.id, contribution });
    const token = encodeGithubTriageConfiguration(GITHUB_TRIAGE_ACCOUNT_SCOPE_V1);
    if (token === null) throw new Error('Invalid GitHub fixture configuration');
    const configured = {
        v: 1 as const, instance: { source, sourceInstanceId },
        binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, account: credentialRef },
        localInstanceKey: 'github.com',
        configuration: { v: 1 as const, token },
        locator: { v: 1 as const, displayLabel: 'Fixture GitHub' },
    };
    const encoded = encodePluginCollectionLogicalValueV1({
        contract, isValidLogicalValue: compilePluginJsonSchema(contract.schema),
        encryptionMode: 'plain', material: null, randomBytes: length => new Uint8Array(length),
        value: {
            instanceTag: 't' + '0'.repeat(42), sourceQualifiedId: `${source.pluginId}/${source.localId}`,
            lifecycle: CORPUS_SOURCE_INSTANCE_LIFECYCLE.active, configuredAtMs: 1,
            configured,
        },
    });
    if (encoded.status !== 'encoded') throw new Error(`Invalid configured-source fixture: ${encoded.reason}`);
    const row = { rowId: encoded.rowId, revision: 1, projection: encoded.projection, content: encoded.content };
    const pullRequest = { repositoryId: GITHUB_FIXTURE_REPOSITORY_ID, number: 1284 };
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
    const githubRequests: string[] = [];
    const http = await nativeHttp.loadUndici();
    const githubFetch = vi.spyOn(nativeHttp, 'loadUndici').mockResolvedValue({ ...http, async fetch(input, init) {
        const url = new URL(typeof input === 'object' && 'url' in input ? input.url : String(input));
        if (url.hostname !== 'api.github.com') return http.fetch(input, init);
        githubRequests.push(url.pathname);
        if (url.pathname === `/repositories/${pullRequest.repositoryId}`) return http.Response.json(GITHUB_REPOSITORY_RESPONSE);
        if (url.pathname === `/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/pulls/${pullRequest.number}`) {
            return http.Response.json(GITHUB_PULL_REQUEST_RESPONSE);
        }
        if (url.pathname === '/graphql') return http.Response.json({ data: { nodes: [] } });
        throw new Error(`Unexpected GitHub fixture URL ${url.pathname}`);
    } });
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
        const { entryRef } = selection;
        const githubLocator = buildGithubEntryLocator({ owner: GITHUB_FIXTURE_OWNER, name: GITHUB_FIXTURE_REPOSITORY,
            entryNumber: entryRef.entryId, webUrl: GITHUB_PULL_REQUEST_RESPONSE.html_url,
        });
        if (!githubLocator) throw new Error('Expected a routable GitHub PR fixture');
        const lastKnownLocator = toTriageLocator(githubLocator);
        const { head, base } = GITHUB_PULL_REQUEST_RESPONSE;
        const observed = { headSha: head.sha, baseSha: base.sha, nativeRevision: head.sha, observedAtMs: Date.now() };
        const comparisonSource = buildGithubPullRequestComparisonSourceV1({
            instance: configured, localRef: { kindId: entryRef.kindId, collisionScope: entryRef.collisionScope, entryId: entryRef.entryId },
            routingToken: lastKnownLocator.routingToken, revision: observed,
        });
        if (!comparisonSource) throw new Error('Expected a routable GitHub comparison fixture');
        const request = { instance: configured, entryRef, lastKnownLocator, observed, workspace: null, workflowSubject: 'pullRequest' };
        const raw = projectTriagePrepareReviewWorkspaceInputV1(request);
        const loadedPlugins = [
            { manifest: triage, packageName: '@happier-dev/plugins-triage' },
            { manifest: github, packageName: '@happier-dev/plugins-scm-github' },
            { manifest: channels, packageName: '@happier-dev/plugins-channels' },
        ].map(({ manifest, packageName }): LoadedPlugin => {
            const ingested = ingestCanonicalPluginManifest(manifest, {
                sourceProvenance: 'localSource', manifestAuthority: 'bundled_first_party', enforceEngineCompatibility: false,
            });
            if (!ingested.ok) throw new Error(ingested.diagnostics.map(({ code }) => code).join(', '));
            return { pluginId: manifest.id, pluginRootPath: packageName, manifestPath: `bundled:${manifest.id}`,
                daemonEntryPath: packageName, devDaemonEntryPath: null, manifest: ingested.manifest,
                sourceSpec: { kind: 'bundled', locator: packageName, trustPolicy: 'local_trusted', installPolicy: 'link', resolvedVersion: manifest.version },
            };
        });
        const occurrences = new Map(loadedPlugins.map(({ pluginId }) => [pluginId, createPluginRuntimeOccurrenceId(pluginId)]));
        const custody = (pluginId: string) => ({ kind: 'development' as const, registeredRootId: `/fixtures/${pluginId}` });
        const registry = createResolvedContributionRegistry({
            ...projectLoadedPluginContributes({ loadResult: { loadedPlugins, diagnosticsByPluginId: {} }, provenance: 'first_party' }),
            occurrenceIdsByPluginId: Object.fromEntries(occurrences),
        });
        const lifetime = new AbortController();
        const targetedContributions = createTargetedContributionsService({
            subscribeToCatalogChanges: () => () => {},
            async readAdmittedSnapshot({ pluginId, point }) {
                const snapshot = registry.readAdmittedTargetedContributions({ targetPluginId: pluginId, pointId: point.id, protocol: point.protocol });
                if (!snapshot) throw new Error('Expected the real targeted-contribution registry');
                return projectAdmittedTargetedContributionSnapshot(point, snapshot, custody);
            },
        }).bind({ pluginId: triage.id, signal: lifetime.signal, isCurrent: () => !lifetime.signal.aborted });
        const localId = TRIAGE_PREPARE_PULL_REQUEST_REVIEW_ACTION_LOCAL_ID_V1;
        const actions = createPluginInvocationActionsService({
            seed: { plugin: { id: triage.id, version: triage.version },
                contribution: { id: localId, qualifiedId: formatQualifiedPluginActionId({ pluginId: triage.id, localId }) },
                occurrenceId: occurrences.get(triage.id)!, sourceCustody: custody(triage.id), surface: 'ui',
                signal: lifetime.signal, isOccurrenceCurrent: () => !lifetime.signal.aborted },
            actionExecutor: {
                // Route the Machine handler's cross-realm read to the fixture's real Account executor.
                async execute(actionId, input) {
                    if (actionId !== 'action.invoke') throw new Error(`Unexpected native Action ${actionId}`);
                    return executor.execute(actionId, input, { surface: 'cli', runtimeAccountId: accountId,
                        serverId, serverIdentityId: serverId });
                },
            },
            async invokeContributedAction() { throw new Error('Stale custody must stop before the workspace Action'); },
        });
        const machine = await createPluginTestkit({ manifest: triage, module: {
            activate(api) {
                // Connect the registered Machine handler's SDK Action port to
                // the real Account executor without opening a second daemon.
                return TRIAGE_PLUGIN.activate({ ...api, actions: { register(id, handler, options) {
                    return api.actions.register(id, (input, context) => handler(input, {
                        ...context, services: { ...context.services, actions },
                    }), options);
                } } });
            },
        }, services: { targetedContributions } });
        try {
            const { id: pointId, protocol } = TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1;
            const { account: _account, ...binding } = configured.binding;
            const readsBeforePrepare = githubRequests.length;
            const stale = await machine.invokeAction(localId, {
                v: 1, request, expectedHeadSha: request.observed.headSha, sessionId: 'fixture-session',
                reviewTarget: { entryRef, lastKnownLocator, comparisonSource },
                prepareReviewWorkspaceSelection: { credentialRef, input: { ...raw, instance: { ...configured, binding } },
                    selection: { point: { pointId, protocol },
                        target: { pluginId: triage.id, sourceCustody: { kind: 'bundled_first_party',
                            packagedRuntime: { kind: 'source_declaration', packageName: '@happier-dev/plugins-triage' },
                        } },
                        contributor: { pluginId: github.id, contributionId: source.localId, sourceCustody: custody(github.id) },
                    },
                },
            }, { surface: 'ui' });
            expect(stale).toMatchObject({ status: 'unavailable', reason: 'target_source_stale' });
            expect(githubRequests.slice(readsBeforePrepare)).toContain(`/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/pulls/${pullRequest.number}`);
        } finally {
            lifetime.abort();
            await machine.dispose();
        }
        channelsUnavailable = true;
        expect(await readDetail()).toMatchObject({
            ok: true, result: { kind: 'read', linkedSessions: [], linkedSessionsAttention: true },
        });
    } finally {
        githubFetch.mockRestore();
        resetActiveAccountSettingsSnapshotForTests();
        await app.close();
        await rm(happyHomeDir, { recursive: true, force: true });
    }
});
