import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { buildReviewCommentPublicationEntryV1, ReviewCommentCreateResponseV1Schema, ReviewCommentListResponseV1Schema,
    ReviewCommentTransitionResponseV1Schema, type ReviewCommentPublicationPlanV1 } from '@happier-dev/protocol/reviews/comments/actions';
import { buildReviewTriageTransitionRequestV1 } from '@happier-dev/protocol/reviews/comments/triageTransition';
import { buildReviewCommentPublicationTransportRequestV1, openReviewCommentPublicationTransportResponseV1 } from '@happier-dev/protocol/reviews/comments/publicationTransport';
import { createAuthenticatedTestApp, withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { db } from '@/storage/db';
import { createAccountTokenForTests } from '@/testkit/lightSqliteHarness';
import { createDatabaseIntegrationHarness } from '@/testkit/databaseIntegrationHarness';
import { registerReviewCommentRoutes } from './routes';
import { publishGithubIssueComment } from '../../../../../../packages/plugins/scm-github/src/triage/mutations/issue';
import { createStubGithubTransport, createTestGithubApiClient, readRecordedJsonBody } from '../../../../../../packages/plugins/scm-github/src/triage/testkit/githubTriage.test-support';
import { GITHUB_FIXTURE_OWNER, GITHUB_FIXTURE_OTHER_REPOSITORY, GITHUB_FIXTURE_OTHER_REPOSITORY_ID, GITHUB_ISSUE_RESPONSE, GITHUB_OTHER_REPOSITORY_RESPONSE } from '../../../../../../packages/plugins/scm-github/src/triage/__fixtures__/githubResponses';

import { buildReviewCommentTextSnapshotHashes } from '@happier-dev/protocol/reviews/comments/snapshots';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { ACCOUNT_SECURITY_PATH_V1, AccountSecurityGetResponseV1Schema } from '@happier-dev/protocol/auth/accountSecurity';
import { inTx } from '@/storage/inTx';
import { setArtifactAccessGrantInTx } from '@/app/artifacts/artifactAccessService';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { sessionRoutes } from '@/app/api/routes/session/sessionRoutes';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { updateMachineRegistration } from '../../../../../cli/src/daemon/machineIdentity/machineRegistrationStore';
import { readOrCreateInstallationIdentity } from '../../../../../cli/src/daemon/identity/store';
import { withConfiguredDaemonTestHome } from '../../../../../cli/src/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createCliActionExecutorFromCredentials } from '../../../../../cli/src/session/actions/createCliActionExecutorFromCredentials';
import { createCliApprovalsArtifactStore } from '../../../../../cli/src/session/actions/approvals/artifactStore';
import { buildSessionMetadataEnvelopeFields } from '../../../../../cli/src/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { createCliReviewCommentActionExecutorFromCredentials } from '../../../../../cli/src/agent/reviews/comments/executor';
import { registerAccountHomeHttp } from '../../../../../cli/src/session/actions/widgetApproval.testkit';
import { createActionSettingsProvider } from '../../../../../cli/src/settings/actionsSettingsProvider';
import { resetInMemoryAccountSettingsContextForTests } from '../../../../../cli/src/settings/accountSettings/bootstrapAccountSettingsContext';
import { installAxiosFastifyAdapter } from '../../../../../cli/src/testkit/http/axiosAdapter';
import { createRequesterCurrentnessSocketHarness } from '../../../../../cli/src/testkit/backends/requesterCurrentnessSocketHarness';
import { createTargetActionInvocationRegistry } from '../../../../../cli/src/plugins/runtime/invocation/targetActionRegistry';
import { createCommittedContributedActionInvoker, createCommittedContributedActionSchemaReader, listRuntimeContributedActionDefinitions } from '../../../../../cli/src/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { createCredentialedTargetActionCurrentIntent } from '../../../../../cli/src/session/actions/approvals/credentialedTargetActionCurrentIntent';
import { createDaemonExternalActionContributedApprovalReplay } from '../../../../../cli/src/daemon/externalActions/createDaemonExternalActionContributedInvoker';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '../../../../../cli/src/daemon/externalActions/daemonExternalActionTargetResolver';
import { runWithServerHttpBaseUrl } from '../../../../../cli/src/api/client/serverHttpBaseUrl';
import { createResolvedContributionRegistry } from '../../../../../cli/src/plugins/projection/registry/createResolvedContributionRegistry';
import { createAuthoredAdmittedPluginRuntimeFixture } from '../../../../../cli/src/plugins/testkit/admittedRuntime';
import { loadInstalledPlugins } from '../../../../../cli/src/plugins/discovery/load/installed';
import { projectLoadedPluginRegistry } from '../../../../../cli/src/plugins/projection/registry/loadedProjection';
import { buildPluginContributionRegistry } from '../../../../../cli/src/plugins/projection/registry/normalize/package';
import { normalizePluginManifestV2 } from '../../../../../cli/src/plugins/manifest/normalize';
import { createTargetActionHostBindingResolver } from '../../../../../cli/src/plugins/runtime/hostAccess/resolve';
import { resolveManifestHostAccessRequests } from '../../../../../cli/src/plugins/runtime/hostAccess/manifestRequests';
import { createPluginInvocationServiceBinding } from '../../../../../cli/src/plugins/runtime/invocation/services/factory';
import { createPluginInvocationActionsService } from '../../../../../cli/src/plugins/runtime/invocation/services/actions';
import { publishGithubPullRequestReviewAction } from '../../../../../../packages/plugins/scm-github/src/triage/mutationOperations';
import { CONFIGURED_ACCOUNT, OBSERVED_BASE, OBSERVED_HEAD, PULL_REQUEST_PATH, PULL_REQUEST_REF, REPOSITORY_KEY, configuredInstance, pullRequestBody } from '../../../../../../packages/plugins/scm-github/src/triage/testkit/githubMutation.test-support';
import { GITHUB_PLUGIN, PLUGIN_MANIFEST as GITHUB_MANIFEST } from '../../../../../../packages/plugins/scm-github/src/manifest';
import { PLUGIN_MANIFEST as CHANNELS_MANIFEST } from '../../../../../../packages/plugins/channels/src/manifest';
import { PLUGIN_MANIFEST as TRIAGE_MANIFEST } from '../../../../../../packages/plugins/triage/src/manifest';
import { GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1 } from '../../../../../../packages/plugins/scm-github/src/triage/contribution';
import { GITHUB_PLUGIN_ID } from '../../../../../../packages/plugins/scm-github/src/observations/githubProviderContracts';

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetInMemoryAccountSettingsContextForTests();
});

