import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyRequest } from "fastify";
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";

import { DISCUSSION_HTTP_PATHS_V1 } from "@happier-dev/protocol";
import { DiscussionAttentionResponseV1Schema } from '@happier-dev/protocol/discussions/api';

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { makeShareEligibleForTest } from "@/testkit/shareEligibility.testkit";
import { createDiscussion } from "@/app/discussions/mutations";
import { registerDiscussionRoutes } from "./registerDiscussionRoutes";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { decideArtifactEditProposal } from '@/app/artifacts/artifactEditProposalService';
import { postDiscussionMessage } from '@/app/discussions/mutations';
import { setDiscussionReadCursor } from '@/app/discussions/readState';
import { encodePlainArtifactStoredContent, ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { decodeBase64 } from 'privacy-kit';

const authentication = createPresentUserSessionAccessAuthentication();

const plainTitle = (title: string) => ({ t: "plain" as const, v: { v: 1, title } });
const plainBody = (text: string) => ({ t: "plain" as const, v: { v: 1, parts: [{ t: "text", text }] } });

/**
 * Transport-level contract for the mounted Session discussion family.
 *
 * The service owns authorization, idempotency and encryption-mode decisions and
 * proves them at its own boundary; this suite proves the parts only the real
 * HTTP entry can establish — the fail-closed server feature gate, the strict
 * request schema that keeps Agent provenance unforgeable from a public caller,
 * the typed failure → status mapping, and querystring paging coercion.
 */
describe("Session discussion HTTP transport (SQLite)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-discussion-routes-", initAuth: false, initEncrypt: true });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    const featureEnvKeys = [
        "HAPPIER_FEATURE_SESSIONS__ENABLED",
        "HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED",
    ] as const;
    const savedEnv = new Map<string, string | undefined>();

    beforeEach(() => {
        for (const key of featureEnvKeys) {
            savedEnv.set(key, process.env[key]);
            process.env[key] = "1";
        }
    });
    afterEach(() => {
        for (const key of featureEnvKeys) {
            const previous = savedEnv.get(key);
            if (previous === undefined) delete process.env[key];
            else process.env[key] = previous;
        }
    });

    it('reads cold proposal attention independently of the read cursor and clears it only at the Doc disposition owner', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const viewer = await db.account.create({ data: { encryptionMode: 'plain' } });
        await makeShareEligibleForTest(owner.id, [viewer.id]);
        const createdDoc = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
            header: decodeBase64(encodePlainArtifactStoredContent({ title: 'Plan', kind: 'markdown' })),
            body: decodeBase64(encodePlainArtifactStoredContent({ body: 'Before' })),
            dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!createdDoc.ok) throw new Error(createdDoc.error);
        const doc = { ref: { kind: 'doc' as const, serverId: 'home-a', artifactId: createdDoc.artifact.id },
            revision: { headerVersion: 1, bodyVersion: 1 } };
        await db.artifactGrant.create({ data: { principalKind: 'account', artifactId: doc.ref.artifactId, accountId: viewer.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        const created = await createDiscussion({ authentication, actorAccountId: owner.id, request: {
            creationLocalId: crypto.randomUUID(), titleContent: plainTitle('Plan review'),
            participants: [{ kind: 'account', accountId: viewer.id }],
            firstMessage: { localId: crypto.randomUUID(), content: plainBody('Review'), mentionedAccountIds: [] },
        } });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        await setDiscussionReadCursor({ authentication, actorAccountId: viewer.id, discussionId, lastReadSeq: 1 });
        const posted = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId, request: {
            localId: crypto.randomUUID(), mentionedAccountIds: [], replyTarget: { kind: 'doc_passage', doc },
            content: { t: 'plain', v: { kind: 'doc_edit_proposal', proposal: { target: { ...doc,
                range: { start: 0, end: 6 }, quote: 'Before' }, baseRevision: doc.revision,
                before: 'Before', after: 'After', reason: 'Clarify' } } },
        } });
        if (!posted.ok) throw new Error(posted.error);
        const { app, actor } = createApp(owner.id);
        try {
            const read = () => app.inject({ method: 'GET', url: '/v1/discussions/attention' });
            let response = await read();
            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({ discussions: [{ discussion: { id: discussionId },
                occurrences: [{ message: { id: posted.value.message.id }, type: 'decision' }] }] });
            const marked = await app.inject({ method: 'PUT', url: `/v1/discussions/${discussionId}/read`, payload: { lastReadSeq: posted.value.message.seq } });
            expect(marked.statusCode).toBe(200);
            response = await read();
            expect(response.json()).toMatchObject({ discussions: [{ discussion: { lastReadSeq: posted.value.message.seq },
                occurrences: [{ message: { id: posted.value.message.id }, type: 'decision' }] }] });
            actor.accountId = viewer.id;
            expect((await read()).json()).toMatchObject({ discussions: [{ occurrences: [{ type: 'update' }] }] });
            await db.artifactGrant.deleteMany({ where: { principalKind: 'account', artifactId: doc.ref.artifactId, accountId: viewer.id } });
            expect((await read()).json()).toMatchObject({ discussions: [] });
            actor.accountId = owner.id;
            expect(await decideArtifactEditProposal({ authentication, actorAccountId: owner.id, decision: 'decline',
                proposalRef: { kind: 'discussion', discussion: { serverId: 'home-a', discussionId }, messageId: posted.value.message.id } }))
                .toMatchObject({ ok: true, disposition: { state: 'declined' } });
            expect((await read()).json()).toMatchObject({ discussions: [] });
        } finally { await app.close(); }
    });

    it('pages exact unread mentions and updates across Discussions without disclosing another Account or revoked grants', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const viewer = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        await makeShareEligibleForTest(owner.id, [viewer.id, outsider.id]);
        const ids: string[] = [];
        for (const mentioned of [false, true]) {
            const created = await createDiscussion({ authentication, actorAccountId: owner.id, request: {
                creationLocalId: crypto.randomUUID(), titleContent: plainTitle('Independent review'),
                participants: [{ kind: 'account', accountId: viewer.id }],
                firstMessage: { localId: crypto.randomUUID(), content: plainBody('Initial'), mentionedAccountIds: [] },
            } });
            if (!created.ok) throw new Error(created.error);
            ids.push(created.value.discussion.id);
            await setDiscussionReadCursor({ authentication, actorAccountId: viewer.id, discussionId: created.value.discussion.id, lastReadSeq: 1 });
            const posted = await postDiscussionMessage({ authentication, actorAccountId: owner.id, discussionId: created.value.discussion.id,
                request: { localId: crypto.randomUUID(), content: mentioned ? { t: 'plain', v: { v: 1, parts: [
                    { t: 'mention', participant: { kind: 'account', accountId: viewer.id } }, { t: 'text', text: 'Review' },
                ] } } : plainBody('Update'), mentionedAccountIds: mentioned ? [viewer.id] : [] } });
            if (!posted.ok) throw new Error(posted.error);
        }
        const { app, actor } = createApp(viewer.id);
        try {
            const first = await app.inject({ method: 'GET', url: '/v1/discussions/attention?limit=1' });
            expect(first.statusCode).toBe(200);
            const page = DiscussionAttentionResponseV1Schema.parse(first.json());
            expect(page.nextCursor).toEqual(expect.any(String));
            if (page.nextCursor === null) throw new Error('Expected another attention page');
            const second = await app.inject({ method: 'GET', url: `/v1/discussions/attention?limit=1&cursor=${encodeURIComponent(page.nextCursor)}` });
            const nextPage = DiscussionAttentionResponseV1Schema.parse(second.json());
            const types = [...page.discussions, ...nextPage.discussions].flatMap(entry => entry.occurrences.map(occurrence => occurrence.type));
            expect(types.sort()).toEqual(['mention', 'update']);
            expect(second.json().nextCursor).toBeNull();
            actor.accountId = outsider.id;
            expect((await app.inject({ method: 'GET', url: '/v1/discussions/attention' })).json()).toMatchObject({ discussions: [], incomplete: false });
            await db.discussionGrant.deleteMany({ where: { principalKind: 'account', accountId: viewer.id, discussionId: { in: ids } } });
            actor.accountId = viewer.id;
            expect((await app.inject({ method: 'GET', url: '/v1/discussions/attention' })).json()).toMatchObject({ discussions: [], incomplete: false });
        } finally { await app.close(); }
    });

    /**
     * Authentication is the one genuine boundary: the real decorator verifies a
     * credential and stamps `userId`/`authAuthority`. Everything below it — the
     * feature gate, schemas, access, service and storage — stays real.
     */
    function createApp(
        initialAccountId: string,
        authenticationKind: "present_user" | "api_token" | "external_action" = "present_user",
        externalAction?: Readonly<{
            effectActionId: string;
            targetSessionId: string;
        }>,
    ) {
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        const actor = { accountId: initialAccountId };
        app.decorate("authenticate", async (request: FastifyRequest) => {
            request.userId = actor.accountId;
            request.authAuthority = authenticationKind === "present_user"
                ? "present_user"
                : "account_automation";
            request.authTokenKind = authenticationKind === "present_user"
                ? "account"
                : "api_token";
            if (authenticationKind === "external_action") {
                request.externalActionExecutionAuthorized = true;
                request.externalActionEffectActionId = externalAction?.effectActionId;
                request.externalActionExecutionTarget = externalAction
                    ? { kind: "session", sessionId: externalAction.targetSessionId }
                    : undefined;
            }
        });
        registerDiscussionRoutes(app);
        return { app, actor };
    }

    it('stores the Discussion check-in override with live management authority and preserves inherit versus never pause', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        await makeShareEligibleForTest(owner.id, [reader.id, outsider.id]);
        const created = await createDiscussion({ authentication, actorAccountId: owner.id, request: {
            creationLocalId: crypto.randomUUID(), titleContent: plainTitle('Check-in policy'),
            participants: [{ kind: 'account', accountId: reader.id }],
            firstMessage: { localId: crypto.randomUUID(), content: plainBody('Review'), mentionedAccountIds: [] },
        } });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        const { app, actor } = createApp(owner.id);
        const url = `/v1/discussions/${discussionId}/settings`;
        try {
            const unattended = createApp(owner.id, 'api_token').app;
            try {
                expect((await unattended.inject({ method: 'PUT', url, payload: { settings: {} } })).statusCode).toBe(403);
            } finally { await unattended.close(); }
            expect((await app.inject({ method: 'GET', url })).json()).toEqual({ discussionId, settings: {} });
            for (const afterTurns of [null, 9]) {
                const settings = { coordination: { autonomousCheckIn: { afterTurns } } };
                const response = await app.inject({ method: 'PUT', url, payload: { settings } });
                expect(response.statusCode).toBe(200);
                expect(response.json()).toEqual({ discussionId, settings });
                expect((await app.inject({ method: 'GET', url })).json()).toEqual({ discussionId, settings });
            }
            actor.accountId = reader.id;
            expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
            expect((await app.inject({ method: 'PUT', url, payload: { settings: {} } })).statusCode).toBe(403);
            await db.discussionGrant.update({ where: { principalKind: 'account', discussionId_accountId: { discussionId, accountId: reader.id } },
                data: { accessLevel: 'admin' } });
            expect((await app.inject({ method: 'PUT', url, payload: { settings: {} } })).statusCode).toBe(200);
            actor.accountId = outsider.id;
            expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
            actor.accountId = owner.id;
            expect((await app.inject({ method: 'GET', url: '/v1/discussions/missing/settings' })).statusCode).toBe(404);
            for (const settings of [{ coordination: { autonomousCheckIn: { afterTurns: 0 } } }, { forged: true }]) {
                expect((await app.inject({ method: 'PUT', url, payload: { settings } })).statusCode).toBe(400);
            }
            expect((await app.inject({ method: 'PUT', url, payload: { settings: {} } })).json())
                .toEqual({ discussionId, settings: {} });
            await db.discussion.update({ where: { id: discussionId }, data: { settingsV1: {
                coordination: { autonomousCheckIn: { afterTurns: null, futureSetting: true } }, futureSetting: true,
            } } });
            expect((await app.inject({ method: 'GET', url })).json()).toEqual({ discussionId,
                settings: { coordination: { autonomousCheckIn: { afterTurns: null } } } });
            await db.discussion.update({ where: { id: discussionId }, data: { settingsV1: {
                coordination: { autonomousCheckIn: { afterTurns: 0 } },
            } } });
            expect((await app.inject({ method: 'GET', url })).statusCode).toBe(409);
        } finally { await app.close(); }
    });

    it("creates and retries a Home Discussion without a Session", async () => {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const { app } = createApp(owner.id);
        const payload = {
            creationLocalId: "standalone-create",
            titleContent: plainTitle("Independent"),
            firstMessage: { localId: "standalone-first", content: plainBody("Hello"), mentionedAccountIds: [] },
        };
        try {
            const created = await app.inject({ method: "POST", url: "/v1/discussions", payload });
            expect(created.statusCode).toBe(200);
            const retried = await app.inject({ method: "POST", url: "/v1/discussions", payload });
            expect(retried.statusCode).toBe(200);
            expect(retried.json().discussion.id).toBe(created.json().discussion.id);
            const listed = await app.inject({ method: "GET", url: "/v1/discussions" });
            expect(listed.statusCode).toBe(200);
            expect(listed.json().discussions.map((row: { id: string }) => row.id)).toContain(created.json().discussion.id);
            const legacy = await app.inject({ method: "GET", url: "/v2/sessions/unrelated/discussions" });
            expect(legacy.statusCode).toBe(404);
        } finally {
            await app.close();
        }
    });

    it("reserves and removes a strict model slot through the actual participant HTTP owner", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        const { app } = createApp(owner.id);
        try {
            const created = await app.inject({ method: "POST", url: DISCUSSION_HTTP_PATHS_V1.collection, payload: {
                creationLocalId: crypto.randomUUID(), titleContent: plainTitle("Models"),
                firstMessage: { localId: crypto.randomUUID(), content: plainBody("Hello"), mentionedAccountIds: [] },
            } });
            expect(created.statusCode).toBe(200);
            const discussionId: string = created.json().discussion.id;
            const url = (path: string) => path.replace(":discussionId", discussionId);
            const participant = { kind: "model", participantSlotId: crypto.randomUUID(), launch: {
                executionTarget: { serverId: "home", machineId: "machine" }, directory: { kind: "path", path: "/tmp" },
                agentTarget: { kind: "agent", identity: { pluginId: "happier.agent.claude", localId: "claude" } },
            } };
            const invited = await app.inject({ method: "POST", url: url(DISCUSSION_HTTP_PATHS_V1.invite), payload: { participant } });
            expect(invited.statusCode).toBe(200);
            expect(invited.json()).toMatchObject({ changed: true, modelParticipant: {
                participant: { kind: "model", participantSlotId: participant.participantSlotId }, sessionId: null, launch: participant.launch,
            } });
            const retried = await app.inject({ method: "POST", url: url(DISCUSSION_HTTP_PATHS_V1.invite), payload: { participant } });
            expect(retried.statusCode).toBe(200);
            expect(retried.json().modelParticipant).toEqual(invited.json().modelParticipant);
            expect((await app.inject({ method: "GET", url: url(DISCUSSION_HTTP_PATHS_V1.participants) })).json().participants)
                .toEqual([invited.json().modelParticipant]);
            expect((await app.inject({ method: "POST", url: url(DISCUSSION_HTTP_PATHS_V1.invite), payload: {
                participant: { ...participant, launch: { ...participant.launch, initialInput: { text: "Do not run" } } },
            } })).statusCode).toBe(400);
            for (const changed of [true, false]) {
                const removed = await app.inject({ method: "DELETE", url: url(DISCUSSION_HTTP_PATHS_V1.participant), payload: {
                    participant: { kind: "model", participantSlotId: participant.participantSlotId },
                } });
                expect(removed.statusCode).toBe(200);
                expect(removed.json()).toMatchObject({ changed });
                expect(removed.json()).not.toHaveProperty("ownedSession");
            }
            expect(await db.session.count({ where: { accountId: owner.id } })).toBe(0);
        } finally { await app.close(); }
    });

    it("invites, reads and self-leaves through one independent grant owner", async () => {
        const owner = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const invitee = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        const outsider = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
        await makeShareEligibleForTest(owner.id, [invitee.id, outsider.id]);
        const { app, actor } = createApp(owner.id);
        try {
            const created = await app.inject({ method: "POST", url: DISCUSSION_HTTP_PATHS_V1.collection, payload: {
                creationLocalId: crypto.randomUUID(), titleContent: plainTitle("Invited only"),
                firstMessage: { localId: crypto.randomUUID(), content: plainBody("Private"), mentionedAccountIds: [] },
            } });
            expect(created.statusCode).toBe(200);
            const discussionId: string = created.json().discussion.id;
            const url = (path: string) => path.replace(":discussionId", discussionId);
            const invited = await app.inject({ method: "POST", url: url(DISCUSSION_HTTP_PATHS_V1.invite), payload: {
                participant: { kind: "account", accountId: invitee.id },
            } });
            expect(invited.statusCode).toBe(200);
            actor.accountId = outsider.id;
            expect((await app.inject({ method: "GET", url: url(DISCUSSION_HTTP_PATHS_V1.discussion) })).statusCode).toBe(404);
            actor.accountId = invitee.id;
            expect((await app.inject({ method: "GET", url: url(DISCUSSION_HTTP_PATHS_V1.discussion) })).statusCode).toBe(200);
            expect((await app.inject({ method: "POST", url: url(DISCUSSION_HTTP_PATHS_V1.leave), payload: { accountId: owner.id } })).statusCode).toBe(400);
            for (const changed of [true, false]) {
                const left = await app.inject({ method: "POST", url: url(DISCUSSION_HTTP_PATHS_V1.leave) });
                expect(left.statusCode).toBe(200);
                expect(left.json()).toMatchObject({ access: null, changed });
            }
            expect((await app.inject({ method: "GET", url: url(DISCUSSION_HTTP_PATHS_V1.discussion) })).statusCode).toBe(404);
            actor.accountId = owner.id;
            expect((await app.inject({ method: "POST", url: url(DISCUSSION_HTTP_PATHS_V1.leave) })).statusCode).toBe(409);
            expect((await app.inject({ method: "GET", url: url(DISCUSSION_HTTP_PATHS_V1.discussion) })).json().discussion.ownerAccountId).toBe(owner.id);
        } finally {
            await app.close();
        }
    });

    async function fixture() {
        const account = async () => await db.account.create({
            data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" },
        });
        const owner = await account();
        const outsider = await account();
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: crypto.randomUUID(),
                encryptionMode: "plain",
                metadata: JSON.stringify({ t: "plain", v: {} }),
            },
        });
        return { owner, outsider, session };
    }

    async function seedDiscussion(params: Readonly<{
        ownerId: string;
        sessionId: string;
        creationLocalId: string;
        localId: string;
    }>) {
        const created = await createDiscussion({
            authentication,
            actorAccountId: params.ownerId,
            request: {
                anchor: { kind: "session", sessionId: params.sessionId },
                creationLocalId: params.creationLocalId,
                titleContent: plainTitle("Rollout"),
                firstMessage: { localId: params.localId, content: plainBody("Start"), mentionedAccountIds: [] },
            },
        });
        if (!created.ok) throw new Error(`discussion seed failed: ${created.error}`);
        return created.value.discussion;
    }

    function collectionUrl(): string {
        return DISCUSSION_HTTP_PATHS_V1.collection;
    }
    function messagesUrl(discussionId: string): string {
        return DISCUSSION_HTTP_PATHS_V1.messages
            .replace(":discussionId", discussionId);
    }
    function discussionUrl(discussionId: string): string {
        return DISCUSSION_HTTP_PATHS_V1.discussion
            .replace(":discussionId", discussionId);
    }
    function archiveUrl(discussionId: string): string {
        return DISCUSSION_HTTP_PATHS_V1.archive
            .replace(":discussionId", discussionId);
    }
    function restoreUrl(discussionId: string): string {
        return DISCUSSION_HTTP_PATHS_V1.restore
            .replace(":discussionId", discussionId);
    }

    it("keeps the whole family unavailable while the conversations server feature is off", async () => {
        const { owner, session } = await fixture();
        const discussion = await seedDiscussion({
            ownerId: owner.id, sessionId: session.id, creationLocalId: "gate-c", localId: "gate-m",
        });
        // The family is on by default, so an operator turns it off explicitly;
        // removing the key would leave it enabled and never exercise the gate.
        process.env.HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED = "0";
        const { app } = createApp(owner.id);
        try {
            const listed = await app.inject({ method: "GET", url: collectionUrl() });
            expect(listed.statusCode).toBe(404);
            // The refusal stays inside this family's declared error union, so a
            // client parses it exactly like any other discussion failure.
            expect(listed.json()).toEqual({ error: "discussions_unavailable" });

            const posted = await app.inject({
                method: "POST",
                url: messagesUrl(discussion.id),
                payload: { localId: "gate-p", content: plainBody("blocked"), mentionedAccountIds: [] },
            });
            expect(posted.statusCode).toBe(404);
            expect(await db.discussionMessage.count({ where: { localId: "gate-p" } })).toBe(0);
        } finally {
            await app.close();
        }
    });

    it("refuses a caller-asserted Agent producer on the public post transport", async () => {
        const { owner, session } = await fixture();
        const discussion = await seedDiscussion({
            ownerId: owner.id, sessionId: session.id, creationLocalId: "forge-c", localId: "forge-m",
        });
        const { app } = createApp(owner.id);
        try {
            const forged = await app.inject({
                method: "POST",
                url: messagesUrl(discussion.id),
                payload: {
                    localId: "forge-p",
                    content: plainBody("I am the Agent"),
                    mentionedAccountIds: [],
                    // Host-stamped provenance is derived only behind the
                    // authenticated current-publisher socket fence.
                    producerV1: { v: 1, kind: "agent", sessionId: session.id, runId: "run-forged" },
                },
            });
            expect(forged.statusCode).toBe(400);
            expect(await db.discussionMessage.count({ where: { localId: "forge-p" } })).toBe(0);

            // The same body without the forged field is accepted and stays human.
            const honest = await app.inject({
                method: "POST",
                url: messagesUrl(discussion.id),
                payload: { localId: "forge-p", content: plainBody("I am the Agent"), mentionedAccountIds: [] },
            });
            expect(honest.statusCode, honest.body).toBe(200);
            expect(honest.json().message).toMatchObject({
                authorAccountId: owner.id,
                producerV1: null,
            });
        } finally {
            await app.close();
        }
    });

    it("rejects aliased creation and first-message retry identities before mutation", async () => {
        const { owner, session } = await fixture();
        const { app } = createApp(owner.id);
        try {
            const response = await app.inject({
                method: "POST",
                url: collectionUrl(),
                payload: {
                    creationLocalId: "same-local-id",
                    titleContent: plainTitle("Distinct retry identities"),
                    firstMessage: {
                        localId: "same-local-id",
                        content: plainBody("Do not alias these operations"),
                        mentionedAccountIds: [],
                    },
                },
            });

            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({ error: "discussion_invalid_content" });
            expect(await db.discussion.count({
                where: { ownerAccountId: owner.id, creationLocalId: "same-local-id" },
            })).toBe(0);
        } finally {
            await app.close();
        }
    });

    it("returns the canonical present-user refusal for PAT mutation calls", async () => {
        const { owner, session } = await fixture();
        const discussion = await seedDiscussion({
            ownerId: owner.id, sessionId: session.id, creationLocalId: "pat-c", localId: "pat-m",
        });
        const { app } = createApp(owner.id, "api_token");
        try {
            const posted = await app.inject({
                method: "POST",
                url: messagesUrl(discussion.id),
                payload: { localId: "pat-p", content: plainBody("blocked"), mentionedAccountIds: [] },
            });
            expect(posted.statusCode).toBe(403);
            expect(posted.json()).toEqual({ error: "present_user_required" });
            expect(await db.discussionMessage.count({ where: { localId: "pat-p" } })).toBe(0);

            const restored = await app.inject({
                method: "POST",
                url: restoreUrl(discussion.id),
            });
            expect(restored.statusCode).toBe(403);
            expect(restored.json()).toEqual({ error: "present_user_required" });
        } finally {
            await app.close();
        }
    });

    it("does not turn an external Action's Session execution target into Agent authorship on human HTTP", async () => {
        const { owner, session } = await fixture();
        const discussion = await seedDiscussion({
            ownerId: owner.id, sessionId: session.id, creationLocalId: "external-c", localId: "external-m",
        });
        const postUrl = messagesUrl(discussion.id);
        const payload = { localId: "external-p", content: plainBody("from the public Action"), mentionedAccountIds: [] };

        const { app } = createApp(owner.id, "external_action", {
            effectActionId: "discussion.post",
            targetSessionId: session.id,
        });
        try {
            const response = await app.inject({ method: "POST", url: postUrl, payload });
            expect(response.statusCode, response.body).toBe(403);
            expect(response.json()).toEqual({ error: "present_user_required" });
            // R2: executable attribution requires the actual current trusted
            // Session publisher, not an Account HTTP caller's execution target.
            expect(await db.discussionMessage.count({ where: { discussionId: discussion.id, localId: payload.localId } })).toBe(0);
        } finally {
            await app.close();
        }
    });

    it("rejoins a lost post retry and conflicts a changed one under the same localId", async () => {
        const { owner, session } = await fixture();
        const discussion = await seedDiscussion({
            ownerId: owner.id, sessionId: session.id, creationLocalId: "retry-c", localId: "retry-m",
        });
        const { app } = createApp(owner.id);
        try {
            const url = messagesUrl(discussion.id);
            const payload = { localId: "retry-p", content: plainBody("only once"), mentionedAccountIds: [] };

            const first = await app.inject({ method: "POST", url, payload });
            expect(first.statusCode).toBe(200);
            // A lost acknowledgement is retried verbatim: the same durable row
            // is reported rather than a second message.
            const retried = await app.inject({ method: "POST", url, payload });
            expect(retried.statusCode).toBe(200);
            expect(retried.json().message.id).toBe(first.json().message.id);
            expect(retried.json().message.seq).toBe(first.json().message.seq);
            expect(await db.discussionMessage.count({ where: { localId: "retry-p" } })).toBe(1);

            const changed = await app.inject({
                method: "POST",
                url,
                payload: { localId: "retry-p", content: plainBody("different text"), mentionedAccountIds: [] },
            });
            expect(changed.statusCode).toBe(409);
            expect(changed.json()).toEqual({ error: "discussion_idempotency_conflict" });
        } finally {
            await app.close();
        }
    });

    it("maps named Discussion denial to absence while an outsider's Home list is empty", async () => {
        const { owner, outsider, session } = await fixture();
        const discussion = await seedDiscussion({
            ownerId: owner.id, sessionId: session.id, creationLocalId: "acl-c", localId: "acl-m",
        });
        const { app } = createApp(outsider.id);
        try {
            const details = await app.inject({ method: "GET", url: discussionUrl(discussion.id) });
            expect(details.statusCode).toBe(404);
            expect(details.json()).toEqual({ error: "discussion_not_found" });

            const listed = await app.inject({ method: "GET", url: collectionUrl() });
            expect(listed.statusCode).toBe(200);
            expect(listed.json().discussions).toEqual([]);
        } finally {
            await app.close();
        }
    });

    it("blocks posting into an archived discussion and accepts again after restore", async () => {
        const { owner, session } = await fixture();
        const discussion = await seedDiscussion({
            ownerId: owner.id, sessionId: session.id, creationLocalId: "arch-c", localId: "arch-m",
        });
        const { app } = createApp(owner.id);
        try {
            expect((await app.inject({ method: "POST", url: archiveUrl(discussion.id) })).statusCode).toBe(200);

            const blocked = await app.inject({
                method: "POST",
                url: messagesUrl(discussion.id),
                payload: { localId: "arch-p", content: plainBody("too late"), mentionedAccountIds: [] },
            });
            expect(blocked.statusCode).toBe(409);
            expect(blocked.json()).toEqual({ error: "discussion_archived" });
            expect(await db.discussionMessage.count({ where: { localId: "arch-p" } })).toBe(0);

            expect((await app.inject({ method: "POST", url: restoreUrl(discussion.id) })).statusCode).toBe(200);
            const accepted = await app.inject({
                method: "POST",
                url: messagesUrl(discussion.id),
                payload: { localId: "arch-p", content: plainBody("too late"), mentionedAccountIds: [] },
            });
            expect(accepted.statusCode).toBe(200);
        } finally {
            await app.close();
        }
    });

    it("coerces and bounds the message paging querystring", async () => {
        const { owner, session } = await fixture();
        const discussion = await seedDiscussion({
            ownerId: owner.id, sessionId: session.id, creationLocalId: "page-c", localId: "page-m",
        });
        const { app } = createApp(owner.id);
        try {
            const url = messagesUrl(discussion.id);
            for (const text of ["second", "third"]) {
                expect((await app.inject({
                    method: "POST",
                    url,
                    payload: { localId: `page-${text}`, content: plainBody(text), mentionedAccountIds: [] },
                })).statusCode).toBe(200);
            }

            // `limit` arrives as a string on the wire; the route's schema is the
            // only place that can turn it into the number the service bounds.
            const page = await app.inject({ method: "GET", url: `${url}?limit=2` });
            expect(page.statusCode).toBe(200);
            const body = page.json();
            expect(body.messages).toHaveLength(2);
            expect(body.hasMoreOlder).toBe(true);
            expect(body.messageSeq).toBe(3);

            const older = await app.inject({
                method: "GET",
                url: `${url}?limit=2&beforeSeq=${body.messages[0].seq}`,
            });
            expect(older.statusCode).toBe(200);
            expect(older.json().hasMoreOlder).toBe(false);
        } finally {
            await app.close();
        }
    });
});
