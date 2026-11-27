import * as React from 'react';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm/comparison';
import { ReviewFindingsV2Schema } from '@happier-dev/protocol/messages/structured/reviewFindingsV2';
import { createReviewRecordPortV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import { ReviewCommentGetResponseV1Schema, ReviewCommentTransitionResponseV1Schema } from '@happier-dev/protocol/reviews/comments/actions';
import { buildReviewTriageTransitionRequestV1 } from '@happier-dev/protocol/reviews/comments/triageTransition';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ReviewWorkflowHistoryResponseV1Schema } from '@happier-dev/protocol/reviews/reviewListV1';
import type { AgentExecutionRunEvent, AgentExecutionRunOpenRequest, AgentExecutionRunRuntimeContextV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { createClawpatchExecutionRunFactory } from '../../../../../../packages/plugins/review-slices/src/agent/reviews/execution';
import { createClawpatchProcessFixture } from '../../../../../../packages/plugins/review-slices/src/agent/reviews/run.testkit';
import { db } from '@/storage/db';
import { createAccountTokenForTests, createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createTrustedMachineInstallation } from '@/testkit/pluginInstallationPublisherTestkit';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { registerAccountEncryptionRoutes } from '@/app/api/routes/account/registerAccountEncryptionRoutes';
import { registerReviewReadRoutes } from '../readRoutes';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { registerReviewCommentRoutes } from './routes';
import { normalizeStrictJsonReviewOutput } from '../../../../../cli/src/agent/reviews/normalize/normalizeStrictJsonReviewOutput';
import { createReviewRunCommentService, projectReviewRunTriage } from '../../../../../cli/src/agent/executionRuns/profiles/review/reviewComments';
import { resolveExecutionRunRuntimeBackendTarget, resolveExecutionRunRuntimeBackendId } from '../../../../../cli/src/agent/runtime/bridges/executionRun/backendTargets';
import { materializeReviewFindings } from '../../../../../cli/src/agent/runtime/bridges/executionRun/materializeReviewFindings';
import { createCliReviewCommentActionExecutorFromCredentials } from '../../../../../cli/src/agent/reviews/comments/executor';
import { createAcknowledgedAccountArtifactTransport, createCredentialedAccountArtifactStore } from '../../../../../cli/src/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '../../../../../cli/src/api/client/serverHttpBaseUrl';
import { createAccountServerActionDeps } from '../../../../../cli/src/api/accountServerActionDeps';
import type { ExecutionRunState } from '../../../../../cli/src/agent/runtime/bridges/executionRun/executionRunTypes';
import { createSessionFilesViewFixture, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '../../../../../ui/sources/components/sessions/files/views/sessionFilesViewTestkit';
import { standardCleanup } from '../../../../../ui/sources/dev/testkit';
import type { DecryptedArtifact } from '../../../../../ui/sources/sync/domains/artifacts/artifactTypes';
import { createCapturingFlatListMock, createCapturingSectionListMock } from '../../../../../ui/sources/dev/testkit/mocks/virtualizedList';

// Native/Expo rendering and the socket transport are the existing system boundaries.
// Normalization, signed comment Actions, HTTP routes, SQLite and detail projections stay real.
installSessionFilesViewBoundaries({ platformOS: 'web', reactNativeOverrides: {
    // The native recyclers are absent from Test Renderer; collection projection and rows stay real.
    ...createCapturingFlatListMock().module,
    ...createCapturingSectionListMock().module,
    useWindowDimensions: () => ({ width: 1440, height: 1000, scale: 1, fontScale: 1 }),
} });
/** The physical app inventory is immutable after Availability's first Account publication. */
async function prepareReviewEvidenceAppPackage() {
    const { definePlugin } = await import('@happier-dev/plugin-sdk');
    const { prepareAuthenticationInventory } = await import('../../../../../ui/sources/dev/testkit/fixtures/connectedAccountAuthentication');
    const { projectBundledPluginUiDeclaration } = await import('../../../../../cli/scripts/build-owned/bundledPlugins/uiDeclarations.mjs');
    const { installBundledPluginUiDeclarationsForTests } = await import('../../../../../ui/sources/dev/testkit/mocks/bundledPluginUiAssets');
    const { PLUGIN_MANIFEST: githubManifest } = await import('../../../../../../packages/plugins/scm-github/src/manifest');
    const { PLUGIN_MANIFEST: triageManifest } = await import('../../../../../../packages/plugins/triage/src/manifest');
    const projectPath = await mkdtemp(join(tmpdir(), 'happier-review-evidence-package-'));
    const namespace = 'qa.review.evidence';
    const evidence = 'Reload the connection after signing out.';
    const artifactTarget = { artifactId: 'account-runtime', exportName: 'activateAccount' };
    const { ReviewCommentGetRequestV1Schema } = await import('@happier-dev/protocol/reviews/comments/actions');
    const extensionPlugin = definePlugin({ id: namespace, version: '1.0.0', displayName: 'Review evidence fixture',
        actions: { 'inspect-evidence': { title: 'Inspect persisted evidence', readOnly: true, dangerLevel: 'safe',
            surfaces: ['ui', 'plugin'], execution: { target: 'account', account: artifactTarget, invokingUi: true },
            inputSchema: { type: 'object', properties: { reviewId: { type: 'string' }, commentId: { type: 'string' } },
                required: ['reviewId', 'commentId'], additionalProperties: false },
            resultSchema: { type: 'object', additionalProperties: true },
            run: async (input, context) => context.services.actions.execute('reviews.comments.get', ReviewCommentGetRequestV1Schema.parse(input)) } },
        ui: { views: [{ id: 'finding-evidence', container: 'reviewFinding', target: { kind: 'app' },
            renderer: 'finding-evidence', title: 'Review evidence' },
            { id: 'review-evidence', container: 'appPage', target: { kind: 'app', context: 'review' },
                renderer: 'finding-evidence', title: 'Evidence overview' }],
            renderers: [{ id: 'finding-evidence', kind: 'reactNative', artifact: 'finding-evidence',
                requiredHostMethods: ['context', 'executeAction'] }] } });
    const entryPath = join(projectPath, 'finding-evidence.tsx');
    await writeFile(entryPath, `import * as React from 'react';
import { Pressable, Text } from 'react-native';
export function activateAccount(api) {
    api.actions.register('inspect-evidence', async (input, context) =>
        context.services.actions.execute('reviews.comments.get', input, { signal: context.signal }));
}
function FindingEvidence(renderContext) {
    const review = renderContext.surface.mount.review;
    const [read, setRead] = React.useState(null);
    if (review.kind === 'page') return React.createElement(Text,
        { testID: 'plugin-evidence:page' }, 'Review evidence page ' + review.reviewId);
    return React.createElement(React.Fragment, null,
        React.createElement(Text, null, review.extension.reproduction),
        React.createElement(Pressable, { testID: 'plugin-evidence:inspect',
            onPress: async () => setRead(await renderContext.hostApi.executeAction('inspect-evidence',
                { reviewId: review.reviewId, commentId: review.commentId })) },
            React.createElement(Text, null, 'Inspect persisted evidence')),
        read && React.createElement(Text, { testID: 'plugin-evidence:read' }, JSON.stringify(read)));
}
export function renderSurface(context) { return React.createElement(FindingEvidence, context); }
`);
    const packaged = { artifacts: [] as unknown[], declarations: [] as unknown[], files: new Map<number, Uint8Array>(), reads: 0 };
    await prepareAuthenticationInventory(packaged, { manifest: extensionPlugin.manifest, target: artifactTarget,
        entryPath, projectPath, packageName: '@qa/review-evidence',
        additionalArtifacts: [{ target: { artifactId: 'finding-evidence', exportName: 'renderSurface' }, entryPath }] });
    // Only the app's physical package inventory is substituted. Availability
    // admits the real authored manifests and stamps the mounted caller custody.
    const declarations = await Promise.all([
        { manifest: githubManifest, packageName: '@happier-dev/plugins-scm-github' },
        { manifest: triageManifest, packageName: '@happier-dev/plugins-triage' },
    ].map(({ manifest, packageName }) => projectBundledPluginUiDeclaration({ packageName,
        packageVersion: manifest.version, manifest, artifactGraphs: [] })));
    if (declarations.some(declaration => !declaration)) throw new Error('Missing authored plugin declaration');
    const restoreInventory = installBundledPluginUiDeclarationsForTests([
        ...declarations.filter(declaration => declaration !== undefined),
        ...packaged.declarations as readonly import('../../../../../ui/sources/sync/domains/plugins/availability/bundledPluginUiArtifactInventory').PluginHostBundledUiDeclaration[],
    ]);
    return { namespace, evidence, packaged, projectPath, restoreInventory };
}
const reviewEvidencePackage = await prepareReviewEvidenceAppPackage();
await prepareSessionFilesViewTestkit();
let harness: LightSqliteHarness;
beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-review-attribution-', initAuth: true, initEncrypt: true }); }, 120_000);
afterAll(async () => {
    standardCleanup();
    await harness?.close();
    reviewEvidencePackage.restoreInventory();
    await rm(reviewEvidencePackage.projectPath, { recursive: true, force: true });
});

it('retains captured scope through persisted comments and detail without treating Seen before as pre-existing', async () => {
    const account = await db.account.create({ data: { id: 'alice', encryptionMode: 'plain' } });
    const token = await createAccountTokenForTests(account.id, { kind: 'account', authority: 'present_user' });
    const machineId = randomUUID(), installationId = randomUUID(), keyPair = tweetnacl.sign.keyPair();
    await createTrustedMachineInstallation({ accountId: account.id, machineId, installationId, keyPair });
    const comparison = ScmComparisonSchema.parse({ id: 'captured-attribution',
        source: { kind: 'branch', base: 'base', head: 'selected-head' }, repository: { rootPath: harness.baseDir },
        endpoints: { before: 'before', after: 'after' }, inventory: { state: 'complete', reasons: [], files: [{
            path: 'renamed.ts', previousPath: 'original.ts', changeKind: 'renamed', binary: false, generated: false, lockfile: false,
            beforeBlobId: 'old-blob', afterBlobId: 'new-blob',
            evidence: { state: 'available', unifiedDiff: '@@ -1,3 +1,4 @@\n oldIssue();\n safe();\n-oldCall();\n+newIssue();\n+oldCall();\n' },
            occurrences: [{ id: 'occurrence', alias: 'c1', path: 'renamed.ts', previousPath: 'original.ts',
                beforeBlobId: 'old-blob', afterBlobId: 'new-blob', before: { startLine: 1, lineCount: 3 },
                after: { startLine: 1, lineCount: 4 }, position: 0, evidence: { state: 'available' } }],
        }] } });
    const common = { severity: 'high', category: 'correctness', summary: 'Preserve the selected evidence.' };
    const reported = [
        { ...common, id: 'old', title: 'Unchanged issue', filePath: 'renamed.ts', startLine: 1, scopeAttribution: 'in_selected_changes' },
        { ...common, id: 'added', title: 'Added issue', filePath: 'renamed.ts', startLine: 3, scopeAttribution: 'pre_existing' },
        { ...common, id: 'conflicting', title: 'Repeated earlier line', filePath: 'renamed.ts', startLine: 4, scopeAttribution: 'pre_existing' },
        { ...common, id: 'incomplete', title: 'Unresolved issue', filePath: 'renamed.ts', startLine: 100, scopeAttribution: 'pre_existing' },
        { ...common, id: 'transcript', title: 'Transcript claim', scopeAttribution: 'pre_existing' },
    ];
    await withAuthenticatedTestApp(app => {
        registerReviewCommentRoutes(app); registerReviewReadRoutes(app); artifactsRoutes(app); registerAccountEncryptionRoutes(app);
    }, async app => {
        const origin = await app.listen({ host: '127.0.0.1', port: 0 });
        await runWithServerHttpBaseUrl(origin, async () => {
            const artifacts = createCredentialedAccountArtifactStore({ token, encryption: null });
            const records = createReviewRecordPortV1(createAcknowledgedAccountArtifactTransport(artifacts));
            const execute = createCliReviewCommentActionExecutorFromCredentials({ credentials: { token, encryption: null },
                resolvePrincipalSigningContext: async () => ({ machineId, installationId,
                    privateKeyBase64Url: Buffer.from(keyPair.secretKey).toString('base64url') }) });
            const comments = createReviewRunCommentService({ cwd: harness.baseDir,
                scope: { workspace: { machineId, path: harness.baseDir } }, execute });
            const persist = async (reviewId: string, findings: typeof reported, captured: boolean) => {
                const binding = await records.start({ reviewId, title: 'Captured scope attribution', subjectKind: 'comparison',
                    sourceKind: 'direct', reviewerIds: ['reviewer'], comparisonId: comparison.id, startedAt: Date.now() });
                const run: ExecutionRunState = { runId: randomUUID(), callId: randomUUID(), sidechainId: randomUUID(), sessionId: null,
                    depth: 0, intent: 'review', backendId: 'claude', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                    instructions: 'Review.', permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded',
                    ioMode: 'request_response', status: 'running', startedAtMs: Date.now(),
                    intentInput: { reviewRound: binding, reviewReviewerId: 'reviewer',
                        ...(captured ? { comparisonId: comparison.id, comparison } : {}) } };
                const normalized = normalizeStrictJsonReviewOutput({ ...run, finishedAtMs: Date.now(),
                    rawText: JSON.stringify({ summary: 'Reviewed.', reviewOutcome: 'complete', findings }) });
                expect(normalized.status).toBe('succeeded');
                const payload = ReviewFindingsV2Schema.parse(normalized.structuredMeta?.payload);
                if (captured) expect(payload.findings.map(finding => finding.scopeAttribution))
                    .toEqual(['pre_existing', 'in_selected_changes', 'unknown', 'unknown', 'unknown']);
                const result = await comments.materialize({ run, findings: payload.findings, reviewedFingerprint: null,
                    comparison, review: binding });
                expect(result).toMatchObject({ status: 'materialized', failures: [] });
                await records.settle({ ...binding, outcome: 'completed', finishedAt: Date.now(), runs: [] });
                return result;
            };
            const earlierId = randomUUID(), currentId = randomUUID();
            const earlier = await persist(earlierId, reported.slice(2, 3), false);
            const current = await persist(currentId, reported, true);
            const row = await artifacts.read(currentId);
            expect(row).not.toBeNull();
            if (!row || typeof row.body !== 'string') throw new Error('Persisted Review is unavailable');
            expect(await records.read(currentId)).toMatchObject({ reviewId: currentId, rounds: [{ ordinal: 1 }] });
            const fixture = await createSessionFilesViewFixture({ serverUrl: origin, credentials: { token },
                serverIdentityId: await getOrCreateServerIdentityId(),
                machine: null, request: async (url, init) => {
                    const path = new URL(String(url)).pathname;
                    if (path.startsWith('/v1/reviews/') || path.startsWith('/v1/artifacts') || path.startsWith('/v1/actions/review.')) {
                        return fetch(url, init);
                    }
                    return undefined;
                } });
            const artifact: DecryptedArtifact = { id: currentId, sourceServerId: fixture.scope.serverId,
                title: 'Captured scope attribution', isDecrypted: true,
                header: { ...row.header, title: 'Captured scope attribution' }, body: row.body,
                ownerAccountId: account.id, access: 'owner', storageMode: 'plain',
                headerVersion: row.revision.headerVersion, bodyVersion: row.revision.bodyVersion,
                seq: 1, createdAt: 1, updatedAt: 1 };
            const { ReviewDetailHost } = await import('../../../../../ui/sources/components/reviews/detail/ReviewDetailHost');
            const { t } = await import('../../../../../ui/sources/text');
            const { readReviewRunComments } = await import('../../../../../ui/sources/sync/domains/reviews/comments/reviewRunComments');
            const { getActiveServerAccountScope } = await import('../../../../../ui/sources/sync/domains/scope/activeServerAccountScope');
            expect(getActiveServerAccountScope()).toEqual({ serverId: fixture.scope.serverId, accountId: account.id });
            const screen = await fixture.render(React.createElement(ReviewDetailHost, {
                artifact, bodyState: 'ready', onRetry() {}, focusThreadId: current.comments[2]!.comment.id,
            }));
            try {
                const textOf = (testId: string) => screen.findByTestId(testId)?.findAll(child => typeof child.type === 'string')
                    .flatMap(child => child.children).filter((child): child is string => typeof child === 'string').join('') ?? '';
                const oldId = current.comments[0]!.comment.id, addedId = current.comments[1]!.comment.id;
                const conflictId = current.comments[2]!.comment.id;
                await vi.waitFor(() => expect(readReviewRunComments({
                    scope: { serverId: fixture.scope.serverId, accountId: account.id }, reviewId: currentId,
                }).status, screen.tree.root.findAll(child => typeof child.type === 'string')
                    .flatMap(child => child.children).filter((child): child is string => typeof child === 'string').join('\n'))
                    .toBe('loaded'));
                const persisted = readReviewRunComments({ scope: { serverId: fixture.scope.serverId, accountId: account.id }, reviewId: currentId });
                expect(current.comments.map(({ comment }) => persisted.comments.find(item => item.id === comment.id)?.scopeAttribution))
                    .toEqual(['pre_existing', 'in_selected_changes', 'unknown', 'unknown', 'unknown']);
                expect(screen.findByTestId(`review-finding:${oldId}`)).not.toBeNull();
                expect(textOf(`review-finding:${oldId}`)).toContain(t('reviewWalkthrough.detail.preExisting'));
                expect(textOf(`review-finding:${addedId}`)).not.toContain(t('reviewWalkthrough.detail.preExisting'));
                await vi.waitFor(() => expect(screen.findByTestId(`review-finding-seen-link:${conflictId}:${earlier.commentIds[0]}`)).not.toBeNull());
                expect(textOf(`review-finding:${conflictId}`)).not.toContain(t('reviewWalkthrough.detail.preExisting'));
            } finally { await screen.unmount(); standardCleanup(); await fixture.dispose(); }
        });
    }, { authentication: 'real' });
});

it('preserves the actual human dismissal and revision through native Stop and a fresh retry', async () => {
    const account = await db.account.create({ data: { encryptionMode: 'plain' } });
    const token = await createAccountTokenForTests(account.id, { kind: 'account', authority: 'present_user' });
    const machineId = randomUUID(), installationId = randomUUID(), keyPair = tweetnacl.sign.keyPair();
    await createTrustedMachineInstallation({ accountId: account.id, machineId, installationId, keyPair });
    const native = await createClawpatchProcessFixture();
    await writeFile(join(native.directory, 'slice-a.ts'), 'one();\ntwo();\nthree();\nlost write\nfive();\nsix();\n');
    const context = { agent: { id: 'clawpatch' }, signal: native.controller.signal,
        services: { exec: native.exec, fs: { getPluginDataDirectory: async () => native.state } } } as unknown as AgentExecutionRunRuntimeContextV1;
    const request: AgentExecutionRunOpenRequest = { kind: 'create', runId: randomUUID(), cwd: native.directory,
        profile: { pluginId: 'happier.review.clawpatch', localId: 'review' }, input: { text: 'Find lost writes', structuredInput: {
            scope: 'repository', engines: { clawpatch: { provider: 'mock' } },
            scmReviewScope: { scope: 'repository', status: 'supported', worktreeRoot: native.directory },
        } } };
    const target = resolveExecutionRunRuntimeBackendTarget({ kind: 'agent', identity: { pluginId: 'happier.review.clawpatch', localId: 'clawpatch' } });
    if (!target) throw new Error('Clawpatch runtime target unavailable');
    const attempt = async (runId: string, stop = false) => {
        const started = stop ? native.pauseNextReview() : undefined;
        const runtime = await createClawpatchExecutionRunFactory().open({ ...request, runId }, context);
        const events: AgentExecutionRunEvent[] = [];
        const terminal = new Promise<void>(resolve => { runtime.watch(event => {
            events.push(event);
            if (event.kind === 'run-complete' || event.kind === 'run-failed' || event.kind === 'run-cancelled') resolve();
        }); });
        try {
            if (stop) { await started; expect(await runtime.stop()).toEqual({ status: 'requested' }); }
            await terminal;
            expect(events.at(-1)?.kind).toBe(stop ? 'run-cancelled' : 'run-complete');
            const output = events.find(event => event.kind === 'output-delta' && event.channel === 'assistant');
            if (stop) { expect(output).toBeUndefined(); return null; }
            if (!output || output.kind !== 'output-delta') throw new Error('Native attempt did not publish findings');
            return output.text;
        } finally { await runtime.dispose(); }
    };
    await withAuthenticatedTestApp(app => {
        registerReviewCommentRoutes(app); artifactsRoutes(app); registerAccountEncryptionRoutes(app);
    }, async app => {
        const origin = await app.listen({ host: '127.0.0.1', port: 0 });
        await runWithServerHttpBaseUrl(origin, async () => {
            const records = createReviewRecordPortV1(createAcknowledgedAccountArtifactTransport(
                createCredentialedAccountArtifactStore({ token, encryption: null })));
            const execute = createCliReviewCommentActionExecutorFromCredentials({ credentials: { token, encryption: null },
                resolvePrincipalSigningContext: async () => ({ machineId, installationId,
                    privateKeyBase64Url: Buffer.from(keyPair.secretKey).toString('base64url') }) });
            const comments = createReviewRunCommentService({ cwd: native.directory,
                scope: { workspace: { machineId, path: native.directory } }, execute, reviewRecords: records });
            const reviewId = randomUUID();
            const start = (newRound = false) => records.start({ reviewId, title: 'Native cancellation and retry',
                subjectKind: 'repository', sourceKind: 'direct', reviewerIds: ['clawpatch'], startedAt: Date.now(), newRound });
            const runFor = (binding: Awaited<ReturnType<typeof start>>, runId: string): ExecutionRunState => ({
                    runId, callId: runId, sidechainId: runId, sessionId: null, depth: 0,
                    intent: 'review', backendTarget: target, backendId: resolveExecutionRunRuntimeBackendId(target),
                    instructions: 'Find lost writes', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
                    runClass: 'bounded', ioMode: 'request_response', status: 'running', startedAtMs: Date.now(),
                    intentInput: { reviewRound: binding, reviewReviewerId: 'clawpatch', reviewRoundSettlement: 'execution' } });
            const materialize = async (binding: Awaited<ReturnType<typeof start>>, runId: string, rawText: string | null) => {
                if (!rawText) throw new Error('Completed native run has no output');
                const run = runFor(binding, runId);
                const normalized = normalizeStrictJsonReviewOutput({ ...run, finishedAtMs: Date.now(), rawText });
                expect(normalized.status).toBe('succeeded');
                const payload = ReviewFindingsV2Schema.parse(normalized.structuredMeta?.payload);
                expect(payload.findings.map(finding => finding.id)).toEqual(['clawpatch-1', 'clawpatch-2']);
                const projected = await materializeReviewFindings({ run, toolResult: { output: normalized.toolResultOutput },
                    structuredMeta: normalized.structuredMeta, expectFindings: true, reviewComments: comments });
                expect(projected.materialization).toMatchObject({ status: 'materialized', failures: [] });
                if (!projected.materialization) throw new Error('Review materialization unavailable');
                await comments.settleRound({ ...run, status: 'succeeded', finishedAtMs: Date.now(), structuredMeta: projected.structuredMeta });
                return projected.materialization;
            };
            const first = await start(), firstRunId = randomUUID();
            const initial = await materialize(first, firstRunId, await attempt(firstRunId));
            const finding = initial.comments[0]!.comment;
            const human = ReviewCommentTransitionResponseV1Schema.parse(await execute('reviews.comments.transition',
                buildReviewTriageTransitionRequestV1({ comment: finding, decision: 'reject',
                    note: 'Inspected and rejected by the person.', clientMutationId: randomUUID() }))).comment;
            expect(human).toMatchObject({ state: 'dismissed', reviewTriageStatus: 'reject', serverRevision: finding.serverRevision + 1 });
            expect(human.transitions.at(-1)).toMatchObject({ transitionedBy: { kind: 'user', userId: account.id },
                toState: 'dismissed', reviewTriageStatus: 'reject', reason: 'Inspected and rejected by the person.' });
            const cancelled = await start(true);
            const cancelledRunId = randomUUID();
            expect(await attempt(cancelledRunId, true)).toBeNull();
            await comments.settleRound({ ...runFor(cancelled, cancelledRunId), status: 'cancelled', finishedAtMs: Date.now() });
            const read = async () => ReviewCommentGetResponseV1Schema.parse(await execute('reviews.comments.get', { reviewId, commentId: finding.id })).comment;
            expect(await read()).toEqual(human);
            const retry = await start(true), retryRunId = randomUUID();
            const repeated = await materialize(retry, retryRunId, await attempt(retryRunId));
            expect(repeated.commentIds).toEqual(initial.commentIds);
            const final = await read();
            const decisionOf = (comment: typeof human) => ({ state: comment.state, reviewTriageStatus: comment.reviewTriageStatus,
                serverRevision: comment.serverRevision, bodyVersion: comment.bodyVersion, transitions: comment.transitions });
            expect(decisionOf(final)).toEqual(decisionOf(human));
            expect(final.appearances).toEqual([...human.appearances ?? [],
                { roundOrdinal: retry.roundOrdinal, runId: retryRunId, reviewerId: 'clawpatch', machineId }]);
            expect(projectReviewRunTriage([final])).toEqual({ findings: [{ id: 'clawpatch-1', status: 'reject', comment: 'Inspected and rejected by the person.' }] });
            expect(JSON.parse(await readFile(join(native.state, 'findings', 'one.json'), 'utf8'))).toMatchObject({ status: 'open' });
            expect((await records.read(reviewId))?.rounds.map(round => round.state)).toEqual(['completed', 'cancelled', 'completed']);
        });
    }, { authentication: 'real' });
});

it('shows authorized Hunt history counts without inheriting another Review human decision', async () => {
    // The canonical mounted UI fixture owns this sandbox Account identity.
    const account = await db.account.upsert({ where: { id: 'alice' }, update: {}, create: { id: 'alice', encryptionMode: 'plain' } });
    const token = await createAccountTokenForTests(account.id, { kind: 'account', authority: 'present_user' });
    const machineId = randomUUID(), installationId = randomUUID(), keyPair = tweetnacl.sign.keyPair();
    await createTrustedMachineInstallation({ accountId: account.id, machineId, installationId, keyPair });
    const workflowId = randomUUID();
    const repeated = { id: 'repeated', title: 'Session token reaches the log', severity: 'high' as const,
        category: 'security', summary: 'A reconnect logs the token.', filePath: 'session.ts', startLine: 8 };
    const stillOpen = { ...repeated, id: 'open', title: 'Missing reconnect cleanup', summary: 'The subscription remains open.', startLine: 15 };
    const fresh = { ...repeated, id: 'fresh', title: 'New credential fallback', summary: 'A new fallback uses another account.', startLine: 22 };
    await withAuthenticatedTestApp(app => {
        registerReviewCommentRoutes(app); registerReviewReadRoutes(app); artifactsRoutes(app); registerAccountEncryptionRoutes(app);
    }, async app => {
        const origin = await app.listen({ host: '127.0.0.1', port: 0 });
        await runWithServerHttpBaseUrl(origin, async () => {
            const artifacts = createCredentialedAccountArtifactStore({ token, encryption: null });
            const records = createReviewRecordPortV1(createAcknowledgedAccountArtifactTransport(artifacts));
            const execute = createCliReviewCommentActionExecutorFromCredentials({ credentials: { token, encryption: null },
                resolvePrincipalSigningContext: async () => ({ machineId, installationId,
                    privateKeyBase64Url: Buffer.from(keyPair.secretKey).toString('base64url') }) });
            const comments = createReviewRunCommentService({ cwd: harness.baseDir,
                scope: { workspace: { machineId, path: harness.baseDir } }, execute });
            const read = async (reviewId: string, commentId: string) => ReviewCommentGetResponseV1Schema.parse(
                await execute('reviews.comments.get', { reviewId, commentId })).comment;
            const persist = async (findings: typeof repeated[], workflow = workflowId, ports = { records, comments }) => {
                const reviewId = randomUUID(), runId = randomUUID();
                const binding = await ports.records.start({ reviewId, title: 'Security sweep', subjectKind: 'repository',
                    sourceKind: 'workflow', workflowId: workflow, workflowRunId: runId, reviewerIds: ['reviewer'], startedAt: Date.now() });
                const run: ExecutionRunState = { runId, callId: runId, sidechainId: runId, sessionId: null, depth: 0,
                    intent: 'review', backendId: 'claude', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                    instructions: 'Review the repository.', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
                    runClass: 'bounded', ioMode: 'request_response', status: 'running', startedAtMs: Date.now(),
                    intentInput: { reviewRound: binding, reviewReviewerId: 'reviewer' } };
                const normalized = normalizeStrictJsonReviewOutput({ ...run, finishedAtMs: Date.now(),
                    rawText: JSON.stringify({ summary: 'Reviewed.', reviewOutcome: 'complete', findings }) });
                expect(normalized.status).toBe('succeeded');
                const payload = ReviewFindingsV2Schema.parse(normalized.structuredMeta?.payload);
                const result = await ports.comments.materialize({ run, findings: payload.findings, reviewedFingerprint: null, review: binding });
                expect(result).toMatchObject({ status: 'materialized', failures: [] });
                await ports.records.settle({ ...binding, outcome: 'completed', finishedAt: Date.now(), runs: [{ kind: 'workflow', runId }] });
                return { reviewId, runId, result };
            };
            await persist([repeated]);
            const previous = await persist([repeated, stillOpen]);
            const priorFinding = await read(previous.reviewId, previous.result.comments.find(row => row.findingId === repeated.id)!.comment.id);
            const closed = ReviewCommentTransitionResponseV1Schema.parse(await execute('reviews.comments.transition',
                buildReviewTriageTransitionRequestV1({ comment: priorFinding, decision: 'reject',
                    note: 'Inspected and rejected only in this Review.', clientMutationId: randomUUID() }))).comment;
            expect(closed).toMatchObject({ state: 'dismissed', reviewTriageStatus: 'reject' });
            // Same identity on a different Hunt cannot inflate this Hunt's counts.
            await persist([repeated, fresh], randomUUID());
            // An unshared Review on this exact Hunt also cannot contribute identities,
            // counts or a previous decision to the reader's authorized history.
            const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
            const outsiderToken = await createAccountTokenForTests(outsider.id, { kind: 'account', authority: 'present_user' });
            const outsiderMachineId = randomUUID(), outsiderInstallationId = randomUUID(), outsiderKeys = tweetnacl.sign.keyPair();
            await createTrustedMachineInstallation({ accountId: outsider.id, machineId: outsiderMachineId,
                installationId: outsiderInstallationId, keyPair: outsiderKeys });
            const outsiderArtifacts = createCredentialedAccountArtifactStore({ token: outsiderToken, encryption: null });
            const outsiderExecute = createCliReviewCommentActionExecutorFromCredentials({
                credentials: { token: outsiderToken, encryption: null },
                resolvePrincipalSigningContext: async () => ({ machineId: outsiderMachineId,
                    installationId: outsiderInstallationId, privateKeyBase64Url: Buffer.from(outsiderKeys.secretKey).toString('base64url') }) });
            const privateReview = await persist([repeated, fresh], workflowId, {
                records: createReviewRecordPortV1(createAcknowledgedAccountArtifactTransport(outsiderArtifacts)),
                comments: createReviewRunCommentService({ cwd: harness.baseDir,
                    scope: { workspace: { machineId: outsiderMachineId, path: harness.baseDir } }, execute: outsiderExecute }),
            });
            const current = await persist([repeated, stillOpen, fresh]);
            const currentFinding = await read(current.reviewId, current.result.comments.find(row => row.findingId === repeated.id)!.comment.id);
            const openFinding = await read(current.reviewId, current.result.comments.find(row => row.findingId === stillOpen.id)!.comment.id);
            const freshFinding = await read(current.reviewId, current.result.comments.find(row => row.findingId === fresh.id)!.comment.id);
            const reader = createActionExecutor(createAccountServerActionDeps({ token, serverId: origin, serverHttpBaseUrl: origin }));
            expect(await reader.execute('review.get', { reviewId: privateReview.reviewId },
                { surface: 'cli', authority: 'present_user', serverId: origin, bypassApprovals: true }))
                .toMatchObject({ ok: false, errorCode: 'review_not_found' });
            const result = await reader.execute('review.history.list', { workflowId, reviewId: current.reviewId },
                { surface: 'cli', authority: 'present_user', serverId: origin, bypassApprovals: true });
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
            if (!result.ok) throw new Error(result.error);
            const history = ReviewWorkflowHistoryResponseV1Schema.parse(result.result);
            expect(history.previousReviewId).toBe(previous.reviewId);
            expect(history.items).toHaveLength(3);
            expect(history.items).toEqual(expect.arrayContaining([
                expect.objectContaining({ findingIdentity: currentFinding.findingIdentity, priorReviewCount: 2, priorRunCount: 2,
                    newSincePrevious: false, inCurrentReview: true, inPreviousReview: true, openReviewCount: 2,
                    previousAppearances: [expect.objectContaining({ runId: previous.runId })] }),
                expect.objectContaining({ findingIdentity: openFinding.findingIdentity, priorReviewCount: 1, priorRunCount: 1,
                    newSincePrevious: false, openReviewCount: 2 }),
                expect.objectContaining({ findingIdentity: freshFinding.findingIdentity, priorReviewCount: 0, priorRunCount: 0,
                    newSincePrevious: true, openReviewCount: 1 }),
            ]));
            const requests: string[] = [];
            const fixture = await createSessionFilesViewFixture({ serverUrl: origin, credentials: { token },
                serverIdentityId: await getOrCreateServerIdentityId(), machine: null, request: async (url, init) => {
                    const path = new URL(String(url)).pathname;
                    if (path.startsWith('/v1/reviews/') || path.startsWith('/v1/artifacts') || path.startsWith('/v1/actions/review.')) {
                        requests.push(path);
                        return fetch(url, init);
                    }
                    return undefined;
                } });
            const { WorkflowRunReview } = await import('../../../../../ui/sources/components/workflows/run/WorkflowRunReview');
            const { ReviewSummary } = await import('../../../../../ui/sources/components/reviews/summary/ReviewSummary');
            const { t } = await import('../../../../../ui/sources/text');
            const screen = await fixture.render(React.createElement(WorkflowRunReview, {
                runId: current.runId, scope: { serverId: fixture.scope.serverId, accountId: account.id }, enabled: true,
            }));
            try {
                await vi.waitFor(() => {
                    expect(screen.getTextContent()).toContain(repeated.title);
                    expect(screen.getTextContent()).toContain(t('reviewWalkthrough.detail.historyEarlierRuns', { count: 2 }));
                    expect(screen.getTextContent()).toContain(t('reviewWalkthrough.detail.historyEarlierRuns', { count: 1 }));
                    expect(screen.getTextContent()).toContain(t('reviewWalkthrough.detail.historyNewSincePrevious'));
                });
                expect(requests).toContain('/v1/reviews/history/list');
                expect(screen.tree.root.findByType(ReviewSummary).props.rows).toEqual(expect.arrayContaining([
                    expect.objectContaining({ rowId: currentFinding.id, decision: 'undecided' }),
                    expect.objectContaining({ rowId: openFinding.id, decision: 'undecided' }),
                    expect.objectContaining({ rowId: freshFinding.id, decision: 'undecided' }),
                ]));
                expect(await read(previous.reviewId, closed.id)).toEqual(closed);
                expect(await read(current.reviewId, currentFinding.id)).toEqual(currentFinding);
                expect(currentFinding.reviewTriageStatus).not.toBe('reject');
            } finally { await screen.unmount(); standardCleanup(); await fixture.dispose(); }
        });
    }, { authentication: 'real' });
});

it('opens one persisted finding from PR, Inbox and Review across Sessions and rounds with one human decision', async () => {
    const { act } = await import('react-test-renderer');
    const { Asset } = await import('expo-asset');
    const { File } = await import('expo-file-system');
    const { AppShellPluginUiProjectionProvider } = await import('../../../../../ui/sources/components/appShell/plugins/AppShellPluginUiProjection');
    const { waitForTestEvent } = await import('../../../../../ui/sources/dev/testkit');
    const { registerPluginAvailabilityRoutes } = await import('../../plugins/availability/routes');
    const { PluginAvailabilityActionHttpPathsV1 } = await import('@happier-dev/protocol/plugins/availability');
    const { setActivePluginAccountAvailabilityIntent } = await import('../../../../../ui/sources/sync/api/plugins/availability/setActivePluginAccountAvailabilityIntent');
    const { installBundledPluginUiArtifactsForTests } = await import('../../../../../ui/sources/dev/testkit/mocks/bundledPluginUiAssets');
    const { namespace, evidence, packaged } = reviewEvidencePackage;
    // Only physical package/Expo bytes are substituted; admission, projection,
    // executable activation and contributed Action dispatch use their real owners.
    const restoreArtifacts = installBundledPluginUiArtifactsForTests(packaged.artifacts as import('../../../../../ui/sources/sync/domains/plugins/availability/bundledPluginUiArtifactInventory').BundledPluginUiAppArtifactInventory);
    const originalAsset = Asset.fromModule;
    const localFiles = [...packaged.files].map(([id, bytes]) => {
        const file = new File(`file:///review-evidence-${id}.js`); file.write(bytes); return file;
    });
    const assetBoundary = vi.spyOn(Asset, 'fromModule').mockImplementation(asset => {
        if (typeof asset !== 'number' || !packaged.files.has(asset)) return originalAsset(asset);
        const uri = `file:///review-evidence-${asset}.js`;
        const result = Asset.fromURI(uri); result.localUri = uri; result.downloaded = true; return result;
    });
    let extensionEnabled = true;
    const { materializeReviewFindings: publishFindings } = await import('../../../../../cli/src/agent/runtime/bridges/executionRun/materializeReviewFindings');
    const { PluginUiProvider } = await import('@happier-dev/plugin-ui/advanced');
    const { Button } = await import('@happier-dev/plugin-ui/components');
    const { createTriageSourceV1Fixture } = await import('@happier-dev/triage-protocol/testing/v1');
    const { REVIEW_TRIAGE_SOURCE_V1, reviewTriageLocalRefV1 } = await import('@happier-dev/triage-protocol/v1');
    const { GithubHappierReviewSummary } = await import('../../../../../../packages/plugins/scm-github/src/ui/detail/happierReviewSummary');
    const { GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1 } = await import('../../../../../../packages/plugins/scm-github/src/triage/contribution');
    const { ReviewDetail, readReviewDetailInput } = await import('../../../../../../packages/plugins/triage/src/reviews/detail');
    const { createBoundPluginSurfaceController } = await import('../../../../../ui/sources/components/plugins/surfaces/boundPluginSurfaceController');
    const { createPluginUiPrivatePresentationHost } = await import('../../../../../ui/sources/components/plugins/surfaces/pluginUiPrivatePresentationHost');
    const { createCanonicalPluginReactNativeHostApiAdapter } = await import('../../../../../ui/sources/components/plugins/reactNative/hostApi');
    const { createPluginSurfaceContextFixture } = await import('../../../../../ui/sources/dev/testkit/fixtures/pluginSurfaceContextFixture');
    const { captureActiveServerAccountScopeLifetime } = await import('../../../../../ui/sources/sync/domains/scope/activeServerAccountScope');
    const { readPluginAccountAvailability } = await import('../../../../../ui/sources/sync/domains/plugins/availability/projection');
    const { getSyncSingleton } = await import('../../../../../ui/sources/sync/runtime/getSyncSingleton');
    const { createHomeHubArtifactHttpBoundary } = await import('../../../../../ui/sources/dev/testkit/harness/homeHubArtifactHttpBoundary');
    const { resetReviewRunCommentsForTests } = await import('../../../../../ui/sources/sync/domains/reviews/comments/reviewRunComments');
    const { ArtifactView } = await import('../../../../../ui/sources/components/artifacts/ArtifactView');
    const { ReviewActivityFeed } = await import('../../../../../ui/sources/components/reviews/detail/ReviewActivityFeed');
    const { router } = await import('expo-router');
    const account = await db.account.upsert({ where: { id: 'alice' }, update: {}, create: { id: 'alice', encryptionMode: 'plain' } });
    const token = await createAccountTokenForTests(account.id, { kind: 'account', authority: 'present_user' });
    const writers = await Promise.all([0, 1].map(async () => {
        const machineId = randomUUID(), installationId = randomUUID(), sessionId = randomUUID(), keyPair = tweetnacl.sign.keyPair();
        await createTrustedMachineInstallation({ accountId: account.id, machineId, installationId, keyPair });
        await db.session.create({ data: { id: sessionId, accountId: account.id, tag: sessionId, metadata: '{}', encryptionMode: 'plain' } });
        return { machineId, installationId, sessionId, keyPair };
    }));
    try {
    await withAuthenticatedTestApp(app => {
        registerReviewCommentRoutes(app); registerReviewReadRoutes(app); artifactsRoutes(app); registerAccountEncryptionRoutes(app);
        registerPluginAvailabilityRoutes(app);
    }, async app => {
        const origin = await app.listen({ host: '127.0.0.1', port: 0 });
        await runWithServerHttpBaseUrl(origin, async () => {
            const artifacts = createCredentialedAccountArtifactStore({ token, encryption: null });
            const records = createReviewRecordPortV1(createAcknowledgedAccountArtifactTransport(artifacts));
            const reviewId = randomUUID();
            const materialize = async (writer: typeof writers[number], binding: Awaited<ReturnType<typeof records.start>>, localId: string, settle = true) => {
                const execute = createCliReviewCommentActionExecutorFromCredentials({ credentials: { token, encryption: null },
                    resolvePrincipalSigningContext: async () => ({ machineId: writer.machineId, installationId: writer.installationId,
                        privateKeyBase64Url: Buffer.from(writer.keyPair.secretKey).toString('base64url') }) });
                const runId = randomUUID();
                const run: ExecutionRunState = { runId, callId: runId, sidechainId: runId, sessionId: writer.sessionId, depth: 0,
                    intent: 'review', backendId: 'claude', backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
                    instructions: 'Review.', permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded',
                    ioMode: 'request_response', status: 'running', startedAtMs: Date.now(),
                    intentInput: { reviewRound: binding, reviewReviewerId: 'reviewer', reviewRoundSettlement: 'execution' } };
                const normalized = normalizeStrictJsonReviewOutput({ ...run, finishedAtMs: Date.now(), rawText: JSON.stringify({
                    summary: 'Reviewed.', reviewOutcome: 'complete', findings: [{ id: localId, title: 'Reconnect loses the subscription',
                        summary: 'The listener is removed before reconnect completes.', severity: 'high', category: 'correctness',
                        filePath: 'connection.ts', startLine: 8, extensions: { [namespace]: { reproduction: evidence } } }],
                }) });
                expect(normalized.status).toBe('succeeded');
                const service = createReviewRunCommentService({ cwd: harness.baseDir,
                    scope: { workspace: { machineId: writer.machineId, path: harness.baseDir } }, execute, reviewRecords: records });
                const projected = await publishFindings({ run, toolResult: { output: normalized.toolResultOutput },
                    structuredMeta: normalized.structuredMeta, expectFindings: true, reviewComments: service });
                const result = projected.materialization;
                expect(result).toMatchObject({ status: 'materialized', failures: [] });
                if (!result) throw new Error('Review materialization unavailable');
                if (settle) await service.settleRound({ ...run, status: 'succeeded', finishedAtMs: Date.now(), structuredMeta: projected.structuredMeta });
                return result.comments[0]!.comment;
            };
            const start = (id: string, newRound = false) => records.start({ reviewId: id, title: 'One canonical finding',
                subjectKind: 'repository', sourceKind: 'direct', reviewerIds: ['reviewer'], startedAt: Date.now(), newRound });
            const first = await start(reviewId);
            const initial = await materialize(writers[0]!, first, 'first-local-id', false);
            const readPersisted = createCliReviewCommentActionExecutorFromCredentials({ credentials: { token, encryption: null } });
            const persistedInitial = ReviewCommentGetResponseV1Schema.parse(await readPersisted('reviews.comments.get', {
                reviewId, commentId: initial.id })).comment;
            expect(persistedInitial?.extensions?.[namespace]).toEqual({ reproduction: evidence });
            const initialFinding = persistedInitial?.finding;
            if (!initialFinding) throw new Error('Missing persisted finding content');
            const otherSession = await materialize(writers[1]!, first, 'second-local-id');
            expect(otherSession.id).toBe(initial.id);
            const second = await start(reviewId, true);
            const repeated = await materialize(writers[1]!, second, 'next-round-local-id');
            expect(repeated.id).toBe(initial.id);
            const separate = await start(randomUUID());
            expect((await materialize(writers[0]!, separate, 'first-local-id')).id).not.toBe(initial.id);
            expect(await db.reviewComment.count({ where: { reviewId } })).toBe(1);
            expect(await db.reviewCommentAppearance.count({ where: { reviewId, commentId: initial.id } })).toBe(3);

            const serverIdentityId = await getOrCreateServerIdentityId();
            const openFixture = async () => {
                const homeBoundary = createHomeHubArtifactHttpBoundary(account.id);
                const mounted = await createSessionFilesViewFixture({ serverUrl: origin, credentials: { token },
                    featureOverrides: { features: { plugins: { enabled: true, ui: { enabled: true,
                        hostedWeb: { enabled: false }, reactNativeBundles: { enabled: true } } } } },
                    serverIdentityId, machine: null, request: async (url, init) => {
                    const path = new URL(String(url)).pathname;
                    if (path.startsWith('/v1/reviews/') || path.startsWith('/v1/artifacts') || path.startsWith('/v1/account/encryption')
                        || Object.values(PluginAvailabilityActionHttpPathsV1).some(candidate => candidate === path))
                        return fetch(url, init);
                    return homeBoundary.request(url, init);
                } });
                await getSyncSingleton().refreshPluginAccountAvailability();
                return { ...mounted, render: (element: React.ReactElement) => mounted.render(
                    React.createElement(AppShellPluginUiProjectionProvider, null, element)) };
            };
            const readArtifact = async (sourceServerId: string): Promise<DecryptedArtifact> => {
                const row = await artifacts.read(reviewId);
                if (!row || typeof row.body !== 'string') throw new Error('Persisted Review unavailable');
                return { id: reviewId, sourceServerId, title: 'One canonical finding', isDecrypted: true,
                    header: { ...row.header, title: 'One canonical finding' }, body: row.body, ownerAccountId: account.id,
                    access: 'owner', storageMode: 'plain', headerVersion: row.revision.headerVersion,
                    bodyVersion: row.revision.bodyVersion, seq: 1, createdAt: 1, updatedAt: 1 };
            };
            let fixture = await openFixture();
            const openEmbedded = async (placement: 'PR' | 'Inbox') => {
                const lifetime = captureActiveServerAccountScopeLifetime();
                if (!lifetime) throw new Error('Missing mounted Account');
                const pluginId = placement === 'PR' ? 'happier.scm.forge.github' : REVIEW_TRIAGE_SOURCE_V1.pluginId;
                const contributionId = placement === 'PR' ? GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1 : REVIEW_TRIAGE_SOURCE_V1.localId;
                const selected = await readPluginAccountAvailability(lifetime.scope).ensureCurrentAccountExecution(pluginId);
                if (selected.kind !== 'available') throw new Error(`Review entry plugin is unavailable: ${selected.code}`);
                const controller = createBoundPluginSurfaceController({ facts: { pluginId, contributionId,
                    surfaceId: `entry-${placement}`, occurrenceId: selected.custodyId, placement: 'browserSurface', platform: 'web',
                    accountExecutionOrigin: { ...lifetime.scope, custodyId: selected.custodyId, sourceCustody: selected.sourceCustody },
                    serverId: lifetime.scope.serverId, accountLifetime: lifetime, interactionEnabled: true, daemonInteractionEnabled: false } });
                const surface = createPluginSurfaceContextFixture({ accountEncryptionMode: 'plain',
                    mount: { kind: 'destination', destination: { pluginId, localId: contributionId }, container: 'appPage' }, target: { kind: 'app' } });
                const native = createCanonicalPluginReactNativeHostApiAdapter({ surface, requestSurface: controller.surfaceContext,
                    handleRequest: controller.hostApi.handleRequest, installedMethods: controller.installedMethods });
                const unwatch = controller.subscribeResourceInvalidations(event => native.publishResourceSubscriptionEvent(event));
                const triage = createTriageSourceV1Fixture().detailInput;
                const input = readReviewDetailInput({ ...triage, observation: { ...triage.observation,
                    entryRef: { ...triage.observation.entryRef, source: REVIEW_TRIAGE_SOURCE_V1, ...reviewTriageLocalRefV1(reviewId) } } });
                const context = { plugin: { id: pluginId, version: selected.manifest.version }, surface, hostApi: native.api, signal: new AbortController().signal };
                const screen = await fixture.render(React.createElement(PluginUiProvider, { hostApi: native.api, context: surface,
                    presentationHost: createPluginUiPrivatePresentationHost(undefined, { pluginId,
                        markdownWorkspace: { target: surface.target, serverId: lifetime.scope.serverId } }) },
                    placement === 'PR' ? React.createElement(GithubHappierReviewSummary, { reviewId })
                        : React.createElement(ReviewDetail, { context, input })));
                try {
                    await vi.waitFor(() => expect(screen.findHostByTestId(`review-summary:row:${initial.id}`), screen.getTextContent()).not.toBeNull());
                    await screen.pressByTestIdAsync(`review-summary:row:${initial.id}`);
                    expect(screen.findHostByTestId(`review-finding:${initial.id}`)).not.toBeNull();
                    if (extensionEnabled) {
                        await vi.waitFor(() => expect(screen.getTextContent()).toContain(evidence));
                        await screen.pressByTestIdAsync('plugin-evidence:inspect');
                        await vi.waitFor(() => expect(screen.findHostByTestId('plugin-evidence:read')).not.toBeNull());
                        expect(screen.getTextContent()).toContain(initial.id);
                    } else {
                        expect(screen.getTextContent()).toContain(initialFinding.title);
                        expect(screen.findHostByTestId('plugin-evidence:inspect')).toBeNull();
                    }
                    const open = screen.findAllByType(Button).find(button => button.props.title === 'Open review');
                    if (!open) throw new Error('The entry has no Open review control');
                    await act(async () => { await open.props.onPress(); });
                    const route = new URL(String(vi.mocked(router.push).mock.calls.at(-1)?.[0]), origin);
                    expect(decodeURIComponent(route.pathname)).toBe(`/artifacts/${reviewId}`);
                    expect(route.searchParams.get('serverId')).toBe(fixture.scope.serverId);
                    return screen.getTextContent();
                } finally { await screen.unmount(); unwatch(); native.dispose(); controller.dispose(); }
            };
            try {
                const artifact = await readArtifact(fixture.scope.serverId);
                const screen = await fixture.render(React.createElement(ArtifactView, { artifactId: reviewId, artifact,
                    presentation: 'page', focusThreadId: initial.id }));
                try {
                    await vi.waitFor(() => expect(screen.findHostByTestId(`review-finding:${initial.id}`)).not.toBeNull());
                    await waitForTestEvent(screen.subscribe, () => expect(screen.getTextContent()).toContain(evidence));
                    await screen.pressByTestIdAsync('plugin-evidence:inspect');
                    await vi.waitFor(() => expect(screen.findHostByTestId('plugin-evidence:read')).not.toBeNull());
                    expect(screen.getTextContent()).toContain(initial.id);
                    await screen.pressByTestIdAsync(`review-finding-triage:${initial.id}:reject`);
                    await vi.waitFor(async () => expect(await db.reviewComment.findUnique({ where: { id: initial.id } }))
                        .toMatchObject({ state: 'dismissed', reviewTriageStatus: 'reject' }));
                } finally { await screen.unmount(); }
                const page = await fixture.render(React.createElement(ArtifactView, { artifactId: reviewId, artifact,
                    presentation: 'page', pluginPageSelection: { pluginId: namespace, localId: 'review-evidence', subPath: '', view: null } }));
                try {
                    await vi.waitFor(() => expect(page.findHostByTestId('plugin-evidence:page'), page.getTextContent()).not.toBeNull());
                    expect(page.getTextContent()).toContain(reviewId);
                } finally { await page.unmount(); }
                await openEmbedded('PR');
                const saved = await db.reviewComment.findUniqueOrThrow({ where: { id: initial.id } });
                const transitions = JSON.parse(saved.transitionsJson);
                expect(transitions.filter((event: { reviewTriageStatus?: string }) => event.reviewTriageStatus === 'reject'))
                    .toEqual([expect.objectContaining({ transitionedBy: { kind: 'user', userId: account.id }, toState: 'dismissed',
                        serverRevision: saved.serverRevision })]);
                // Discard the mounted projection, then require real HTTP to reopen the SQL-backed history.
                await fixture.dispose(); standardCleanup(); resetReviewRunCommentsForTests();
                fixture = await openFixture();
                const inboxText = await openEmbedded('Inbox');
                expect(inboxText).toContain(account.id);
                expect(inboxText).toContain('Ignored');
                const prText = await openEmbedded('PR');
                expect(prText).toContain(account.id);
                expect(prText).toContain('Ignored');
                const reopened = await fixture.render(React.createElement(ArtifactView, { artifactId: reviewId,
                    artifact: await readArtifact(fixture.scope.serverId), presentation: 'page', focusThreadId: initial.id }));
                try {
                    await vi.waitFor(() => expect(reopened.findHostByTestId(`review-finding:${initial.id}`)).not.toBeNull());
                    await reopened.pressByTestIdAsync('review-detail:tab:activity');
                    const decisions = reopened.findByType(ReviewActivityFeed).props.events.filter((event: { kind: string }) => event.kind === 'decided');
                    expect(decisions).toEqual([expect.objectContaining({ decision: 'reject', actor: { kind: 'account', accountId: account.id } })]);
                    expect(reopened.findHostByTestId(`review-activity:${decisions[0].id}`)).not.toBeNull();
                } finally { await reopened.unmount(); }
                expect((await db.reviewComment.findUniqueOrThrow({ where: { id: initial.id } })).transitionsJson).toBe(saved.transitionsJson);
                expect(await db.reviewComment.count({ where: { reviewId } })).toBe(1);
                expect(await setActivePluginAccountAvailabilityIntent({ pluginId: namespace, desiredVersion: null,
                    enabled: false, offlineUiHosting: 'disabled', writableCollections: [], expectedRevision: null }))
                    .toMatchObject({ kind: 'updated', intent: { enabled: false } });
                extensionEnabled = false;
                await fixture.dispose(); standardCleanup(); resetReviewRunCommentsForTests();
                fixture = await openFixture();
                const fallback = await fixture.render(React.createElement(ArtifactView, { artifactId: reviewId,
                    artifact: await readArtifact(fixture.scope.serverId), presentation: 'page', focusThreadId: initial.id }));
                try {
                    await vi.waitFor(() => expect(fallback.findHostByTestId(`review-finding:${initial.id}`)).not.toBeNull());
                    expect(fallback.getTextContent()).toContain(initialFinding.title);
                    expect(fallback.findHostByTestId('plugin-evidence:inspect')).toBeNull();
                    await fallback.pressByTestIdAsync(`review-finding-triage:${initial.id}:accept`);
                    await vi.waitFor(async () => expect(await db.reviewComment.findUnique({ where: { id: initial.id } }))
                        .toMatchObject({ reviewTriageStatus: 'accept' }));
                    const retained = ReviewCommentGetResponseV1Schema.parse(await createCliReviewCommentActionExecutorFromCredentials({
                        credentials: { token, encryption: null } })('reviews.comments.get', { reviewId, commentId: initial.id }));
                    expect(retained.comment?.extensions?.[namespace]).toEqual({ reproduction: evidence });
                } finally { await fallback.unmount(); }
                await openEmbedded('PR');
                await openEmbedded('Inbox');
            } finally { standardCleanup(); await fixture.dispose(); }
        });
    }, { authentication: 'real' });
    } finally { assetBoundary.mockRestore(); restoreArtifacts(); for (const file of localFiles) file.delete(); }
});

it('retains reviewer omission explanations, partial coverage and question states from publication through detail and an unavailable refresh', async () => {
    const { act } = await import('react-test-renderer');
    const { ReviewModelOutputV1Schema } = await import('@happier-dev/protocol/reviews/reviewModelOutputV1');
    const { RPC_METHODS, SESSION_RPC_METHODS } = await import('@happier-dev/protocol/rpc');
    const { projectExecutionRunPublicState } = await import('../../../../../cli/src/agent/runtime/bridges/executionRun/publicState');
    const { EXECUTION_RUN_CAPABILITIES_DESCRIBE_FIXTURE } = await import('../../../../../ui/sources/dev/testkit/fixtures/executionRunCapabilitiesDescribe');
    const { createSessionReadBatchFetchBoundary } = await import('../../../../../ui/sources/dev/testkit/harness/sessionReadBatchHttpBoundary');
    const { createPlainV2SessionRecordFixture } = await import('../../../../../ui/sources/dev/testkit/fixtures/sessionFixtures');
    const { notifyExecutionRunActivityFromUpdate } = await import('../../../../../ui/sources/sync/runtime/executionRuns/executionRunActivityBus');
    const { ArtifactView } = await import('../../../../../ui/sources/components/artifacts/ArtifactView');
    const account = await db.account.upsert({ where: { id: 'alice' }, update: {}, create: { id: 'alice', encryptionMode: 'plain' } });
    const token = await createAccountTokenForTests(account.id, { kind: 'account', authority: 'present_user' });
    const machineId = 'm1', installationId = randomUUID(), sessionId = randomUUID(), keyPair = tweetnacl.sign.keyPair();
    await createTrustedMachineInstallation({ accountId: account.id, machineId, installationId, keyPair });
    await db.session.create({ data: { id: sessionId, accountId: account.id, tag: sessionId, metadata: '{}', encryptionMode: 'plain' } });
    // The external reviewer reports omissions in its existing narrative contract; the host
    // must retain that disclosure rather than infer counts or equate an empty list with clean coverage.
    const explanation = 'Unchanged findings and style nits were withheld. Outside-scope issues were not posted. Coverage is partial because generated files could not be inspected.';
    const modelOutput = ReviewModelOutputV1Schema.parse({ reviewOutcome: 'partial', summary: 'Incomplete coverage',
        overviewMarkdown: explanation, findings: [{ id: 'retained-finding', title: 'Retained supported finding',
            summary: 'Keep the supported evidence.', severity: 'high', category: 'correctness', filePath: 'connection.ts', startLine: 8 }],
        questions: [{ id: 'open-question', text: 'Which generated sources should be reviewed?', status: 'open' },
            { id: 'answered-question', text: 'The build target was clarified.', status: 'answered' },
            { id: 'superseded-question', text: 'Obsolete scope question.', status: 'superseded' }], assumptions: [] });
    await withAuthenticatedTestApp(app => {
        registerReviewCommentRoutes(app); registerReviewReadRoutes(app); artifactsRoutes(app); registerAccountEncryptionRoutes(app);
    }, async app => {
        const origin = await app.listen({ host: '127.0.0.1', port: 0 });
        await runWithServerHttpBaseUrl(origin, async () => {
            const artifacts = createCredentialedAccountArtifactStore({ token, encryption: null });
            const records = createReviewRecordPortV1(createAcknowledgedAccountArtifactTransport(artifacts));
            const reviewId = randomUUID();
            const binding = await records.start({ reviewId, title: 'Reviewer coverage disclosure', subjectKind: 'repository',
                sourceKind: 'direct', reviewerIds: ['reviewer'], startedAt: Date.now() });
            const runId = randomUUID();
            const run: ExecutionRunState = { runId, callId: runId, sidechainId: runId, sessionId, depth: 0, intent: 'review',
                backendId: 'claude', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, instructions: 'Review.',
                permissionMode: 'read_only', retentionPolicy: 'resumable', runClass: 'bounded', ioMode: 'request_response',
                status: 'running', startedAtMs: Date.now(),
                intentInput: { reviewRound: binding, reviewReviewerId: 'reviewer', reviewRoundSettlement: 'execution' } };
            const normalized = normalizeStrictJsonReviewOutput({ ...run, finishedAtMs: Date.now(), rawText: JSON.stringify(modelOutput) });
            expect(normalized.status).toBe('succeeded');
            const execute = createCliReviewCommentActionExecutorFromCredentials({ credentials: { token, encryption: null },
                resolvePrincipalSigningContext: async () => ({ machineId, installationId,
                    privateKeyBase64Url: Buffer.from(keyPair.secretKey).toString('base64url') }) });
            const comments = createReviewRunCommentService({ cwd: harness.baseDir,
                scope: { workspace: { machineId, path: harness.baseDir } }, execute, reviewRecords: records });
            const publication = await materializeReviewFindings({ run, toolResult: { output: normalized.toolResultOutput },
                structuredMeta: normalized.structuredMeta, expectFindings: true, reviewComments: comments });
            expect(publication.materialization).toMatchObject({ status: 'materialized', failures: [] });
            const finding = publication.materialization?.comments[0]?.comment;
            if (!finding) throw new Error('Supported finding was not published');
            const completed: ExecutionRunState = { ...run, status: 'succeeded', finishedAtMs: Date.now(),
                structuredMeta: publication.structuredMeta };
            await comments.settleRound(completed);
            const published = ReviewFindingsV2Schema.parse(publication.structuredMeta?.payload);
            expect(published).toMatchObject({ reviewOutcome: 'partial', overviewMarkdown: explanation,
                questions: modelOutput.questions });
            expect(await records.read(reviewId)).toMatchObject({ rounds: [{ state: 'partial',
                runs: [{ kind: 'execution', machineId, sessionId, runId }],
                reviewerQuestionSummaries: [{ overviewMarkdown: explanation }] }] });
            expect(await db.reviewComment.count({ where: { reviewId } })).toBe(1);
            let unavailable = false;
            const fixture = await createSessionFilesViewFixture({ serverUrl: origin, credentials: { token }, sessionId,
                serverIdentityId: await getOrCreateServerIdentityId(), rpc: request => {
                    if (request.method === RPC_METHODS.CAPABILITIES_DESCRIBE) return EXECUTION_RUN_CAPABILITIES_DESCRIBE_FIXTURE;
                    if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_GET) {
                        if (unavailable) return { ok: false, errorCode: 'execution_run_target_unavailable', error: 'Disconnected' };
                        return { run: projectExecutionRunPublicState(completed), reviewFindings: published };
                    }
                    return undefined;
                }, request: createSessionReadBatchFetchBoundary(async (url, init) => {
                    const path = new URL(String(url)).pathname;
                    if (path.startsWith('/v1/reviews/') || path.startsWith('/v1/artifacts') || path.startsWith('/v1/account/encryption'))
                        return fetch(url, init);
                    if (path === `/v2/sessions/${sessionId}`) return Response.json({ session: createPlainV2SessionRecordFixture({
                        id: sessionId, metadata: { path: harness.baseDir, host: 'test', machineId },
                    }) });
                    return undefined;
                }) });
            try {
                const row = await artifacts.read(reviewId);
                if (!row || typeof row.body !== 'string') throw new Error('Persisted Review unavailable');
                const artifact: DecryptedArtifact = { id: reviewId, sourceServerId: fixture.scope.serverId,
                    title: 'Reviewer coverage disclosure', isDecrypted: true,
                    header: { ...row.header, title: 'Reviewer coverage disclosure' }, body: row.body,
                    ownerAccountId: account.id, access: 'owner', storageMode: 'plain',
                    headerVersion: row.revision.headerVersion, bodyVersion: row.revision.bodyVersion,
                    seq: 1, createdAt: 1, updatedAt: 1 };
                const screen = await fixture.render(React.createElement(ArtifactView, {
                    artifactId: reviewId, artifact, presentation: 'page',
                }));
                try {
                    // Control: real signed publication, SQL and artifact HTTP already reach the
                    // mounted detail before checking the narrative that its run reader dropped.
                    await vi.waitFor(() => expect(screen.findByTestId(`review-finding:${finding.id}`), screen.getTextContent()).not.toBeNull());
                    await vi.waitFor(() => expect(screen.getTextContent()).toContain(modelOutput.questions[0]!.text));
                    expect(screen.getTextContent()).toContain(modelOutput.questions[1]!.text);
                    expect(screen.getTextContent()).not.toContain(modelOutput.questions[2]!.text);
                    expect(screen.findByTestId('review-detail:quality')).not.toBeNull();
                    expect(screen.getTextContent()).toContain(explanation);
                    unavailable = true;
                    await act(async () => notifyExecutionRunActivityFromUpdate(fixture.scope.serverId, {
                        type: 'execution-run-updated', sessionId, run: { runId },
                    }));
                    expect(fixture.requests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_GET)).toHaveLength(0);
                    expect(screen.findByTestId('review-detail:questions-unavailable')).toBeNull();
                    expect(screen.getTextContent()).toContain(explanation);
                    expect(screen.findByTestId(`review-finding:${finding.id}`)).not.toBeNull();
                    expect(screen.getTextContent()).toContain(modelOutput.questions[0]!.text);
                    expect(screen.getTextContent()).toContain(modelOutput.questions[1]!.text);
                    expect(screen.getTextContent()).not.toContain(modelOutput.questions[2]!.text);
                } finally { await screen.unmount(); }
            } finally { await fixture.dispose(); }
        });
    }, { authentication: 'real' });
});

