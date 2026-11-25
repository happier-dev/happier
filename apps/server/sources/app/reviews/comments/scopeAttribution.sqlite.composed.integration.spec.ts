import * as React from 'react';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm/comparison';
import { ReviewFindingsV2Schema } from '@happier-dev/protocol/messages/structured/reviewFindingsV2';
import { createReviewRecordPortV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
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
import { createReviewRunCommentService } from '../../../../../cli/src/agent/executionRuns/profiles/review/reviewComments';
import { createCliReviewCommentActionExecutorFromCredentials } from '../../../../../cli/src/agent/reviews/comments/executor';
import { createAcknowledgedAccountArtifactTransport, createCredentialedAccountArtifactStore } from '../../../../../cli/src/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '../../../../../cli/src/api/client/serverHttpBaseUrl';
import type { ExecutionRunState } from '../../../../../cli/src/agent/runtime/bridges/executionRun/executionRunTypes';
import { createSessionFilesViewFixture, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '../../../../../ui/sources/components/sessions/files/views/sessionFilesViewTestkit';
import { standardCleanup } from '../../../../../ui/sources/dev/testkit';
import type { DecryptedArtifact } from '../../../../../ui/sources/sync/domains/artifacts/artifactTypes';

// Native/Expo rendering and the socket transport are the existing system boundaries.
// Normalization, signed comment Actions, HTTP routes, SQLite and detail projections stay real.
installSessionFilesViewBoundaries({ platformOS: 'web', reactNativeOverrides: {
    useWindowDimensions: () => ({ width: 1440, height: 1000, scale: 1, fontScale: 1 }),
} });
await prepareSessionFilesViewTestkit();
let harness: LightSqliteHarness;
beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-review-attribution-', initAuth: true, initEncrypt: true }); }, 120_000);
afterAll(async () => { standardCleanup(); await harness?.close(); });

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
