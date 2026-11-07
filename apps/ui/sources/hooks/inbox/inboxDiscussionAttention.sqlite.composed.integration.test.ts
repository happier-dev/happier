// Cross-package composition runs under the integration harness's app-owned alias resolution.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import Fastify, { type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { decodeBase64 } from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { db } from '../../../../server/sources/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '../../../../server/sources/testkit/lightSqliteHarness';
import { createPresentUserSessionAccessAuthentication } from '../../../../server/sources/app/session/access/sessionAccessAuthentication.testkit';
import { createArtifact } from '../../../../server/sources/app/artifacts/artifactWriteService';
import { decideArtifactEditProposal } from '../../../../server/sources/app/artifacts/artifactEditProposalService';
import { createDiscussion, postDiscussionMessage } from '../../../../server/sources/app/discussions/mutations';
import { setDiscussionReadCursor } from '../../../../server/sources/app/discussions/readState';
import { registerDiscussionRoutes } from '../../../../server/sources/app/api/routes/discussions/registerDiscussionRoutes';
import { createDiscussionClient, readDiscussionAttentionPage } from '@/sync/api/discussions/discussionActions';
import { createDiscussionRepository } from '@/sync/ops/discussions/discussionRepository';
import { buildInboxItems, type InboxItemsInput } from '@/components/inbox/inboxItems';
import { publishMountedDiscussionChanges } from '@/sync/domains/discussions/discussionChangeWatch';
import { AppShellActionOutputSchemas } from '@happier-dev/protocol/actions/appShellActionFamily';
import { invokeMountedWorkRead, registerMountedInboxReadOwner } from '@/sync/ops/actions/mountedWorkReadAction';
import { createInboxAttentionFixture } from '@/dev/testkit/fixtures/inboxFixtures';
import { serveSessionActionHome } from '@/dev/testkit/harness/sessionActionHome';
import type { InboxModel } from './useInboxModel';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

let harness: LightSqliteHarness;
beforeAll(async () => {
    harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-inbox-discussions-', initAuth: false, initEncrypt: true,
        env: { HAPPIER_FEATURE_SESSIONS__ENABLED: '1', HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED: '1' } });
}, 120_000);
afterAll(async () => { await harness?.close(); });