it('carries an actual Session start through Reviews, a human decision and a cold Session summary', async () => {
    const { ExecutionRunStartRequestSchema } = await import('@happier-dev/protocol/execution/runs/startRequest');
    const { ReviewRoundBindingV1Schema } = await import('@happier-dev/protocol/reviews/reviewArtifactV1');
    const { readReviewStartActionResultV1 } = await import('@happier-dev/protocol/actions/specs/executionRunCompletion');
    const { DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1 } = await import('@happier-dev/protocol/account/settings/sessionAgentSpawnPolicyV1');
    const { ReviewProfile } = await import('../../../../../cli/src/agent/executionRuns/profiles/review/ReviewProfile');
    const { finishExecutionRun } = await import('../../../../../cli/src/agent/runtime/bridges/executionRun/finishExecutionRun');
    const { projectExecutionRunPublicState } = await import('../../../../../cli/src/agent/runtime/bridges/executionRun/publicState');
    const { ReviewListRequestV1Schema } = await import('@happier-dev/protocol/reviews/reviewListV1');
    const { RPC_METHODS, SESSION_RPC_METHODS } = await import('@happier-dev/protocol/rpc');
    const { EXECUTION_RUN_CAPABILITIES_DESCRIBE_FIXTURE } = await import('../../../../../ui/sources/dev/testkit/fixtures/executionRunCapabilitiesDescribe');
    const { createSessionReadBatchFetchBoundary } = await import('../../../../../ui/sources/dev/testkit/harness/sessionReadBatchHttpBoundary');
    const { createPlainV2SessionRecordFixture } = await import('../../../../../ui/sources/dev/testkit/fixtures/sessionFixtures');
    const { reportCollectionLayout } = await import('../../../../../ui/sources/dev/testkit/harness/collectionLayoutHarness');
    const { PluginSurfaceFocusEligibilityProvider } = await import('../../../../../ui/sources/components/ui/presentation/PluginSurfaceFocusEligibility');
    const { ReviewsListHost } = await import('../../../../../ui/sources/components/reviews/ReviewsListHost');
    const { ArtifactDetailScreen } = await import('../../../../../ui/sources/app/(app)/artifacts/[id]');
    const { ReviewFindingsMessageCard } = await import('../../../../../ui/sources/components/sessions/reviews/messages/ReviewFindingsMessageCard');
    const { AppSessionTranscriptSourceProvider } = await import('../../../../../ui/sources/components/sessions/transcript/source/appSessionTranscriptSource');
    const { ReviewSummary } = await import('../../../../../ui/sources/components/reviews/summary/ReviewSummary');
    const { ReviewSummaryHost } = await import('../../../../../ui/sources/components/reviews/summary/ReviewSummaryHost');
    const { reviewListKey, retireReviewList, getReviewListSnapshot } = await import('../../../../../ui/sources/sync/store/domains/reviews/list');
    const { reviewDetailKey, retireReviewDetail, getReviewDetailSnapshot } = await import('../../../../../ui/sources/sync/store/domains/reviews/detail');
    const { resetReviewRunCommentsForTests } = await import('../../../../../ui/sources/sync/domains/reviews/comments/reviewRunComments');
    const { useRouter } = await import('expo-router');
    const account = await db.account.upsert({ where: { id: 'alice' }, update: {}, create: { id: 'alice', encryptionMode: 'plain' } });
    const token = await createAccountTokenForTests(account.id, { kind: 'account', authority: 'present_user' });
    const machineId = randomUUID(), installationId = randomUUID(), sessionId = randomUUID(), keyPair = tweetnacl.sign.keyPair();
    await createTrustedMachineInstallation({ accountId: account.id, machineId, installationId, keyPair });
    await db.session.create({ data: { id: sessionId, accountId: account.id, tag: sessionId,
        metadata: '{}', encryptionMode: 'plain', seq: 7 } });
    await withAuthenticatedTestApp(app => {
        registerReviewCommentRoutes(app); registerReviewReadRoutes(app); artifactsRoutes(app); registerAccountEncryptionRoutes(app);
    }, async app => {
        const origin = await app.listen({ host: '127.0.0.1', port: 0 });
        await runWithServerHttpBaseUrl(origin, async () => {
            const records = createReviewRecordPortV1(createAcknowledgedAccountArtifactTransport(
                createCredentialedAccountArtifactStore({ token, encryption: null })));
            const starts: ExecutionRunState[] = [];
            const executor = createActionExecutor({
                ...createAccountServerActionDeps({ token, serverId: origin, serverHttpBaseUrl: origin }),
                reviewRecords: () => records,
                // Only daemon inventory/protocol/start RPCs cross the process boundary; admission stays real.
                reviewEnginesList: async () => ({ items: [{ value: 'codex', label: 'Codex', enabled: true,
                    capabilities: { structuredNarration: true } }] }),
                executionRunCheckProtocolV2: async () => ({ ok: true, exactMachineId: machineId }),
                executionRunStart: async (sourceSessionId, input) => {
                    const request = ExecutionRunStartRequestSchema.parse(input);
                    const backendTarget = resolveExecutionRunRuntimeBackendTarget(request.backendTarget);
                    if (!backendTarget) throw new Error('Missing admitted reviewer target');
                    const run: ExecutionRunState = { runId: randomUUID(), callId: randomUUID(), sidechainId: randomUUID(),
                        sessionId: sourceSessionId, depth: 0, intent: 'review',
                        backendId: resolveExecutionRunRuntimeBackendId(backendTarget), backendTarget,
                        instructions: request.instructions ?? '', permissionMode: request.permissionMode,
                        retentionPolicy: request.retentionPolicy, runClass: request.runClass, ioMode: request.ioMode,
                        status: 'running', startedAtMs: Date.now(), intentInput: request.intentInput };
                    starts.push(run);
                    return { runId: run.runId, callId: run.callId, sidechainId: run.sidechainId };
                },
            });
            const started = await executor.execute('review.start', { sessionId, scope: 'repository',
                instructions: 'Review connection cleanup.', reviewers: [{ kind: 'engine', engineId: 'codex' }] }, {
                surface: 'cli', authority: 'present_user', serverId: origin, bypassApprovals: true, defaultSessionId: sessionId,
                callerPermissionMode: 'read-only', sessionAgentSpawnPolicyV1: DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
                agentStartContext: { caller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 },
                    baseline: { machineId, directory: harness.baseDir }, roles: {}, ledSubtreeSessionIds: [],
                    workDepthLimit: 4, callerPermissionCeiling: 'read-only' },
            });
            expect(started, JSON.stringify(started)).toMatchObject({ ok: true });
            if (!started.ok) throw new Error(started.error);
            const receipt = readReviewStartActionResultV1(started.result, { reviewers: [{ kind: 'engine', engineId: 'codex' }] });
            if (receipt.kind !== 'native') throw new Error('Expected native Review admission');
            const binding = ReviewRoundBindingV1Schema.parse(receipt.reviewRound);
            expect(starts).toHaveLength(1);
            const run = starts[0]!;
            const execute = createCliReviewCommentActionExecutorFromCredentials({ credentials: { token, encryption: null },
                resolvePrincipalSigningContext: async () => ({ machineId, installationId,
                    privateKeyBase64Url: Buffer.from(keyPair.secretKey).toString('base64url') }) });
            const comments = createReviewRunCommentService({ cwd: harness.baseDir,
                scope: { workspace: { machineId, path: harness.baseDir } }, execute, reviewRecords: records });
            const completion = ReviewProfile.onBoundedComplete({ start: run, finishedAtMs: Date.now(),
                rawText: JSON.stringify({ reviewOutcome: 'complete', summary: 'Connection cleanup needs a decision.', findings: [{
                    id: 'cleanup', title: 'Reconnect retains a closed subscription', severity: 'high', category: 'correctness',
                    summary: 'Release the subscription before reconnecting.', filePath: 'connection.ts', startLine: 8,
                }] }) });
            expect(completion.status).toBe('succeeded');
            const runs = new Map([[run.runId, run]]);
            expect(await finishExecutionRun({ runId: run.runId,
                next: { status: 'succeeded', summary: completion.summary, finishedAtMs: Date.now() },
                toolResult: { output: completion.toolResultOutput, meta: completion.toolResultMeta }, structuredMeta: completion.structuredMeta,
                runs, controllers: new Map(), budgetRegistry: null, parentProvider: 'claude', sendAcp: async () => {},
                enqueueMarkerWrite: async (_id, write) => { await write(); }, terminalMarkerWritePromises: new Map(), reviewComments: comments })).toBe(true);
            const completed = runs.get(run.runId)!;
            const published = ReviewFindingsV2Schema.parse(completed.structuredMeta?.payload);
            const finding = published.findings[0]!;
            expect(finding.comment).toMatchObject({ reviewId: binding.reviewId });
            const commentId = finding.comment!.id;
            const listInputs: ReturnType<typeof ReviewListRequestV1Schema.parse>[] = [];
            const reads: string[] = [];
            const serverIdentityId = await getOrCreateServerIdentityId();
            const openFixture = () => createSessionFilesViewFixture({ serverUrl: origin, credentials: { token }, sessionId, machineId,
                serverIdentityId, rpc: request => {
                    if (request.method === RPC_METHODS.CAPABILITIES_DESCRIBE) return EXECUTION_RUN_CAPABILITIES_DESCRIBE_FIXTURE;
                    if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_GET)
                        return { run: projectExecutionRunPublicState(completed), reviewFindings: published };
                    return undefined;
                }, request: createSessionReadBatchFetchBoundary(async (url, init) => {
                    const path = new URL(String(url)).pathname;
                    if (path.startsWith('/v1/reviews/') || path.startsWith('/v1/artifacts') || path.startsWith('/v1/account/encryption')) {
                        reads.push(path);
                        if (path === '/v1/reviews/list') listInputs.push(ReviewListRequestV1Schema.parse(JSON.parse(String(init?.body))));
                        return fetch(url, init);
                    }
                    if (path === `/v2/sessions/${sessionId}`) return Response.json({ session: createPlainV2SessionRecordFixture({
                        id: sessionId, metadata: { path: harness.baseDir, host: 'test', machineId },
                    }) });
                    return undefined;
                }) });
            let fixture = await openFixture();
            const router = useRouter();
            const listElement = React.createElement(PluginSurfaceFocusEligibilityProvider, { active: true, presentationActive: true,
                children: React.createElement(ReviewsListHost, { surface: 'column' }) });
            const openList = async () => {
                const screen = await fixture.render(listElement);
                await reportCollectionLayout(screen, 'reviews:column');
                await vi.waitFor(() => expect(screen.findHostByTestId(`reviews:column:row:${binding.reviewId}`),
                    `${screen.getTextContent()}\n${JSON.stringify(listInputs)}`).not.toBeNull());
                return screen;
            };
            try {
                const list = await openList();
                try {
                    await list.pressByTestIdAsync(`reviews:column:row:${binding.reviewId}`);
                    expect(decodeURIComponent(String(vi.mocked(router.push).mock.calls.at(-1)?.[0]))).toContain(`/artifacts/${binding.reviewId}`);
                } finally { await list.unmount(); }
                // The route owns its real Artifact subscription; no body is seeded into the host.
                router.setParams({ id: binding.reviewId, thread: commentId });
                const detail = await fixture.render(React.createElement(ArtifactDetailScreen));
                try {
                    await vi.waitFor(() => expect(detail.findHostByTestId(`review-finding:${commentId}`),
                        detail.getTextContent()).not.toBeNull());
                    await detail.pressByTestIdAsync(`review-finding-triage:${commentId}:reject`);
                    await vi.waitFor(async () => expect(await db.reviewComment.findUnique({ where: { id: commentId } }))
                        .toMatchObject({ reviewId: binding.reviewId, state: 'dismissed', reviewTriageStatus: 'reject' }));
                } finally { await detail.unmount(); }
                const saved = ReviewCommentGetResponseV1Schema.parse(await execute('reviews.comments.get', {
                    reviewId: binding.reviewId, commentId })).comment;
                expect(saved.transitions.at(-1)).toMatchObject({ transitionedBy: { kind: 'user', userId: account.id }, reviewTriageStatus: 'reject' });
                const scope = { serverId: fixture.scope.serverId, accountId: account.id };
                const listKey = reviewListKey(scope, listInputs.at(-1)!);
                await fixture.dispose(); standardCleanup(); resetReviewRunCommentsForTests();
                retireReviewList(listKey); retireReviewDetail(reviewDetailKey(scope, binding.reviewId));
                expect(getReviewListSnapshot(listKey).items).toBeNull();
                expect(getReviewDetailSnapshot(reviewDetailKey(scope, binding.reviewId)).data).toBeNull();
                reads.length = 0;
                fixture = await openFixture();
                const reloaded = await openList();
                try {
                    expect(getReviewListSnapshot(listKey).items?.find(row => row.reviewId === binding.reviewId))
                        .toMatchObject({ sourceSessionId: sessionId, sourceSessionSeq: 7, counts: { total: 1, needsDecision: 0 } });
                } finally { await reloaded.unmount(); }
                const card = await fixture.render(React.createElement(AppSessionTranscriptSourceProvider, { sessionId, serverId: fixture.scope.serverId,
                    children: React.createElement(ReviewFindingsMessageCard, { sessionId, serverId: fixture.scope.serverId,
                        payload: published, canSendMessages: false }) }));
                try {
                    await vi.waitFor(() => expect(card.tree.root.findByType(ReviewSummary).props.rows)
                        .toContainEqual(expect.objectContaining({ rowId: finding.id, decision: 'reject' })));
                    expect(card.tree.root.findByType(ReviewSummaryHost).props.reviewId).toBe(binding.reviewId);
                    expect(card.getTextContent()).toContain(finding.title);
                    await card.pressByTestIdAsync('review-summary:open');
                    expect(decodeURIComponent(String(vi.mocked(router.push).mock.calls.at(-1)?.[0]))).toContain(`/artifacts/${binding.reviewId}`);
                    expect(reads).toContain('/v1/reviews/list');
                    expect(reads).toContain('/v1/reviews/get');
                    expect(reads).toContain('/v1/reviews/comments');
                } finally { await card.unmount(); }
                expect(ReviewCommentGetResponseV1Schema.parse(await execute('reviews.comments.get', {
                    reviewId: binding.reviewId, commentId })).comment).toEqual(saved);
            } finally { standardCleanup(); await fixture.dispose(); }
        });
    }, { authentication: 'real' });
});

