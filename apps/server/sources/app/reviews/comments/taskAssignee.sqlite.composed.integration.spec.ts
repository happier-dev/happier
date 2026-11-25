import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import tweetnacl from 'tweetnacl';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, createActionExecutor, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import type { PluginAccountApi } from '@happier-dev/plugin-sdk';
import { ReviewCommentV1Schema } from '@happier-dev/protocol/reviews/comments/v1';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { projectAdmittedTargetedContributionSnapshot } from '@happier-dev/cli-common/plugins/registration';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { PLUGIN_MANIFEST as TRIAGE_MANIFEST, TRIAGE_PLUGIN } from '@happier-dev/plugins-triage/manifest';
import { createConfiguredTaskSourceStorage } from '@happier-dev/plugins-triage/testkit';
import { GITHUB_PLUGIN } from '@happier-dev/plugins-scm-github';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createAccountTokenForTests, createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { createTrustedMachineInstallation } from '@/testkit/pluginInstallationPublisherTestkit';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { registerAccountEncryptionRoutes } from '@/app/api/routes/account/registerAccountEncryptionRoutes';
import { setArtifactAccessGrantInTx } from '@/app/artifacts/artifactAccessService';
import { registerReviewCommentRoutes } from './routes';
import { createAccountServerActionDeps } from '../../../../../cli/src/api/accountServerActionDeps';
import { createCliReviewCommentActionExecutorFromCredentials } from '../../../../../cli/src/agent/reviews/comments/executor';
import { runWithServerHttpBaseUrl } from '../../../../../cli/src/api/client/serverHttpBaseUrl';
import { createResolvedContributionRegistry } from '../../../../../cli/src/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '../../../../../cli/src/plugins/projection/registry/fullProjection';
import { ingestCanonicalPluginManifest } from '../../../../../cli/src/plugins/manifest/ingest';
import type { LoadedPlugin } from '../../../../../cli/src/plugins/discovery/load/installed';
import type { PluginRuntimeOccurrenceId } from '../../../../../cli/src/plugins/runtime/runtimeSlots';
import { createTargetedContributionsService } from '../../../../../cli/src/plugins/runtime/invocation/services/targetedContributions';
import { createPluginInvocationActionsService } from '../../../../../cli/src/plugins/runtime/invocation/services/actions';
import { createPluginActionCallerMaterializationFixture } from '../../../../../cli/src/plugins/runtime/invocation/services/actionCaller.testkit';
import { GITHUB_CONNECTED_ACCOUNT_PURPOSE, GITHUB_PLUGIN_ID } from '../../../../../../packages/plugins/scm-github/src/observations/githubProviderContracts';
import { GITHUB_ISSUE_RESPONSE, GITHUB_REPOSITORY_RESPONSE } from '../../../../../../packages/plugins/scm-github/src/triage/__fixtures__/githubResponses';
import { encodeGithubTriageConfiguration } from '../../../../../../packages/plugins/scm-github/src/triage/configuration';
import { createStubGithubTransport, GITHUB_TEST_ACCOUNT, readRecordedJsonBody } from '../../../../../../packages/plugins/scm-github/src/triage/testkit/githubTriage.test-support';
import { CORPUS_USER_MARKS_COLLECTION } from '../../../../../../packages/plugins/triage/src/corpus/collections/definitions';

function loadedPlugin(manifest: unknown, packageName: string): LoadedPlugin {
    const ingested = ingestCanonicalPluginManifest(manifest, {
        sourceProvenance: 'localSource', manifestAuthority: 'bundled_first_party', enforceEngineCompatibility: false,
    });
    if (!ingested.ok) throw new Error(ingested.diagnostics.map(item => item.code).join(', '));
    return {
        pluginId: ingested.manifest.id, pluginRootPath: packageName, manifestPath: `bundled:${ingested.manifest.id}`,
        daemonEntryPath: packageName, devDaemonEntryPath: null, manifest: ingested.manifest,
        sourceSpec: { kind: 'bundled', locator: packageName, trustPolicy: 'local_trusted', installPolicy: 'link', resolvedVersion: ingested.manifest.version },
    };
}

let harness: LightSqliteHarness;
beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-review-task-assignee-', initAuth: true, initEncrypt: true }); }, 120_000);
afterAll(async () => { await harness?.close(); });