it('takes a cold SQL/HTTP proposal through the real codec and repository into Needs you until the exact Doc owner decides', async () => {
    const authentication = createPresentUserSessionAccessAuthentication();
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const writer = await db.account.create({ data: { encryptionMode: 'plain' } });
    const home = await serveSessionActionHome({ homes: [{ key: 'inbox', serverUrl: 'https://inbox-actions.test',
        accountId: owner.id, currentAccount: true }], route: () => undefined });
    const artifact = await createArtifact({ actorUserId: owner.id, artifactId: randomUUID(),
        header: decodeBase64(encodePlainArtifactStoredContent({ title: 'Plan', kind: 'markdown' })),
        body: decodeBase64(encodePlainArtifactStoredContent({ body: 'Before' })),
        dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
    if (!artifact.ok) throw new Error(artifact.error);
    const scope = { serverId: home.serverId, accountId: owner.id };
    const doc = { ref: { kind: 'doc' as const, artifactId: artifact.artifact.id, serverId: scope.serverId },
        revision: { headerVersion: 1, bodyVersion: 1 } };
    const created = await createDiscussion({ authentication, actorAccountId: owner.id, request: {
        creationLocalId: randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Plan review' } },
        firstMessage: { localId: randomUUID(), content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Review' }] } }, mentionedAccountIds: [] },
    } });
    if (!created.ok) throw new Error(created.error);
    const discussionId = created.value.discussion.id;
    const proposed = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId, request: {
        localId: randomUUID(), mentionedAccountIds: [], replyTarget: { kind: 'doc_passage', doc },
        content: { t: 'plain', v: { kind: 'doc_edit_proposal', proposal: { target: { ...doc, range: { start: 0, end: 6 }, quote: 'Before' },
            baseRevision: doc.revision, before: 'Before', after: 'After', reason: 'Clarify' } } },
    } });
    if (!proposed.ok) throw new Error(proposed.error);
    const mentionDiscussion = await createDiscussion({ authentication, actorAccountId: writer.id, request: {
        creationLocalId: randomUUID(), titleContent: { t: 'plain', v: { v: 1, title: 'Review request' } },
        participants: [{ kind: 'account', accountId: owner.id }],
        firstMessage: { localId: randomUUID(), content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Review' }] } }, mentionedAccountIds: [] },
    } });
    if (!mentionDiscussion.ok) throw new Error(mentionDiscussion.error);
    const mentioned = await postDiscussionMessage({ authentication, actorAccountId: writer.id,
        discussionId: mentionDiscussion.value.discussion.id, request: {
        localId: randomUUID(), mentionedAccountIds: [owner.id],
        content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Please review' },
            { t: 'mention', participant: { kind: 'account', accountId: owner.id } }] } },
    } });
    if (!mentioned.ok) throw new Error(mentioned.error);
    const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('authenticate', async (request: FastifyRequest) => {
        request.userId = owner.id; request.authAuthority = 'present_user'; request.authTokenKind = 'account';
    });
    registerDiscussionRoutes(app);
    const paths: string[] = [];
    // HTTP and credential verification are the only substituted boundaries.
    const options = { scope, availability: 'available' as const, encryption: null,
        request: async (path: string) => { paths.push(path); const response = await app.inject({ method: 'GET', url: path });
            return new Response(response.body, { status: response.statusCode, headers: { 'Content-Type': 'application/json' } }); } };
    const repository = createDiscussionRepository({ scope, address: { serverId: scope.serverId },
        client: { ...createDiscussionClient(options), attention: (input, signal) => readDiscussionAttentionPage(options, input, signal) } });
    const unmount = repository.mount({ attention: true });
    const base: InboxItemsInput = { sessionPresentation: { sessionsNeedingAttention: [], readySessions: [],
        markAllReadTargets: [], pendingRequestHydrationTargets: [] }, workGroups: [], workflowServerId: scope.serverId,
        accountServerId: scope.serverId, notices: [] };
    const items = () => buildInboxItems({ ...base, discussions: { scope, entries: repository.getSnapshot().attention.discussions } });
    let current = true;
    let capturedScope = scope;
    let retireOnRead = false;
    let coverage: 'complete' | 'partial' = 'complete';
    const read = (): InboxModel => {
        if (retireOnRead) current = false;
        return {
            ...createInboxAttentionFixture(scope.serverId),
            source: { isDataReady: true, sessionsById: {}, sessionListRowsByServerId: {},
                ordinarySessionListMembershipByServerId: {}, sessionListIndexByServerId: {}, concurrentSessionListCacheByServerId: {} },
            openApprovals: [], openUsageNotices: [], friendRequests: [], items: items(),
            discussionAttention: { ...createInboxAttentionFixture().discussionAttention, available: true, coverage,
                source: { scope: capturedScope, entries: repository.getSnapshot().attention.discussions } },
            sessionPresentation: base.sessionPresentation, workGroups: [], targetBySessionAddress: new Map(),
            actionOperationEntries: [], pendingReadKeys: new Set(), markAllPending: false, isLoading: false,
            readUnavailableReasonBySessionAddress: new Map(), markAllReadUnavailableReason: null,
            hasPrimaryAttention: true, hasContent: items().length > 0, showCaughtUp: items().length === 0, spansHomes: false,
            dismissUsageNotice: async () => {}, markRead: async () => {}, resolveActionOperation: () => {},
            settle: async () => {}, setReminder: async () => {},
        };
    };
    const remove = registerMountedInboxReadOwner({ scope, isCurrent: () => current, read });
    const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
    const execute = createFrontDoorActionExecute();
    const readAction = async (surface: 'ui' | 'voice' | 'cli' = 'ui') => {
        const response = await execute('inbox.get', {}, { surface, serverId: scope.serverId, runtimeAccountId: owner.id });
        expect(response.ok).toBe(true);
        if (!response.ok) throw new Error(response.errorCode);
        return AppShellActionOutputSchemas['inbox.get'].parse(response.result);
    };
    try {
        expect(repository.getSnapshot().threads).toEqual({});
        await repository.refreshAttention();
        expect(items()).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'decision', view: 'needs_you',
            focus: { kind: 'discussion', serverId: scope.serverId, id: discussionId, messageId: proposed.value.message.id } }),
            expect.objectContaining({ type: 'mention', view: 'mentions', read: false })]));
        expect(paths).toEqual(['/v1/discussions/attention']);
        expect(repository.getSnapshot().threads).toEqual({});
        const expectedItems = items().map(({ key, producer, type, view, title, context, createdAt, read, focus, pageRoute, source, discussion }) =>
            ({ key, producer, type, view, title, context, createdAt, read, focus, pageRoute, source, discussion }));
        for (const surface of ['ui', 'voice', 'cli'] as const) {
            expect(await readAction(surface)).toMatchObject({ status: 'ready', groups: [], items: expectedItems,
                coverage: { discussions: 'complete' } });
        }
        expect(AppShellActionOutputSchemas['inbox.get'].safeParse({ ...await readAction(), items: [{ ...expectedItems[0],
            source: { ...expectedItems[0]!.source, granted: true } }] }).success).toBe(false);
        coverage = 'partial';
        expect(await readAction()).toMatchObject({ status: 'ready', items: expectedItems, coverage: { discussions: 'partial' } });
        coverage = 'complete';
        capturedScope = { ...scope, accountId: 'other-account' };
        expect(await readAction()).toEqual({ status: 'unavailable' });
        capturedScope = scope;
        expect(await invokeMountedWorkRead({ actionId: 'inbox.get', input: {},
            context: { surface: 'ui', serverId: scope.serverId, runtimeAccountId: 'other-account' } }))
            .toEqual({ status: 'unavailable' });
        current = false;
        expect(await readAction()).toEqual({ status: 'unavailable' });
        current = true;
        retireOnRead = true;
        expect(await readAction()).toEqual({ status: 'unavailable' });
        retireOnRead = false;
        current = true;
        await setDiscussionReadCursor({ authentication, actorAccountId: owner.id, discussionId, lastReadSeq: proposed.value.message.seq });
        await setDiscussionReadCursor({ authentication, actorAccountId: owner.id, discussionId: mentionDiscussion.value.discussion.id,
            lastReadSeq: mentioned.value.message.seq });
        await repository.refreshAttention();
        const [decision] = items();
        expect(decision).toMatchObject({ view: 'needs_you', read: true });
        expect(await readAction()).toMatchObject({ status: 'ready', items: [{ type: 'decision', read: true,
            discussion: { proposalDisposition: { state: 'open' } } }] });
        expect(await decideArtifactEditProposal({ authentication, actorAccountId: owner.id, proposalRef: decision!.discussion!.messageRef,
            decision: 'decline' })).toMatchObject({ ok: true, disposition: { state: 'declined' } });
        publishMountedDiscussionChanges({ ...scope, changes: [{ cursor: 1, kind: 'discussion', entityId: discussionId, changedAt: Date.now() }] });
        await vi.waitFor(() => expect(items()).toEqual([]));
        expect(await readAction()).toMatchObject({ status: 'ready', items: [] });
    } finally { remove(); unmount(); repository.clear(); await app.close(); await home.dispose(); }
});