it('persists a mounted gutter comment through a cold PR read while keeping Viewed personal and comparison scoped', async () => {
    const { act } = await import('react-test-renderer');
    const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');
    const { CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION } = await import('@happier-dev/protocol');
    const { captureAccountStoredContentCompatibilityForHttpRequest } = await import('@/app/clientCompatibility/accountStoredContentCompatibility');
    const { decodeBase64StoredJsonContentEnvelope } = await import('../../../../../ui/sources/sync/encryption/base64StoredJsonContent');
    const { ScmReviewedMarkInputSchema } = await import('@happier-dev/protocol/scm/reviewedMarks');
    const { buildScmFileReviewUnits, buildScmReviewScopeId } = await import('@happier-dev/protocol/scm/comparisonOccurrences');
    const { buildScmReviewedMarksKey } = await import('@happier-dev/protocol/scm/reviewedMarks');
    const { createLocalScmRepositoryFixture } = await import('../../../../../cli/src/testkit/scm/scmBackendContractFixtures');
    const { removeTempDir } = await import('../../../../../cli/src/testkit/fs/tempDir');
    const { runWithScmAccountScope } = await import('../../../../../cli/src/scm/accountScope');
    const { captureScmComparison } = await import('../../../../../cli/src/scm/comparisons/captureScmComparison');
    const { executeScmActionOperation } = await import('../../../../../cli/src/scm/actions/executeScmActionOperation');
    const { createCliScmReviewedMarkAction } = await import('../../../../../cli/src/scm/actions/executeScmReviewedMarkAction');
    const { kvRoutes } = await import('@/app/api/routes/kv/kvRoutes');
    const { ReviewChangesHost } = await import('../../../../../ui/sources/components/reviews/ReviewChangesHost');
    const { WorkspaceScmReviewBody } = await import('../../../../../ui/sources/components/projects/scm/WorkspaceScmReviewBody');
    const { CodeLineRow } = await import('../../../../../ui/sources/components/ui/code/view/CodeLineRow');
    const { TextInput } = await import('../../../../../ui/sources/components/ui/text/Text');
    const { pressTestInstanceAsync, flushHookEffects, renderHook } = await import('../../../../../ui/sources/dev/testkit');
    const { resetReviewRunCommentsForTests } = await import('../../../../../ui/sources/sync/domains/reviews/comments/reviewRunComments');
    const { createHomeHubArtifactHttpBoundary } = await import('../../../../../ui/sources/dev/testkit/harness/homeHubArtifactHttpBoundary');
    const { restoreServerAccountForTest } = await import('../../../../../ui/sources/dev/testkit/harness/serverAccountConnectionHarness');
    const { InjectedAuthProvider } = await import('../../../../../ui/sources/auth/context/AuthContext');
    const { useScmReviewedMarks } = await import('../../../../../ui/sources/components/sessions/files/comparison/useScmReviewedMarks');
    const { PluginUiProvider } = await import('@happier-dev/plugin-ui/advanced');
    const { Button } = await import('@happier-dev/plugin-ui/components');
    const { ArtifactView } = await import('../../../../../ui/sources/components/artifacts/ArtifactView');
    const { router } = await import('expo-router');
    const { GithubHappierReviewSummary } = await import('../../../../../../packages/plugins/scm-github/src/ui/detail/happierReviewSummary');
    const { GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1 } = await import('../../../../../../packages/plugins/scm-github/src/triage/contribution');
    const { PLUGIN_MANIFEST: githubManifest } = await import('../../../../../../packages/plugins/scm-github/src/manifest');
    const { createBoundPluginSurfaceController } = await import('../../../../../ui/sources/components/plugins/surfaces/boundPluginSurfaceController');
    const { createCanonicalPluginReactNativeHostApiAdapter } = await import('../../../../../ui/sources/components/plugins/reactNative/hostApi');
    const { createPluginSurfaceContextFixture } = await import('../../../../../ui/sources/dev/testkit/fixtures/pluginSurfaceContextFixture');
    const { captureActiveServerAccountScopeLifetime } = await import('../../../../../ui/sources/sync/domains/scope/activeServerAccountScope');
    const { readPluginAccountAvailability } = await import('../../../../../ui/sources/sync/domains/plugins/availability/projection');
    const { getSyncSingleton } = await import('../../../../../ui/sources/sync/runtime/getSyncSingleton');
    const { projectBundledPluginUiDeclaration } = await import('../../../../../cli/scripts/build-owned/bundledPlugins/uiDeclarations.mjs');
    const { installBundledPluginUiDeclarationsForTests } = await import('../../../../../ui/sources/dev/testkit/mocks/bundledPluginUiAssets');
    const account = await db.account.upsert({ where: { id: 'alice' }, update: {}, create: { id: 'alice', encryptionMode: 'plain' } });
    const other = await db.account.create({ data: { id: randomUUID(), encryptionMode: 'plain' } });
    const token = await createAccountTokenForTests(account.id, { kind: 'account', authority: 'present_user' });
    const otherToken = await createAccountTokenForTests(other.id, { kind: 'account', authority: 'present_user' });
    const repository = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-review-gutter-' });
    const cwd = repository.rootPath;
    try {
        await writeFile(join(cwd, repository.trackedPath), 'const total = prices.reduce(add);\n');
        await writeFile(join(cwd, 'package-lock.json'), '{"lockfileVersion":3}\n');
        await withAuthenticatedTestApp(app => {
            app.addHook('preHandler', async request => { captureAccountStoredContentCompatibilityForHttpRequest(request); });
            registerReviewCommentRoutes(app); registerReviewReadRoutes(app); artifactsRoutes(app); registerAccountEncryptionRoutes(app); kvRoutes(app);
        }, async app => {
            const origin = await app.listen({ host: '127.0.0.1', port: 0 });
            await runWithServerHttpBaseUrl(origin, () => runWithScmAccountScope(account.id, async () => {
                const captured = await captureScmComparison({ cwd, source: { kind: 'workingTree' } });
                const comparison = captured.comparison;
                expect(comparison.inventory.files.map(file => file.path)).toEqual(expect.arrayContaining([repository.trackedPath, 'package-lock.json']));
                const artifacts = createCredentialedAccountArtifactStore({ token, encryption: null });
                const records = createReviewRecordPortV1(createAcknowledgedAccountArtifactTransport(artifacts));
                const reviewId = randomUUID();
                const capture = { target: { kind: 'machine' as const, machineId: 'm1' }, input: { cwd, comparisonId: comparison.id, source: comparison.source } };
                const binding = await records.start({ reviewId, title: 'Durable gutter review', subjectKind: 'repository', sourceKind: 'direct',
                    reviewerIds: [], startedAt: Date.now(), comparisonCapture: capture });
                await records.settle({ ...binding, outcome: 'completed', finishedAt: Date.now(), runs: [] });
                const serverIdentityId = await getOrCreateServerIdentityId();
                const machineCalls: Array<{ method: string; payload: unknown }> = [];
                const executeScm = async (actionId: Parameters<typeof executeScmActionOperation>[0]['actionId'], input: unknown) =>
                    executeScmActionOperation({ actionId, input, workingDirectory: cwd, accessPolicy: { kind: 'restrictedRoots', roots: [cwd] },
                        executeReviewedMarks: (evidence, request, reviewed) => createCliScmReviewedMarkAction({
                            credentials: { token, encryption: null }, serverBaseUrl: origin,
                            resolveAuthorizationHeaders: () => ({ Authorization: `Bearer ${token}` }),
                            ...('id' in evidence ? { comparison: evidence } : { source: evidence }),
                            ...('reset' in request ? { reset: true as const } : 'changeKeys' in request ? { changeKeys: request.changeKeys } : { changeRefs: request.changeRefs }), reviewed,
                        }),
                    });
                // Only the Machine/Home transport is substituted; the admitted SCM owner
                // captures, pages, reads evidence and writes the real per-Account KV route.
                const homeBoundary = createHomeHubArtifactHttpBoundary(account.id);
                const request = async (url: RequestInfo | URL, init?: RequestInit) => {
                    const path = new URL(String(url)).pathname;
                    if (path.startsWith('/v1/reviews/') || path.startsWith('/v1/artifacts') || path.startsWith('/v1/account/encryption') || path.startsWith('/v1/kv')) return fetch(url, init);
                    return homeBoundary.request(url, init);
                };
                const openFixture = () => createSessionFilesViewFixture({ serverUrl: origin, rootPath: cwd, credentials: { token }, serverIdentityId,
                    featureOverrides: { features: { plugins: { enabled: true, ui: { enabled: true,
                        hostedWeb: { enabled: false }, reactNativeBundles: { enabled: true } } } } },
                    settings: { featureToggles: { 'files.reviewComments': true } }, request,
                    rpc: call => {
                        machineCalls.push(call);
                        if (call.method === RPC_METHODS.SCM_DIFF_FILE) return executeScm('scm.diff.file', call.payload);
                        if (call.method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE) return executeScm('scm.diffSummary.capture', call.payload);
                        if (call.method === RPC_METHODS.SCM_DIFF_SUMMARY_REVIEWED_MARK) return executeScm('scm.diffSummary.reviewed.mark', ScmReviewedMarkInputSchema.parse(call.payload));
                        return undefined;
                    } });
                const declaration = await projectBundledPluginUiDeclaration({ packageName: '@happier-dev/plugins-scm-github', packageVersion: githubManifest.version,
                    manifest: githubManifest, artifactGraphs: [] });
                if (!declaration) throw new Error('The authored PR renderer declaration is unavailable');
                const restoreInventory = installBundledPluginUiDeclarationsForTests([declaration]);
                try {
                    let fixture = await openFixture();
                    const body = 'Keep the addition in the captured total.';
                    const mountChanges = async (selected = capture, active = true) => {
                        const screen = await fixture.render(React.createElement(ReviewChangesHost, { reviewId, roundOrdinal: 1,
                            scope: { serverId: fixture.scope.serverId, accountId: account.id }, capture: selected, comments: [], view: 'files',
                            onSelectView() {}, onOpenComment() {}, active }));
                        if (active) {
                            await vi.waitFor(() => expect(screen.findAllByType(WorkspaceScmReviewBody)).toHaveLength(1));
                            await act(async () => { screen.findByType(WorkspaceScmReviewBody).findAll(node => typeof node.props.onLayout === 'function')[0]
                                ?.props.onLayout({ nativeEvent: { layout: { width: 900, height: 360 } } }); });
                            await vi.waitFor(() => expect(screen.findAllByType(CodeLineRow).some(row => row.props.line.kind === 'add'), screen.getTextContent()).toBe(true));
                        }
                        return screen;
                    };
                    try {
                        const hidden = await mountChanges(capture, false);
                        await flushHookEffects({ cycles: 20 });
                        expect(machineCalls).toEqual([]);
                        await hidden.unmount();
                        const screen = await mountChanges();
                        try {
                            const row = screen.findAllByType(CodeLineRow).find(item => item.props.line.kind === 'add');
                            if (!row) throw new Error('The captured added line is not mounted');
                            const hover = row.findAll(node => typeof node.type === 'string' && typeof node.props.onHoverIn === 'function')[0];
                            if (!hover) throw new Error('The actual gutter row has no hover control');
                            await act(async () => { hover.props.onHoverIn({}); });
                            const gutter = row.findAll(node => typeof node.type === 'string' && node.props.testID === 'review-comment-line-affordance'
                                && typeof node.props.onPress === 'function')[0];
                            if (!gutter) throw new Error('The hovered line has no comment affordance');
                            await act(async () => { await pressTestInstanceAsync(gutter); });
                            await act(async () => { screen.findByType(TextInput).props.onChangeText(body); });
                            expect(await db.reviewComment.count({ where: { reviewId } })).toBe(0);
                            await screen.pressByTestIdAsync('review-comment-composer-save');
                            await vi.waitFor(async () => expect(await db.reviewComment.count({ where: { reviewId } })).toBe(1));
                            await screen.pressByTestIdAsync(`diff-file-menu:${repository.trackedPath}`);
                            await screen.pressByTestIdAsync('diff-file-viewed');
                            await vi.waitFor(async () => expect(await db.userKVStore.findUnique({ where: { accountId_key: { accountId: account.id,
                                key: buildScmReviewedMarksKey(buildScmReviewScopeId({ repositoryRootPath: cwd, source: comparison.source })) } } })).not.toBeNull());
                        } finally { await screen.unmount(); }
                        const scopeId = buildScmReviewScopeId({ repositoryRootPath: cwd, source: comparison.source });
                        const marksKey = buildScmReviewedMarksKey(scopeId);
                        const readMarks = async (bearer: string) => {
                            const response = await fetch(`${origin}/v1/kv/${encodeURIComponent(marksKey)}`, { headers: { Authorization: `Bearer ${bearer}`, 'x-happier-account-stored-content-protocol': String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION) } });
                            return { status: response.status, row: await response.json() };
                        };
                        await vi.waitFor(async () => expect((await readMarks(token)).status).toBe(200));
                        const saved = await db.reviewComment.findFirstOrThrow({ where: { reviewId } });
                        const ownerRecord = (await readMarks(token)).row;
                        const expectedKeys = buildScmFileReviewUnits(comparison.inventory.files.find(file => file.path === repository.trackedPath)!).map(unit => unit.key);
                        expect(decodeBase64StoredJsonContentEnvelope(ownerRecord.value)).toMatchObject({ t: 'plain', v: { reviewedChangeKeys: expectedKeys } });
                        expect(JSON.parse(saved.authorJson)).toMatchObject({ kind: 'user', userId: account.id });
                        expect(machineCalls.filter(call => call.method === RPC_METHODS.SCM_DIFF_FILE).every(call => !JSON.stringify(call.payload).includes('package-lock.json'))).toBe(true);
                        expect(machineCalls.filter(call => call.method === RPC_METHODS.SCM_DIFF_FILE).length).toBeGreaterThan(0);
                        await fixture.dispose(); standardCleanup(); resetReviewRunCommentsForTests();
                        fixture = await openFixture();
                        const reread = await mountChanges();
                        try {
                            await reread.pressByTestIdAsync(`diff-file-menu:${repository.trackedPath}`);
                            expect(reread.findByTestId('diff-file-viewed')?.props.accessibilityState?.selected).toBe(true);
                        } finally { await reread.unmount(); }
                        await writeFile(join(cwd, repository.trackedPath), 'const total = prices.reduce(subtract);\n');
                        const changed = await captureScmComparison({ cwd, source: { kind: 'workingTree' } });
                        expect(changed.comparison.id).not.toBe(comparison.id);
                        const changedKeys = buildScmFileReviewUnits(changed.comparison.inventory.files.find(file => file.path === repository.trackedPath)!).map(unit => unit.key);
                        expect(changedKeys.some(key => expectedKeys.includes(key))).toBe(false);
                        const nextComparison = await mountChanges({ ...capture, input: { ...capture.input, comparisonId: changed.comparison.id } });
                        try {
                            await nextComparison.pressByTestIdAsync(`diff-file-menu:${repository.trackedPath}`);
                            expect(nextComparison.findByTestId('diff-file-viewed')?.props.accessibilityState?.selected).toBe(false);
                        } finally { await nextComparison.unmount(); }
                        await getSyncSingleton().refreshPluginAccountAvailability();
                        const lifetime = captureActiveServerAccountScopeLifetime();
                        if (!lifetime) throw new Error('Missing cold Account lifetime');
                        const selected = await readPluginAccountAvailability(lifetime.scope).ensureCurrentAccountExecution(githubManifest.id);
                        if (selected.kind !== 'available') throw new Error(`PR entry unavailable: ${selected.code}`);
                        const controller = createBoundPluginSurfaceController({ facts: { pluginId: githubManifest.id, contributionId: GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1,
                            surfaceId: 'gutter-cold-pr', occurrenceId: selected.custodyId, placement: 'browserSurface', platform: 'web',
                            accountExecutionOrigin: { ...lifetime.scope, custodyId: selected.custodyId, sourceCustody: selected.sourceCustody },
                            serverId: lifetime.scope.serverId, accountLifetime: lifetime, interactionEnabled: true, daemonInteractionEnabled: false } });
                        const surface = createPluginSurfaceContextFixture({ accountEncryptionMode: 'plain',
                            mount: { kind: 'destination', destination: { pluginId: githubManifest.id, localId: GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1 }, container: 'appPage' }, target: { kind: 'app' } });
                        const native = createCanonicalPluginReactNativeHostApiAdapter({ surface, requestSurface: controller.surfaceContext,
                            handleRequest: controller.hostApi.handleRequest, installedMethods: controller.installedMethods });
                        const pr = await fixture.render(React.createElement(PluginUiProvider, { hostApi: native.api, context: surface }, React.createElement(GithubHappierReviewSummary, { reviewId })));
                        try {
                            // Gutter comments are comments, not structured finding rows. The
                            // actual PR entry opens their existing Review rather than inventing a finding.
                            await vi.waitFor(() => expect(pr.findAllByType(Button).some(button => button.props.title === 'Open review'), pr.getTextContent()).toBe(true));
                            const open = pr.findAllByType(Button).find(button => button.props.title === 'Open review');
                            if (!open) throw new Error('The PR entry has no Open review control');
                            await act(async () => { await open.props.onPress(); });
                            const route = new URL(String(vi.mocked(router.push).mock.calls.at(-1)?.[0]), origin);
                            expect(decodeURIComponent(route.pathname)).toBe(`/artifacts/${reviewId}`);
                            expect(route.searchParams.get('serverId')).toBe(fixture.scope.serverId);
                            const row = await artifacts.read(reviewId);
                            if (!row || typeof row.body !== 'string') throw new Error('The cold Review Artifact is unavailable');
                            const artifact: DecryptedArtifact = { id: reviewId, sourceServerId: fixture.scope.serverId,
                                title: 'Durable gutter review', isDecrypted: true, header: row.header, body: row.body,
                                ownerAccountId: account.id, access: 'owner', storageMode: 'plain', headerVersion: row.revision.headerVersion,
                                bodyVersion: row.revision.bodyVersion, seq: 1, createdAt: 1, updatedAt: 1 };
                            const reader = await fixture.render(React.createElement(ArtifactView, { artifactId: reviewId, artifact, presentation: 'page' }));
                            try {
                                await reader.pressByTestIdAsync('review-detail:tab:changes');
                                await vi.waitFor(() => expect(reader.findAllByType(WorkspaceScmReviewBody)).toHaveLength(1));
                                await act(async () => { reader.findByType(WorkspaceScmReviewBody).findAll(node => typeof node.props.onLayout === 'function')[0]
                                    ?.props.onLayout({ nativeEvent: { layout: { width: 900, height: 360 } } }); });
                                await vi.waitFor(() => expect(reader.findByTestId(`review-comment-${saved.id}`), reader.getTextContent()).not.toBeNull());
                                expect(reader.getTextContent()).toContain(body);
                                expect(await db.reviewComment.count({ where: { reviewId } })).toBe(1);
                            } finally { await reader.unmount(); }
                        } finally { await pr.unmount(); native.dispose(); controller.dispose(); }
                        const ownerMarks = await readMarks(token);
                        expect((await readMarks(otherToken)).status).toBe(404);
                        await fixture.dispose(); standardCleanup();
                        const otherBoundary = createHomeHubArtifactHttpBoundary(other.id);
                        const otherConnection = await restoreServerAccountForTest({ serverUrl: origin, serverIdentityId, accountId: other.id, credentials: { token: otherToken },
                            request: (url, init) => new URL(String(url)).pathname.startsWith('/v1/kv') ? fetch(url, init) : otherBoundary.request(url, init) });
                        const otherMarks = await renderHook(() => useScmReviewedMarks({ comparison, host: null, serverId: otherConnection.serverId }), {
                            wrapper: ({ children }) => React.createElement(InjectedAuthProvider, { credentials: otherConnection.credentials }, children),
                        });
                        try {
                            await vi.waitFor(() => expect(otherMarks.getCurrent().pending).toBe(false));
                            expect(otherMarks.getCurrent().record).toEqual({ v: 1, scopeId, reviewedChangeKeys: [] });
                            expect(await readMarks(token)).toEqual(ownerMarks);
                        } finally { await otherMarks.unmount(); await otherConnection.dispose(); }
                    } finally { standardCleanup(); await fixture.dispose(); }
                } finally { restoreInventory(); }
            }));
        }, { authentication: 'real' });
    } finally { await removeTempDir(cwd); }
});