it('assigns a task without disclosing its private Review to an assignee who has no grant', async () => {
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
    const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
    const machineId = randomUUID(), installationId = randomUUID();
    const keyPair = tweetnacl.sign.keyPair();
    await createTrustedMachineInstallation({ accountId: owner.id, machineId, installationId, keyPair });
    await makeShareEligibleForTest(owner.id, [reader.id]);
    const reviewId = randomUUID();
    await db.artifact.create({ data: { id: reviewId, accountId: owner.id, kind: 'v1:other:review.v1',
        header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'review.v1' })),
        body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: '' })),
        dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) } });
    await db.reviewMetadata.create({ data: { artifactId: reviewId, subjectKind: 'comparison', sourceKind: 'direct',
        state: 'completed', currentRoundOrdinal: 1, startedAt: new Date(1), finishedAt: new Date(2) } });
    expect(await inTx(tx => setArtifactAccessGrantInTx(tx, { actorAccountId: owner.id, artifactId: reviewId,
        principal: { kind: 'account', accountId: reader.id }, accessLevel: 'view' }))).toMatchObject({ ok: true });
    const tokens = await Promise.all([owner, reader, outsider].map(account => createAccountTokenForTests(account.id,
        { kind: 'account', authority: 'present_user' })));
    await withAuthenticatedTestApp(app => {
        registerReviewCommentRoutes(app);
        artifactsRoutes(app);
        registerAccountEncryptionRoutes(app);
    }, async app => {
        const origin = await app.listen({ host: '127.0.0.1', port: 0 });
        const lifetime = new AbortController();
        const route = 'octo-org/example-app';
        const issue = { ...GITHUB_ISSUE_RESPONSE, title: 'Address selected finding', body: '',
            repository_url: `https://api.github.com/repos/${route}`, assignees: [{ login: reader.id }, { login: outsider.id }], labels: [] };
        // Only the external forge HTTP and credential boundary is replaced; its
        // registered task Action, request serializer and observation remain real.
        const transport = createStubGithubTransport({ respond(request) {
            if (new URL(request.url).pathname === `/repos/${route}`) return { status: 200, body: GITHUB_REPOSITORY_RESPONSE };
            if (new URL(request.url).pathname === `/repos/${route}/issues/${GITHUB_ISSUE_RESPONSE.number}`) return { status: 200, body: issue };
            if (request.method === 'POST' && new URL(request.url).pathname === `/repos/${route}/issues`) {
                return { status: 201, body: issue };
            }
            return undefined;
        } });
        const provider = await createPluginTestkit({ manifest: GITHUB_PLUGIN.manifest, module: GITHUB_PLUGIN,
            services: { http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts } });
        try {
            const configured = createTriageSourceV1Fixture().configuredInstance;
            const source = { pluginId: GITHUB_PLUGIN_ID, localId: 'github-forge' };
            const instance = { ...configured, instance: { ...configured.instance, source },
                binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, account: GITHUB_TEST_ACCOUNT },
                configuration: { v: 1 as const, token: encodeGithubTriageConfiguration({ v: 1, scope: { kind: 'repository', repositoryKey: route } })! } };
            const storage = createConfiguredTaskSourceStorage(instance);
            const loadedPlugins = [loadedPlugin(TRIAGE_MANIFEST, '@happier-dev/plugins-triage'), loadedPlugin(GITHUB_PLUGIN.manifest, '@happier-dev/plugins-scm-github')];
            const occurrence = (pluginId: string) => `${pluginId}-task-assignee` as PluginRuntimeOccurrenceId;
            const custody = (pluginId: string) => ({ kind: 'development' as const, registeredRootId: `test:${pluginId}` });
            const registry = createResolvedContributionRegistry({
                ...projectLoadedPluginContributes({ loadResult: { loadedPlugins, diagnosticsByPluginId: {} }, provenance: 'first_party' }),
                occurrenceIdsByPluginId: Object.fromEntries(loadedPlugins.map(plugin => [plugin.pluginId, occurrence(plugin.pluginId)])),
            });
            const targetedContributions = createTargetedContributionsService({ subscribeToCatalogChanges: () => () => {},
                async readAdmittedSnapshot(params) {
                    const snapshot = registry.readAdmittedTargetedContributions({ targetPluginId: params.pluginId, pointId: params.point.id, protocol: params.point.protocol });
                    if (!snapshot) throw new Error('Expected the admitted GitHub source');
                    return projectAdmittedTargetedContributionSnapshot(params.point, snapshot, custody);
                },
            }).bind({ pluginId: TRIAGE_MANIFEST.id, signal: lifetime.signal, isCurrent: () => !lifetime.signal.aborted });
            const executor = (token: string) => {
                const comments = createCliReviewCommentActionExecutorFromCredentials({ credentials: { token, encryption: null },
                    resolvePrincipalSigningContext: async () => ({ machineId, installationId,
                        privateKeyBase64Url: Buffer.from(keyPair.secretKey).toString('base64url') }) });
                return createActionExecutor({ ...createAccountServerActionDeps({ token, serverId: origin, serverHttpBaseUrl: origin }),
                    reviewCommentAction: ({ actionId, input, reviewCommentPrincipal, signal }) => runWithServerHttpBaseUrl(origin,
                        () => comments(actionId, input, { principal: reviewCommentPrincipal, signal })),
                });
            };
            const ownerExecutor = executor(tokens[0]!);
            const caller = createPluginActionCallerMaterializationFixture(TRIAGE_MANIFEST.id);
            const actions = createPluginInvocationActionsService({
                seed: { plugin: { id: TRIAGE_MANIFEST.id, version: TRIAGE_MANIFEST.version },
                    contribution: { id: 'tasks/create-v1', qualifiedId: `${TRIAGE_MANIFEST.id}/actions/tasks/create-v1` },
                    occurrenceId: occurrence(TRIAGE_MANIFEST.id), sourceCustody: custody(TRIAGE_MANIFEST.id), surface: 'ui',
                    resolveCurrentPluginMaterializationRef: caller.resolveCurrentPluginMaterializationRef,
                    signal: lifetime.signal, isOccurrenceCurrent: () => !lifetime.signal.aborted },
                actionExecutor: ownerExecutor,
                async invokeContributedAction(request) {
                    if (request.input === undefined) throw new Error('Task operations require input');
                    await request.beforeHandlerInvocation?.();
                    return { status: 'executed', value: await provider.invokeAction(request.action.localId, request.input, { surface: request.surface, signal: request.signal }) };
                },
            });
            const aggregate = await createPluginTestkit({ manifest: TRIAGE_MANIFEST, module: { ...TRIAGE_PLUGIN,
                activateAccount(api: PluginAccountApi) {
                    TRIAGE_PLUGIN.activateAccount({ ...api, actions: { register(id, handler, options) {
                        api.actions.register(id, (input, context) => handler(input, { ...context,
                            services: { ...context.services, actions } }), options);
                    } } });
                },
            }, services: { storage, targetedContributions, actions } });
            try {
                const body = 'Private finding: do not disclose this to the task assignee';
                const created = await app.inject({ method: 'POST', url: '/v1/reviews/comments',
                    headers: { authorization: `Bearer ${tokens[0]}` }, payload: { reviewId,
                        anchor: { kind: 'file', filePath: 'private.ts' }, snapshot: { kind: 'none', capturedAt: 1 },
                        body, authorIntent: 'open', clientMutationId: randomUUID() } });
                expect(created.statusCode, created.body).toBe(200);
                const findingId = ReviewCommentV1Schema.parse(created.json().comment).id;
                const originReview = { reviewId, findingIds: [findingId] };
                const task = await aggregate.invokeAction('tasks/create-v1', { v: 1, source,
                    sourceInstanceId: instance.instance.sourceInstanceId, kindId: 'issue',
                    fields: { title: 'Address selected finding', assigneeIds: [reader.id, outsider.id] }, originReview,
                }, { surface: 'ui' });
                expect(task, JSON.stringify(task)).toMatchObject({ kind: 'createdAndLinkAttempted', reviewLink: 'linked', creation: { kind: 'applied' } });
                const writes = transport.requests.filter(request => request.method !== 'GET').map(readRecordedJsonBody);
                expect(writes).toEqual([{ title: 'Address selected finding', assignees: [reader.id, outsider.id] }]);
                const entryRef = { source, kindId: 'issue', collisionScope: `github:${GITHUB_REPOSITORY_RESPONSE.id}`, entryId: String(GITHUB_ISSUE_RESPONSE.number) };
                expect(await aggregate.invokeAction('tasks/read-origin-review-v1', { v: 1, entryRef }, { surface: 'ui' })).toEqual({ v: 1, originReview });
                const marks = await storage.account.collection(CORPUS_USER_MARKS_COLLECTION).query({ index: 'by-pinned', order: 'asc' });
                expect(marks.rows).toHaveLength(1);
                expect(JSON.stringify({ writes, marks })).not.toContain(body);
                expect(JSON.stringify({ writes, marks })).not.toContain('private.ts');
                const input = { reviewId, commentIds: [findingId], allPages: true as const, includeHistory: true };
                for (const token of tokens.slice(0, 2)) {
                    expect(await executor(token).execute('reviews.comments.list', input, { surface: 'ui' }))
                        .toMatchObject({ ok: true, result: { items: [{ id: findingId, body }] } });
                }
                const httpRefused = await app.inject({ method: 'GET', url: `/v1/reviews/comments/${findingId}`,
                    headers: { authorization: `Bearer ${tokens[2]}` } });
                expect(httpRefused.statusCode).toBe(404);
                expect(httpRefused.json()).toMatchObject({ error: 'review_comment_not_found' });
                expect(httpRefused.json()).not.toHaveProperty('comment');
                expect(httpRefused.body).not.toContain(body);
                expect(httpRefused.body).not.toContain('private.ts');
                const refused = await executor(tokens[2]!).execute('reviews.comments.list', input, { surface: 'ui' });
                // The native resource reader stops before the comments route when this
                // Account cannot open the Artifact. Its typed cause survives projection.
                expect(refused, JSON.stringify(refused)).toMatchObject({ ok: false, errorCode: 'review_comment_encryption_material_unavailable',
                    failureCause: { errorCode: 'review_comment_encryption_material_unavailable' } });
                expect(JSON.stringify(refused)).not.toContain(body);
            } finally {
                lifetime.abort();
                await aggregate.dispose();
            }
        } finally {
            await provider.dispose();
        }
    }, { authentication: 'real' });
});
