import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import tweetnacl from "tweetnacl";
import {
    normalizeVerifiedEmail,
    openEncryptedDataKeyEnvelopeV1,
    sealEncryptedDataKeyEnvelopeV1,
    sealSessionOwnerMetadataV1,
} from "@happier-dev/protocol";

import type { AuthEmailMessage } from "@/app/auth/email/authEmailDelivery";
import { upsertVerifiedMailboxEvidenceInTx } from "@/app/auth/verifiedMailboxEvidence";
import { homeGovernanceRoutes } from "@/app/api/routes/home/homeGovernanceRoutes";
import { sessionRoutes } from "@/app/api/routes/session/sessionRoutes";
import { registerDiscussionRoutes } from "@/app/api/routes/discussions/registerDiscussionRoutes";
import { DISCUSSION_HTTP_PATHS_V1 } from "@happier-dev/protocol/discussions/api";
import { encodeBase64 } from "@happier-dev/protocol/crypto/base64";
import { deriveAccountRecipientEnvelopeReadinessFromRow } from "@/app/encryption/accountRecipientEnvelopeReadiness";
import { RECIPIENT_READINESS_SELECT } from "@/app/session/encryption/sessionDataKeyRecipientProjection";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import {
    initializeSessionSystemRecordsProtocolV1Activation,
    resetSessionSystemRecordsProtocolV1ActivationForTests,
} from "@/app/session/systemRecords/sessionSystemRecordProtocolContract";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { registerTeamInvitationRoutes } from "./invitations/registerTeamInvitationRoutes";
import { registerTeamMemberRoutes } from "./memberships/registerTeamMemberRoutes";
import { registerTeamRoutes } from "./registerTeamRoutes";

/**
 * The one composed two-Account journey the Teams program promises, driven
 * across the real server route handlers of one Home. Requests are dispatched
 * with `app.inject`, so this exercises routing, admission, transactions and
 * projections but not a listener, socket, client transport or delivery leg;
 * the loaded-app journey remains a release check.
 *
 * Every step asserts the canonical projection a client would read; nothing
 * asserts a row shape or an internal helper. The steps are ordered `it`
 * blocks over shared state so that a RED step does not hide the steps after
 * it: each later step re-derives what it needs from the transports, never
 * from an earlier assertion. Assertions that are expected RED today carry the
 * verified finding id they map to, so the closeout lane can watch them turn
 * GREEN without rewriting the journey.
 *
 * Feature bits this journey needs on the Home (`teams` is enabled by default
 * and is named for completeness):
 *   HAPPIER_FEATURE_TEAMS__ENABLED
 *   HAPPIER_FEATURE_SESSIONS_FILTERED_LISTING__ENABLED (Team-shared Sessions appear in a listing)
 *   HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED       (explicit Follow, read tracking, attention)
 *   HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED   (discussions and mentions)
 *   HAPPIER_FEATURE_SESSIONS_BOARD__ENABLED           (Board items, views and the surface wakeup)
 * plus HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY=optional so an E2EE Session
 * can be created on a Home whose policy does not force one mode.
 *
 * Two boundaries are substituted and nothing else: the mail transport, a real
 * external system; and authentication, which `createAuthenticatedTestApp`
 * replaces with the `x-test-user-id` header so each request carries a known
 * Account. Every decision beneath them — admission, capability resolution,
 * transactions, projections — runs for real against the database.
 */