it('repairs an HTTP-refused Review relationship from the mounted Task draft without creating another Task', async () => {
    const { isPluginError } = await import('@happier-dev/plugin-sdk');
    const { createPluginTestkit } = await import('@happier-dev/plugin-sdk/testing');
    const { createManifestTargetedContributionsService, resolveManifestTargetedContributions } = await import('@happier-dev/cli-common/plugins/registration');
    const { createPluginInvocationActionsService } = await import('../../../../../cli/src/plugins/runtime/invocation/services/actions');
    const { projectPluginUiTargetedContributionsV1 } = await import('@happier-dev/protocol/plugins/ui/targetedContributions');
    const { PluginUiProviderInternal: PluginUiProvider } = await import('../../../../../../packages/plugin-ui/src/components/PluginUiProvider');
    const { PLUGIN_MANIFEST, TRIAGE_PLUGIN, collectionMigrations, TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } = await import('../../../../../../packages/plugins/triage/src/manifest');
    const { INTERNAL_TASK_SOURCE_RECORD_V1 } = await import('../../../../../../packages/plugins/triage/src/internalTasks/configuration');
    const { TriageCreateTaskFields } = await import('../../../../../../packages/plugins/triage/src/ui/detail/taskFields');
    const { createTriageEphemeralSharedScopeFixture } = await import('../../../../../../packages/plugins/triage/src/ui/window/ephemeralSharedScope.test-support');
    const { createAccountPluginDataStorageHost } = await import('../../../../../cli/src/plugins/runtime/context/accountPluginDataStorage');
    const { createCliTasksActionDeps } = await import('../../../../../cli/src/session/actions/cliActionDeps/tasks');
    const { InternalTaskActionIdSchema } = await import('@happier-dev/protocol/actions/internalTaskActions');
    const { normalizePluginAccountCollectionContractV1, PluginAccountCollectionContributionV1Schema,
        PLUGIN_COLLECTION_MUTATION_HTTP_PATH_V1, PluginCollectionMutationRequestV1Schema,
        PluginCollectionMutationErrorV1Schema, AccountEncryptionCurrentnessResponseSchema,
        ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION, PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1 } = await import('@happier-dev/protocol');
    const { SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1 } = await import('@happier-dev/protocol/server/http/requestBodyBoundsV1');
    const { PluginUiExecuteActionRequestV1Schema } = await import('@happier-dev/protocol/plugins/ui');
    const { registerPluginAvailabilityRoutes } = await import('../../plugins/availability/routes');
    const { pluginDataRoutes } = await import('@/app/api/routes/plugins/data/pluginDataRoutes');
    const { accountRoutes } = await import('@/app/api/routes/account/accountRoutes');
    const { kvRoutes } = await import('@/app/api/routes/kv/kvRoutes');
    const { taskRoutes } = await import('@/app/api/routes/todos/taskRoutes');
    const { captureAccountStoredContentCompatibilityForHttpRequest } = await import('@/app/clientCompatibility/accountStoredContentCompatibility');
    const { createSignedPluginInstallationPublisherHeader } = await import('@/testkit/pluginInstallationPublisherTestkit');
    const { createPluginSurfaceActionControls } = await import('../../../../../ui/sources/components/plugins/surfaces/pluginSurfaceActionControls');
    const { resolveBoundPluginSurfaceContext } = await import('../../../../../ui/sources/components/plugins/surfaces/boundPluginSurfaceController');
    const { createPluginSurfaceHostApi } = await import('../../../../../ui/sources/components/plugins/surfaces/createPluginSurfaceHostApi');
    const { createCanonicalPluginReactNativeHostApiAdapter } = await import('../../../../../ui/sources/components/plugins/reactNative/hostApi');
    const { createPluginUiPrivatePresentationHost } = await import('../../../../../ui/sources/components/plugins/surfaces/pluginUiPrivatePresentationHost');
    const { createPluginSurfaceContextFixture } = await import('../../../../../ui/sources/dev/testkit/fixtures/pluginSurfaceContextFixture');
    const { act } = await import('react-test-renderer');
    const account = await db.account.create({ data: { encryptionMode: 'plain' } });
    const token = await createAccountTokenForTests(account.id, { kind: 'account', authority: 'present_user' });
    const credentials = { token, encryption: null };
    const machineId = randomUUID(), installationId = randomUUID(), keyPair = tweetnacl.sign.keyPair();
    await createTrustedMachineInstallation({ accountId: account.id, machineId, installationId, keyPair });
    await withAuthenticatedTestApp(app => {
        app.addHook('preHandler', async request => { captureAccountStoredContentCompatibilityForHttpRequest(request); });
        registerReviewCommentRoutes(app); registerReviewReadRoutes(app); artifactsRoutes(app);
        accountRoutes(app); kvRoutes(app); taskRoutes(app); pluginDataRoutes(app); registerPluginAvailabilityRoutes(app);
    }, async app => {
        const origin = await app.listen({ host: '127.0.0.1', port: 0 });
        await runWithServerHttpBaseUrl(origin, async () => {
            const artifacts = createCredentialedAccountArtifactStore(credentials);
            const records = createReviewRecordPortV1(createAcknowledgedAccountArtifactTransport(artifacts));
            const reviewId = randomUUID();
            const round = await records.start({ reviewId, title: 'Task relationship recovery', subjectKind: 'repository',
                sourceKind: 'direct', reviewerIds: ['reviewer'], startedAt: Date.now() });
            const comments = createCliReviewCommentActionExecutorFromCredentials({ credentials,
                resolvePrincipalSigningContext: async () => ({ machineId, installationId,
                    privateKeyBase64Url: Buffer.from(keyPair.secretKey).toString('base64url') }) });
            const runId = randomUUID();
            const run: ExecutionRunState = { runId, callId: runId, sidechainId: runId, sessionId: null, depth: 0,
                intent: 'review', backendId: 'claude', backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, instructions: 'Review.',
                permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
                status: 'running', startedAtMs: Date.now(), intentInput: { reviewRound: round, reviewReviewerId: 'reviewer' } };
            const published = await createReviewRunCommentService({ cwd: harness.baseDir,
                scope: { workspace: { machineId, path: harness.baseDir } }, execute: comments }).materialize({ run, review: round,
                reviewedFingerprint: null, findings: ['selected-a', 'selected-b', 'unselected'].map((id, index) => ({
                    id, title: id, summary: 'Private finding content stays in the Review.', severity: 'high', category: 'correctness',
                    filePath: `file-${index}.ts`, startLine: 1,
                })) });
            expect(published).toMatchObject({ status: 'materialized', failures: [] });
            const originReview = { reviewId, findingIds: published.comments.slice(0, 2).map(row => row.comment.id) };
            const lifetime = new AbortController();
            const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json',
                'x-happier-account-stored-content-protocol': String(ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION) };
            const requests: Array<{ collectionId: string; refused: boolean }> = [];
            let refuseNextLink = false;
            const storageHost = createAccountPluginDataStorageHost({
                contracts: PLUGIN_MANIFEST.contributes.accountCollections.map(contribution => normalizePluginAccountCollectionContractV1({
                    pluginId: PLUGIN_MANIFEST.id, contribution: PluginAccountCollectionContributionV1Schema.parse(contribution) })),
                readCredentials: async () => credentials, isCurrentAccount: () => true,
                resolveAccountScopeKey: () => account.id, resolveBaseUrl: () => origin,
                resolveReleaseLessDeclaration: () => PLUGIN_MANIFEST,
                resolveReleaseLessCollectionMigrations: async () => collectionMigrations,
                resolveAccountEncryptionCurrentness: async () => {
                    const reply = await fetch(`${origin}/v1/account/encryption/currentness`, { headers });
                    expect(reply.status).toBe(200);
                    return AccountEncryptionCurrentnessResponseSchema.parse(await reply.json());
                },
                http: {
                    get: async url => { const reply = await fetch(url, { headers }); return { status: reply.status, data: await reply.json() }; },
                    post: async (url, body) => {
                        const path = new URL(url).pathname;
                        const request = JSON.parse(body);
                        if (path === PLUGIN_COLLECTION_MUTATION_HTTP_PATH_V1) {
                            const mutation = PluginCollectionMutationRequestV1Schema.parse(request);
                            const refused = refuseNextLink && mutation.collectionId === 'user-marks';
                            requests.push({ collectionId: mutation.collectionId, refused });
                            if (refused) {
                                refuseNextLink = false;
                                // The Account HTTP transport is the fault boundary; every codec and owner stays real.
                                return { status: 400, data: PluginCollectionMutationErrorV1Schema.parse({ error: 'collection_mutation_invalid' }) };
                            }
                        }
                        const reply = await fetch(url, { method: 'POST', body, headers: { ...headers,
                            [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPluginInstallationPublisherHeader({
                                keyPair, machineId, installationId, path, body: request, nonce: randomUUID() }) } });
                        return { status: reply.status, data: await reply.json() };
                    },
                },
            });
            const binding = { pluginId: PLUGIN_MANIFEST.id, occurrenceId: 'task-repair', signal: lifetime.signal, isOccurrenceCurrent: () => true };
            await storageHost.claimReleaseLessDeclaration(binding);
            const storage = storageHost.bind(binding);
            if (!storage) throw new Error('Task Account storage unavailable');
            const tasks = createCliTasksActionDeps({ credentials, serverId: 'task-repair-home' }, { homeAccountId: account.id,
                todoHomeBaseUrl: origin, todoHomeServerId: 'task-repair-home', actionHomeId: 'task-repair-home',
                resolveServerRequestHeaders: () => headers });
            const hostCalls: string[] = [];
            const uiCalls: string[] = [];
            const results: unknown[] = [];
            let plugin: Awaited<ReturnType<typeof createPluginTestkit>>;
            const readCurrentDeclarations = () => {
                const snapshot = plugin.readTargetedContributionFixture(TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1);
                return { declarations: [{ manifest: PLUGIN_MANIFEST, occurrenceId: snapshot.occurrenceId,
                    sourceCustody: snapshot.sourceCustody }] };
            };
            const targetedOwner = createManifestTargetedContributionsService({ readCurrentDeclarations,
                subscribeToCatalogChanges: () => () => {} });
            plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { ...TRIAGE_PLUGIN, activateAccount(api) {
                TRIAGE_PLUGIN.activateAccount({ ...api, actions: { register(id, handler, options) {
                    api.actions.register(id, (input, context) => {
                        const declaration = readCurrentDeclarations().declarations[0]!;
                        const actions = createPluginInvocationActionsService({ seed: {
                            plugin: context.plugin, contribution: { id, qualifiedId: `${PLUGIN_MANIFEST.id}/actions/${id}` },
                            occurrenceId: declaration.occurrenceId, sourceCustody: declaration.sourceCustody,
                            surface: context.surface, signal: context.signal, isOccurrenceCurrent: () => !lifetime.signal.aborted,
                            readCurrentTargetedDeclarations: async () => readCurrentDeclarations(),
                        }, actionExecutor: { execute: async () => { throw new Error('Unexpected host Action dispatch'); } },
                        // The SDK fixture is only the cross-host registration/parser/provider dispatch boundary.
                        invokeContributedAction: async request => {
                            await request.beforeHandlerInvocation?.();
                            return { status: 'executed', value: await plugin.invokeAction(request.action.localId,
                                request.input, { surface: 'plugin', signal: request.signal }) };
                        } });
                        return handler(input, { ...context, services: { ...context.services,
                            targetedContributions: targetedOwner.bind({ pluginId: PLUGIN_MANIFEST.id,
                                signal: context.signal, isCurrent: () => !lifetime.signal.aborted }),
                            actions: { ...context.services.actions,
                                executeAdmittedTargetedOperation: actions.executeAdmittedTargetedOperation },
                        } });
                    }, options);
                } } });
            } }, services: { storage: { account: storage }, actions: { execute: async (id, input, options) => {
                hostCalls.push(id);
                if (id === 'reviews.comments.list') return await comments(id, input);
                const parsed = InternalTaskActionIdSchema.safeParse(id);
                if (!parsed.success) throw new Error(`Unexpected Task host Action ${id}`);
                return await tasks.internalTaskAction!({ actionId: parsed.data, input,
                    context: { surface: 'ui', authority: 'present_user' }, signal: options?.signal });
            } } } });
            const configured = INTERNAL_TASK_SOURCE_RECORD_V1.value.configured;
            const invoke = async (id: string, input: unknown) => {
                uiCalls.push(id);
                const result = await plugin.invokeAction(id, input, { surface: 'ui' });
                results.push(result);
                return result;
            };
            try {
                // Positive control uses the same real Review read, native Task source and collection HTTP port.
                const control = await invoke('tasks/create-v1', { v: 1, source: configured.instance.source,
                    sourceInstanceId: configured.instance.sourceInstanceId, kindId: 'task', fields: { title: 'Task recovery control' }, originReview });
                expect(control, JSON.stringify(control)).toMatchObject({ kind: 'createdAndLinkAttempted', creation: { kind: 'applied' }, reviewLink: 'linked' });
                const surface = createPluginSurfaceContextFixture({ accountEncryptionMode: 'plain', target: { kind: 'app' },
                    mount: { kind: 'destination', destination: { pluginId: PLUGIN_MANIFEST.id, localId: PLUGIN_MANIFEST.contributes.ui.views[0]!.id }, container: 'appPage' } });
                const snapshot = plugin.readTargetedContributionFixture(TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1);
                const declarations = [{ manifest: PLUGIN_MANIFEST, occurrenceId: snapshot.occurrenceId,
                    sourceCustody: snapshot.sourceCustody }];
                const admitted = resolveManifestTargetedContributions(declarations);
                const point = TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1;
                const semantic = admitted.read({ targetPluginId: PLUGIN_MANIFEST.id, pointId: point.id, protocol: point.protocol });
                if (!semantic) throw new Error('Native Task source declaration unavailable');
                const targeted = projectPluginUiTargetedContributionsV1({
                    target: { pluginId: PLUGIN_MANIFEST.id, occurrenceId: snapshot.occurrenceId },
                    snapshots: [{ point: { pointId: point.id, protocol: point.protocol }, snapshot: semantic }],
                    readSourceCustody: () => snapshot.sourceCustody,
                });
                const requestSurface = resolveBoundPluginSurfaceContext({ pluginId: PLUGIN_MANIFEST.id,
                    contributionId: PLUGIN_MANIFEST.contributes.ui.views[0]!.id, surfaceId: 'task-repair',
                    placement: 'browserSurface', platform: 'web', accountLifetime: null, interactionEnabled: true, daemonInteractionEnabled: false });
                const controls = createPluginSurfaceActionControls({ pluginId: PLUGIN_MANIFEST.id, surfaceId: 'task-repair',
                    signal: lifetime.signal, isCurrent: () => true, captureCurrentBinding: () => () => true,
                    hostAction: { execute: async (_actionId, raw) => {
                        const request = PluginUiExecuteActionRequestV1Schema.parse(raw);
                        const action = typeof request.action === 'string' ? request.action : request.action.localId;
                        try { return { ok: true, result: await invoke(action, request.input) }; }
                        catch (error) { if (!isPluginError(error)) throw error; return { ok: false, errorCode: error.code, error: error.message }; }
                    } } });
                const host = createPluginSurfaceHostApi({ surfaceContext: requestSurface, handlers: {
                    actionControl: controls.handleRequest,
                    executeAction: async request => {
                        const input = PluginUiExecuteActionRequestV1Schema.parse(request.payload);
                        return await invoke(typeof input.action === 'string' ? input.action : input.action.localId, input.input);
                    },
                } });
                const native = createCanonicalPluginReactNativeHostApiAdapter({ surface: { ...surface, targetedContributions: targeted },
                    requestSurface, handleRequest: host.handleRequest, installedMethods: host.installedMethods });
                expect(native.api.version().methods).toContain('actionControl');
                const fixture = await createSessionFilesViewFixture({ serverUrl: origin, credentials: { token },
                    serverIdentityId: await getOrCreateServerIdentityId(), machine: null });
                const created: import('@happier-dev/triage-protocol/v1').TriageEntryRefV1[] = [];
                const screen = await fixture.render(React.createElement(PluginUiProvider, { hostApi: native.api, mountedPluginId: PLUGIN_MANIFEST.id, context: { ...surface, targetedContributions: targeted },
                    ephemeralSharedScope: createTriageEphemeralSharedScopeFixture(),
                    presentationHost: createPluginUiPrivatePresentationHost(undefined, { actionControls: controls }) },
                    React.createElement(TriageCreateTaskFields, { sources: [{ configured, sourceInstanceId: configured.instance.sourceInstanceId, displayLabel: 'Happier tasks' }],
                        sourcesLoaded: true, sourcesUnavailableReason: null, draft: { title: 'Repair selected findings', originReview },
                        onApplied: async () => undefined, onClose() {}, onCreated: value => { created.push(value.entryRef); } })));
                const press = async (title: string) => {
                    const controlled = title === 'Create task' || title === 'Repair Review link';
                    const buttons = () => screen.tree.root.findAll(node => node.props.title === title && typeof node.props.onPress === 'function'
                        && !node.props.disabled && !node.props.loading
                        && (!controlled || String(node.props.testID).startsWith('plugin-surface-action-control:')));
                    await vi.waitFor(() => expect(buttons().length, JSON.stringify({ text: screen.getTextContent(),
                        controls: controls.getSnapshot().map(control => ({ id: control.id, busy: control.busy, presentation: control.presentation })) })).toBeGreaterThan(0));
                    const button = buttons()[0]!;
                    await act(async () => { await button.props.onPress(); });
                };
                try {
                    await press('Task');
                    refuseNextLink = true;
                    await press('Create task');
                    await vi.waitFor(() => expect(screen.getTextContent()).toContain('Repair Review link'));
                    expect(results.at(-1)).toMatchObject({ kind: 'createdAndLinkAttempted', creation: { kind: 'applied' }, reviewLink: 'failed' });
                    expect(created).toEqual([]);
                    const createsBeforeRepair = hostCalls.filter(id => id === 'tasks.internal.create').length;
                    expect(createsBeforeRepair).toBe(2); // One positive control and the one requested Task.
                    const failed = results.at(-1) as { creation: { observation: { localRef: { entryId: string } } } };
                    const retainedId = failed.creation.observation.localRef.entryId;
                    // The initial aggregate must retain the HTTP refusal before any relationship retry.
                    await press('Details');
                    await vi.waitFor(() => expect(screen.getTextContent()).toContain('collection_mutation_invalid'));
                    expect(hostCalls.filter(id => id === 'tasks.internal.create')).toHaveLength(createsBeforeRepair);
                    // A refused Repair retains the owner's typed cause and the already-created Task.
                    refuseNextLink = true;
                    await press('Repair Review link');
                    await vi.waitFor(() => expect(screen.getTextContent()).toContain('collection_mutation_invalid'));
                    expect(created).toEqual([]);
                    expect(hostCalls.filter(id => id === 'tasks.internal.create')).toHaveLength(createsBeforeRepair);
                    await press('Repair Review link');
                    await vi.waitFor(() => expect(created).toHaveLength(1));
                    expect(created[0]?.entryId).toBe(retainedId);
                    expect(hostCalls.filter(id => id === 'tasks.internal.create')).toHaveLength(createsBeforeRepair);
                    expect(uiCalls.filter(id => id === 'tasks/create-v1')).toHaveLength(2);
                    expect(requests.filter(request => request.refused)).toHaveLength(2);
                    expect(await plugin.invokeAction('tasks/read-origin-review-v1', { v: 1, entryRef: created[0] }, { surface: 'ui' }))
                        .toEqual({ v: 1, originReview });
                    const fresh = storageHost.bind({ ...binding, occurrenceId: 'cold-task-repair' });
                    if (!fresh) throw new Error('Cold Task relationship storage unavailable');
                    const { readTaskOriginReview } = await import('../../../../../../packages/plugins/triage/src/corpus/marks/setPinned');
                    const { bindCorpusCollections } = await import('../../../../../../packages/plugins/triage/src/corpus/collections/bindCorpusCollections');
                    expect(await readTaskOriginReview({ entryRef: created[0]!, collections: bindCorpusCollections(fresh), signal: lifetime.signal }))
                        .toEqual(originReview);
                    const retained = await tasks.internalTaskAction!({ actionId: 'tasks.internal.read', input: { taskId: retainedId },
                        context: { surface: 'ui', authority: 'present_user' } });
                    expect(retained).toMatchObject({ status: 'applied', todo: { id: retainedId, title: 'Repair selected findings' } });
                    expect(JSON.stringify(retained)).not.toContain('Private finding content stays in the Review.');
                } finally { await screen.unmount(); standardCleanup(); await fixture.dispose(); native.dispose(); controls.dispose(); host.dispose(); }
            } finally { lifetime.abort(); await plugin.dispose(); }
        });
    }, { authentication: 'real', bodyLimit: SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1 });
});
