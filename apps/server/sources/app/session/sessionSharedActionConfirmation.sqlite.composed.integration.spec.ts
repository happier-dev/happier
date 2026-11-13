import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlainSessionOwnerMetadataEnvelopeV1, encodeSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { SessionActionConfirmationsV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionActionConfirmationsV1';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerSessionPatchRoute } from '@/app/api/routes/session/registerSessionPatchRoute';
import { registerSessionListingRoutes } from '@/app/api/routes/session/registerSessionListingRoutes';
import { createPresentUserSessionAccessAuthentication } from './access/sessionAccessAuthentication.testkit';
import { loadSessionViewerProjection } from './personal/projection';
import { countSessionPersonalAttentionRowsInTx } from './personal/queries';
import { updateSessionMetadataEnvelopeTuple } from './sessionWriteService';
import { runWithServerHttpBaseUrl } from '../../../../cli/src/api/client/serverHttpBaseUrl';
import { AgentStateRequestStore } from '../../../../cli/src/agent/permissions/agentStateRequestStore';
import { createSessionActionConfirmationAdapter } from '../../../../cli/src/session/actions/approvals/sessionActionConfirmation';
import { readSessionMetadataSharedEditorTupleSnapshot, updateSessionMetadataEnvelopeTupleWithRetry } from '../../../../cli/src/session/metadata/updateSessionMetadataWithRetry';
import { encryptStoredSessionPayload } from '../../../../cli/src/session/transport/encryption/sessionEncryptionContext';
import type { SessionStoredContentCryptoContext } from '../../../../cli/src/session/transport/encryption/sessionEncryptionContext';
import type { Metadata } from '../../../../cli/src/api/types';
import { createSessionFixture, createSessionAccessFixture } from '../../../../ui/sources/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListRenderableFromSession } from '../../../../ui/sources/sync/domains/session/listing/sessionListRenderable';
import { buildPendingNavigationFromSource, selectPendingNavigationTarget } from '../../../../ui/sources/activity/source/buildPendingNavigationFromSource';
import { planPendingNavigationRoute } from '../../../../ui/sources/activity/source/navigateToPendingRequest';
import { listPendingSessionRequests } from '../../../../ui/sources/sync/domains/session/pending/listPendingSessionRequests';

describe('shared-editor Action confirmation → cold viewer → Next (SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-shared-confirmation-', initAuth: false,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it.each(['plain', 'e2ee'] as const)('publishes, retries and settles %s confirmations without replacing the owner summary', async mode => {
        const owner = await db.account.create({ data: mode === 'plain' ? { encryptionMode: mode }
            : { encryptionMode: mode, ...createSignedAccountContentBinding() } });
        const editor = await db.account.create({ data: { encryptionMode: 'plain' } });
        const crypto: SessionStoredContentCryptoContext = mode === 'plain' ? { mode, ctx: null }
            : { mode, ctx: { encryptionKey: randomBytes(32), encryptionVariant: 'dataKey' } };
        const seal = (payload: unknown) => encryptStoredSessionPayload({ ...crypto, payload });
        const ownerEnvelope = mode === 'plain' ? createPlainSessionOwnerMetadataEnvelopeV1({ v: 1 })
            : sealSessionOwnerMetadataEnvelopeV1({ ownerMetadata: { v: 1 }, material: { type: 'legacy', secret: randomBytes(32) }, randomBytes });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), encryptionMode: mode,
            active: true, metadataLayoutVersion: 1, metadata: seal({ v: 1 }),
            ownerMetadata: encodeSessionOwnerMetadataEnvelopeV1(ownerEnvelope), agentState: seal({}) } });
        if (crypto.mode === 'e2ee') await db.sessionDataKeyEnvelope.create({ data: { sessionId: session.id, recipientAccountId: owner.id,
            encryptedDataKey: sealEncryptedDataKeyEnvelopeV1({ dataKey: crypto.ctx.encryptionKey,
                recipientPublicKey: new Uint8Array(owner.contentPublicKey!), randomBytes }) } });
        await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: session.id, createdByAccountId: owner.id,
            accountId: editor.id, accessLevel: 'edit', canApprovePermissions: false } });
        await db.accountSessionFollow.create({ data: { accountId: editor.id, sessionId: session.id } });
        const authentication = createPresentUserSessionAccessAuthentication();
        const readViewer = (accountId = owner.id) => loadSessionViewerProjection({ accountId, sessionId: session.id, authentication });
        const readRaw = () => db.session.findUniqueOrThrow({ where: { id: session.id } });
        let snapshot = readSessionMetadataSharedEditorTupleSnapshot({ ...crypto, rawSession: await readRaw() });
        const ownerPatch = async (count: number) => {
            const raw = await readRaw();
            return updateSessionMetadataEnvelopeTuple({ actorUserId: owner.id, sessionId: session.id, mode: 'owner', metadataLayoutVersion: 1,
                expectedOwnerMetadata: ownerEnvelope, ownerMetadata: ownerEnvelope,
                sharedMetadata: { ciphertext: raw.metadata, expectedVersion: raw.metadataVersion },
                agentState: { ciphertext: seal({}), expectedVersion: raw.agentStateVersion },
                activitySummaryV1: { pendingPermissionRequestCount: count, pendingUserActionRequestCount: 0, pendingRequestNewestCreatedAt: count ? 1 : null } });
        };
        // A real owner CAS makes the editor's captured snapshot stale before creation.
        expect(await ownerPatch(0)).toMatchObject({ ok: true });
        const app = createAuthenticatedTestApp();
        app.addHook('onRequest', async request => { request.headers['x-test-user-id'] = editor.id; });
        // Test-only packet subtraction: remove the producer's summary at the HTTP boundary.
        app.addHook('preValidation', async request => {
            if (process.env.HAPPIER_TEST_SUBTRACT_SHARED_CONFIRMATION_SUMMARY === '1' && request.body && typeof request.body === 'object') {
                Reflect.deleteProperty(request.body, 'sharedActionConfirmationSummaryV1');
            }
        });
        registerSessionPatchRoute(app);
        registerSessionListingRoutes(app);
        const origin = await app.listen({ host: '127.0.0.1', port: 0 });
        const lifetime = new AbortController();
        let adapter: ReturnType<typeof createSessionActionConfirmationAdapter> | undefined;
        try {
            await runWithServerHttpBaseUrl(origin, async () => {
                let publicationError: unknown;
                // The persistence port writes through the real CLI tuple producer,
                // strict HTTP route and SQLite transaction; request custody stays real.
                const store = new AgentStateRequestStore({ logPrefix: '[shared-confirmation-composed]', target: {
                    scopeId: session.id,
                    readState: () => SessionActionConfirmationsV1Schema.parse(snapshot.value.sharedMetadata.actionConfirmationsV1
                        ?? { v: 1, requests: {}, completedRequests: {} }),
                    updateState: async updater => {
                        const updated = await updateSessionMetadataEnvelopeTupleWithRetry({ ...crypto, token: 'fixture', sessionId: session.id,
                            authority: { kind: 'shared_editor' }, initialSnapshot: snapshot,
                            mutation: { kind: 'metadata', update: metadata => {
                                const current = SessionActionConfirmationsV1Schema.parse(metadata.actionConfirmationsV1
                                    ?? { v: 1, requests: {}, completedRequests: {} });
                                const next = updater(current);
                                return { ...metadata, actionConfirmationsV1: SessionActionConfirmationsV1Schema.parse({ v: 1,
                                    requests: next.requests ?? {}, completedRequests: next.completedRequests ?? {} }) } as Metadata;
                            } } }).catch((error: unknown) => { publicationError = error; throw error; });
                        if (updated.mode !== 'shared_editor') throw new Error('Shared writer changed authority');
                        snapshot = updated;
                    },
                } });
                adapter = createSessionActionConfirmationAdapter({ sessionId: session.id, store, sessionSignal: lifetime.signal,
                    getAuthenticatedAccountId: async () => editor.id });
                const pending = adapter.confirm({ sessionId: session.id, actionId: 'session.activity.get', input: { sessionId: session.id },
                    preview: { sessionId: session.id }, context: { surface: 'agent', authority: 'account_automation', defaultSessionId: session.id,
                        sessionInputSource: { sourceSessionId: session.id, sourceTurnId: 'turn-1', via: 'action' } } },
                { turnId: 'turn-1', lifetimeSignal: lifetime.signal, isCurrent: () => true });
                // Await the actual storage publication rather than a request-store call count.
                await expect.poll(async () => {
                    // The request store is best-effort; expose the real tuple
                    // boundary error instead of reporting only an empty row.
                    if (publicationError) throw publicationError;
                    return Object.keys((await readRaw()).metadata === session.metadata ? {}
                        : snapshot.value.sharedMetadata.actionConfirmationsV1?.requests ?? {}).length;
                }).toBe(1);
                const viewer = await readViewer();
                expect(viewer?.attention.reasons).toContain('permission_required');
                expect(viewer?.attention.reasons).not.toContain('user_action_required');
                const attentionCount = (accountId: string) => inTx(tx => countSessionPersonalAttentionRowsInTx(tx,
                    { accountId, where: { id: session.id } }));
                expect(await attentionCount(owner.id)).toBe(1);
                expect(await attentionCount(editor.id)).toBe(0);
                const cold = createSessionFixture({ id: session.id, serverId: 'home', active: true, viewer: viewer!, agentState: null });
                const source = (row: typeof cold) => ({ isDataReady: true, sessionsById: {}, activeServerId: 'home',
                    sessionListRowsByServerId: { home: { [row.id]: buildSessionListRenderableFromSession(row) } },
                    ordinarySessionListMembershipByServerId: { home: [row.id] }, sessionListIndexByServerId: {}, concurrentSessionListCacheByServerId: {} });
                const candidates = buildPendingNavigationFromSource({ source: source(cold), nowMs: Date.now() });
                expect(candidates.map(candidate => candidate.address)).toEqual([{ serverId: 'home', sessionId: session.id }]);
                const deniedViewer = await readViewer(editor.id);
                expect(deniedViewer?.attention.reasons).not.toContain('permission_required');
                const denied = createSessionFixture({ ...cold, viewer: deniedViewer!, access: createSessionAccessFixture('edit') });
                expect(buildPendingNavigationFromSource({ source: source(denied), nowMs: Date.now() })).toEqual([]);
                const hydrated = createSessionFixture({ ...cold, metadataLayoutVersion: 1, metadata: snapshot.value.metadata });
                const requests = listPendingSessionRequests(hydrated, []);
                const target = selectPendingNavigationTarget(requests.map(request => ({ address: candidates[0]!.address, requestId: request.id,
                    requestKind: request.kind, requestSource: request.source, createdAt: request.createdAt })));
                expect(target).toMatchObject({ requestSource: 'happier_action' });
                expect(planPendingNavigationRoute({ target: target!, nowMs: Date.now(),
                    details: { kind: 'available', session: hydrated, messages: [], requests } })).toMatchObject({ kind: 'route', state: 'pending', focusTarget: 'prompt' });
                expect(await ownerPatch(0)).toMatchObject({ ok: true });
                expect((await readViewer())?.attention.reasons).toContain('permission_required');
                expect(await ownerPatch(1)).toMatchObject({ ok: true });
                await adapter.dispose();
                await expect(pending).resolves.toMatchObject({ decision: 'canceled' });
                expect((await readViewer())?.attention.reasons).toContain('permission_required');
                expect((await readRaw()).pendingPermissionRequestCount).toBe(1);
                expect(await ownerPatch(0)).toMatchObject({ ok: true });
                expect((await readViewer())?.attention.reasons).not.toContain('permission_required');
            });
        } finally {
            lifetime.abort();
            await runWithServerHttpBaseUrl(origin, async () => { await adapter?.dispose(); });
            await app.close();
        }
    });
});