describe("Composed two-Account Teams journey (SQLite integration)", () => {
    let harness: LightSqliteHarness;
    let app: ReturnType<typeof createAuthenticatedTestApp>;
    const delivered: AuthEmailMessage[] = [];

    const HOME_TARGET = "portable-home-target";
    const APPLICATION_ORIGIN = "https://app.example.test";
    const B_EMAIL = "brooke@example.test";

    // Recipient content keys: B must be able to open what A seals for it.
    const bContentKeys = tweetnacl.box.keyPair();
    const sessionDataKey = tweetnacl.randomBytes(32);
    const e2eeTag = (seed: string) => ({ kind: "e2eeTag" as const, tag: seed.repeat(43).slice(0, 43) });

    const state: {
        aId: string;
        bId: string;
        teamId: string;
        invitationToken: string | null;
        sessionId: string;
        discussionId: string | null;
        discussionMessageSeq: number | null;
        boardItemRevision: string | null;
        boardLayoutRevision: string | null;
    } = {
        aId: "",
        bId: "",
        teamId: "",
        invitationToken: null,
        sessionId: "",
        discussionId: null,
        discussionMessageSeq: null,
        boardItemRevision: null,
        boardLayoutRevision: null,
    };

    const headers = (accountId: string) => ({
        "x-test-user-id": accountId,
        "x-happier-account-stored-content-protocol": "2",
    });
    const post = (url: string, accountId: string, payload: unknown) =>
        app.inject({ method: "POST", url, headers: headers(accountId), payload: payload as Record<string, unknown> });
    const get = (url: string, accountId: string) =>
        app.inject({ method: "GET", url, headers: headers(accountId) });
    const put = (url: string, accountId: string, payload: unknown) =>
        app.inject({ method: "PUT", url, headers: headers(accountId), payload: payload as Record<string, unknown> });
    // The System Record reads are the client's refresh path; V1 addresses are
    // only served to a caller that asks for the V1 protocol.
    const readSystemRecord = (accountId: string, query: Record<string, string>) =>
        app.inject({
            method: "GET", url: `/v2/sessions/${state.sessionId}/system-records/record`,
            headers: { ...headers(accountId), "x-happier-session-system-records-protocol": "1" },
            query,
        });
    const BOARD_ITEM_ID = "journey-note";
    const boardItemQuery = { owner: "host", namespace: "surface", kind: "item.v1", localId: BOARD_ITEM_ID };
    const boardLayoutQuery = { owner: "host", namespace: "surface", kind: "layout.v1", localId: "layout" };

    async function e2eeAccount(input: Readonly<{ homeRole: "owner" | "member"; contentPublicKey?: Uint8Array }>) {
        const binding = createSignedAccountContentBinding(input.contentPublicKey);
        return db.account.create({
            data: {
                publicKey: binding.publicKey,
                encryptionMode: "e2ee",
                homeRole: input.homeRole,
                contentPublicKey: Buffer.from(binding.contentPublicKey),
                contentPublicKeySig: Buffer.from(binding.contentPublicKeySig),
            },
            select: { id: true },
        });
    }

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-composed-two-account-journey-",
            initAuth: false,
            env: {
                HAPPIER_FEATURE_TEAMS__ENABLED: "1",
                HAPPIER_FEATURE_SESSIONS_FILTERED_LISTING__ENABLED: "1",
                HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED: "1",
                HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED: "1",
                HAPPIER_FEATURE_SESSIONS_BOARD__ENABLED: "1",
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            },
        });
        // The Board bit depends on the System Records v1 contract being active
        // on this database, exactly as it does on a running Home.
        await expect(initializeSessionSystemRecordsProtocolV1Activation(db)).resolves.toBe(true);

        const a = await e2eeAccount({ homeRole: "owner" });
        const b = await e2eeAccount({ homeRole: "member", contentPublicKey: bContentKeys.publicKey });
        state.aId = a.id;
        state.bId = b.id;
        // B's mailbox is proven the way every live admission path proves it.
        const email = normalizeVerifiedEmail(B_EMAIL);
        if (!email) throw new Error("fixture email must normalize");
        await inTx((tx) => upsertVerifiedMailboxEvidenceInTx(tx, { accountId: b.id, email }));

        app = createAuthenticatedTestApp();
        sessionRoutes(app);
        registerDiscussionRoutes(app);
        homeGovernanceRoutes(app);
        registerTeamRoutes(app);
        registerTeamMemberRoutes(app);
        registerTeamInvitationRoutes(app, {
            resolveJoinLinkTarget: async () => ({ applicationOrigin: APPLICATION_ORIGIN, homeTarget: HOME_TARGET }),
            resolveJoinScreenHomeIdentity: async () => ({
                serverId: "home-1",
                displayName: "Acme Home",
                // The join screen's storage disclosure is its own vocabulary
                // (`encrypted` | `plain` | `null` when the Home admits both):
                // it is the Home's at-rest fact, not the Account encryption
                // mode, whose values are `plain` | `e2ee`.
                storageMode: "encrypted",
                hosting: null,
            }),
            email: {
                delivery: {
                    isReady: async () => true,
                    deliver: async (message) => {
                        delivered.push(message);
                        return { status: "sent" };
                    },
                },
                isDeliveryReady: () => true,
            },
        });
        await app.ready();
    }, 180_000);

    afterAll(async () => {
        if (app) await app.close();
        resetSessionSystemRecordsProtocolV1ActivationForTests();
        if (harness) await harness.close();
    });

    it("step 1 — A creates a Team and is its owner", async () => {
        const created = await post("/v1/teams/create", state.aId, {
            // A is the Home owner creating a Team for themselves; under the default managed_only policy the owner must be named (H7).
            initialOwnerAccountId: state.aId,
            v: 1, name: "Acme", requestKey: randomUUID(),
        });
        expect(created.statusCode, created.body).toBe(200);
        const team = created.json();
        expect(team).toMatchObject({
            name: "Acme",
            archivedAt: null,
            viewerRole: "owner",
            capabilities: expect.objectContaining({ manageMembers: true }),
        });
        state.teamId = team.id;
    });

    it("step 2 — A finds B by verified email in the Team member picker [C2-1]", async () => {
        const search = await post("/v1/home/accounts/search", state.aId, {
            query: B_EMAIL,
            scope: { kind: "team", teamId: state.teamId },
        });
        expect(search.statusCode, search.body).toBe(200);
        // C2-1: `searchHomeAccountsInTx` used to resolve only an exact Account
        // ID, so a verified mailbox found nobody and every picker was a dead
        // end. The owner now matches the exact verified mailbox as well; this
        // step is the journey's proof that the picker finds B by email.
        expect(search.json()).toEqual({
            accounts: [{
                accountId: state.bId,
                profile: { name: null, firstName: null, lastName: null, username: null, avatarUrl: null },
                eligible: true,
            }],
        });
    });

    it("step 3 — A invites B by email with existing-history access and the link names the Home", async () => {
        const created = await post("/v1/teams/invitations/create", state.aId, {
            v: 1,
            teamId: state.teamId,
            role: "member",
            historyAccess: "all_existing",
            recipientEmail: B_EMAIL,
            requestKey: randomUUID(),
        });
        expect(created.statusCode, created.body).toBe(200);
        const body = created.json();
        expect(body.invitation).toMatchObject({
            role: "member",
            historyAccess: "all_existing",
            lastEmailDelivery: expect.objectContaining({ status: "sent" }),
        });
        expect(body.invitation.recipientEmailMask).not.toBeNull();
        // An email-bound invitation travels only inside the mail; the manager
        // page never shows the bearer. The mailed link is explicit about the
        // Home it opens on.
        expect(body.joinUrl).toBeNull();
        expect(delivered.map((message) => message.kind)).toEqual(["invitation"]);
        const mail = delivered[0];
        if (mail?.kind !== "invitation") throw new Error("expected the invitation mail");
        expect(mail.joinUrl).toMatch(
            new RegExp(`^${APPLICATION_ORIGIN.replace(/\./gu, "\\.")}/join/[A-Za-z0-9]{43}\\?target=${HOME_TARGET}&targetBinding=[A-Za-z0-9_-]{43}$`, "u"),
        );
        state.invitationToken = new URL(mail.joinUrl).pathname.split("/").at(-1) ?? null;
    });

    it("step 4 — B accepts on that Home and becomes an active member with the invited history", async () => {
        if (state.invitationToken === null) throw new Error("step 3 produced no invitation token");
        const accepted = await post("/v1/team-invitations/accept", state.bId, { v: 1, token: state.invitationToken });
        expect(accepted.statusCode, accepted.body).toBe(200);
        expect(accepted.json()).toEqual({ outcome: "joined", teamId: state.teamId });

        const members = await post("/v1/teams/members/list", state.aId, {
            v: 1, teamId: state.teamId, filter: "all",
        });
        expect(members.statusCode, members.body).toBe(200);
        const rows = members.json().items as Array<{ accountId: string; role: string; status: string; historyAccess: string }>;
        expect(rows.map((row) => [row.accountId, row.role, row.status, row.historyAccess]).sort()).toEqual([
            [state.aId, "owner", "active", "all_existing"],
            [state.bId, "member", "active", "all_existing"],
        ].sort());
    });

    it("step 5 — A creates an E2EE Session and shares it with the Team", async () => {
        const ownerEnvelope = sealEncryptedDataKeyEnvelopeV1({
            dataKey: sessionDataKey,
            recipientPublicKey: tweetnacl.box.keyPair().publicKey,
            randomBytes: (length) => tweetnacl.randomBytes(length),
        });
        const created = await post("/v1/sessions", state.aId, {
            tag: "journey-session",
            metadataLayoutVersion: 1,
            sharedMetadata: { ciphertext: "opaque-shared-metadata" },
            ownerMetadata: {
                t: "encrypted",
                c: sealSessionOwnerMetadataV1({
                    material: { type: "legacy", secret: tweetnacl.randomBytes(32) },
                    ownerMetadata: { v: 1 },
                    randomBytes: (length) => tweetnacl.randomBytes(length),
                }),
            },
            encryptionMode: "e2ee",
            dataEncryptionKey: Buffer.from(ownerEnvelope).toString("base64"),
        });
        expect(created.statusCode, created.body).toBe(200);
        expect(created.json().session).toMatchObject({ encryptionMode: "e2ee" });
        state.sessionId = created.json().session.id;

        const shared = await post("/v2/sessions/access-grants/set", state.aId, {
            sessionId: state.sessionId,
            subject: { kind: "team", teamId: state.teamId },
            accessLevel: "edit",
            canApprovePermissions: false,
        });
        expect(shared.statusCode, shared.body).toBe(200);
        expect(shared.json()).toMatchObject({
            changed: true,
            grant: { subject: { kind: "team", teamId: state.teamId }, accessLevel: "edit" },
        });
    });

    it("step 6 — B lists and opens it; the recipient envelope is pending, then present", async () => {
        // A's collaboration editor sees B as a recipient whose envelope is pending.
        const pending = await get(`/v2/sessions/${state.sessionId}/data-key/envelopes`, state.aId);
        expect(pending.statusCode, pending.body).toBe(200);
        expect(pending.json()).toMatchObject({
            status: "required",
            summary: { pending: 1, recipientKeyUnavailable: 0, invalid: 0 },
        });
        expect(pending.json().items).toContainEqual({
            recipientAccountId: state.bId,
            envelopeState: "missing",
            contentKey: expect.objectContaining({ status: "available" }),
        });

        // B lists through the Team-aware listing and opens the detail with
        // effective access; the key is not there yet, and that is stated.
        const listed = await post("/v2/sessions/query", state.bId, {
            v: 1, storage: "active", includeInactive: true, scope: "all_accessible",
            attention: "any", audiences: { include: [{ kind: "team", teamId: state.teamId }], exclude: [] }, tagIds: { include: [], exclude: [] },
        });
        expect(listed.statusCode, listed.body).toBe(200);
        expect(listed.json().sessions.map((row: { id: string }) => row.id)).toEqual([state.sessionId]);
        expect(listed.json().sessions[0]).toMatchObject({
            dataEncryptionKey: null,
            viewer: { readState: { state: "not_started" }, follow: { follows: false } },
        });
        const openedBefore = await get(`/v2/sessions/${state.sessionId}?accessProjectionVersion=1`, state.bId);
        expect(openedBefore.statusCode, openedBefore.body).toBe(200);
        expect(openedBefore.json().session).toMatchObject({ id: state.sessionId, dataEncryptionKey: null });

        // A prepares B's envelope through the one envelope owner.
        const bEnvelope = sealEncryptedDataKeyEnvelopeV1({
            dataKey: sessionDataKey,
            recipientPublicKey: bContentKeys.publicKey,
            randomBytes: (length) => tweetnacl.randomBytes(length),
        });
        const patched = await app.inject({
            method: "PATCH",
            url: `/v2/sessions/${state.sessionId}/data-key/envelopes`,
            headers: headers(state.aId),
            payload: { entries: [{ recipientAccountId: state.bId, encryptedDataKey: Buffer.from(bEnvelope).toString("base64") }] },
        });
        expect(patched.statusCode, patched.body).toBe(200);
        expect(patched.json()).toEqual({ appliedCount: 1 });

        // The default page lists only exceptions, so a prepared recipient is
        // read through the explicit `state=all` view of the same collection.
        const prepared = await get(`/v2/sessions/${state.sessionId}/data-key/envelopes?state=all`, state.aId);
        expect(prepared.statusCode, prepared.body).toBe(200);
        expect(prepared.json()).toMatchObject({ status: "required", summary: { pending: 0, invalid: 0, recipientKeyUnavailable: 0 } });
        expect(prepared.json().items).toContainEqual({
            recipientAccountId: state.bId,
            envelopeState: "prepared",
            contentKey: expect.objectContaining({ status: "available" }),
        });

        // B now opens the Session and can open its own envelope to the Session key.
        const opened = await get(`/v2/sessions/${state.sessionId}?accessProjectionVersion=1`, state.bId);
        expect(opened.statusCode, opened.body).toBe(200);
        const dataEncryptionKey = opened.json().session.dataEncryptionKey as string | null;
        expect(dataEncryptionKey).not.toBeNull();
        expect(openEncryptedDataKeyEnvelopeV1({
            envelope: new Uint8Array(Buffer.from(dataEncryptionKey!, "base64")),
            recipientSecretKeyOrSeed: bContentKeys.secretKey,
        })).toEqual(sessionDataKey);
    });

    it("step 7 — A assigns B responsible and B explicitly follows at Important", async () => {
        const assigned = await post("/v2/sessions/responsibility/set", state.aId, {
            sessionId: state.sessionId, responsibleAccountId: state.bId,
        });
        expect(assigned.statusCode, assigned.body).toBe(200);
        expect(assigned.json()).toMatchObject({
            changed: true, responsibleAccountId: state.bId, autoFollowed: false,
        });

        const followed = await app.inject({
            method: "PUT", url: `/v2/sessions/${state.sessionId}/follow`, headers: headers(state.bId),
            payload: { notificationLevel: "important", includeInVoice: false },
        });
        expect(followed.statusCode, followed.body).toBe(200);

        const follow = await get(`/v2/sessions/${state.sessionId}/follow`, state.bId);
        expect(follow.statusCode, follow.body).toBe(200);
        expect(follow.json()).toMatchObject({
            follow: { sessionId: state.sessionId, following: true, notificationLevel: "important" },
            isSessionOwner: false,
        });

        const opened = await get(`/v2/sessions/${state.sessionId}?accessProjectionVersion=1`, state.bId);
        expect(opened.statusCode, opened.body).toBe(200);
        expect(opened.json().session).toMatchObject({
            responsibleAccountId: state.bId,
            viewer: {
                readState: { state: "tracking" },
                follow: { follows: true, notificationLevel: "important" },
                relevance: { reasons: expect.arrayContaining(["responsible_for_me", "followed_by_me"]) },
            },
        });
    });

    it("step 8 — new Session activity puts the Session in B's attention as unread", async () => {
        const posted = await post(`/v2/sessions/${state.sessionId}/messages`, state.aId, {
            content: { t: "encrypted", c: "opaque-transcript-message" },
            localId: randomUUID(),
        });
        expect(posted.statusCode, posted.body).toBe(200);
        expect(posted.json()).toMatchObject({ didWrite: true });

        const attention = await post("/v2/sessions/query", state.bId, {
            v: 1, storage: "active", includeInactive: true, scope: "assigned_to_me",
            attention: "needs_my_attention", audiences: { include: [], exclude: [] }, tagIds: { include: [], exclude: [] },
        });
        expect(attention.statusCode, attention.body).toBe(200);
        expect(attention.json().sessions.map((row: { id: string }) => row.id)).toEqual([state.sessionId]);
        expect(attention.json().sessions[0].viewer.attention).toMatchObject({
            needsAttention: true,
            reasons: expect.arrayContaining(["unread"]),
        });
    });

    it("step 9 — A mentions B in a discussion on the Session", async () => {
        const [a, b] = await Promise.all([state.aId, state.bId].map(id => db.account.findUniqueOrThrow({ where: { id }, select: RECIPIENT_READINESS_SELECT })));
        const ownerKey = deriveAccountRecipientEnvelopeReadinessFromRow(a);
        const recipientKey = deriveAccountRecipientEnvelopeReadinessFromRow(b);
        if (ownerKey.status !== "available" || recipientKey.status !== "available") throw new Error("Discussion recipients require current content keys");
        const discussionDataKey = tweetnacl.randomBytes(32);
        const sealKey = (recipientPublicKey: Uint8Array) => encodeBase64(sealEncryptedDataKeyEnvelopeV1({
            dataKey: discussionDataKey, recipientPublicKey, randomBytes: length => tweetnacl.randomBytes(length),
        }));
        const created = await post(DISCUSSION_HTTP_PATHS_V1.collection, state.aId, {
            anchor: { kind: "session", sessionId: state.sessionId },
            participants: [{ kind: "account", accountId: state.bId }],
            dataEncryptionKey: sealKey(ownerKey.binding.contentPublicKey),
            expectedOwnerContentPublicKeyFingerprint: ownerKey.binding.contentPublicKeyFingerprint,
            recipientKeyEnvelopes: [{ recipientAccountId: state.bId, encryptedDataKey: sealKey(recipientKey.binding.contentPublicKey),
                recipientContentPublicKeyFingerprint: recipientKey.binding.contentPublicKeyFingerprint }],
            creationLocalId: "journey-discussion",
            creationEqualityEvidenceV1: e2eeTag("A"),
            titleContent: { t: "encrypted", c: "opaque-title" },
            firstMessage: {
                localId: "journey-mention",
                requestEqualityEvidenceV1: e2eeTag("B"),
                content: { t: "encrypted", c: "opaque-mention" },
                mentionedAccountIds: [state.bId],
            },
        });
        expect(created.statusCode, created.body).toBe(200);
        expect(created.json()).toMatchObject({
            discussion: { anchor: { kind: "session", sessionId: state.sessionId }, ownerAccountId: state.aId, messageSeq: 1 },
            firstMessage: { mentionedAccountIds: [state.bId], producerV1: null },
        });
        state.discussionId = created.json().discussion.id;
        state.discussionMessageSeq = created.json().discussion.messageSeq;
    });

    it("step 10 — B's read state and awareness reflect the mention, then clear when B reads", async () => {
        if (state.discussionId === null || state.discussionMessageSeq === null) {
            throw new Error("step 9 produced no discussion");
        }
        const discussionUrl = DISCUSSION_HTTP_PATHS_V1.discussion.replace(":discussionId", state.discussionId);
        const unread = await get(discussionUrl, state.bId);
        expect(unread.statusCode, unread.body).toBe(200);
        // B is a tracked reader (explicitly followed at step 7), so B's own baseline
        // cursor already exists at 0; the unread counts are what a client reads.
        expect(unread.json().discussion).toMatchObject({ unreadCount: 1, unreadMentionCount: 1, lastReadSeq: 0 });

        const mentioned = await get(`/v2/sessions/${state.sessionId}?accessProjectionVersion=1`, state.bId);
        expect(mentioned.json().session.viewer).toMatchObject({
            attention: { needsAttention: true, reasons: expect.arrayContaining(["mentioned", "unread_discussion"]) },
            relevance: { reasons: expect.arrayContaining(["mentioned_in_discussion"]) },
        });

        // B reads the discussion and the Session; both cursors are B's own.
        const readDiscussion = await app.inject({
            method: "PUT", url: `${discussionUrl}/read`, headers: headers(state.bId),
            payload: { lastReadSeq: state.discussionMessageSeq },
        });
        expect(readDiscussion.statusCode, readDiscussion.body).toBe(200);
        const readSession = await post(`/v2/sessions/${state.sessionId}/read-state`, state.bId, { state: "read" });
        expect(readSession.statusCode, readSession.body).toBe(200);
        expect(readSession.json()).toMatchObject({ success: true, state: "read" });

        const caughtUp = await get(discussionUrl, state.bId);
        expect(caughtUp.json().discussion).toMatchObject({
            unreadCount: 0, unreadMentionCount: 0, lastReadSeq: state.discussionMessageSeq,
        });
        const quiet = await get(`/v2/sessions/${state.sessionId}?accessProjectionVersion=1`, state.bId);
        expect(quiet.json().session.viewer.attention).toMatchObject({ needsAttention: false, reasons: [] });
        expect(quiet.json().session.viewer.relevance.reasons).toContain("mentioned_in_discussion");
    });

    it("step 11 — A's authenticated Board Action creates an item and its view atomically; E2EE content stays opaque and B is woken content-free", async () => {
        const boardUrl = `/v2/sessions/${state.sessionId}/board`;
        const itemContent = { t: "encrypted", c: "sealed-journey-item" };
        const layoutContent = { t: "encrypted", c: "sealed-journey-layout" };
        const created = await put(boardUrl, state.aId, {
            operation: "upsert_item", itemId: BOARD_ITEM_ID, itemContent, expectedItemRevision: null,
            placement: { layoutContent, expectedLayoutRevision: null },
        });
        expect(created.statusCode, created.body).toBe(200);
        expect(created.json()).toMatchObject({ operation: "upsert_item", outcome: "created", itemId: BOARD_ITEM_ID });
        state.boardItemRevision = created.json().itemRevision;
        state.boardLayoutRevision = created.json().layoutRevision;

        // Item and placement commit together on the Session owner's tuple;
        // both encrypted payloads remain opaque to the server.
        const stored = await db.sessionSystemRecord.findMany({
            where: { sessionId: state.sessionId }, select: { id: true, accountId: true, kind: true, localId: true, content: true },
        });
        expect(stored).toHaveLength(2);
        expect(new Set(stored.map(row => row.accountId))).toEqual(new Set([state.aId]));
        expect(stored.find(row => row.localId === BOARD_ITEM_ID)?.content).toEqual(itemContent);
        expect(stored.find(row => row.localId === "layout")?.content).toEqual(layoutContent);

        // Each physical record retains an independent, content-free wake for both viewers.
        const woken = await db.accountChange.findMany({
            where: { entityId: { in: stored.map(record => `session-record:${record.id}`) }, kind: "account" }, select: { accountId: true, entityId: true, hint: true },
        });
        expect(woken).toHaveLength(4);
        expect(new Set(woken.map(row => row.accountId))).toEqual(new Set([state.aId, state.bId]));
        for (const change of woken) {
            const record = stored.find(record => change.entityId === `session-record:${record.id}`)!;
            expect(change.hint).toEqual({ v: 1, sessionRecords: { sessionId: state.sessionId,
                address: { owner: 'host', namespace: 'surface', kind: record.kind, localId: record.localId } } });
        }
    });

    it("step 12 — B refreshes through the System Record reads and both viewers converge on one shared Board", async () => {
        const item = await readSystemRecord(state.bId, boardItemQuery);
        expect(item.statusCode, item.body).toBe(200);
        expect(item.json().record).toMatchObject({
            revision: state.boardItemRevision,
            content: { t: "encrypted", c: "sealed-journey-item" },
        });
        const layout = await readSystemRecord(state.bId, boardLayoutQuery);
        expect(layout.statusCode, layout.body).toBe(200);
        expect(layout.json().record.revision).toBe(state.boardLayoutRevision);

        // B is an editor, so B's own layout change is admitted at the revision
        // B just read, and A converges on exactly that one shared order —
        // there is no second per-viewer Board tuple.
        const reordered = await put(`/v2/sessions/${state.sessionId}/board`, state.bId, {
            operation: "update_layout", layoutContent: { t: "encrypted", c: "sealed-journey-layout-2" },
            expectedLayoutRevision: state.boardLayoutRevision,
        });
        expect(reordered.statusCode, reordered.body).toBe(200);
        state.boardLayoutRevision = reordered.json().layoutRevision;
        const stale = await put(`/v2/sessions/${state.sessionId}/board`, state.aId, {
            operation: "update_layout", layoutContent: { t: "encrypted", c: "sealed-journey-layout-3" },
            expectedLayoutRevision: layout.json().record.revision,
        });
        expect(stale.statusCode, stale.body).toBe(409);
        const converged = await readSystemRecord(state.aId, boardLayoutQuery);
        expect(converged.statusCode, converged.body).toBe(200);
        expect(converged.json().record).toMatchObject({
            revision: state.boardLayoutRevision,
            content: { t: "encrypted", c: "sealed-journey-layout-2" },
        });
    });

    it("step 13 — A withdraws the Team grant; B loses access and the envelope leaves the projection", async () => {
        const removed = await post("/v2/sessions/access-grants/remove", state.aId, {
            sessionId: state.sessionId, subject: { kind: "team", teamId: state.teamId },
        });
        expect(removed.statusCode, removed.body).toBe(200);
        expect(removed.json()).toEqual({ changed: true, subject: { kind: "team", teamId: state.teamId } });

        // B: concealed everywhere a client would look.
        const opened = await get(`/v2/sessions/${state.sessionId}?accessProjectionVersion=1`, state.bId);
        expect(opened.statusCode, opened.body).toBe(404);
        const listed = await post("/v2/sessions/query", state.bId, {
            v: 1, storage: "active", includeInactive: true, scope: "all_accessible",
            attention: "any", audiences: { include: [], exclude: [] }, tagIds: { include: [], exclude: [] },
        });
        expect(listed.statusCode, listed.body).toBe(200);
        expect(listed.json().sessions).toEqual([]);
        const follow = await get(`/v2/sessions/${state.sessionId}/follow`, state.bId);
        expect([follow.statusCode, follow.json()]).toEqual([404, { error: "session_not_found" }]);

        // The Board retires with the access: B can neither read the records nor
        // write the view any more, while A's Board is untouched.
        // The record read conceals rather than refuses, exactly like the
        // Session read above: B is told nothing about a Board it can no
        // longer reach.
        const retiredItem = await readSystemRecord(state.bId, boardItemQuery);
        expect(retiredItem.statusCode, retiredItem.body).toBe(404);
        expect(retiredItem.json()).toMatchObject({ code: "plugin_session_not_found" });
        expect(retiredItem.body).not.toContain("sealed-journey-item");
        const retiredWrite = await put(`/v2/sessions/${state.sessionId}/board`, state.bId, {
            operation: "update_layout", layoutContent: { t: "encrypted", c: "sealed-after-revocation" },
            expectedLayoutRevision: state.boardLayoutRevision,
        });
        expect(retiredWrite.statusCode, retiredWrite.body).toBe(403);
        expect(retiredWrite.json()).toEqual({ error: "session_board_forbidden" });
        const ownerBoard = await readSystemRecord(state.aId, boardLayoutQuery);
        expect(ownerBoard.statusCode, ownerBoard.body).toBe(200);
        expect(ownerBoard.json().record).toMatchObject({
            revision: state.boardLayoutRevision,
            content: { t: "encrypted", c: "sealed-journey-layout-2" },
        });

        // A: the responsibility is released with the access and the envelope
        // collection projects only the audience that remains. The stored tuple
        // may persist, but it is never projected for a recipient without access.
        const detail = await get(`/v2/sessions/${state.sessionId}?accessProjectionVersion=1`, state.aId);
        expect(detail.statusCode, detail.body).toBe(200);
        expect(detail.json().session).toMatchObject({ responsibleAccountId: null });
        const envelopes = await get(`/v2/sessions/${state.sessionId}/data-key/envelopes?state=all`, state.aId);
        expect(envelopes.statusCode, envelopes.body).toBe(200);
        expect(envelopes.json()).toMatchObject({
            status: "required",
            summary: { prepared: 1, pending: 0, invalid: 0, recipientKeyUnavailable: 0 },
        });
        // The one prepared envelope left is the storage owner's own.
        expect(envelopes.json().items.map((item: { recipientAccountId: string }) => item.recipientAccountId))
            .toEqual([state.aId]);
    });
});
