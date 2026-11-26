import * as React from 'react';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Server } from 'socket.io';
import { createReviewRecordPortV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import { ReviewCommentCreateResponseV1Schema, ReviewCommentTransitionResponseV1Schema } from '@happier-dev/protocol/reviews/comments/actions';
import { buildReviewTriageTransitionRequestV1 } from '@happier-dev/protocol/reviews/comments/triageTransition';
import { deriveArtifactStoredKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { ArtifactReadBatchHttpInputV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { createReviewFindingIdentityV1, createReviewFindingMessageHashV1 } from '@happier-dev/protocol/reviews/comments/findingIdentity';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createSessionFilesViewFixture, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { allowRealServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { reportCollectionLayout } from '@/dev/testkit/harness/collectionLayoutHarness';
import { standardCleanup } from '@/dev/testkit';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { readReviewRunComments } from '@/sync/domains/reviews/comments/reviewRunComments';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { createAccountTokenForTests, createLightSqliteHarness, type LightSqliteHarness } from '../../../../../server/sources/testkit/lightSqliteHarness';
import { db } from '../../../../../server/sources/storage/db';
import { inTx } from '../../../../../server/sources/storage/inTx';
import { makeShareEligibleForTest } from '../../../../../server/sources/testkit/shareEligibility.testkit';
import { createAuthenticatedTestApp } from '../../../../../server/sources/app/api/testkit/sqliteFastify';
import { artifactsRoutes } from '../../../../../server/sources/app/api/routes/artifacts/artifactsRoutes';
import { registerAccountEncryptionRoutes } from '../../../../../server/sources/app/api/routes/account/registerAccountEncryptionRoutes';
import { changesRoutes } from '../../../../../server/sources/app/api/routes/changes/changesRoutes';
import { registerSessionListingRoutes } from '../../../../../server/sources/app/api/routes/session/registerSessionListingRoutes';
import { registerSessionReadBatchRoute } from '../../../../../server/sources/app/api/routes/session/registerSessionReadBatchRoute';
import { registerReviewReadRoutes } from '../../../../../server/sources/app/reviews/readRoutes';
import { registerReviewCommentRoutes } from '../../../../../server/sources/app/reviews/comments/routes';
import { setArtifactAccessGrantInTx } from '../../../../../server/sources/app/artifacts/artifactAccessService';
import { createArtifact } from '../../../../../server/sources/app/artifacts/artifactWriteService';
import { getOrCreateServerIdentityId } from '../../../../../server/sources/app/serverIdentity/serverIdentity';
import { startSocket } from '../../../../../server/sources/app/api/socket';

// Reuse the mounted Review testkit's native/Expo presentation boundaries. This
// Home opts into its real loopback socket; authentication and change ingress stay real.
installSessionFilesViewBoundaries({ platformOS: 'web', reactNativeOverrides: {
    useWindowDimensions: () => ({ width: 1440, height: 1000, scale: 1, fontScale: 1 }),
} });
await prepareSessionFilesViewTestkit();
let database: LightSqliteHarness;
beforeAll(async () => { database = await createLightSqliteHarness({ tempDirPrefix: 'happier-review-publication-', initAuth: true,
    initEncrypt: true, env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', AUTH_REQUIRED_LOGIN_PROVIDERS: '', HAPPIER_SOCKET_ADAPTER: 'memory' } }); }, 120_000);
afterAll(async () => { standardCleanup(); await database?.close(); });

it('delivers another Account decision to mounted Review list and detail without reading unrelated bodies', async () => {
    const owner = await db.account.create({ data: { id: 'alice', encryptionMode: 'plain' } });
    const editor = await db.account.create({ data: { encryptionMode: 'plain' } });
    await makeShareEligibleForTest(owner.id, [editor.id]);
    const token = await createAccountTokenForTests(owner.id, { kind: 'account', authority: 'present_user' });
    const editorToken = await createAccountTokenForTests(editor.id, { kind: 'account', authority: 'present_user' });
    const app = createAuthenticatedTestApp({ authentication: 'real' });
    artifactsRoutes(app); registerReviewReadRoutes(app); registerReviewCommentRoutes(app); registerAccountEncryptionRoutes(app);
    changesRoutes(app); registerSessionListingRoutes(app); registerSessionReadBatchRoute(app); startSocket(app);
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const realSocket = allowRealServerSocketBoundary(origin);
    const requests: Array<{ path: string; url: URL; method: string; body: unknown }> = [];
    const fixture = await createSessionFilesViewFixture({ serverUrl: origin, credentials: { token },
        serverIdentityId: await getOrCreateServerIdentityId(), machine: null,
        request: async (url, init) => {
            const address = new URL(String(url));
            const path = address.pathname;
            if (path.startsWith('/v1/reviews/') || path.startsWith('/v1/artifacts') || path.startsWith('/v2/sessions') || path === '/v2/cursor' || path === '/v2/changes') {
                requests.push({ path, url: address, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
                return fetch(url, init);
            }
            return undefined;
        } });
    const context = await captureLazyActionAccountContext(fixture.scope.serverId);
    const scope = context.accountLifetime.scope;
    const records = createReviewRecordPortV1(context.homeHubArtifactTransport);
    const execute = createFrontDoorActionExecute();
    const reviewId = randomUUID();
    let screen: Awaited<ReturnType<typeof fixture.render>> | undefined;
    try {
        const round = await records.start({ reviewId, title: 'Shared decision publication', subjectKind: 'repository',
            sourceKind: 'direct', reviewerIds: [], startedAt: Date.now() });
        await records.settle({ ...round, outcome: 'completed', finishedAt: Date.now(), runs: [] });
        expect(await inTx(tx => setArtifactAccessGrantInTx(tx, { actorAccountId: owner.id, artifactId: reviewId,
            principal: { kind: 'account', accountId: editor.id }, accessLevel: 'edit' }))).toMatchObject({ ok: true });
        const createFinding = async (title: string) => {
            const path = `${title}.ts`;
            const fingerprint = { normalizedMessageHash: createReviewFindingMessageHashV1(title) };
            const response = await execute('reviews.comments.create', { reviewId, body: title,
                finding: { id: title, title, summary: title, severity: 'high', category: 'correctness' },
                findingIdentity: createReviewFindingIdentityV1({ title, path, fingerprint }), fingerprint,
                anchor: { kind: 'file', filePath: path }, snapshot: { kind: 'none', capturedAt: 1 },
                authorIntent: 'open', clientMutationId: randomUUID() }, { surface: 'ui' });
            if (!response.ok) throw new Error(response.error);
            return ReviewCommentCreateResponseV1Schema.parse(response.result).comment;
        };
        const changed = await createFinding('Affected finding');
        const sibling = await createFinding('Unchanged sibling');
        const row = await context.homeHubArtifactTransport.read(reviewId);
        if (!row) throw new Error('Created Review unavailable');
        const artifact: DecryptedArtifact = { id: reviewId, sourceServerId: fixture.scope.serverId,
            title: 'Shared decision publication', isDecrypted: true, header: row.header, body: row.body,
            ownerAccountId: owner.id, access: 'owner', storageMode: 'plain', headerVersion: row.revision.headerVersion,
            bodyVersion: row.revision.bodyVersion, seq: 1, createdAt: 1, updatedAt: 1 };
        const { ReviewDetailHost } = await import('@/components/reviews/detail/ReviewDetailHost');
        const { ReviewsListHost } = await import('@/components/reviews/ReviewsListHost');
        const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
        const { View } = await import('react-native');
        const { t } = await import('@/text');
        screen = await fixture.render(<PluginSurfaceFocusEligibilityProvider eligible>
            <View testID="mounted-review-list"><ReviewsListHost surface="hub" /></View>
            <View testID="mounted-review-detail"><ReviewDetailHost artifact={artifact} bodyState="ready" onRetry={() => {}} /></View>
        </PluginSurfaceFocusEligibilityProvider>);
        const textOf = (testID: string) => screen!.findByTestId(testID)!.findAll(child => typeof child.type === 'string')
            .flatMap(child => child.children).filter((child): child is string => typeof child === 'string').join('');
        await reportCollectionLayout(screen, 'reviews:home');
        await vi.waitFor(() => {
            for (const consumer of ['mounted-review-list', 'mounted-review-detail']) {
                expect(textOf(consumer)).toContain(t('reviewWalkthrough.detail.glanceToDecide', { count: 2 }));
            }
            expect(readReviewRunComments({ scope, reviewId }).comments).toHaveLength(2);
        });
        const ioServer = app.machineDaemonPresence;
        if (!(ioServer instanceof Server)) throw new Error('Production socket server unavailable');
        await vi.waitFor(() => expect([...ioServer.sockets.sockets.values()].some(socket =>
            socket.rooms.has(`account-stored-content-v3:${owner.id}`))).toBe(true));
        await vi.dynamicImportSettled();
        const beforeUnrelated = requests.length;
        const unrelatedIds: string[] = Array.from({ length: 20 }, () => randomUUID());
        const consumed = new Set<string>();
        const release = subscribeHomeAccountChange(event => {
            if (event.serverId === scope.serverId && event.feedPageConsumed) {
                for (const id of event.entityIds ?? []) consumed.add(id);
            }
        }, { serverIds: [scope.serverId] });
        try {
            for (const [index, artifactId] of unrelatedIds.entries()) {
                expect(await createArtifact({ actorUserId: owner.id, artifactId,
                    kind: deriveArtifactStoredKindV1({ kind: 'doc.v1' }),
                    header: Buffer.from(encodePlainArtifactStoredContent({ kind: 'doc.v1', title: `Unrelated ${index}` }), 'base64'),
                    body: Buffer.from(encodePlainArtifactStoredContent({ body: '' }), 'base64'),
                    dataEncryptionKey: Buffer.from(ARTIFACT_PLAIN_DATA_KEY_MARKER, 'base64') })).toMatchObject({ ok: true });
            }
            await vi.waitFor(() => expect(unrelatedIds.every(id => consumed.has(id))).toBe(true));
        } finally { release(); }
        await vi.dynamicImportSettled();
        const unrelatedReads = requests.slice(beforeUnrelated);
        expect(unrelatedReads.filter(request => request.path.startsWith('/v1/reviews/'))).toEqual([]);
        // Generic sync materializes the new documents' headers. Neither Review
        // bodies nor finding/sibling bodies belong to that unrelated demand.
        for (const request of unrelatedReads.filter(request => request.path.startsWith('/v1/artifacts'))) {
            expect(request.path).toBe('/v1/artifacts/read');
            const batch = ArtifactReadBatchHttpInputV1Schema.parse(request.body);
            expect(batch.projection).toBe('headers');
            expect(batch.artifactIds.every(id => unrelatedIds.includes(id))).toBe(true);
        }
        const beforeDecision = requests.length;
        const decision = buildReviewTriageTransitionRequestV1({ comment: changed, decision: 'reject', clientMutationId: randomUUID() });
        const result = await fetch(`${origin}/v1/reviews/comments/${changed.id}/transition`, { method: 'POST',
            headers: { authorization: `Bearer ${editorToken}`, 'content-type': 'application/json' }, body: JSON.stringify(decision) });
        expect(result.status).toBe(200);
        expect(ReviewCommentTransitionResponseV1Schema.parse(await result.json())).toMatchObject({ comment: { id: changed.id, state: 'dismissed', serverRevision: 2 } });
        await vi.waitFor(() => {
            expect(readReviewRunComments({ scope, reviewId }).comments.find(comment => comment.id === changed.id))
                .toMatchObject({ state: 'dismissed', reviewTriageStatus: 'reject', serverRevision: 2 });
            for (const consumer of ['mounted-review-list', 'mounted-review-detail']) {
                expect(textOf(consumer)).toContain(t('reviewWalkthrough.detail.glanceToDecide', { count: 1 }));
            }
        });
        const decisionReads = requests.slice(beforeDecision);
        expect(decisionReads.filter(request => request.path === `/v1/reviews/comments/${changed.id}`)).toHaveLength(1);
        expect(decisionReads.filter(request => request.path === `/v1/reviews/comments/${sibling.id}`)).toEqual([]);
        expect(decisionReads.filter(request => request.path === '/v1/reviews/comments')).toEqual([]);
        // The targeted comment's codec opens its bound Review resource once.
        // Audience metadata and header projections do not contain Review bodies.
        const bodyReads = decisionReads.filter(request => {
            if (request.path === '/v1/artifacts/read') {
                return ArtifactReadBatchHttpInputV1Schema.parse(request.body).projection !== 'headers';
            }
            return request.method === 'GET' && (/^\/v1\/artifacts\/[^/]+$/.test(request.path)
                || request.path === '/v1/artifacts' && request.url.searchParams.get('includeBody') === 'true');
        });
        expect(bodyReads.map(request => request.path)).toEqual([`/v1/artifacts/${reviewId}`]);
        expect(decisionReads.filter(request => request.path === '/v1/reviews/get')).toHaveLength(1);
        expect(decisionReads.filter(request => request.path === '/v1/reviews/list')).toHaveLength(1);
    } finally {
        await screen?.unmount(); context.dispose(); standardCleanup(); await fixture.dispose(); realSocket.dispose(); await app.close();
    }
});