describe('GitHub publication through registered Reviews routes and the SQL claim owner', () => {
    let harness: Awaited<ReturnType<typeof createDatabaseIntegrationHarness>>;
    beforeAll(async () => {
        const options = { tempDirPrefix: 'happier-github-publication-concurrency-', initAuth: true, initEncrypt: true, sqliteConnectionLimit: 2 };
        harness = await createDatabaseIntegrationHarness(options);
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it('admits one writer before a marker exists and preserves distinct same-body comments after provider answer loss', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const reviewId = randomUUID();
        await db.artifact.create({ data: {
            id: reviewId, accountId: account.id, kind: 'v1:other:review.v1',
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'review.v1' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({})),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
        } });
        await db.reviewMetadata.create({ data: { artifactId: reviewId, subjectKind: 'comparison', sourceKind: 'direct',
            state: 'completed', currentRoundOrdinal: 1, startedAt: new Date(1), finishedAt: new Date(2) } });
        const headers = { authorization: `Bearer ${await createAccountTokenForTests(account.id, { kind: 'account', authority: 'present_user' })}` };
        const context = { accountId: account.id, mode: 'plain' as const, material: null };
        const route = { owner: GITHUB_FIXTURE_OWNER, name: GITHUB_FIXTURE_OTHER_REPOSITORY };
        const localRef = { kindId: 'issue' as const, collisionScope: `github:${GITHUB_FIXTURE_OTHER_REPOSITORY_ID}`, entryId: '7' };
        const issuePath = `/repos/${route.owner}/${route.name}/issues/7`;
        const comments: Array<{ id: number; body: string }> = [];
        let holdNextWrite = false;
        let enterHeldWrite!: () => void;
        const heldWriteEntered = new Promise<void>(resolve => { enterHeldWrite = resolve; });
        let releaseHeldWrite!: () => void;
        const heldWriteReleased = new Promise<void>(resolve => { releaseHeldWrite = resolve; });
        const transport = createStubGithubTransport({ respond: async request => {
            const path = new URL(request.url).pathname;
            if (request.method === 'GET' && path === issuePath) return { status: 200, body: GITHUB_ISSUE_RESPONSE };
            if (request.method === 'GET' && path === `/repos/${route.owner}/${route.name}`) return { status: 200, body: GITHUB_OTHER_REPOSITORY_RESPONSE };
            if (request.method === 'GET' && path === `${issuePath}/comments`) return { status: 200, body: [...comments] };
            if (request.method === 'POST' && path === `${issuePath}/comments`) {
                const payload = readRecordedJsonBody(request);
                if (typeof payload !== 'object' || payload === null || !('body' in payload) || typeof payload.body !== 'string') {
                    throw new Error('Expected a GitHub issue comment request');
                }
                const loseAnswer = holdNextWrite;
                holdNextWrite = false;
                if (loseAnswer) {
                    enterHeldWrite();
                    await heldWriteReleased;
                }
                const comment = { id: 5579420454 + comments.length, body: payload.body };
                comments.push(comment);
                // The real external HTTP boundary loses its answer after GitHub stores the effect.
                if (loseAnswer) throw Object.assign(new Error('Provider answer lost'), { code: 'ECONNRESET' });
                return { status: 201, body: comment };
            }
            return undefined;
        } });
        const client = await createTestGithubApiClient(transport);
        await withAuthenticatedTestApp(registerReviewCommentRoutes, async app => {
            const createComment = async () => {
                const response = await app.inject({ method: 'POST', url: '/v1/reviews/comments', headers, payload: {
                    reviewId, anchor: { kind: 'file', filePath: 'a.ts' }, snapshot: { kind: 'none', capturedAt: 1 },
                    body: 'The same finding at the same anchor.', authorIntent: 'open', clientMutationId: randomUUID(),
                } });
                expect(response.statusCode, response.body).toBe(200);
                return ReviewCommentCreateResponseV1Schema.parse(response.json()).comment;
            };
            const [commentA, commentB] = await Promise.all([createComment(), createComment()]);
            expect(commentA.id).not.toBe(commentB.id);
            const makePlan = (comment: typeof commentA): ReviewCommentPublicationPlanV1 => ({
                target: { providerId: 'github', configuredAccountId: 'account-under-test', subtarget: null,
                    entryRef: { sourceId: 'happier.scm.forge.github/github-forge', ...localRef } },
                baseRevision: null, headRevision: null, verdict: null,
                entries: [{ happierCommentId: comment.id, expectedServerRevision: comment.serverRevision,
                    anchor: comment.anchor, snapshot: comment.snapshot, body: comment.body }],
            });
            const claim = async (input: Parameters<typeof buildReviewCommentPublicationTransportRequestV1>[0]['input']) => {
                const response = await app.inject({ method: 'POST', url: '/v1/reviews/comments/publication/claim', headers,
                    payload: buildReviewCommentPublicationTransportRequestV1({ input, context, randomBytes }) });
                expect(response.statusCode, response.body).toBe(200);
                return openReviewCommentPublicationTransportResponseV1({ plan: input, context, response: response.json() });
            };
            const dispositions: string[] = [];
            const publish = (plan: ReviewCommentPublicationPlanV1) => publishGithubIssueComment({
                localRef, route, publicationPlan: plan,
                claimPublicationDispatch: async () => {
                    const result = await claim(plan);
                    dispositions.push(result.disposition);
                    return result;
                },
                settlePublicationDispatch: async (dispatch, result) => {
                    await claim({ ...plan, settlement: { dispatchToken: dispatch.dispatchToken, result } });
                },
            }, { client, now: () => 1234, signal: transport.context.signal });
            const planA = makePlan(commentA);
            const planB = makePlan(commentB);
            const published = (commentId: string, externalRef: string) => ({ kind: 'settled', publication: {
                entries: [{ happierCommentId: commentId, outcome: { kind: 'published', externalRef } }],
            } });
            const providerWrites = () => transport.requests.filter(request => request.method === 'POST');

            // Control uses the same routes, SQL owner and real provider adapter before the fault.
            expect(await publish(planB)).toMatchObject(published(commentB.id, '5579420454'));
            expect(providerWrites()).toHaveLength(1);
            holdNextWrite = true;
            const first = publish(planA);
            // Both registered HTTP claims start before either caller reaches the
            // provider write, exercising PostgreSQL's competing insert/lock path.
            const competing = publish(planA);
            try {
                await Promise.race([heldWriteEntered, Promise.all([first, competing]).then(result => {
                    throw new Error(`Publication settled before reaching the held provider write: ${JSON.stringify(result)}`);
                })]);
                expect(comments).toHaveLength(1);
                expect(await Promise.race([first, competing])).toMatchObject({ kind: 'settled', publication: {
                    entries: [{ happierCommentId: commentA.id, outcome: { kind: 'uncertain' } }],
                } });
                expect(providerWrites()).toHaveLength(2);
            } finally {
                releaseHeldWrite();
            }
            const completed = await Promise.all([first, competing]);
            expect(completed.find(result => result.kind === 'settled'
                && result.publication.entries[0]?.outcome.kind === 'published'))
                .toMatchObject(published(commentA.id, '5579420455'));
            expect(await publish(planA)).toMatchObject(published(commentA.id, '5579420455'));
            expect(dispositions).toEqual(['dispatch', 'dispatch', 'reconcile', 'reconcile']);
            expect(providerWrites()).toHaveLength(2);
            expect(comments).toHaveLength(2);
            expect(comments[0]!.body).not.toBe(comments[1]!.body);
            expect(comments.every(comment => comment.body.startsWith('The same finding at the same anchor.\n\n'))).toBe(true);
            const correlations = await db.reviewCommentPublicationCorrelation.findMany({ where: { accountId: account.id },
                select: { commentId: true, publicationCorrelationId: true } });
            expect(correlations.map(value => value.commentId).sort()).toEqual([commentA.id, commentB.id].sort());
            expect(new Set(correlations.map(value => value.publicationCorrelationId)).size).toBe(2);
        }, { authentication: 'real' });
    });

    it('requires Edit and real Action consent before publishing only the selected findings through the selected forge account', async () =>
        withConfiguredDaemonTestHome({ prefix: 'review-publication-authority-', env: {
            HAPPIER_ACCOUNT_SETTINGS_MODE: 'auto', HAPPIER_ACTIONS_SETTINGS_V1: undefined,
        } }, async () => {
            const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
            const recipient = await db.account.create({ data: { id: '5e3a0581-6f3d-4e73-bf40-383db0be6c3e', encryptionMode: 'plain' } });
            await makeShareEligibleForTest(owner.id, [recipient.id]);
            const reviewId = randomUUID();
            await db.artifact.create({ data: { id: reviewId, accountId: owner.id, kind: 'v1:other:review.v1',
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'review.v1' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: '' })),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) } });
            await db.reviewMetadata.create({ data: { artifactId: reviewId, subjectKind: 'comparison', sourceKind: 'direct',
                state: 'completed', currentRoundOrdinal: 1, startedAt: new Date(1), finishedAt: new Date(2) } });
            const grant = async (accessLevel: 'view' | 'edit') => {
                expect(await inTx(tx => setArtifactAccessGrantInTx(tx, { actorAccountId: owner.id, artifactId: reviewId,
                    principal: { kind: 'account', accountId: recipient.id }, accessLevel }))).toMatchObject({ ok: true });
            };
            await grant('edit');
            // CLI filesystem identity and socket transport are isolated system boundaries.
            const identity = await readOrCreateInstallationIdentity();
            const machine = await db.machine.create({ data: { id: randomUUID(), accountId: recipient.id,
                metadata: encodePlainMachineStoredContent({ host: 'publication-fixture', platform: 'linux', happyCliVersion: 'test' }),
                metadataVersion: 1, daemonStateVersion: 0, installationId: identity.installationId,
                installationPublicKey: privacyKit.decodeBase64(identity.publicKey, 'base64url'),
                dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
            await updateMachineRegistration(() => ({ machineId: machine.id }));
            const credentials = { token: await createAccountTokenForTests(recipient.id, { kind: 'account', authority: 'present_user' }),
                encryption: null, credentialProvenance: 'stored_session' as const };
            const sessionId = 'cmwygn62d039i1bmc2l8o2h8u';
            const sessionMetadata = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain',
                storedContentMode: 'plain', agentState: null, metadata: {
                    machineId: machine.id, path: '/publication-fixture', permissionMode: 'default',
                } });
            await db.session.create({ data: { id: sessionId, accountId: recipient.id, tag: randomUUID(),
                encryptionMode: 'plain', metadata: sessionMetadata.sharedMetadata.ciphertext,
                ownerMetadata: JSON.stringify(sessionMetadata.ownerMetadata), metadataLayoutVersion: 1, active: true } });
            const ownerHeaders = { authorization: `Bearer ${await createAccountTokenForTests(owner.id, { kind: 'account', authority: 'present_user' })}` };
            const app = createAuthenticatedTestApp({ authentication: 'real' });
            const socket = await createRequesterCurrentnessSocketHarness();
            const base = 'https://publication-home.example.invalid';
            const settings = accountSettingsParse({ actionsSettingsV1: { v: 1,
                approvalWaivedSurfaces: { 'action.invoke': ['agent'] } } });
            const features = registerAccountHomeHttp(app, { accountId: recipient.id, serverId: 'srv_publication', settings,
                actionHttpBodyAlreadyEnabled: true });
            artifactsRoutes(app);
            sessionRoutes(app);
            registerReviewCommentRoutes(app);
            app.get(ACCOUNT_SECURITY_PATH_V1, async () => AccountSecurityGetResponseV1Schema.parse({ v: 1,
                encryptionMode: 'plain', nativeEmail: null, password: { status: 'not_enrolled', revision: null } }));
            const claimStatuses: number[] = [];
            const claimResponses: unknown[] = [];
            app.addHook('onSend', (request, _reply, payload, done) => {
                if (request.url === '/v1/reviews/comments/publication/claim' && typeof payload === 'string') {
                    claimResponses.push(JSON.parse(payload));
                }
                done(null, payload);
            });
            app.addHook('onResponse', (request, reply, done) => {
                if (request.url === '/v1/reviews/comments/publication/claim') claimStatuses.push(reply.statusCode);
                done();
            });
            const restoreHttp = installAxiosFastifyAdapter({ app, origin: base });
            vi.stubGlobal('fetch', async (url: string | URL | Request) => {
                const path = new URL(String(url)).pathname;
                if (path !== '/v1/features' && path !== '/v1/features/authenticated') throw new Error(`Unexpected fetch ${path}`);
                return Response.json(features);
            });
            const controllers: AbortController[] = [];
            const registries: ReturnType<typeof createTargetActionInvocationRegistry>[] = [];
            const admittedFixtures: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>>[] = [];
            try {
                const pullRequestUrl = pullRequestBody().html_url;
                if (typeof pullRequestUrl !== 'string') throw new Error('Missing canonical pull-request fixture URL');
                const createFinding = async (body: string, filePath: string) => {
                    const response = await app.inject({ method: 'POST', url: '/v1/reviews/comments', headers: ownerHeaders, payload: {
                        reviewId, anchor: { kind: 'line', filePath, line: 7 }, body,
                        snapshot: { kind: 'text', selectedLines: ['unsafe();'], beforeContext: [], afterContext: [],
                            ...buildReviewCommentTextSnapshotHashes({ selectedLines: ['unsafe();'], beforeContext: [], afterContext: [] }),
                            capturedAt: 1, fileLength: 10,
                            source: 'diffSide', isUncommitted: false, isUntracked: false, truncated: false,
                            hasBidiControls: false, likelyMinified: false,
                            diffContext: { side: 'after', baseSha: OBSERVED_BASE, headSha: OBSERVED_HEAD } },
                        authorIntent: 'propose', linkedRefs: [{ kind: 'pullRequest', url: pullRequestUrl }], clientMutationId: randomUUID(),
                    } });
                    expect(response.statusCode, response.body).toBe(200);
                    return ReviewCommentCreateResponseV1Schema.parse(response.json()).comment;
                };
                const selected = await createFinding('Selected finding: check the caller before dispatch.', 'selected.ts');
                const excluded = await createFinding('Unselected private finding must stay in Happier.', 'unselected.ts');
                const ignored = await createFinding('Ignored finding must never enter this publication.', 'ignored.ts');
                const commentAction = createCliReviewCommentActionExecutorFromCredentials({ credentials });
                const ignoredTransition = ReviewCommentTransitionResponseV1Schema.parse(await runWithServerHttpBaseUrl(base,
                    () => commentAction('reviews.comments.transition', buildReviewTriageTransitionRequestV1({ comment: ignored,
                        decision: 'reject', clientMutationId: randomUUID() }))));
                expect(ignoredTransition.comment).toMatchObject({ id: ignored.id, state: 'dismissed', reviewTriageStatus: 'reject' });
                // This is the exact candidate query owned by useReviewCommentProposalsForEntry.
                // Home applies the state selection; the publication caller does not filter human decisions.
                const candidates = ReviewCommentListResponseV1Schema.parse(await runWithServerHttpBaseUrl(base,
                    () => commentAction('reviews.comments.list', { reviewId, states: ['proposed'], taxonomyIds: [],
                        includeHistory: false, limit: 200 })));
                expect(candidates.items.map(comment => comment.id).sort()).toEqual([selected.id, excluded.id].sort());
                expect(candidates.items.every(comment => comment.linkedRefs?.some(ref => ref.kind === 'pullRequest'
                    && ref.url === pullRequestUrl))).toBe(true);
                const selectedIds = [selected.id];
                const entries = candidates.items.filter(comment => selectedIds.includes(comment.id)).map(comment => {
                    if (typeof comment.body !== 'string' || !comment.snapshot) throw new Error('Missing publishable candidate content');
                    return buildReviewCommentPublicationEntryV1({ ...comment, body: comment.body, snapshot: comment.snapshot });
                });
                const plan: ReviewCommentPublicationPlanV1 = {
                    target: { providerId: 'github', configuredAccountId: CONFIGURED_ACCOUNT.accountId, subtarget: null,
                        entryRef: { sourceId: `${GITHUB_PLUGIN_ID}/github-forge`, ...PULL_REQUEST_REF } },
                    baseRevision: OBSERVED_BASE, headRevision: OBSERVED_HEAD,
                    entries,
                    verdict: { kind: 'comment', body: 'Publish the selected finding.' },
                };
                const manifest = normalizePluginManifestV2(GITHUB_MANIFEST);
                const localId = GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestSubmitReview;
                const declaration = manifest.contributes.actions?.find(action => action.id === localId);
                if (!declaration) throw new Error('Missing canonical GitHub publication declaration');
                const resourceFiles = Object.fromEntries(await Promise.all(manifest.contributes.resources.flatMap(resource =>
                    'path' in resource && typeof resource.path === 'string' ? [readFile(new URL(
                        `../../../../../../packages/plugins/scm-github/${resource.path}`, import.meta.url,
                    )).then(bytes => [resource.path, bytes] as const)] : [])));
                const admitted = await runWithServerHttpBaseUrl(base, () => createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{ manifest: GITHUB_MANIFEST,
                    files: { ...resourceFiles, '.happier-plugin-build/daemon.js': 'export function activate() {}' },
                    instantiateCommittedModule: () => ({ activate: GITHUB_PLUGIN.activate }),
                }], resolveContributes: async happyHomeDir => {
                    const loadResult = await loadInstalledPlugins({ happyHomeDir });
                    const loaded = loadResult.loadedPlugins[0];
                    if (!loaded) throw new Error('Missing installed GitHub fixture');
                    const referencePlugins = [CHANNELS_MANIFEST, TRIAGE_MANIFEST].map(reference => ({ ...loaded,
                        pluginId: reference.id, manifest: normalizePluginManifestV2(reference) }));
                    return createResolvedContributionRegistry(projectLoadedPluginRegistry({ loadResult, provenance: 'external',
                        pluginRegistry: buildPluginContributionRegistry({ loadedPlugins: loadResult.loadedPlugins, referencePlugins }) }));
                },
                    runtimeOptions: { scopedActionRuntime: { credentials,
                        actionsSettingsProvider: createActionSettingsProvider({ getAccountSettings: () => settings, allowEnvironmentOverride: false }) },
                        externalActionHomeBinding: { serverId: 'publication-profile', serverIdentityId: 'srv_publication' },
                        resolveCurrentMachineId: () => machine.id,
                        resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: machine.id, serverIdentityId: 'srv_publication' }) },
                }));
                admittedFixtures.push(admitted);
                expect(await admitted.registry.resolveCurrentPluginExecutionOrigin?.(GITHUB_PLUGIN_ID),
                    JSON.stringify(admitted.registry.pluginDiagnosticsByPluginId[GITHUB_PLUGIN_ID])).toBeTruthy();
                const occurrenceId = admitted.registry.readPluginOccurrenceId?.(GITHUB_PLUGIN_ID);
                const sourceCustody = admitted.registry.readPluginSourceCustody?.(GITHUB_PLUGIN_ID);
                if (!occurrenceId || !sourceCustody) throw new Error('Missing admitted GitHub source custody');
                const attempt = async (decision: 'approve' | 'reject', providerDenied = false, sessionReply = false) => {
                    const controller = new AbortController();
                    controllers.push(controller);
                    const reviews: Array<{ id: number; body: string }> = [];
                    const comments: Array<{ id: number; body: string; path: string; line: number; side: string }> = [];
                    let approvalCount = 0;
                    let approvalArtifactId: string | undefined;
                    const staleReasons: string[] = [];
                    const transport = createStubGithubTransport({ signal: controller.signal,
                        ...(sessionReply ? { binding: null, nativeMaterialization: { kind: 'httpHeaders' as const,
                            headers: { Authorization: 'Bearer native-gh-fixture' } } } : {}), respond: request => {
                        const path = new URL(request.url).pathname;
                        if (request.method === 'GET' && path === PULL_REQUEST_PATH) return providerDenied
                            ? { status: 403, body: { message: 'Resource not accessible by integration' } }
                            : { status: 200, body: pullRequestBody() };
                        if (request.method === 'GET' && path === `${PULL_REQUEST_PATH}/reviews`) return { status: 200, body: reviews };
                        if (request.method === 'GET' && path === `${PULL_REQUEST_PATH}/comments`) return { status: 200, body: comments };
                        if (request.method === 'POST' && path === `${PULL_REQUEST_PATH}/reviews`) {
                            const payload = readRecordedJsonBody(request);
                            if (!payload || typeof payload !== 'object' || !('body' in payload) || typeof payload.body !== 'string'
                                || !('comments' in payload) || !Array.isArray(payload.comments)) throw new Error('Invalid native review payload');
                            reviews.push({ id: 700, body: payload.body });
                            for (const comment of payload.comments) comments.push({ id: 701 + comments.length, ...comment });
                            return { status: 201, body: reviews[0] };
                        }
                        return undefined;
                    }, executeAction: async (action, input) => {
                        throw new Error(`Unexpected boundary Action ${String(action)}: ${String(input)}`);
                    } });
                    const writes = () => transport.requests.filter(request => request.method === 'POST');
                    const onApprovalRequested: NonNullable<Parameters<typeof createCliActionExecutorFromCredentials>[0]['onApprovalRequested']> = async (artifactId, _signal, decide) => {
                        approvalCount += 1;
                        approvalArtifactId = artifactId;
                        expect(await db.artifact.findUnique({ where: { id: artifactId } })).not.toBeNull();
                        if (approvalCount === 1) expect(writes()).toHaveLength(0);
                        const answer = sessionReply ? await executor.execute('approval.request.decide', { artifactId, decision }, {
                            surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
                            runtimeAccountId: recipient.id, serverId: 'publication-profile', serverIdentityId: 'srv_publication',
                            signal: controller.signal,
                        }) : await decide(decision);
                        expect(answer.ok, JSON.stringify({ answer, staleReasons })).toBe(true);
                        return answer;
                    };
                    const checkDaemonOrigin = createDaemonApprovalExecutionOriginCurrentnessFromCredentials({ credentials,
                        machineId: machine.id, serverId: 'publication-profile', serverApiUrl: base,
                        // The fixture's Session process stays alive for this invocation.
                        isSessionCallerCurrent: async ({ caller }) => caller.sessionId === sessionId,
                        resolveCurrentSessionAgentSpawnPolicyV1: async () => settings.sessionAgentSpawnPolicyV1 ?? {},
                        resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: machine.id, serverIdentityId: 'srv_publication' }),
                    });
                    const checkOrigin: NonNullable<Parameters<typeof createCliActionExecutorFromCredentials>[0]['isApprovalExecutionOriginCurrent']> = async args => {
                        if (!checkDaemonOrigin) throw new Error('Missing credentialed replay checker');
                        return await checkDaemonOrigin({ ...args, reportStale: reason => {
                            staleReasons.push(reason);
                            args.reportStale?.(reason);
                        } });
                    };
                    const executor = createCliActionExecutorFromCredentials({ credentials, readCredentials: async () => credentials,
                        serverId: 'publication-profile', serverIdentityId: 'srv_publication', serverApiUrl: base,
                        isApprovalExecutionOriginCurrent: checkOrigin,
                        pluginActionExecutionOwner: 'current_process',
                        targetActionApprovalReplay: createDaemonExternalActionContributedApprovalReplay({ credentials,
                            acquireRuntimeRegistryLease: async () => ({ registry: runtime, source: 'ephemeral', durableRevision: -1,
                                resolveCurrentPluginMaterializationRef: runtime.resolveCurrentPluginMaterializationRef,
                                release: async () => {} }),
                            isApprovalExecutionOriginCurrent: checkOrigin,
                        }),
                        invokeContributedAction: createCommittedContributedActionInvoker({
                            // The fixture owns this installed runtime through all invocations, as a daemon does.
                            acquireRuntimeRegistryLease: async () => ({ registry: runtime, source: 'ephemeral', durableRevision: -1,
                                resolveCurrentPluginMaterializationRef: runtime.resolveCurrentPluginMaterializationRef,
                                release: async () => {} }),
                            requestCurrentIntent: createCredentialedTargetActionCurrentIntent(credentials, { onApprovalRequested }),
                        }),
                        listContributedActionDefinitions: selection => listRuntimeContributedActionDefinitions(runtime, selection),
                        readContributedActionSchemas: createCommittedContributedActionSchemaReader(selection =>
                            listRuntimeContributedActionDefinitions(runtime, selection)),
                        actionsSettingsProvider: createActionSettingsProvider({ getAccountSettings: () => settings, allowEnvironmentOverride: false }),
                        onApprovalRequested,
                    });
                    const registry = createTargetActionInvocationRegistry({ actions: [{ pluginId: GITHUB_PLUGIN_ID,
                        pluginVersion: manifest.version, occurrenceId, localId,
                        sourceCustody,
                        definition: { ...declaration, hostAccessRequests: resolveManifestHostAccessRequests({ manifest,
                            pluginId: GITHUB_PLUGIN_ID, contribution: { family: 'actions', localId },
                            requestIds: declaration.hostAccess ?? [] }) },
                        handler: publishGithubPullRequestReviewAction,
                    }], readMachineLocalDatabaseAgentLevel: async () => undefined,
                        // These are the finite loaded-plugin/OS facts. Admission and policy stay real.
                        resolveAuthorizationFacts: action => ({ generation: { targetGeneration: action.occurrenceId,
                            desiredGeneration: action.occurrenceId, appliedGeneration: action.occurrenceId },
                            resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [] }),
                        readCurrentPluginOccurrenceId: () => occurrenceId,
                        resolveCurrentPluginMaterializationRef: admitted.registry.resolveCurrentPluginMaterializationRef,
                        resolveHostBinding: createTargetActionHostBindingResolver({ createServiceBinding: createPluginInvocationServiceBinding }),
                        createServices: seed => ({ ...transport.context.services, actions: createPluginInvocationActionsService({ seed,
                            actionExecutor: executor, invokeContributedAction: async () => { throw new Error('Unexpected nested contributed Action'); } }) }),
                    });
                    registries.push(registry);
                    const runtime = { ...admitted.registry, targetActionInvocations: registry };
                    const invocation = executor.bindInvocation(controller.signal, { actionId: 'action.invoke', signal: controller.signal,
                        surface: 'cli', isCurrent: () => !controller.signal.aborted });
                    const instance = configuredInstance();
                    const replyPlan: ReviewCommentPublicationPlanV1 = { ...plan, entries: [],
                        target: { providerId: plan.target.providerId, entryRef: plan.target.entryRef, subtarget: null,
                            nativeService: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-account' } },
                        verdict: { kind: 'comment', body: 'Owner-approved Session reply.' } };
                    const outcome = await runWithServerHttpBaseUrl(base, () => invocation.execute('action.invoke', { action: { pluginId: GITHUB_PLUGIN_ID, localId }, input: {
                        v: 1, instance: sessionReply ? { ...instance, binding: { purpose: instance.binding.purpose,
                            source: 'native', service: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-account' } } } : instance,
                        localRef: PULL_REQUEST_REF, routingToken: REPOSITORY_KEY, publicationPlan: sessionReply ? replyPlan : plan,
                    } }, { surface: sessionReply ? 'agent' : 'cli', authority: sessionReply ? 'account_automation' : 'present_user', runtimeAccountId: recipient.id,
                        serverId: 'publication-profile', serverIdentityId: 'srv_publication', signal: controller.signal,
                        ...(sessionReply ? { defaultSessionId: sessionId, defaultSessionMachineId: machine.id,
                            reviewCommentPrincipal: { actor: { kind: 'agent' as const, agentId: 'muse', sessionId: 'cmwygn62d039i1bmc2l8o2h8u' } },
                            callerPermissionMode: 'default',
                            causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'default' },
                            sessionInputSource: { sourceSessionId: sessionId, sourceInputId: 'native-input', sourceTurnId: 'native-turn', via: 'action' as const } } : {}),
                        externalActionTarget: { kind: 'machine', machineId: machine.id }, actionCaller: sessionReply
                            ? { kind: 'session', sessionId: 'cmwygn62d039i1bmc2l8o2h8u', starterDepth: 0, turnDepth: 0 }
                            : { kind: 'host' } })).then(
                        result => result.ok ? { kind: 'completed' as const, result: result.result }
                            : { kind: 'refused' as const, error: result }, error => ({ kind: 'refused' as const, error }));
                    const approval = approvalArtifactId ? await runWithServerHttpBaseUrl(base, () =>
                        createCliApprovalsArtifactStore({ credentials }).targetActionApprovalsGet({ artifactId: approvalArtifactId! })) : null;
                    return { outcome, transport, approvalCount, approval, writes: writes() };
                };
                const approved = await attempt('approve');
                expect(approved.outcome).toMatchObject({ kind: 'completed', result: { kind: 'settled', publication: {
                    entries: [{ happierCommentId: selected.id, outcome: { kind: 'published', externalRef: '701' } }],
                    verdict: { outcome: { kind: 'published', externalRef: '700' } },
                } } });
                expect(approved.approvalCount).toBe(1);
                expect(approved.writes).toHaveLength(1);
                expect(approved.transport.materializations).toMatchObject([{ account: CONFIGURED_ACCOUNT }]);
                expect(readRecordedJsonBody(approved.writes[0]!)).toEqual({ event: 'COMMENT', commit_id: OBSERVED_HEAD,
                    body: expect.stringContaining(plan.verdict!.body),
                    comments: [{ path: 'selected.ts', line: 7, side: 'RIGHT', body: expect.stringContaining(selected.body) }] });
                const sent = JSON.stringify(readRecordedJsonBody(approved.writes[0]!));
                expect(sent).not.toContain(excluded.body);
                expect(sent).not.toContain('unselected.ts');
                expect(sent).not.toContain(ignored.body);
                expect(sent).not.toContain('ignored.ts');
                const correlations = await db.reviewCommentPublicationCorrelation.findMany({ where: { accountId: recipient.id },
                    select: { commentId: true } });
                expect(correlations).toHaveLength(2);
                expect(correlations).toEqual(expect.arrayContaining([{ commentId: null }, { commentId: selected.id }]));
                expect(await db.reviewComment.count({ where: { reviewId } })).toBe(3);
                const reply = await attempt('approve', false, true);
                expect(reply.outcome, JSON.stringify({ outcome: reply.outcome, claimResponses, claimStatuses })).toMatchObject({
                    kind: 'completed', result: { kind: 'settled', publication: { verdict: { outcome: { kind: 'published' } } } },
                });
                expect(reply.approvalCount).toBe(1);
                expect(reply.writes).toHaveLength(1);
                expect(reply.approval).toMatchObject({ executionOriginV1: {
                    accountId: recipient.id, surface: 'agent', authority: 'account_automation', sessionId,
                    reviewCommentActor: { kind: 'agent', agentId: 'muse', sessionId },
                } });
                const successfulClaims = [...claimStatuses];
                await grant('view');
                const view = await attempt('approve');
                expect(view.outcome).toMatchObject({ kind: 'refused' });
                expect(claimResponses.at(-1), JSON.stringify(view.outcome, (_key, value) => value instanceof Error
                    ? { name: value.name, message: value.message } : value)).toMatchObject({ error: 'review_comment_permission_denied' });
                expect(claimStatuses).toEqual([...successfulClaims, 400]);
                expect(view.approvalCount).toBe(1);
                expect(view.approval).toMatchObject({ status: 'failed', execution: {
                    errorCode: 'review_comment_permission_denied', error: 'Review Edit access is required to publish findings',
                } });
                expect(view.writes).toHaveLength(0);
                await grant('edit');
                const declined = await attempt('reject');
                expect(declined.outcome).toMatchObject({ kind: 'refused' });
                expect(declined.approvalCount).toBe(1);
                expect(claimStatuses).toEqual([...successfulClaims, 400]);
                expect(declined.writes).toHaveLength(0);
                const forge = await attempt('approve', true);
                expect(forge.outcome).toMatchObject({ kind: 'completed', result: { kind: 'rejected', reason: 'admission_failed',
                    failure: { class: 'permission' } } });
                expect(forge.approvalCount).toBe(1);
                expect(forge.writes).toHaveLength(0);
                expect(claimStatuses).toEqual([...successfulClaims, 400]);
                expect(await db.reviewCommentPublicationCorrelation.count({ where: { accountId: recipient.id } })).toBe(3);
            } finally {
                for (const controller of controllers) controller.abort();
                for (const registry of registries) registry.dispose();
                for (const admitted of admittedFixtures) await admitted.dispose();
                restoreHttp();
                await socket.close();
                await app.close();
            }
        }));
});
