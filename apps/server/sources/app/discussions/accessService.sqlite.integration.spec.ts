import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { API_TOKEN_FULL_GRANT_V1 } from "@happier-dev/protocol/auth/apiTokenGrant";
import { computeContentPublicKeyFingerprint } from "@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint";
import { sealEncryptedDataKeyEnvelopeV1 } from "@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1";
import { DiscussionAccessGrantMutationResponseV1Schema, DiscussionAccessRecipientCensusResponseV1Schema, DiscussionLeaveResponseV1Schema } from "@happier-dev/protocol/discussions/access";
import { DiscussionListResponseV1Schema } from '@happier-dev/protocol/discussions/api';
import * as privacyKit from "privacy-kit";
import tweetnacl from "tweetnacl";
import { db } from "@/storage/db";
import { makeShareEligibleForTest } from "@/testkit/shareEligibility.testkit";
import { getPublicUrl } from '@/storage/blob/files';
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { publishTeamChangedInTx } from "@/app/teams/teamChanges";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { createDiscussion, postDiscussionMessage } from "./mutations";
import { getDiscussion, listDiscussions, readDiscussionMessages } from "./queries";
import { filterDiscussionsWithCurrentReadAccessInTx, resolveDiscussionContextInTx } from "./access";
import { commitDiscussionRecipientKeyEnvelopes, inviteDiscussionParticipant, leaveDiscussion, listDiscussionParticipants, readDiscussionRecipientCensus, removeDiscussionParticipant, setDiscussionGrant, transferDiscussionOwner } from "./accessService";

// Public blob storage is an external boundary; keep profile sanitization and all grants/DB logic real.
vi.mock('@/storage/blob/files', () => ({ getPublicUrl: (path: string) => `https://files.test/${path}` }));

