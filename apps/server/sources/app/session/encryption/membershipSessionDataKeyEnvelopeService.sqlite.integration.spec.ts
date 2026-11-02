import { afterAll, beforeAll, describe, expect, it } from "vitest";
import tweetnacl from "tweetnacl";
import { decodeBase64, encodeBase64 as encodeBase64Bytes } from "privacy-kit";
import {
    ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES,
    openEncryptedDataKeyEnvelopeV1,
    sealEncryptedDataKeyEnvelopeV1,
    signAccountContentKeyBindingV1,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { admitTeamMemberInTx } from "@/app/teams/memberships/membershipService";
import { hashPasswordMaterial } from "@/app/auth/password/passwordMaterialVerifier";

const ACCEPTED_EMAIL_PASSWORD = { kind: "home_method" as const, methodId: "email_password" };
const EMAIL_PASSWORD_EVIDENCE = [ACCEPTED_EMAIL_PASSWORD];
const HOME_OFFERS_EMAIL_PASSWORD = {
    HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: "1",
    HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
};

import {
    applyMembershipSessionDataKeyEnvelopes,
    readMembershipSessionDataKeyEnvelopePage,
    type MembershipSessionDataKeyEnvelopeSubject,
} from "./membershipSessionDataKeyEnvelopeService";

/**
 * Membership-history Session-key preparation against a real database.
 *
 * Access, the history horizon, recipient readiness and envelope structure are
 * exercised through their canonical owners rather than mocked: a mocked policy
 * would let this suite pass while the resource disclosed a Session the caller
 * cannot read or accepted ciphertext sealed to a replaced Account.
 */
describe("Membership session data-key envelope history (SQLite)", () => {
    const authentication = {
        env: process.env,
        authority: "present_user",
        authenticationEvidence: undefined,
    } as const;
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-membership-envelopes-",
            initAuth: false,
            env: {
                HAPPIER_FEATURE_TEAMS__ENABLED: "1",
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            },
        });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    function encodeBase64(bytes: Uint8Array): string {
        return encodeBase64Bytes(new Uint8Array(bytes));
    }

    function keyMaterial() {
        const signing = tweetnacl.sign.keyPair();
        const content = tweetnacl.box.keyPair();
        const contentPublicKey = new Uint8Array(content.publicKey);
        return {
            publicKey: Buffer.from(signing.publicKey).toString("hex"),
            contentPublicKey,
            contentSecretKey: new Uint8Array(content.secretKey),
            contentPublicKeySig: signAccountContentKeyBindingV1({
                accountSigningSecretKey: signing.secretKey,
                contentPublicKey,
            }),
        };
    }

    async function e2eeAccount() {
        const keys = keyMaterial();
        const account = await db.account.create({ data: {
            publicKey: keys.publicKey,
            encryptionMode: "e2ee",
            contentPublicKey: Buffer.from(keys.contentPublicKey),
            contentPublicKeySig: Buffer.from(keys.contentPublicKeySig),
        } });
        return { ...account, keys };
    }

    async function setupPendingAccount() {
        // An e2ee Account that has not finished publishing its content binding:
        // key presence is never inferred, so this is a whole-page stable state.
        return await db.account.create({ data: {
            publicKey: crypto.randomUUID(), encryptionMode: "e2ee",
        } });
    }

    function seal(dataKey: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
        return new Uint8Array(sealEncryptedDataKeyEnvelopeV1({
            dataKey,
            recipientPublicKey,
            randomBytes: (length) => tweetnacl.randomBytes(length),
        }));
    }

    function malformedEnvelope(): Uint8Array {
        // A v1 envelope is structurally valid when it has the fixed 105-byte
        // length and version byte 0. Use an unsupported version so this test
        // exercises the Protocol parser's intended malformed-input boundary.
        const envelope = new Uint8Array(ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES);
        envelope[0] = 255;
        return envelope;
    }

    async function e2eeSession(ownerId: string) {
        return await db.session.create({ data: {
            accountId: ownerId, tag: crypto.randomUUID(), encryptionMode: "e2ee",
            metadata: JSON.stringify({ t: "encrypted", c: "" }), seq: 1,
        } });
    }

    /**
     * One Team where `manager` owns e2ee Sessions granted to the Team and
     * `target` has just joined with the whole existing history.
     */
    async function history() {
        const manager = await e2eeAccount();
        const target = await e2eeAccount();
        const team = await db.team.create({ data: { name: crypto.randomUUID() } });
        const admitted = await inTx(async (tx) => ({
            manager: await admitTeamMemberInTx(tx, {
                teamId: team.id, accountId: manager.id, role: "owner", historyAccess: "all_existing",
            }),
            target: await admitTeamMemberInTx(tx, {
                teamId: team.id, accountId: target.id, role: "member", historyAccess: "all_existing",
            }),
        }));
        if (!admitted.manager.ok || !admitted.target.ok) throw new Error("team admission failed");

        const targetMembershipId = admitted.target.membership.teamMembershipId;
        const subject: MembershipSessionDataKeyEnvelopeSubject = {
            kind: "team", teamId: team.id, teamMembershipId: targetMembershipId,
        };
        return { manager, target, team, subject, targetMembershipId };
    }

    type Granted = Readonly<{ sessionId: string; dataKey: Uint8Array }>;

    /** A Team-granted e2ee Session whose owner holds a valid transferable tuple. */
    async function grantedSession(
        team: Readonly<{ id: string }>,
        manager: Awaited<ReturnType<typeof e2eeAccount>>,
        options: Readonly<{ callerEnvelope?: "valid" | "invalid" | "absent" }> = {},
    ): Promise<Granted> {
        const session = await e2eeSession(manager.id);
        await db.sessionTeamGrant.create({ data: {
            sessionId: session.id, teamId: team.id, accessLevel: "view", effectiveAt: new Date(),
        } });
        const dataKey = tweetnacl.randomBytes(32);
        const shape = options.callerEnvelope ?? "valid";
        if (shape !== "absent") {
            await db.sessionDataKeyEnvelope.create({ data: {
                sessionId: session.id,
                recipientAccountId: manager.id,
                encryptedDataKey: Buffer.from(shape === "valid"
                    ? seal(dataKey, manager.keys.contentPublicKey)
                    // Bytes no conforming producer could emit: the version byte is wrong.
                    : malformedEnvelope()),
            } });
        }
        return { sessionId: session.id, dataKey: new Uint8Array(dataKey) };
    }

    async function readPage(actorAccountId: string, subject: MembershipSessionDataKeyEnvelopeSubject, limit = 24) {
        return await readMembershipSessionDataKeyEnvelopePage({
            actorAccountId, subject, query: { state: "action_required", limit }, authentication,
        });
    }

    function readyPage(result: Awaited<ReturnType<typeof readPage>>) {
        expect(result.ok).toBe(true);
        if (!result.ok || result.page.status !== "ready") throw new Error(`not a ready page: ${JSON.stringify(result)}`);
        return result.page;
    }

    it("hands a cold caller the exact work plus its own envelope, and the target opens the same data key", async () => {
        const { manager, target, team, subject } = await history();
        const granted = await grantedSession(team, manager);

        const page = readyPage(await readPage(manager.id, subject));
        expect(page.recipientAccountId).toBe(target.id);
        expect(page.contentKey.status).toBe("available");
        expect(page.items.map(item => item.sessionId)).toEqual([granted.sessionId]);
        expect(page.nextCursor).toBeNull();
        expect(page.exceptions).toEqual({
            callerVisibleNonTransferableSessionCount: 0,
            callerEnvelopeRepairRequiredCount: 0,
        });

        // The Session's own stored shared metadata and layout travel with the item, so the client
        // can prove the key the Home names is this Session's before resealing it.
        const sessionRow = await db.session.findUniqueOrThrow({ where: { id: granted.sessionId },
            select: { metadata: true, metadataLayoutVersion: true } });
        expect(page.items[0]).toEqual({
            sessionId: granted.sessionId, callerDataKeyEnvelope: expect.any(String),
            metadata: sessionRow.metadata, metadataLayoutVersion: sessionRow.metadataLayoutVersion,
        });

        // The page alone is enough to prepare: no Session-detail request, no warm cache.
        const callerEnvelope = decodeBase64(page.items[0]!.callerDataKeyEnvelope);
        const openedByCaller = openEncryptedDataKeyEnvelopeV1({
            envelope: callerEnvelope, recipientSecretKeyOrSeed: manager.keys.contentSecretKey,
        });
        expect(openedByCaller).toEqual(granted.dataKey);

        const applied = await applyMembershipSessionDataKeyEnvelopes({
            actorAccountId: manager.id,
            authentication,
            subject,
            request: {
                recipientAccountId: target.id,
                entries: [{
                    sessionId: granted.sessionId,
                    encryptedDataKey: encodeBase64(seal(openedByCaller!, decodeBase64(
                        page.contentKey.status === "available" ? page.contentKey.contentPublicKey : "",
                    ))),
                }],
            },
        });
        expect(applied).toEqual({ ok: true, appliedCount: 1 });

        const stored = await db.sessionDataKeyEnvelope.findUnique({ where: {
            sessionId_recipientAccountId: { sessionId: granted.sessionId, recipientAccountId: target.id },
        } });
        const openedByTarget = openEncryptedDataKeyEnvelopeV1({
            envelope: new Uint8Array(stored!.encryptedDataKey),
            recipientSecretKeyOrSeed: target.keys.contentSecretKey,
        });
        // The recipient recovers the same Session DEK; no transcript was re-encrypted.
        expect(openedByTarget).toEqual(granted.dataKey);

        // The committed Session leaves the worklist without any receipt or revision.
        expect(readyPage(await readPage(manager.id, subject)).items).toEqual([]);
    });

    it("prepares an independently-horizoned Group Session through the same real crypto path", async () => {
        const manager = await e2eeAccount();
        const target = await e2eeAccount();
        const team = await db.team.create({ data: { name: crypto.randomUUID() } });
        const admitted = await inTx(async (tx) => ({
            manager: await admitTeamMemberInTx(tx, {
                teamId: team.id, accountId: manager.id, role: "owner", historyAccess: "all_existing",
            }),
            target: await admitTeamMemberInTx(tx, {
                teamId: team.id, accountId: target.id, role: "member", historyAccess: "from_membership",
            }),
        }));
        if (!admitted.manager.ok || !admitted.target.ok) throw new Error("team admission failed");
        const group = await db.teamGroup.create({ data: {
            teamId: team.id, name: "Historical readers", nameKey: crypto.randomUUID(),
        } });
        await db.teamGroupMembership.create({ data: {
            teamId: team.id,
            teamGroupId: group.id,
            teamMembershipId: admitted.target.membership.teamMembershipId,
            // Independent from the target's future-only Team horizon.
            sessionAccessStartsAt: null,
        } });
        const session = await e2eeSession(manager.id);
        await db.sessionGroupGrant.create({ data: {
            sessionId: session.id,
            teamGroupId: group.id,
            accessLevel: "view",
            effectiveAt: new Date(0),
        } });
        const dataKey = new Uint8Array(tweetnacl.randomBytes(32));
        await db.sessionDataKeyEnvelope.create({ data: {
            sessionId: session.id,
            recipientAccountId: manager.id,
            encryptedDataKey: Buffer.from(seal(dataKey, manager.keys.contentPublicKey)),
        } });
        const subject: MembershipSessionDataKeyEnvelopeSubject = {
            kind: "group",
            teamId: team.id,
            groupId: group.id,
            accountId: target.id,
        };

        const page = readyPage(await readPage(manager.id, subject));
        expect(page.items.map(item => item.sessionId)).toEqual([session.id]);
        const openedByManager = openEncryptedDataKeyEnvelopeV1({
            envelope: decodeBase64(page.items[0]!.callerDataKeyEnvelope),
            recipientSecretKeyOrSeed: manager.keys.contentSecretKey,
        });
        expect(openedByManager).toEqual(dataKey);

        expect(await applyMembershipSessionDataKeyEnvelopes({
            actorAccountId: manager.id,
            authentication,
            subject,
            request: {
                recipientAccountId: target.id,
                entries: [{
                    sessionId: session.id,
                    encryptedDataKey: encodeBase64(seal(openedByManager!, target.keys.contentPublicKey)),
                }],
            },
        })).toEqual({ ok: true, appliedCount: 1 });
        const stored = await db.sessionDataKeyEnvelope.findUniqueOrThrow({ where: {
            sessionId_recipientAccountId: { sessionId: session.id, recipientAccountId: target.id },
        } });
        expect(openEncryptedDataKeyEnvelopeV1({
            envelope: new Uint8Array(stored.encryptedDataKey),
            recipientSecretKeyOrSeed: target.keys.contentSecretKey,
        })).toEqual(dataKey);
    });

    it("excludes Sessions the caller cannot manage from both the items and the exception counts", async () => {
        const { manager, team, subject } = await history();
        const stranger = await e2eeAccount();
        const hidden = await e2eeSession(stranger.id);
        await db.sessionTeamGrant.create({ data: {
            sessionId: hidden.id, teamId: team.id, accessLevel: "view", effectiveAt: new Date(),
        } });
        // The stranger's own tuple exists; the manager still learns nothing about it.
        await db.sessionDataKeyEnvelope.create({ data: {
            sessionId: hidden.id, recipientAccountId: stranger.id,
            encryptedDataKey: Buffer.from(seal(tweetnacl.randomBytes(32), stranger.keys.contentPublicKey)),
        } });

        const page = readyPage(await readPage(manager.id, subject));
        expect(page.items).toEqual([]);
        expect(page.exceptions).toEqual({
            callerVisibleNonTransferableSessionCount: 0,
            callerEnvelopeRepairRequiredCount: 0,
        });

        // Nor can the manager reach it by naming it directly.
        expect(await applyMembershipSessionDataKeyEnvelopes({
            actorAccountId: manager.id,
            authentication,
            subject,
            request: { recipientAccountId: page.recipientAccountId, entries: [{
                sessionId: hidden.id,
                encryptedDataKey: encodeBase64(seal(tweetnacl.randomBytes(32), stranger.keys.contentPublicKey)),
            }] },
        })).toEqual({ ok: false, error: "forbidden" });
    });

    it("never lists a plain Session, which needs no envelope at all", async () => {
        const { manager, team, subject } = await history();
        const plain = await db.session.create({ data: {
            accountId: manager.id, tag: crypto.randomUUID(), encryptionMode: "plain",
            metadata: JSON.stringify({ t: "plain", v: {} }), seq: 1,
        } });
        await db.sessionTeamGrant.create({ data: {
            sessionId: plain.id, teamId: team.id, accessLevel: "view", effectiveAt: new Date(),
        } });

        const page = readyPage(await readPage(manager.id, subject));
        expect(page.items).toEqual([]);
        expect(page.exceptions).toEqual({
            callerVisibleNonTransferableSessionCount: 0,
            callerEnvelopeRepairRequiredCount: 0,
        });
    });

    it("separates a caller-owned non-transferable Session from caller-envelope repair work", async () => {
        const { manager, target, team, subject } = await history();
        // Owned by the caller with no envelope at all: no published transferable
        // data key, and the Home must not guess how it was secured.
        await grantedSession(team, manager, { callerEnvelope: "absent" });
        // Readable and manageable through an admin share, but the caller's own
        // envelope is structurally unusable: ordinary repair, not a legacy claim.
        const peer = await e2eeAccount();
        const repair = await e2eeSession(peer.id);
        await db.sessionTeamGrant.create({ data: {
            sessionId: repair.id, teamId: team.id, accessLevel: "view", effectiveAt: new Date(),
        } });
        await db.sessionShare.create({ data: {
            sessionId: repair.id, sharedByUserId: peer.id, sharedWithUserId: manager.id, accessLevel: "admin",
        } });
        await db.sessionDataKeyEnvelope.create({ data: {
            sessionId: repair.id, recipientAccountId: manager.id, encryptedDataKey: Buffer.from(malformedEnvelope()),
        } });
        // A present but structurally invalid target tuple is still unfinished;
        // it must preserve the caller-repair exception instead of being treated
        // as a successfully prepared recipient.
        await db.sessionDataKeyEnvelope.create({ data: {
            sessionId: repair.id, recipientAccountId: target.id, encryptedDataKey: Buffer.from(malformedEnvelope()),
        } });

        const page = readyPage(await readPage(manager.id, subject));
        expect(page.items).toEqual([]);
        // Disjoint buckets: one Session lands in exactly one of them.
        expect(page.exceptions).toEqual({
            callerVisibleNonTransferableSessionCount: 1,
            callerEnvelopeRepairRequiredCount: 1,
        });
    });

    it("does not report caller-envelope exceptions after the target already has a valid tuple", async () => {
        const { manager, target, team, subject } = await history();

        const callerOwned = await grantedSession(team, manager, { callerEnvelope: "absent" });
        await db.sessionDataKeyEnvelope.create({ data: {
            sessionId: callerOwned.sessionId,
            recipientAccountId: target.id,
            encryptedDataKey: Buffer.from(seal(callerOwned.dataKey, target.keys.contentPublicKey)),
        } });

        const peer = await e2eeAccount();
        const peerOwned = await e2eeSession(peer.id);
        await db.sessionTeamGrant.create({ data: {
            sessionId: peerOwned.id, teamId: team.id, accessLevel: "view", effectiveAt: new Date(),
        } });
        await db.sessionShare.create({ data: {
            sessionId: peerOwned.id, sharedByUserId: peer.id, sharedWithUserId: manager.id, accessLevel: "admin",
        } });
        await db.sessionDataKeyEnvelope.createMany({ data: [
            {
                sessionId: peerOwned.id,
                recipientAccountId: manager.id,
                encryptedDataKey: Buffer.from(malformedEnvelope()),
            },
            {
                sessionId: peerOwned.id,
                recipientAccountId: target.id,
                encryptedDataKey: Buffer.from(seal(tweetnacl.randomBytes(32), target.keys.contentPublicKey)),
            },
        ] });

        const page = readyPage(await readPage(manager.id, subject));
        expect(page.items).toEqual([]);
        expect(page.exceptions).toEqual({
            callerVisibleNonTransferableSessionCount: 0,
            callerEnvelopeRepairRequiredCount: 0,
        });
    });

    it("reports an unfinished recipient as a whole-page state instead of work", async () => {
        const manager = await e2eeAccount();
        const pending = await setupPendingAccount();
        const team = await db.team.create({ data: { name: crypto.randomUUID() } });
        const admitted = await inTx(async (tx) => ({
            manager: await admitTeamMemberInTx(tx, {
                teamId: team.id, accountId: manager.id, role: "owner", historyAccess: "all_existing",
            }),
            target: await admitTeamMemberInTx(tx, {
                teamId: team.id, accountId: pending.id, role: "member", historyAccess: "all_existing",
            }),
        }));
        if (!admitted.manager.ok || !admitted.target.ok) throw new Error("team admission failed");
        const subject: MembershipSessionDataKeyEnvelopeSubject = {
            kind: "team", teamId: team.id, teamMembershipId: admitted.target.membership.teamMembershipId,
        };
        const granted = await grantedSession(team, manager);

        const result = await readPage(manager.id, subject);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("unreachable");
        expect(result.page.status).toBe("recipient_unavailable");
        if (result.page.status !== "recipient_unavailable") throw new Error("unreachable");
        expect(result.page.recipientAccountId).toBe(pending.id);
        expect(result.page.contentKey.status).toBe("unavailable");

        // And the same readiness answer refuses the write, before any tuple is touched.
        expect(await applyMembershipSessionDataKeyEnvelopes({
            actorAccountId: manager.id,
            authentication,
            subject,
            request: { recipientAccountId: pending.id, entries: [{
                sessionId: granted.sessionId,
                encryptedDataKey: encodeBase64(seal(tweetnacl.randomBytes(32), tweetnacl.box.keyPair().publicKey)),
            }] },
        })).toEqual({ ok: false, error: "recipient_key_unavailable" });
        expect(await db.sessionDataKeyEnvelope.count({ where: { recipientAccountId: pending.id } })).toBe(0);
    });

    it("rejects a whole page before the first write and repairs a valid tuple by overwriting it", async () => {
        const { manager, target, team, subject, targetMembershipId } = await history();
        const first = await grantedSession(team, manager);
        const second = await grantedSession(team, manager);
        const sealedFor = (dataKey: Uint8Array) => encodeBase64(seal(dataKey, target.keys.contentPublicKey));
        const patch = (request: unknown) => applyMembershipSessionDataKeyEnvelopes({
            actorAccountId: manager.id, subject, request, authentication,
        });
        const targetTuples = () => db.sessionDataKeyEnvelope.count({ where: { recipientAccountId: target.id } });

        // Duplicate Session ids: the bounded page is rejected by its own contract.
        expect(await patch({ recipientAccountId: target.id, entries: [
            { sessionId: first.sessionId, encryptedDataKey: sealedFor(first.dataKey) },
            { sessionId: first.sessionId, encryptedDataKey: sealedFor(first.dataKey) },
        ] })).toEqual({ ok: false, error: "invalid_request" });
        expect(await targetTuples()).toBe(0);

        // One malformed entry cannot leave the page half prepared.
        expect(await patch({ recipientAccountId: target.id, entries: [
            { sessionId: first.sessionId, encryptedDataKey: sealedFor(first.dataKey) },
            { sessionId: second.sessionId, encryptedDataKey: encodeBase64(malformedEnvelope()) },
        ] })).toEqual({ ok: false, error: "invalid_request" });
        expect(await targetTuples()).toBe(0);

        // A valid page commits both.
        expect(await patch({ recipientAccountId: target.id, entries: [
            { sessionId: first.sessionId, encryptedDataKey: sealedFor(first.dataKey) },
            { sessionId: second.sessionId, encryptedDataKey: sealedFor(second.dataKey) },
        ] })).toEqual({ ok: true, appliedCount: 2 });
        const beforeRepair = await db.sessionDataKeyEnvelope.findUnique({ where: {
            sessionId_recipientAccountId: { sessionId: first.sessionId, recipientAccountId: target.id },
        } });

        // `Prepare again` legitimately replaces a structurally valid tuple: the
        // ciphertext is randomized, so last valid write wins with no revision.
        expect(await patch({ recipientAccountId: target.id, entries: [
            { sessionId: first.sessionId, encryptedDataKey: sealedFor(first.dataKey) },
        ] })).toEqual({ ok: true, appliedCount: 1 });
        const afterRepair = await db.sessionDataKeyEnvelope.findUnique({ where: {
            sessionId_recipientAccountId: { sessionId: first.sessionId, recipientAccountId: target.id },
        } });
        expect(new Uint8Array(afterRepair!.encryptedDataKey))
            .not.toEqual(new Uint8Array(beforeRepair!.encryptedDataKey));
        expect(openEncryptedDataKeyEnvelopeV1({
            envelope: new Uint8Array(afterRepair!.encryptedDataKey),
            recipientSecretKeyOrSeed: target.keys.contentSecretKey,
        })).toEqual(first.dataKey);

        // A provider reset keeps the membership id while replacing its Account.
        const replacement = await e2eeAccount();
        await db.teamMembership.update({ where: { id: targetMembershipId }, data: { accountId: replacement.id } });
        expect(await patch({ recipientAccountId: target.id, entries: [
            { sessionId: second.sessionId, encryptedDataKey: sealedFor(second.dataKey) },
        ] })).toEqual({ ok: false, error: "recipient_changed" });
        expect(await db.sessionDataKeyEnvelope.count({ where: { recipientAccountId: replacement.id } })).toBe(0);

        // The membership must lose access entirely for the write to stop for that reason.
        await db.teamMembership.update({ where: { id: targetMembershipId }, data: { accountId: target.id } });
        await db.sessionTeamGrant.deleteMany({ where: { sessionId: second.sessionId } });
        expect(await patch({ recipientAccountId: target.id, entries: [
            { sessionId: second.sessionId, encryptedDataKey: sealedFor(second.dataKey) },
        ] })).toEqual({ ok: false, error: "forbidden" });
    });

    it("pages the actionable set with a route-local cursor and rejects a foreign one", async () => {
        const { manager, team, subject } = await history();
        const granted = [
            await grantedSession(team, manager),
            await grantedSession(team, manager),
            await grantedSession(team, manager),
        ];
        const expected = granted.map(entry => entry.sessionId).sort();

        const first = readyPage(await readPage(manager.id, subject, 2));
        expect(first.items.map(item => item.sessionId)).toEqual(expected.slice(0, 2));
        expect(first.nextCursor).not.toBeNull();

        const second = readyPage(await readMembershipSessionDataKeyEnvelopePage({
            actorAccountId: manager.id,
            authentication,
            subject,
            query: { state: "action_required", limit: 2, cursor: first.nextCursor! },
        }));
        expect(second.items.map(item => item.sessionId)).toEqual(expected.slice(2));
        expect(second.nextCursor).toBeNull();
        expect(second.exceptions).toBeNull();

        expect(await readMembershipSessionDataKeyEnvelopePage({
            actorAccountId: manager.id,
            authentication,
            subject,
            query: { state: "action_required", limit: 2, cursor: "sdke_cursor_v1_not-this-resource" },
        })).toEqual({ ok: false, error: "invalid_cursor" });
    });

    it("serves a restricted Team's history to the manager whose credential qualified for this exact request", async () => {
        const { manager, target, team, subject } = await history();
        await db.team.update({
            where: { id: team.id },
            data: { authenticationPolicy: { v: 1, mode: "restricted", accepted: [ACCEPTED_EMAIL_PASSWORD] } },
        });
        await db.accountIdentity.create({
            data: { accountId: manager.id, provider: "email", providerUserId: `${manager.id}@example.test`, profile: {} },
        });
        await db.accountPasswordCredential.create({
            data: {
                accountId: manager.id,
                credential: {
                    v: 1,
                    kind: "plain_password_hash",
                    hash: await hashPasswordMaterial(new TextEncoder().encode("manager password factor")),
                },
            },
        });
        const granted = await grantedSession(team, manager);

        const qualified = {
            env: { ...process.env, ...HOME_OFFERS_EMAIL_PASSWORD },
            authority: "present_user",
            authenticationEvidence: EMAIL_PASSWORD_EVIDENCE,
        } as const;
        const unqualified = { ...qualified, authenticationEvidence: undefined } as const;

        // A manager presenting no evidence of the accepted method stays refused.
        expect(await readMembershipSessionDataKeyEnvelopePage({
            actorAccountId: manager.id, subject, authentication: unqualified,
            query: { state: "action_required", limit: 24 },
        })).toEqual({ ok: false, error: "team_authentication_required" });

        const page = readyPage(await readMembershipSessionDataKeyEnvelopePage({
            actorAccountId: manager.id, subject, authentication: qualified,
            query: { state: "action_required", limit: 24 },
        }));
        expect(page.recipientAccountId).toBe(target.id);
        expect(page.items.map(item => item.sessionId)).toEqual([granted.sessionId]);

        const openedByCaller = openEncryptedDataKeyEnvelopeV1({
            envelope: decodeBase64(page.items[0]!.callerDataKeyEnvelope),
            recipientSecretKeyOrSeed: manager.keys.contentSecretKey,
        });
        const entries = [{
            sessionId: granted.sessionId,
            encryptedDataKey: encodeBase64(seal(openedByCaller!, decodeBase64(
                page.contentKey.status === "available" ? page.contentKey.contentPublicKey : "",
            ))),
        }];
        expect(await applyMembershipSessionDataKeyEnvelopes({
            actorAccountId: manager.id, authentication: unqualified, subject,
            request: { recipientAccountId: target.id, entries },
        })).toEqual({ ok: false, error: "team_authentication_required" });
        expect(await applyMembershipSessionDataKeyEnvelopes({
            actorAccountId: manager.id, authentication: qualified, subject,
            request: { recipientAccountId: target.id, entries },
        })).toEqual({ ok: true, appliedCount: 1 });
    });

    it.each(["team", "group"] as const)("writes nothing when the %s membership disappears between the page and the apply", async (kind) => {
        const { manager, target, team, subject: teamSubject, targetMembershipId } = await history();
        const granted = await grantedSession(team, manager);
        let subject: MembershipSessionDataKeyEnvelopeSubject = teamSubject;
        if (kind === "group") {
            const group = await db.teamGroup.create({ data: {
                teamId: team.id, name: crypto.randomUUID(), nameKey: crypto.randomUUID(),
            } });
            await db.teamGroupMembership.create({ data: {
                teamId: team.id,
                teamGroupId: group.id,
                teamMembershipId: targetMembershipId,
                sessionAccessStartsAt: null,
            } });
            await db.sessionGroupGrant.create({ data: {
                sessionId: granted.sessionId,
                teamGroupId: group.id,
                accessLevel: "view",
                effectiveAt: new Date(),
            } });
            subject = { kind: "group", teamId: team.id, groupId: group.id, accountId: target.id };
        }

        const page = readyPage(await readPage(manager.id, subject));
        expect(page.items.map(item => item.sessionId)).toEqual([granted.sessionId]);
        const openedByCaller = openEncryptedDataKeyEnvelopeV1({
            envelope: decodeBase64(page.items[0]!.callerDataKeyEnvelope),
            recipientSecretKeyOrSeed: manager.keys.contentSecretKey,
        });
        expect(openedByCaller).toEqual(granted.dataKey);
        const entries = [{
            sessionId: granted.sessionId,
            encryptedDataKey: encodeBase64(seal(openedByCaller!, decodeBase64(
                page.contentKey.status === "available" ? page.contentKey.contentPublicKey : "",
            ))),
        }];

        // Only the subject membership disappears after the caller read its work.
        if (subject.kind === "group") {
            expect(await db.teamGroupMembership.deleteMany({ where: {
                teamGroupId: subject.groupId,
                teamMembershipId: targetMembershipId,
            } })).toEqual({ count: 1 });
            expect(await db.teamMembership.findUnique({
                where: { id: targetMembershipId },
                select: { accountId: true },
            })).toEqual({ accountId: target.id });
        } else {
            await db.teamMembership.delete({ where: { id: targetMembershipId } });
        }
        const changesBefore = await db.accountChange.count({ where: { accountId: target.id } });

        expect(await applyMembershipSessionDataKeyEnvelopes({
            actorAccountId: manager.id, authentication, subject,
            request: { recipientAccountId: target.id, entries },
        })).toEqual({ ok: false, error: "membership_not_found" });
        expect(await db.sessionDataKeyEnvelope.count({ where: { recipientAccountId: target.id } })).toBe(0);
        expect(await db.accountChange.count({ where: { accountId: target.id } })).toBe(changesBefore);

        if (subject.kind === "group") {
            // The Group membership disappeared, but the containing Team lifetime
            // is still current. The nested Group resource must be gone while the
            // same Session remains actionable through the surviving Team grant.
            expect(await readPage(manager.id, subject)).toEqual({
                ok: false,
                error: "membership_not_found",
            });
            const survivingTeamPage = readyPage(await readPage(manager.id, teamSubject));
            expect(survivingTeamPage.items.map(item => item.sessionId)).toEqual([granted.sessionId]);
            expect(survivingTeamPage.recipientAccountId).toBe(target.id);
            expect(await db.sessionDataKeyEnvelope.count({ where: { recipientAccountId: target.id } })).toBe(0);
            expect(await db.accountChange.count({ where: { accountId: target.id } })).toBe(changesBefore);
        }
    });

    it("conceals the membership from an Account that cannot view the Team", async () => {
        const { team, subject } = await history();
        const outsider = await e2eeAccount();
        expect(await readPage(outsider.id, subject)).toEqual({ ok: false, error: "team_not_found" });
        expect(await readPage(outsider.id, {
            kind: "group", teamId: team.id, groupId: crypto.randomUUID(), accountId: outsider.id,
        })).toEqual({ ok: false, error: "team_not_found" });
    });
});