describe("Discussion grant service (SQLite)", () => {
    let harness: LightSqliteHarness;
    const authentication = createPresentUserSessionAccessAuthentication();
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-discussion-access-", initAuth: false });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    async function fixture() {
        const [owner, invitee, outsider] = await Promise.all(Array.from({ length: 3 }, () => db.account.create({
            data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" },
        })));
        await makeShareEligibleForTest(owner.id, [invitee.id, outsider.id]);
        const created = await createDiscussion({ actorAccountId: owner.id, authentication, request: {
            creationLocalId: crypto.randomUUID(), titleContent: { t: "plain", v: { v: 1, title: "Private discussion" } },
            firstMessage: { localId: crypto.randomUUID(), content: { t: "plain", v: { v: 1, parts: [{ t: "text", text: "Hello" }] } }, mentionedAccountIds: [] },
        } });
        expect(created.ok).toBe(true);
        if (!created.ok) throw new Error(created.error);
        return { owner, invitee, outsider, discussionId: created.value.discussion.id };
    }

    it.each(['plain', 'e2ee'] as const)('admits the owning Account automation publisher without granting Session authorship (%s)', async mode => {
        const keys = tweetnacl.box.keyPair();
        const owner = await db.account.create({ data: { encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding(keys.publicKey) : {}) } });
        const request = mode === 'plain' ? {
            creationLocalId: crypto.randomUUID(), titleContent: { t: 'plain' as const, v: { v: 1 as const, title: 'Account delivery' } },
            firstMessage: { localId: crypto.randomUUID(), content: { t: 'plain' as const, v: { v: 1 as const, parts: [{ t: 'text' as const, text: 'Start' }] } }, mentionedAccountIds: [] },
        } : {
            creationLocalId: crypto.randomUUID(), titleContent: { t: 'encrypted' as const, c: 'opaque-title' },
            creationEqualityEvidenceV1: { kind: 'e2eeTag' as const, tag: 'A'.repeat(43) },
            dataEncryptionKey: privacyKit.encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: tweetnacl.randomBytes(32),
                recipientPublicKey: keys.publicKey, randomBytes: tweetnacl.randomBytes })),
            expectedOwnerContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(keys.publicKey),
            firstMessage: { localId: crypto.randomUUID(), content: { t: 'encrypted' as const, c: 'opaque-message' },
                requestEqualityEvidenceV1: { kind: 'e2eeTag' as const, tag: 'B'.repeat(43) }, mentionedAccountIds: [] },
        };
        const created = await createDiscussion({ actorAccountId: owner.id, authentication, request });
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        const automated = { ...authentication, authority: 'account_automation' as const };
        const message = { ...request.firstMessage, localId: crypto.randomUUID() };
        const delivered = await postDiscussionMessage({ actorAccountId: owner.id, discussionId, authentication: automated, request: message });
        expect(delivered).toMatchObject({ ok: true, value: { message: { authorAccountId: owner.id, seq: 2 } } });
        expect(await postDiscussionMessage({ actorAccountId: owner.id, discussionId, authentication: automated, request: message })).toEqual(delivered);
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: mode } });
        // Signed Session Actions retain this verified Session scope even when
        // their HTTP credential has no materialized runtime principal.
        expect(await postDiscussionMessage({ actorAccountId: owner.id, discussionId,
            authentication: { ...automated, contentDisclosureSessionId: session.id },
            request: { ...message, localId: crypto.randomUUID() } }))
            .toEqual({ ok: false, error: 'discussion_post_denied' });
        expect(await postDiscussionMessage({ actorAccountId: owner.id, discussionId, authentication: automated,
            producer: { v: 1, kind: 'agent', sessionId: session.id }, request: { ...message, localId: crypto.randomUUID() } }))
            .toEqual({ ok: false, error: 'discussion_post_denied' });
        const outsider = await db.account.create({ data: { encryptionMode: mode } });
        expect(await postDiscussionMessage({ actorAccountId: outsider.id, discussionId, authentication: automated,
            request: { ...message, localId: crypto.randomUUID() } })).toMatchObject({ ok: false });
        expect(await db.discussion.findUniqueOrThrow({ where: { id: discussionId } })).toMatchObject({ messageSeq: 2 });
    });

    it.each(['view', 'edit'] as const)('keeps non-owner automation denied despite a %s Discussion grant', async accessLevel => {
        const { owner, invitee, discussionId } = await fixture();
        expect(await setDiscussionGrant({ actorAccountId: owner.id, discussionId, authentication,
            request: { principal: { kind: 'account', accountId: invitee.id }, accessLevel } })).toMatchObject({ ok: true });
        const request = { localId: crypto.randomUUID(), content: { t: 'plain' as const,
            v: { v: 1 as const, parts: [{ t: 'text' as const, text: 'Account delivery' }] } }, mentionedAccountIds: [] };
        expect(await postDiscussionMessage({ actorAccountId: invitee.id, discussionId,
            authentication: { ...authentication, authority: 'account_automation' }, request }))
            .toEqual({ ok: false, error: 'discussion_post_denied' });
        expect(await db.discussion.findUniqueOrThrow({ where: { id: discussionId } })).toMatchObject({ messageSeq: 1 });
    });

    it('keeps atomic encrypted initial Session bindings subject to actual runtime recipient readiness', async () => {
        const ownerKeys = tweetnacl.box.keyPair();
        const colleagueKeys = tweetnacl.box.keyPair();
        const owner = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(ownerKeys.publicKey) } });
        const colleague = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(colleagueKeys.publicKey) } });
        await db.userRelationship.create({ data: { fromUserId: owner.id, toUserId: colleague.id, status: 'friend' } });
        const own = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'e2ee' } });
        const foreign = await db.session.create({ data: { accountId: colleague.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: foreign.id, createdByAccountId: colleague.id, accountId: owner.id, accessLevel: 'edit' } });
        const dataKey = tweetnacl.randomBytes(32);
        const envelope = (recipientPublicKey: Uint8Array) => privacyKit.encodeBase64(sealEncryptedDataKeyEnvelopeV1({
            dataKey, recipientPublicKey, randomBytes: tweetnacl.randomBytes,
        }));
        const request = {
            creationLocalId: crypto.randomUUID(), titleContent: { t: 'encrypted' as const, c: 'opaque-title' },
            creationEqualityEvidenceV1: { kind: 'e2eeTag' as const, tag: 'A'.repeat(43) },
            dataEncryptionKey: envelope(ownerKeys.publicKey), expectedOwnerContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(ownerKeys.publicKey),
            participants: [{ kind: 'session' as const, sessionId: own.id }],
            firstMessage: { localId: crypto.randomUUID(), content: { t: 'encrypted' as const, c: 'opaque-message' },
                requestEqualityEvidenceV1: { kind: 'e2eeTag' as const, tag: 'B'.repeat(43) }, mentionedAccountIds: [] },
        };
        expect(await createDiscussion({ actorAccountId: owner.id, authentication, request }))
            .toMatchObject({ ok: true, value: { discussion: { participantSessionIds: [own.id] } } });
        const sharedRequest = { ...request, creationLocalId: crypto.randomUUID(), firstMessage: { ...request.firstMessage, localId: crypto.randomUUID() },
            participants: [{ kind: 'account' as const, accountId: colleague.id },
                { kind: 'session' as const, sessionId: own.id }, { kind: 'session' as const, sessionId: foreign.id }] };
        expect(await createDiscussion({ actorAccountId: owner.id, authentication, request: sharedRequest }))
            .toEqual({ ok: false, error: 'discussion_content_unavailable' });
        expect(await db.discussion.count({ where: { createdByAccountId: owner.id } })).toBe(1);
        expect(await db.discussionAccountGrant.count({ where: { discussion: { createdByAccountId: owner.id } } })).toBe(0);
        expect(await db.discussionParticipant.count({ where: { discussion: { createdByAccountId: owner.id } } })).toBe(1);
        expect(await db.discussionMessage.count({ where: { discussion: { createdByAccountId: owner.id } } })).toBe(1);
        const prepared = await createDiscussion({ actorAccountId: owner.id, authentication, request: { ...sharedRequest,
            recipientKeyEnvelopes: [{ recipientAccountId: colleague.id, encryptedDataKey: envelope(colleagueKeys.publicKey),
                recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(colleagueKeys.publicKey) }],
        } });
        expect(prepared).toMatchObject({ ok: true, value: { discussion: { participantSessionIds: expect.arrayContaining([own.id, foreign.id]) } } });
        if (!prepared.ok) throw new Error(prepared.error);
        expect(await inTx(tx => resolveDiscussionContextInTx(tx, { discussionId: prepared.value.discussion.id, accountId: colleague.id, authentication })))
            .toMatchObject({ keyReadiness: true });
    });

    it("projects real invited participant faces without expanding a Team's private membership", async () => {
        const { owner, invitee, outsider, discussionId } = await fixture();
        await db.account.update({ where: { id: invitee.id }, data: { name: 'Quiet invitee', avatar: { path: 'avatar', width: 1, height: 1, thumbhash: 'x' } } });
        await inviteDiscussionParticipant({ actorAccountId: owner.id, discussionId, authentication,
            request: { participant: { kind: 'account', accountId: invitee.id } } });
        const team = await db.team.create({ data: { name: 'Readers' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "admin", status: "active" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: outsider.id, role: 'member', status: 'active' } });
        await setDiscussionGrant({ actorAccountId: owner.id, discussionId, authentication,
            request: { principal: { kind: 'team', teamId: team.id }, accessLevel: 'view' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await inviteDiscussionParticipant({ actorAccountId: owner.id, discussionId, authentication,
            request: { participant: { kind: 'session', sessionId: session.id } } });
        const listed = await listDiscussions({ actorAccountId: outsider.id, authentication });
        expect(listed).toMatchObject({ ok: true, value: { discussions: [expect.objectContaining({
            id: discussionId, participantAccounts: expect.arrayContaining([
                expect.objectContaining({ accountId: owner.id }),
                expect.objectContaining({ accountId: invitee.id, profile: expect.objectContaining({ name: 'Quiet invitee', avatarUrl: getPublicUrl('avatar') }) }),
            ]), participantSessionIds: [session.id],
        })] } });
        if (!listed.ok) throw new Error(listed.error);
        const serialized = JSON.parse(JSON.stringify(listed.value));
        const parsed = DiscussionListResponseV1Schema.parse(serialized);
        expect(parsed.discussions[0]).toMatchObject({ participantAccounts: expect.not.arrayContaining([expect.objectContaining({ accountId: outsider.id })]) });
        await removeDiscussionParticipant({ actorAccountId: owner.id, discussionId, authentication, request: { participant: { kind: 'account', accountId: invitee.id } } });
        await removeDiscussionParticipant({ actorAccountId: owner.id, discussionId, authentication, request: { participant: { kind: 'session', sessionId: session.id } } });
        expect(await getDiscussion({ actorAccountId: owner.id, discussionId, authentication })).toMatchObject({ ok: true, value: { discussion: {
            participantAccounts: [expect.objectContaining({ accountId: owner.id })], participantSessionIds: [],
        } } });
    });

    it('projects an explicit former relationship in the roster while retaining the sanitized profile', async () => {
        const { owner, invitee, discussionId } = await fixture();
        await db.account.update({ where: { id: invitee.id }, data: { name: 'Retained invitee' } });
        await inviteDiscussionParticipant({ actorAccountId: owner.id, discussionId, authentication,
            request: { participant: { kind: 'account', accountId: invitee.id } } });
        await db.account.update({ where: { id: invitee.id }, data: { status: 'suspended' } });

        expect(await listDiscussionParticipants({ actorAccountId: owner.id, discussionId, authentication })).toMatchObject({
            ok: true,
            value: {
                grants: [expect.objectContaining({ principal: { kind: 'account', accountId: invitee.id },
                    display: expect.objectContaining({ name: 'Retained invitee' }) })],
                accountActors: expect.arrayContaining([expect.objectContaining({ accountId: invitee.id,
                    accessibility: 'former', profile: expect.objectContaining({ name: 'Retained invitee' }) })]),
            },
        });
    });

    it("admits an invitation, revokes the next read, and preserves its own independent cursor", async () => {
        const { owner, invitee, outsider, discussionId } = await fixture();
        const invited = await inviteDiscussionParticipant({ actorAccountId: owner.id, discussionId, authentication,
            request: { participant: { kind: "account", accountId: invitee.id } } });
        expect(invited).toMatchObject({ ok: true, value: { changed: true } });
        if (invited.ok) expect(DiscussionAccessGrantMutationResponseV1Schema.safeParse(invited.value).success).toBe(true);
        expect(await getDiscussion({ actorAccountId: invitee.id, discussionId, authentication })).toMatchObject({ ok: true });
        expect(await db.discussionReadState.findUnique({ where: { discussionId_accountId: { discussionId, accountId: invitee.id } } })).toMatchObject({ lastReadSeq: 1 });
        const readable = await inTx(tx => filterDiscussionsWithCurrentReadAccessInTx(tx, {
            discussionIds: [discussionId], accountIds: [owner.id, invitee.id, outsider.id],
        }));
        expect([...readable.get(invitee.id) ?? []]).toEqual([discussionId]);
        expect([...readable.get(outsider.id) ?? []]).toEqual([]);
        expect(await removeDiscussionParticipant({ actorAccountId: owner.id, discussionId, authentication, request: { participant: { kind: "account", accountId: invitee.id } } })).toMatchObject({ ok: true });
        expect(await getDiscussion({ actorAccountId: invitee.id, discussionId, authentication })).toEqual({ ok: false, error: "discussion_not_found" });
        expect(await db.discussionReadState.findUnique({ where: { discussionId_accountId: { discussionId, accountId: invitee.id } } })).toBeNull();
    });

    it("self-leave rejoins success and cannot orphan the owner", async () => {
        const { owner, invitee, outsider, discussionId } = await fixture();
        await inviteDiscussionParticipant({ actorAccountId: owner.id, discussionId, authentication,
            request: { participant: { kind: "account", accountId: invitee.id } } });
        expect(await leaveDiscussion({ actorAccountId: owner.id, discussionId, authentication })).toEqual({ ok: false, error: "discussion_owner_transfer_required" });
        const left = await leaveDiscussion({ actorAccountId: invitee.id, discussionId, authentication });
        expect(left).toMatchObject({ ok: true, value: { access: null, changed: true } });
        if (left.ok) expect(DiscussionLeaveResponseV1Schema.safeParse(left.value).success).toBe(true);
        expect(await leaveDiscussion({ actorAccountId: invitee.id, discussionId, authentication })).toMatchObject({ ok: true, value: { access: null, changed: false } });
        expect(await leaveDiscussion({ actorAccountId: outsider.id, discussionId, authentication })).toEqual({ ok: true,
            value: { discussionId, access: null, changed: false } });
        expect(await db.discussion.findUnique({ where: { id: discussionId } })).toMatchObject({ ownerAccountId: owner.id });
    });

    it("retains inherited access after leaving a direct invitation", async () => {
        const { owner, invitee, discussionId } = await fixture();
        const team = await db.team.create({ data: { name: "Invited team" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "admin", status: "active" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: invitee.id, role: "member", status: "active" } });
        await setDiscussionGrant({ actorAccountId: owner.id, discussionId, authentication,
            request: { principal: { kind: "team", teamId: team.id }, accessLevel: "view" } });
        await inviteDiscussionParticipant({ actorAccountId: owner.id, discussionId, authentication,
            request: { participant: { kind: "account", accountId: invitee.id } } });
        expect(await leaveDiscussion({ actorAccountId: invitee.id, discussionId, authentication })).toMatchObject({ ok: true, value: { access: "view", changed: true } });
        expect(await getDiscussion({ actorAccountId: invitee.id, discussionId, authentication })).toMatchObject({ ok: true });
    });

    it("transfers ownership only to an already entitled eligible person", async () => {
        const { owner, invitee, outsider, discussionId } = await fixture();
        expect(await transferDiscussionOwner({ actorAccountId: owner.id, discussionId, authentication, request: { accountId: outsider.id } })).toMatchObject({ ok: false });
        await inviteDiscussionParticipant({ actorAccountId: owner.id, discussionId, authentication,
            request: { participant: { kind: "account", accountId: invitee.id } } });
        expect(await transferDiscussionOwner({ actorAccountId: owner.id, discussionId, authentication, request: { accountId: invitee.id } })).toMatchObject({ ok: true });
        expect(await transferDiscussionOwner({ actorAccountId: owner.id, discussionId, authentication, request: { accountId: invitee.id } })).toMatchObject({ ok: true, value: { changed: false } });
        expect(await leaveDiscussion({ actorAccountId: owner.id, discussionId, authentication })).toMatchObject({ ok: true, value: { access: null } });
        expect(await getDiscussion({ actorAccountId: invitee.id, discussionId, authentication })).toMatchObject({ ok: true, value: { discussion: { ownerAccountId: invitee.id, access: "owner" } } });
    });

    it("reserves owner transfer for the present person", async () => {
        const { owner, invitee, discussionId } = await fixture();
        await inviteDiscussionParticipant({ actorAccountId: owner.id, discussionId, authentication,
            request: { participant: { kind: "account", accountId: invitee.id } } });
        expect(await transferDiscussionOwner({ actorAccountId: owner.id, discussionId,
            authentication: { ...authentication, authority: "account_automation" }, request: { accountId: invitee.id } })).toEqual({ ok: false, error: "discussion_access_forbidden" });
        expect(await db.discussion.findUnique({ where: { id: discussionId } })).toMatchObject({ ownerAccountId: owner.id });
    });

    it("qualifies inherited credentials without suppressing an independent direct invitation", async () => {
        const { owner, invitee, discussionId } = await fixture();
        const team = await db.team.create({ data: { name: "Restricted source", authenticationPolicy: { invalidPolicy: true } } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "admin", status: "active" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: invitee.id, role: "member", status: "active" } });
        await setDiscussionGrant({ actorAccountId: owner.id, discussionId, authentication,
            request: { principal: { kind: "team", teamId: team.id }, accessLevel: "admin" } });
        expect(await getDiscussion({ actorAccountId: invitee.id, discussionId, authentication })).toEqual({ ok: false, error: "discussion_not_found" });
        await inviteDiscussionParticipant({ actorAccountId: owner.id, discussionId, authentication,
            request: { participant: { kind: "account", accountId: invitee.id } } });
        expect(await getDiscussion({ actorAccountId: invitee.id, discussionId, authentication })).toMatchObject({ ok: true, value: { discussion: { access: "edit" } } });
        expect(await db.discussionReadState.findUnique({ where: { discussionId_accountId: { discussionId, accountId: invitee.id } } })).toMatchObject({ lastReadSeq: 1 });
    });

    it("retires inherited readers through the canonical Team-change publication", async () => {
        const { owner, invitee, outsider, discussionId } = await fixture();
        const team = await db.team.create({ data: { name: "Changing audience" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "admin", status: "active" } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: invitee.id, role: "member", status: "active" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: outsider.id, role: "member", status: "active" } });
        await setDiscussionGrant({ actorAccountId: owner.id, discussionId, authentication,
            request: { principal: { kind: "team", teamId: team.id }, accessLevel: "edit" } });
        expect(await postDiscussionMessage({ actorAccountId: invitee.id, discussionId, authentication, request: {
            localId: crypto.randomUUID(), content: { t: "plain", v: { v: 1, parts: [{ t: "text", text: "Before leaving" }] } }, mentionedAccountIds: [],
        } })).toMatchObject({ ok: true, value: { message: { accountActor: { accountId: invitee.id, accessibility: 'current' } } } });
        expect(await db.discussionReadState.findUnique({ where: { discussionId_accountId: { discussionId, accountId: invitee.id } } })).not.toBeNull();
        await inTx(async tx => {
            await tx.teamMembership.delete({ where: { id: membership.id } });
            await publishTeamChangedInTx(tx, { teamId: team.id, additionalAccountIds: [invitee.id] });
        });
        expect(await getDiscussion({ actorAccountId: invitee.id, discussionId, authentication })).toEqual({ ok: false, error: "discussion_not_found" });
        expect(await getDiscussion({ actorAccountId: owner.id, discussionId, authentication })).toMatchObject({ ok: true,
            value: { discussion: { latestMessage: { accountActor: {
                accountId: invitee.id, accessibility: 'former', profile: expect.any(Object),
            } } } } });
        expect(await db.discussionReadState.findUnique({ where: { discussionId_accountId: { discussionId, accountId: invitee.id } } })).toBeNull();
        expect(await db.accountChange.findFirst({ where: { accountId: invitee.id, kind: "discussion", entityId: discussionId } })).not.toBeNull();
        expect(await postDiscussionMessage({ actorAccountId: owner.id, discussionId, authentication, request: {
            localId: crypto.randomUUID(), content: { t: "plain", v: { v: 1, parts: [{ t: "text", text: "While you were away" }] } }, mentionedAccountIds: [],
        } })).toMatchObject({ ok: true, value: { messageSeq: 3 } });
        await inTx(async tx => {
            await tx.teamMembership.create({ data: { teamId: team.id, accountId: invitee.id, role: "member", status: "active" } });
            await publishTeamChangedInTx(tx, { teamId: team.id, additionalAccountIds: [invitee.id] });
        });
        expect(await db.discussionReadState.findUnique({ where: { discussionId_accountId: { discussionId, accountId: invitee.id } } }))
            .toMatchObject({ lastReadSeq: 3 });
        expect(await db.discussionReadState.findUnique({ where: { discussionId_accountId: { discussionId, accountId: owner.id } } }))
            .toMatchObject({ lastReadSeq: 0 });
        const exact = await getDiscussion({ actorAccountId: owner.id, discussionId, authentication });
        expect(exact).toMatchObject({ ok: true, value: { discussion: { participantAccounts: expect.arrayContaining([
            expect.objectContaining({ accountId: invitee.id, accessibility: 'current' }),
        ]) } } });
        if (!exact.ok) throw new Error(exact.error);
        expect(exact.value.discussion.participantAccounts ?? []).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ accountId: outsider.id }),
        ]));
        const roster = await listDiscussionParticipants({ actorAccountId: owner.id, discussionId, authentication });
        expect(roster).toMatchObject({ ok: true, value: { accountActors: expect.arrayContaining([
            expect.objectContaining({ accountId: invitee.id, accessibility: 'current' }),
        ]) } });
        if (!roster.ok) throw new Error(roster.error);
        expect(roster.value.accountActors ?? []).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ accountId: outsider.id }),
        ]));
    });

    it("keeps server-written authorship but withholds a requester from a producer rejected by canonical admission", async () => {
        const { owner, invitee, outsider, discussionId } = await fixture();
        const team = await db.team.create({ data: { name: "Malformed producer" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "admin", status: "active" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: invitee.id, role: "member", status: "active" } });
        await setDiscussionGrant({ actorAccountId: owner.id, discussionId, authentication,
            request: { principal: { kind: "team", teamId: team.id }, accessLevel: "edit" } });
        const posted = await postDiscussionMessage({ actorAccountId: invitee.id, discussionId, authentication, request: {
            localId: crypto.randomUUID(), content: { t: "plain", v: { v: 1, parts: [{ t: "text", text: "Invalid producer" }] } }, mentionedAccountIds: [],
        } });
        expect(posted.ok).toBe(true);
        if (!posted.ok) throw new Error(posted.error);
        const serverId = await getOrCreateServerIdentityId();
        await db.discussionMessage.update({ where: { id: posted.value.message.id }, data: { producerV1: {
            v: 1, kind: "agent", sessionId: "session-a",
            sourceSession: { sourceSessionId: "session-b", sourceInputId: "input", sourceTurnId: "turn", via: "action" },
            actionRequestAttributionV1: { requestRef: "request", requester: { serverId, accountId: outsider.id },
                persona: { serverId, sessionId: "session-a" }, origin: null },
        } } });
        await postDiscussionMessage({ actorAccountId: owner.id, discussionId, authentication, request: {
            localId: crypto.randomUUID(), content: { t: "plain", v: { v: 1, parts: [{ t: "text", text: "Valid latest" }] } }, mentionedAccountIds: [],
        } });

        expect(await readDiscussionMessages({ actorAccountId: owner.id, discussionId, authentication }))
            .toEqual({ ok: false, error: "discussion_invalid_content" });
        const expectedAuthors = expect.arrayContaining([
            expect.objectContaining({ accountId: owner.id }), expect.objectContaining({ accountId: invitee.id }),
        ]);
        const exact = await getDiscussion({ actorAccountId: owner.id, discussionId, authentication });
        expect(exact).toMatchObject({ ok: true, value: { discussion: { participantAccounts: expectedAuthors } } });
        if (!exact.ok) throw new Error(exact.error);
        expect(exact.value.discussion.participantAccounts ?? []).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ accountId: outsider.id }),
        ]));
        const roster = await listDiscussionParticipants({ actorAccountId: owner.id, discussionId, authentication });
        expect(roster).toMatchObject({ ok: true, value: { accountActors: expectedAuthors } });
        if (!roster.ok) throw new Error(roster.error);
        expect(roster.value.accountActors ?? []).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ accountId: outsider.id }),
        ]));
    });

    it("keeps a Team-derived recipient envelope inert across leave and restores it on rejoin", async () => {
        const ownerKeys = tweetnacl.box.keyPair();
        const memberKeys = tweetnacl.box.keyPair();
        const owner = await db.account.create({ data: { encryptionMode: "e2ee", ...createSignedAccountContentBinding(ownerKeys.publicKey) } });
        const member = await db.account.create({ data: { encryptionMode: "e2ee", ...createSignedAccountContentBinding(memberKeys.publicKey) } });
        const team = await db.team.create({ data: { name: "Rejoin envelope" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "admin", status: "active" } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: member.id, role: "member", status: "active" } });
        const dataKey = tweetnacl.randomBytes(32);
        const seal = (publicKey: Uint8Array) => privacyKit.encodeBase64(sealEncryptedDataKeyEnvelopeV1({
            dataKey, recipientPublicKey: publicKey, randomBytes: tweetnacl.randomBytes,
        }));
        const ownerEnvelope = seal(ownerKeys.publicKey);
        const memberEnvelope = { recipientAccountId: member.id, encryptedDataKey: seal(memberKeys.publicKey),
            recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(memberKeys.publicKey) };
        const created = await createDiscussion({ actorAccountId: owner.id, authentication, request: {
            creationLocalId: crypto.randomUUID(), titleContent: { t: "encrypted", c: "opaque-title" },
            creationEqualityEvidenceV1: { kind: "e2eeTag", tag: "A".repeat(43) },
            dataEncryptionKey: ownerEnvelope, expectedOwnerContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(ownerKeys.publicKey),
            firstMessage: { localId: crypto.randomUUID(), content: { t: "encrypted", c: "opaque-message" },
                requestEqualityEvidenceV1: { kind: "e2eeTag", tag: "B".repeat(43) }, mentionedAccountIds: [] },
        } });
        expect(created.ok).toBe(true);
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        expect(await setDiscussionGrant({ actorAccountId: owner.id, discussionId, authentication,
            request: { principal: { kind: "team", teamId: team.id }, accessLevel: "edit" } })).toMatchObject({ ok: true });
        expect(await commitDiscussionRecipientKeyEnvelopes({ actorAccountId: owner.id, discussionId, authentication,
            request: { expectedDataEncryptionKey: ownerEnvelope, recipientKeyEnvelopes: [memberEnvelope] } }))
            .toMatchObject({ ok: true, value: { appliedRecipientAccountIds: [member.id] } });
        expect(await getDiscussion({ actorAccountId: owner.id, discussionId, authentication }))
            .toMatchObject({ ok: true, value: { discussion: { recipientKeyPreparationRequired: false } } });
        expect(await inTx(tx => resolveDiscussionContextInTx(tx, { discussionId, accountId: member.id, authentication })))
            .toMatchObject({ access: { level: "edit" }, keyReadiness: true, dataEncryptionKey: memberEnvelope.encryptedDataKey });

        await inTx(async tx => {
            await tx.teamMembership.delete({ where: { id: membership.id } });
            await publishTeamChangedInTx(tx, { teamId: team.id, additionalAccountIds: [member.id] });
        });
        expect(await getDiscussion({ actorAccountId: member.id, discussionId, authentication }))
            .toEqual({ ok: false, error: "discussion_not_found" });
        expect(await db.discussionKeyEnvelope.findUnique({ where: { discussionId_recipientAccountId: {
            discussionId, recipientAccountId: member.id,
        } } })).toMatchObject({ recipientContentPublicKeyFingerprint: memberEnvelope.recipientContentPublicKeyFingerprint });
        expect(await getDiscussion({ actorAccountId: owner.id, discussionId, authentication }))
            .toMatchObject({ ok: true, value: { discussion: { recipientKeyPreparationRequired: false } } });

        await inTx(async tx => {
            await tx.teamMembership.create({ data: { teamId: team.id, accountId: member.id, role: "member", status: "active" } });
            await publishTeamChangedInTx(tx, { teamId: team.id, additionalAccountIds: [member.id] });
        });
        expect(await inTx(tx => resolveDiscussionContextInTx(tx, { discussionId, accountId: member.id, authentication })))
            .toMatchObject({ access: { level: "edit" }, keyReadiness: true, dataEncryptionKey: memberEnvelope.encryptedDataKey });
        expect(await getDiscussion({ actorAccountId: owner.id, discussionId, authentication }))
            .toMatchObject({ ok: true, value: { discussion: { recipientKeyPreparationRequired: false } } });
        const lateMemberKeys = tweetnacl.box.keyPair();
        const lateMember = await db.account.create({ data: { encryptionMode: "e2ee", ...createSignedAccountContentBinding(lateMemberKeys.publicKey) } });
        await inTx(async tx => {
            await tx.teamMembership.create({ data: { teamId: team.id, accountId: lateMember.id, role: "member", status: "active" } });
            await publishTeamChangedInTx(tx, { teamId: team.id, additionalAccountIds: [lateMember.id] });
        });
        expect(await getDiscussion({ actorAccountId: owner.id, discussionId, authentication }))
            .toMatchObject({ ok: true, value: { discussion: { recipientKeyPreparationRequired: true } } });
    });

    it("rejects a Session-scoped credential even when its Account owns the Discussion", async () => {
        const { owner, discussionId } = await fixture();
        const scopedAuthentication = { ...authentication, apiTokenGrant: { ...API_TOKEN_FULL_GRANT_V1, targets: { sessions: ["different-session"], machines: [] } } };
        expect(await getDiscussion({ actorAccountId: owner.id, discussionId, authentication: scopedAuthentication })).toEqual({ ok: false, error: "discussion_not_found" });
        await db.account.update({ where: { id: owner.id }, data: { status: "suspended" } });
        expect(await getDiscussion({ actorAccountId: owner.id, discussionId, authentication })).toEqual({ ok: false, error: "discussion_not_found" });
    });

    it.each([false, true])("keeps grants separate from current recipient envelopes and fences encrypted key commits (Agent create: %s)", async agent => {
        const ownerKeys = tweetnacl.box.keyPair();
        const inviteeKeys = tweetnacl.box.keyPair();
        const owner = await db.account.create({ data: { encryptionMode: "e2ee", ...createSignedAccountContentBinding(ownerKeys.publicKey) } });
        const invitee = await db.account.create({ data: { encryptionMode: "e2ee", ...createSignedAccountContentBinding(inviteeKeys.publicKey) } });
        await makeShareEligibleForTest(owner.id, invitee.id);
        const dataKey = tweetnacl.randomBytes(32);
        const ownerEnvelope = privacyKit.encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: ownerKeys.publicKey, randomBytes: tweetnacl.randomBytes }));
        const recipientEnvelope = { recipientAccountId: invitee.id,
            encryptedDataKey: privacyKit.encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: inviteeKeys.publicKey, randomBytes: tweetnacl.randomBytes })),
            recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(inviteeKeys.publicKey) };
        const creationLocalId = crypto.randomUUID();
        const session = agent ? await db.session.create({ data: { accountId: owner.id, tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'e2ee' } }) : null;
        const producer = session ? { v: 1 as const, kind: 'agent' as const, sessionId: session.id, toolCallId: 'encrypted-create' } : undefined;
        const created = await createDiscussion({ actorAccountId: owner.id, authentication, request: {
            creationLocalId, titleContent: { t: "encrypted", c: "opaque-title" },
            creationEqualityEvidenceV1: { kind: "e2eeTag", tag: "A".repeat(43) },
            dataEncryptionKey: ownerEnvelope, expectedOwnerContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(ownerKeys.publicKey),
            participants: [{ kind: "account", accountId: invitee.id }],
            firstMessage: { localId: crypto.randomUUID(), content: { t: "encrypted", c: "opaque-message" },
                requestEqualityEvidenceV1: { kind: "e2eeTag", tag: "B".repeat(43) }, mentionedAccountIds: [] },
        }, ...(producer ? { producer } : {}) });
        expect(created.ok).toBe(true);
        if (!created.ok) throw new Error(created.error);
        const discussionId = created.value.discussion.id;
        expect(created.value.firstMessage.producerV1).toEqual(producer ?? null);
        expect(await db.discussionParticipant.count({ where: { discussionId } })).toBe(0);
        const listed = await listDiscussions({ actorAccountId: owner.id, authentication, creationLocalId });
        expect(listed)
            .toMatchObject({ ok: true, value: { discussions: [expect.objectContaining({ id: discussionId, dataEncryptionKey: ownerEnvelope,
                latestMessage: expect.objectContaining({ content: { t: 'encrypted', c: 'opaque-message' } }) })] } });
        if (!listed.ok) throw new Error(listed.error);
        // Feed the real JSON projection through the exact response schema the clients consume.
        expect(DiscussionListResponseV1Schema.parse(JSON.parse(JSON.stringify(listed.value))).discussions[0]?.latestMessage.content)
            .toEqual({ t: 'encrypted', c: 'opaque-message' });
        expect(await listDiscussions({ actorAccountId: invitee.id, authentication, creationLocalId }))
            .toEqual({ ok: true, value: { discussions: [], nextCursor: null } });
        const initial = await inTx(tx => resolveDiscussionContextInTx(tx, { discussionId, accountId: invitee.id, authentication }));
        expect(initial).toMatchObject({ access: { level: "edit" }, keyReadiness: false, dataEncryptionKey: null });
        expect(await getDiscussion({ actorAccountId: owner.id, discussionId, authentication }))
            .toMatchObject({ ok: true, value: { discussion: { recipientKeyPreparationRequired: true } } });
        expect(await getDiscussion({ actorAccountId: invitee.id, discussionId, authentication }))
            .toMatchObject({ ok: true, value: { discussion: expect.not.objectContaining({ recipientKeyPreparationRequired: expect.anything() }) } });
        const census = await readDiscussionRecipientCensus({ actorAccountId: owner.id, discussionId, authentication });
        if (census.ok) expect(DiscussionAccessRecipientCensusResponseV1Schema.safeParse(census.value).success).toBe(true);
        expect(census).toMatchObject({ ok: true, value: { dataEncryptionKey: ownerEnvelope, recipients: expect.arrayContaining([
            expect.objectContaining({ recipientAccountId: invitee.id, encryptedDataKey: null }),
        ]) } });
        expect(await commitDiscussionRecipientKeyEnvelopes({ actorAccountId: owner.id, discussionId, authentication,
            request: { expectedDataEncryptionKey: recipientEnvelope.encryptedDataKey, recipientKeyEnvelopes: [recipientEnvelope] } })).toEqual({ ok: false, error: "discussion_data_key_changed" });
        expect(await commitDiscussionRecipientKeyEnvelopes({ actorAccountId: owner.id, discussionId, authentication,
            request: { expectedDataEncryptionKey: ownerEnvelope, recipientKeyEnvelopes: [recipientEnvelope] } })).toMatchObject({ ok: true, value: { appliedRecipientAccountIds: [invitee.id] } });
        expect(await getDiscussion({ actorAccountId: owner.id, discussionId, authentication }))
            .toMatchObject({ ok: true, value: { discussion: { recipientKeyPreparationRequired: false } } });
        expect(await inTx(tx => resolveDiscussionContextInTx(tx, { discussionId, accountId: invitee.id, authentication }))).toMatchObject({ keyReadiness: true, dataEncryptionKey: recipientEnvelope.encryptedDataKey });
        await db.discussionKeyEnvelope.update({ where: { discussionId_recipientAccountId: { discussionId, recipientAccountId: invitee.id } },
            data: { recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(tweetnacl.box.keyPair().publicKey) } });
        expect(await inTx(tx => resolveDiscussionContextInTx(tx, { discussionId, accountId: invitee.id, authentication }))).toMatchObject({ keyReadiness: false, dataEncryptionKey: null });
        expect(await getDiscussion({ actorAccountId: owner.id, discussionId, authentication }))
            .toMatchObject({ ok: true, value: { discussion: { recipientKeyPreparationRequired: true } } });
    });

    it("preserves retained encrypted content when the legacy resource has no recipient key", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "e2ee", ...createSignedAccountContentBinding() } });
        const titleContent = { t: "encrypted", c: "retained-opaque-title" };
        const messageContent = { t: "encrypted", c: "retained-opaque-message" };
        const discussion = await db.discussion.create({ data: {
            ownerAccountId: owner.id, createdByAccountId: owner.id, encryptionMode: "e2ee", dataEncryptionKey: new Uint8Array(),
            creationLocalId: crypto.randomUUID(), creationEqualityEvidenceV1: { kind: "e2eeTag", tag: "A".repeat(43) },
            titleContent, messageSeq: 1, lastMessageAt: new Date(), anchorSessionId: "unavailable-legacy-source",
            messages: { create: { localId: crypto.randomUUID(), seq: 1, authorAccountId: owner.id,
                requestEqualityEvidenceV1: { kind: "e2eeTag", tag: "B".repeat(43) }, content: messageContent } },
        } });
        expect(await inTx(tx => resolveDiscussionContextInTx(tx, { discussionId: discussion.id, accountId: owner.id, authentication })))
            .toMatchObject({ storageMode: "e2ee", access: { level: "owner" }, keyReadiness: false, dataEncryptionKey: null });
        expect(await getDiscussion({ actorAccountId: owner.id, discussionId: discussion.id, authentication }))
            .toMatchObject({ ok: true, value: { discussion: { encryptionMode: "e2ee", keyReadiness: false, dataEncryptionKey: null, titleContent } } });
        expect(await readDiscussionRecipientCensus({ actorAccountId: owner.id, discussionId: discussion.id, authentication }))
            .toEqual({ ok: false, error: "recipient_key_unavailable" });
        expect(await db.discussion.findUnique({ where: { id: discussion.id }, select: { titleContent: true, dataEncryptionKey: true } }))
            .toEqual({ titleContent, dataEncryptionKey: new Uint8Array() });
        expect(await db.discussionMessage.findFirst({ where: { discussionId: discussion.id }, select: { content: true } }))
            .toEqual({ content: messageContent });
    });
});
