import { storedPlainPrivateLabel } from "@/testkit/privateLabelFixture";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import tweetnacl from "tweetnacl";
import { encodeBase64 as encodeBase64Bytes } from "privacy-kit";
import {
    ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES,
    SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1,
    sealEncryptedDataKeyEnvelopeV1,
    openEncryptedDataKeyEnvelopeV1,
    signAccountContentKeyBindingV1,
    projectSessionDisplayV1,
    sealSessionSharedDisplayEnvelopeV1,
    sealSessionOwnerDisplayEnvelopeV1,
    sealSessionOwnerMetadataEnvelopeV1,
    sealSessionDataKeyBundleV0,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { sessionRoutes } from "@/app/api/routes/session/sessionRoutes";
import { registerSessionDataKeyEnvelopeRoutes } from "@/app/api/routes/session/registerSessionDataKeyEnvelopeRoutes";
import { admitAccountContentKey } from "@/app/encryption/accountContentKeyAdmission";
import { inTx } from "@/storage/inTx";
import {
    applySessionDataKeyEnvelopes,
    readSessionDataKeyEnvelopePage,
} from "./sessionDataKeyEnvelopeService";

/**
 * The per-Session recipient envelope collection against a real database.
 *
 * Access, recipient readiness and envelope structure are exercised through
 * their canonical owners rather than mocked: a mocked policy would let this
 * suite pass while the resource disclosed a Session the caller cannot read.
 */
describe("Session data-key envelope collection (SQLite)", () => {
    let harness: LightSqliteHarness;
    const authentication = createPresentUserSessionAccessAuthentication();
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-envelopes-",
            initAuth: false,
            env: {
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            },
        });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    function encodeBase64(bytes: Uint8Array): string {
        return encodeBase64Bytes(new Uint8Array(bytes));
    }

    function signedBinding() {
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
        const binding = signedBinding();
        const account = await db.account.create({ data: {
            publicKey: binding.publicKey,
            encryptionMode: "e2ee",
            contentPublicKey: Buffer.from(binding.contentPublicKey),
            contentPublicKeySig: Buffer.from(binding.contentPublicKeySig),
        } });
        return { ...account, binding };
    }

    async function plainAccount() {
        return await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: "plain" } });
    }

    function envelopeFor(contentPublicKey: Uint8Array): Uint8Array {
        return new Uint8Array(sealEncryptedDataKeyEnvelopeV1({
            dataKey: tweetnacl.randomBytes(32),
            recipientPublicKey: contentPublicKey,
            randomBytes: (length) => tweetnacl.randomBytes(length),
        }));
    }

    async function e2eeSession(ownerId: string) {
        return await db.session.create({ data: {
            accountId: ownerId, tag: crypto.randomUUID(), encryptionMode: "e2ee",
            metadata: JSON.stringify({ t: "encrypted", c: "" }), seq: 1,
        } });
    }

    /** The owner is the manager; a valid owner tuple is their transferable key. */
    async function managedSession() {
        const owner = await e2eeAccount();
        const session = await e2eeSession(owner.id);
        await db.sessionDataKeyEnvelope.create({ data: {
            sessionId: session.id, recipientAccountId: owner.id,
            encryptedDataKey: Buffer.from(envelopeFor(owner.binding.contentPublicKey)),
        } });
        return { owner, session };
    }

    async function shareWith(sessionId: string, ownerId: string, accountId: string, accessLevel: "view" | "edit" | "admin" = "view") {
        await db.sessionGrant.create({ data: { principalKind: 'account',
            sessionId, createdByAccountId: ownerId, accountId: accountId, accessLevel,
        } });
    }

    it("answers a plain Session before doing any recipient key work", async () => {
        const owner = await plainAccount();
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: "plain",
            metadata: JSON.stringify({ t: "plain", v: {} }), seq: 1,
        } });

        const result = await readSessionDataKeyEnvelopePage({
            actorAccountId: owner.id, sessionId: session.id,
            authentication,
            query: { state: "action_required", limit: 24 },
        });

        expect(result).toEqual({ ok: true, page: { status: "not_required" } });
    });

    it("fails closed when the persisted Session encryption mode is inconsistent", async () => {
        const { owner, session } = await managedSession();
        const recipient = await e2eeAccount();
        await shareWith(session.id, owner.id, recipient.id, "view");
        await db.session.update({
            where: { id: session.id },
            data: { encryptionMode: "unsupported" },
        });

        expect(await readSessionDataKeyEnvelopePage({
            actorAccountId: owner.id,
            sessionId: session.id,
            authentication,
            query: { state: "all", limit: 24 },
        })).toEqual({ ok: false, error: "session_data_key_unavailable" });

        expect(await applySessionDataKeyEnvelopes({
            actorAccountId: owner.id,
            sessionId: session.id,
            authentication,
            entries: [{
                recipientAccountId: recipient.id,
                encryptedDataKey: encodeBase64(envelopeFor(recipient.binding.contentPublicKey)),
            }],
        })).toEqual({ ok: false, error: "session_data_key_unavailable" });
        expect(await db.sessionDataKeyEnvelope.count({
            where: { sessionId: session.id, recipientAccountId: recipient.id },
        })).toBe(0);

        await withAuthenticatedTestApp(sessionRoutes, async app => {
            const response = await app.inject({
                method: "GET",
                url: `/v2/sessions/${session.id}/data-key/envelopes?state=all`,
                headers: { "x-test-user-id": owner.id },
            });
            expect(response.statusCode, response.body).toBe(409);
            expect(response.json()).toEqual({ error: "session_data_key_unavailable" });
        });
    });

    it("conceals a Session the caller cannot read as not found", async () => {
        const { session } = await managedSession();
        const stranger = await plainAccount();

        expect(await readSessionDataKeyEnvelopePage({
            actorAccountId: stranger.id, sessionId: session.id,
            authentication,
            query: { state: "action_required", limit: 24 },
        })).toEqual({ ok: false, error: "session_not_found" });

        expect(await readSessionDataKeyEnvelopePage({
            actorAccountId: stranger.id, sessionId: "missing-session",
            authentication,
            query: { state: "action_required", limit: 24 },
        })).toEqual({ ok: false, error: "session_not_found" });
    });

    it("separates a visible Session without manageAccess from a concealed one", async () => {
        const { owner, session } = await managedSession();
        const viewer = await e2eeAccount();
        await shareWith(session.id, owner.id, viewer.id, "view");

        expect(await readSessionDataKeyEnvelopePage({
            actorAccountId: viewer.id, sessionId: session.id,
            authentication,
            query: { state: "action_required", limit: 24 },
        })).toEqual({ ok: false, error: "forbidden" });
    });

    it("preserves Team authentication recovery for envelope management without replaying writes", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1" });
        const { owner, session } = await managedSession();
        const manager = await e2eeAccount();
        const recipient = await e2eeAccount();
        await shareWith(session.id, owner.id, manager.id, "view");
        await shareWith(session.id, owner.id, recipient.id);
        await db.sessionDataKeyEnvelope.create({ data: {
            sessionId: session.id, recipientAccountId: manager.id,
            encryptedDataKey: Buffer.from(envelopeFor(manager.binding.contentPublicKey)),
        } });
        const team = await db.team.create({ data: {
            name: crypto.randomUUID(),
            authenticationPolicy: {
                v: 1, mode: "restricted",
                accepted: [{ kind: "home_method", methodId: "key_challenge" }],
            },
        } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: manager.id, role: "member" } });
        const grant = await db.sessionGrant.create({ data: { principalKind: 'team',
            sessionId: session.id, teamId: team.id, accessLevel: "admin", effectiveAt: new Date(),
        } });
        const url = `/v2/sessions/${session.id}/data-key/envelopes`;
        const payload = { entries: [{
            recipientAccountId: recipient.id,
            encryptedDataKey: encodeBase64(envelopeFor(recipient.binding.contentPublicKey)),
        }] };
        const headers = { "x-test-user-id": manager.id };
        const qualifiedHeaders = {
            ...headers,
            "x-test-authentication-evidence": JSON.stringify([{ kind: "home_method", methodId: "key_challenge" }]),
        };
        const recipientEnvelopeCount = () => db.sessionDataKeyEnvelope.count({
            where: { sessionId: session.id, recipientAccountId: recipient.id },
        });
        try {
            await withAuthenticatedTestApp(registerSessionDataKeyEnvelopeRoutes, async app => {
                // Independent View preserves visibility but cannot hide a recoverable Admin arm.
                for (const method of ["GET", "PATCH"] as const) {
                    const response = await app.inject({ method, url, headers, ...(method === "PATCH" ? { payload } : {}) });
                    expect(response.statusCode, response.body).toBe(403);
                    expect(response.json()).toEqual({ error: "session_access_authentication_required" });
                }
                expect(await recipientEnvelopeCount()).toBe(0);
                const qualifiedRead = await app.inject({ method: "GET", url, headers: qualifiedHeaders });
                expect(qualifiedRead.statusCode, qualifiedRead.body).toBe(200);
                // Qualification and a refresh never replay the failed PATCH.
                expect(await recipientEnvelopeCount()).toBe(0);
                const qualifiedWrite = await app.inject({ method: "PATCH", url, headers: qualifiedHeaders, payload });
                expect(qualifiedWrite.statusCode, qualifiedWrite.body).toBe(200);
                expect(qualifiedWrite.json()).toEqual({ appliedCount: 1 });

                // A policy change after discovery blocks the next page/write with its real cause.
                await db.team.update({ where: { id: team.id }, data: {
                    authenticationPolicy: { v: 1, mode: "restricted", accepted: [{ kind: "home_method", methodId: "missing-method" }] },
                } });
                const stored = await db.sessionDataKeyEnvelope.findUniqueOrThrow({ where: {
                    sessionId_recipientAccountId: { sessionId: session.id, recipientAccountId: recipient.id },
                } });
                for (const method of ["GET", "PATCH"] as const) {
                    const response = await app.inject({ method, url, headers: qualifiedHeaders, ...(method === "PATCH" ? { payload } : {}) });
                    expect(response.statusCode, response.body).toBe(503);
                    expect(response.json()).toEqual({ error: "session_access_authentication_unavailable" });
                }
                expect(await db.sessionDataKeyEnvelope.findUniqueOrThrow({ where: {
                    sessionId_recipientAccountId: { sessionId: session.id, recipientAccountId: recipient.id },
                } })).toEqual(stored);

                await db.sessionGrant.delete({
                    where: { principalKind: 'team', sessionId_teamId: { sessionId: session.id, teamId: grant.teamId } },
                });
                await db.sessionGrant.deleteMany({ where: { principalKind: 'account', sessionId: session.id, accountId: manager.id } });
                for (const method of ["GET", "PATCH"] as const) {
                    const response = await app.inject({ method, url, headers: qualifiedHeaders, ...(method === "PATCH" ? { payload } : {}) });
                    expect(response.statusCode, response.body).toBe(404);
                    expect(response.json()).toEqual({ error: "session_not_found" });
                }
            });
        } finally {
            harness.resetEnv();
        }
    });

    it("resolves one target for a recipient reached by direct, Team and Group grants at once", async () => {
        const { owner, session } = await managedSession();
        const recipient = await e2eeAccount();
        await shareWith(session.id, owner.id, recipient.id, "view");

        const team = await db.team.create({ data: { name: crypto.randomUUID() } });
        const membership = await db.teamMembership.create({ data: {
            teamId: team.id, accountId: recipient.id, role: "member", sessionAccessStartsAt: null,
        } });
        const group = await db.teamGroup.create({ data: {
            teamId: team.id, name: storedPlainPrivateLabel("Developers"),
        } });
        await db.teamGroupMembership.create({ data: {
            teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id, sessionAccessStartsAt: null,
        } });
        await db.sessionGrant.create({ data: { principalKind: 'team',
            sessionId: session.id, teamId: team.id, accessLevel: "view", effectiveAt: new Date(),
        } });
        await db.sessionGrant.create({ data: { principalKind: 'group',
            sessionId: session.id, teamGroupId: group.id, accessLevel: "view", effectiveAt: new Date(),
        } });

        const result = await readSessionDataKeyEnvelopePage({
            actorAccountId: owner.id, sessionId: session.id,
            authentication,
            query: { state: "action_required", limit: 24 },
        });

        expect(result.ok).toBe(true);
        if (!result.ok || result.page.status !== "required") throw new Error("expected a required page");
        const targets = result.page.items.filter(item => item.recipientAccountId === recipient.id);
        expect(targets).toHaveLength(1);
        expect(targets[0]?.envelopeState).toBe("missing");
        expect(result.page.summary?.pending).toBe(1);
        expect(result.page.summary?.prepared).toBe(1);
    });

    it("keeps an unavailable recipient out of prepared even when an inert tuple remains", async () => {
        const { owner, session } = await managedSession();
        const recipient = await plainAccount();
        await shareWith(session.id, owner.id, recipient.id, "view");
        await db.sessionDataKeyEnvelope.create({ data: {
            sessionId: session.id, recipientAccountId: recipient.id,
            encryptedDataKey: Buffer.from(envelopeFor(tweetnacl.box.keyPair().publicKey)),
        } });

        const result = await readSessionDataKeyEnvelopePage({
            actorAccountId: owner.id, sessionId: session.id,
            authentication,
            query: { state: "action_required", limit: 24 },
        });

        if (!result.ok || result.page.status !== "required") throw new Error("expected a required page");
        const item = result.page.items.find(entry => entry.recipientAccountId === recipient.id);
        expect(item?.envelopeState).toBe("prepared");
        expect(item?.contentKey).toEqual({ status: "unavailable", reason: "plain_account" });
        expect(result.page.summary?.recipientKeyUnavailable).toBe(1);
        expect(result.page.summary?.prepared).toBe(1);
    });

    it("surfaces structurally invalid stored bytes as repair work instead of discarding them", async () => {
        const { owner, session } = await managedSession();
        const recipient = await e2eeAccount();
        await shareWith(session.id, owner.id, recipient.id, "view");
        const malformed = Buffer.alloc(ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES, 7);
        await db.sessionDataKeyEnvelope.create({ data: {
            sessionId: session.id, recipientAccountId: recipient.id, encryptedDataKey: malformed,
        } });

        const result = await readSessionDataKeyEnvelopePage({
            actorAccountId: owner.id, sessionId: session.id,
            authentication,
            query: { state: "action_required", limit: 24 },
        });

        if (!result.ok || result.page.status !== "required") throw new Error("expected a required page");
        expect(result.page.items.find(entry => entry.recipientAccountId === recipient.id)?.envelopeState).toBe("invalid");
        expect(result.page.summary?.invalid).toBe(1);
        const stored = await db.sessionDataKeyEnvelope.findUnique({ where: {
            sessionId_recipientAccountId: { sessionId: session.id, recipientAccountId: recipient.id },
        } });
        expect(Buffer.from(stored!.encryptedDataKey).equals(malformed)).toBe(true);
    });

    it("writes a prepared tuple and exactly one recipient-private session invalidation", async () => {
        const { owner, session } = await managedSession();
        const recipient = await e2eeAccount();
        await shareWith(session.id, owner.id, recipient.id, "view");
        const sealed = encodeBase64(envelopeFor(recipient.binding.contentPublicKey));

        const applied = await applySessionDataKeyEnvelopes({
            actorAccountId: owner.id, sessionId: session.id,
            authentication,
            entries: [{ recipientAccountId: recipient.id, encryptedDataKey: sealed }],
        });

        expect(applied).toEqual({ ok: true, appliedCount: 1 });
        const stored = await db.sessionDataKeyEnvelope.findUnique({ where: {
            sessionId_recipientAccountId: { sessionId: session.id, recipientAccountId: recipient.id },
        } });
        expect(encodeBase64(new Uint8Array(stored!.encryptedDataKey))).toBe(sealed);

        const changes = await db.accountChange.findMany({ where: { accountId: recipient.id } });
        expect(changes).toHaveLength(1);
        expect(changes[0]?.kind).toBe("session");
        expect(changes.some(change => change.kind === "share")).toBe(false);
    });

    it("overwrites a current valid tuple so a manager can prepare again", async () => {
        const { owner, session } = await managedSession();
        const recipient = await e2eeAccount();
        await shareWith(session.id, owner.id, recipient.id, "view");
        const dataKey = tweetnacl.randomBytes(32);
        const wrap = (recipientPublicKey: Uint8Array) => new Uint8Array(sealEncryptedDataKeyEnvelopeV1({
            dataKey, recipientPublicKey, randomBytes: length => tweetnacl.randomBytes(length),
        }));
        await db.sessionDataKeyEnvelope.update({ where: {
            sessionId_recipientAccountId: { sessionId: session.id, recipientAccountId: owner.id },
        }, data: { encryptedDataKey: Buffer.from(wrap(owner.binding.contentPublicKey)) } });
        const sharedMetadata = { v: 1 as const, summary: { text: 'Same-DEK shared display', updatedAt: 0 } };
        const ownerMetadata = { v: 1 as const, workspace: { name: 'Account-private display' } };
        const display = projectSessionDisplayV1({ sharedMetadata, ownerMetadata });
        const material = { type: 'dataKey' as const, machineKey: owner.binding.contentSecretKey };
        const randomBytes = (length: number) => tweetnacl.randomBytes(length);
        const shared = await sealSessionSharedDisplayEnvelopeV1({ sessionMode: 'e2ee', display: display.shared,
            encryptPayload: async payload => encodeBase64(await sealSessionDataKeyBundleV0(payload, dataKey)) });
        const privateDisplay = sealSessionOwnerDisplayEnvelopeV1({ accountMode: 'e2ee', display: display.owner!, material, randomBytes });
        if (!shared.ok || !privateDisplay.ok) throw new Error('Canonical same-DEK display producer failed');
        const displayProjectionV1 = JSON.stringify({ v: 1, metadataLayoutVersion: 1, sourceMetadataVersion: session.metadataVersion,
            shared: shared.envelope, owner: privateDisplay.envelope });
        await db.session.update({ where: { id: session.id }, data: {
            metadataLayoutVersion: 1, metadata: encodeBase64(await sealSessionDataKeyBundleV0(sharedMetadata, dataKey)),
            ownerMetadata: JSON.stringify(sealSessionOwnerMetadataEnvelopeV1({ ownerMetadata, material, randomBytes })),
            displayProjectionV1,
        } });
        const before = await db.session.findUniqueOrThrow({ where: { id: session.id } });
        const first = encodeBase64(wrap(recipient.binding.contentPublicKey));
        const second = encodeBase64(wrap(recipient.binding.contentPublicKey));
        expect(second).not.toBe(first);

        await applySessionDataKeyEnvelopes({
            actorAccountId: owner.id, sessionId: session.id,
            authentication,
            entries: [{ recipientAccountId: recipient.id, encryptedDataKey: first }],
        });
        const applied = await applySessionDataKeyEnvelopes({
            actorAccountId: owner.id, sessionId: session.id,
            authentication,
            entries: [{ recipientAccountId: recipient.id, encryptedDataKey: second }],
        });

        expect(applied).toEqual({ ok: true, appliedCount: 1 });
        const stored = await db.sessionDataKeyEnvelope.findUnique({ where: {
            sessionId_recipientAccountId: { sessionId: session.id, recipientAccountId: recipient.id },
        } });
        expect(encodeBase64(new Uint8Array(stored!.encryptedDataKey))).toBe(second);
        expect(openEncryptedDataKeyEnvelopeV1({ envelope: new Uint8Array(stored!.encryptedDataKey),
            recipientSecretKeyOrSeed: recipient.binding.contentSecretKey })).toEqual(dataKey);
        const after = await db.session.findUniqueOrThrow({ where: { id: session.id } });
        expect(after.displayProjectionV1).toBe(displayProjectionV1);
        expect(after.metadata).toBe(before.metadata);
        expect(after.ownerMetadata).toBe(before.ownerMetadata);
        expect(after.metadataVersion).toBe(before.metadataVersion);
        expect(after.agentStateVersion).toBe(before.agentStateVersion);
    });

    it("writes nothing when any single entry in the bounded page is malformed", async () => {
        const { owner, session } = await managedSession();
        const good = await e2eeAccount();
        const other = await e2eeAccount();
        await shareWith(session.id, owner.id, good.id, "view");
        await shareWith(session.id, owner.id, other.id, "view");

        const applied = await applySessionDataKeyEnvelopes({
            actorAccountId: owner.id, sessionId: session.id,
            authentication,
            entries: [
                { recipientAccountId: good.id, encryptedDataKey: encodeBase64(envelopeFor(good.binding.contentPublicKey)) },
                { recipientAccountId: other.id, encryptedDataKey: encodeBase64(Buffer.alloc(ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES, 9)) },
            ],
        });

        expect(applied).toEqual({ ok: false, error: "invalid_request" });
        expect(await db.sessionDataKeyEnvelope.count({ where: {
            sessionId: session.id, recipientAccountId: { in: [good.id, other.id] },
        } })).toBe(0);
    });

    it("enforces the atomic page bound at the service boundary before authorization or writes", async () => {
        const sealed = encodeBase64(envelopeFor(tweetnacl.box.keyPair().publicKey));
        expect(await applySessionDataKeyEnvelopes({
            actorAccountId: "absent-actor",
            authentication,
            sessionId: "absent-session",
            entries: Array.from({ length: SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1 + 1 }, (_, index) => ({
                recipientAccountId: `recipient-${index}`,
                encryptedDataKey: sealed,
            })),
        })).toEqual({ ok: false, error: "invalid_request" });
    });

    it("rejects the whole page when a target is no longer in the current audience", async () => {
        const { owner, session } = await managedSession();
        const kept = await e2eeAccount();
        const removed = await e2eeAccount();
        await shareWith(session.id, owner.id, kept.id, "view");

        const applied = await applySessionDataKeyEnvelopes({
            actorAccountId: owner.id, sessionId: session.id,
            authentication,
            entries: [
                { recipientAccountId: kept.id, encryptedDataKey: encodeBase64(envelopeFor(kept.binding.contentPublicKey)) },
                { recipientAccountId: removed.id, encryptedDataKey: encodeBase64(envelopeFor(removed.binding.contentPublicKey)) },
            ],
        });

        expect(applied).toEqual({ ok: false, error: "recipient_changed" });
        expect(await db.sessionDataKeyEnvelope.count({ where: {
            sessionId: session.id, recipientAccountId: { in: [kept.id, removed.id] },
        } })).toBe(0);
    });

    it("rechecks manager capability after discovery before applying a prepared page", async () => {
        const { owner, session } = await managedSession();
        const manager = await e2eeAccount();
        const recipient = await e2eeAccount();
        await shareWith(session.id, owner.id, manager.id, "admin");
        await shareWith(session.id, owner.id, recipient.id);
        await db.sessionDataKeyEnvelope.create({ data: {
            sessionId: session.id, recipientAccountId: manager.id,
            encryptedDataKey: Buffer.from(envelopeFor(manager.binding.contentPublicKey)),
        } });
        const discovered = await readSessionDataKeyEnvelopePage({
            actorAccountId: manager.id, sessionId: session.id,
            authentication,
            query: { state: "action_required", limit: 24 },
        });
        expect(discovered.ok).toBe(true);
        await db.sessionGrant.updateMany({
            where: { principalKind: 'account', sessionId: session.id, accountId: manager.id }, data: { accessLevel: "view" },
        });
        expect(await applySessionDataKeyEnvelopes({
            actorAccountId: manager.id, sessionId: session.id,
            authentication,
            entries: [{ recipientAccountId: recipient.id, encryptedDataKey: encodeBase64(envelopeFor(recipient.binding.contentPublicKey)) }],
        })).toEqual({ ok: false, error: "forbidden" });
        expect(await db.sessionDataKeyEnvelope.count({ where: {
            sessionId: session.id, recipientAccountId: recipient.id,
        } })).toBe(0);
        expect(await db.accountChange.count({ where: { accountId: recipient.id } })).toBe(0);
    });

    it("rejects the whole page when a target is not envelope-ready", async () => {
        const { owner, session } = await managedSession();
        const ready = await e2eeAccount();
        const keyless = await plainAccount();
        await shareWith(session.id, owner.id, ready.id, "view");
        await shareWith(session.id, owner.id, keyless.id, "view");

        const applied = await applySessionDataKeyEnvelopes({
            actorAccountId: owner.id, sessionId: session.id,
            authentication,
            entries: [
                { recipientAccountId: ready.id, encryptedDataKey: encodeBase64(envelopeFor(ready.binding.contentPublicKey)) },
                { recipientAccountId: keyless.id, encryptedDataKey: encodeBase64(envelopeFor(tweetnacl.box.keyPair().publicKey)) },
            ],
        });

        expect(applied).toEqual({ ok: false, error: "recipient_key_unavailable" });
        expect(await db.sessionDataKeyEnvelope.count({ where: {
            sessionId: session.id, recipientAccountId: { in: [ready.id, keyless.id] },
        } })).toBe(0);
    });

    it("rejects a disabled direct recipient even when its grant and valid binding remain", async () => {
        const { owner, session } = await managedSession();
        const recipient = await e2eeAccount();
        await shareWith(session.id, owner.id, recipient.id);
        await db.account.update({ where: { id: recipient.id }, data: { status: "disabled" } });
        expect(await applySessionDataKeyEnvelopes({
            actorAccountId: owner.id, sessionId: session.id,
            authentication,
            entries: [{ recipientAccountId: recipient.id, encryptedDataKey: encodeBase64(envelopeFor(recipient.binding.contentPublicKey)) }],
        })).toEqual({ ok: false, error: "recipient_changed" });
        expect(await db.sessionDataKeyEnvelope.count({ where: {
            sessionId: session.id, recipientAccountId: recipient.id,
        } })).toBe(0);
        expect(await db.accountChange.count({ where: { accountId: recipient.id } })).toBe(0);
    });

    it("refuses to write when the caller holds no transferable Session key", async () => {
        const owner = await e2eeAccount();
        const session = await e2eeSession(owner.id);
        const recipient = await e2eeAccount();
        await shareWith(session.id, owner.id, recipient.id, "view");

        const applied = await applySessionDataKeyEnvelopes({
            actorAccountId: owner.id, sessionId: session.id,
            authentication,
            entries: [{ recipientAccountId: recipient.id, encryptedDataKey: encodeBase64(envelopeFor(recipient.binding.contentPublicKey)) }],
        });

        expect(applied).toEqual({ ok: false, error: "session_data_key_unavailable" });
        expect(await db.sessionDataKeyEnvelope.count({ where: { sessionId: session.id } })).toBe(0);
    });

    it("refuses recipient cryptography on a plain Session", async () => {
        const owner = await plainAccount();
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: crypto.randomUUID(), encryptionMode: "plain",
            metadata: JSON.stringify({ t: "plain", v: {} }), seq: 1,
        } });
        const recipient = await e2eeAccount();
        await shareWith(session.id, owner.id, recipient.id, "view");

        expect(await applySessionDataKeyEnvelopes({
            actorAccountId: owner.id, sessionId: session.id,
            authentication,
            entries: [{ recipientAccountId: recipient.id, encryptedDataKey: encodeBase64(envelopeFor(recipient.binding.contentPublicKey)) }],
        })).toEqual({ ok: false, error: "data_key_not_required" });
    });

    it("pages action-required exceptions by recipient keyset and settles on a null cursor", async () => {
        const { owner, session } = await managedSession();
        const recipients = [];
        for (let index = 0; index < 3; index += 1) {
            const recipient = await e2eeAccount();
            await shareWith(session.id, owner.id, recipient.id, "view");
            recipients.push(recipient.id);
        }
        recipients.sort();

        const first = await readSessionDataKeyEnvelopePage({
            actorAccountId: owner.id, sessionId: session.id,
            authentication,
            query: { state: "action_required", limit: 2 },
        });
        if (!first.ok || first.page.status !== "required") throw new Error("expected a required page");
        expect(first.page.items.map(item => item.recipientAccountId)).toEqual(recipients.slice(0, 2));
        expect(first.page.nextCursor).not.toBeNull();
        expect(first.page.summary?.pending).toBe(3);

        const second = await readSessionDataKeyEnvelopePage({
            actorAccountId: owner.id, sessionId: session.id,
            authentication,
            query: { state: "action_required", limit: 2, cursor: first.page.nextCursor! },
        });
        if (!second.ok || second.page.status !== "required") throw new Error("expected a required page");
        expect(second.page.items.map(item => item.recipientAccountId)).toEqual(recipients.slice(2));
        expect(second.page.nextCursor).toBeNull();
        expect(second.page.summary).toBeNull();
    });

    it("continues beyond the 500-entry atomic page boundary instead of treating it as an audience limit", async () => {
        const { owner, session } = await managedSession();
        const team = await db.team.create({ data: { name: crypto.randomUUID() } });
        const recipientIds = Array.from(
            { length: SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1 + 1 },
            (_unused, index) => `fanout-recipient-${String(index).padStart(4, "0")}`,
        );
        await db.account.createMany({
            data: recipientIds.map((id) => ({
                id,
                publicKey: `fanout-key-${id}`,
                encryptionMode: "plain",
            })),
        });
        await db.teamMembership.createMany({
            data: recipientIds.map((accountId) => ({
                teamId: team.id,
                accountId,
                role: "member",
                sessionAccessStartsAt: null,
            })),
        });
        await db.sessionGrant.create({ data: { principalKind: 'team',
            sessionId: session.id,
            teamId: team.id,
            accessLevel: "view",
            effectiveAt: new Date(),
        } });

        const first = await readSessionDataKeyEnvelopePage({
            actorAccountId: owner.id,
            sessionId: session.id,
            authentication,
            query: {
                state: "action_required",
                limit: SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1,
            },
        });
        if (!first.ok || first.page.status !== "required") throw new Error("expected a required page");
        expect(first.page.items.map(item => item.recipientAccountId)).toEqual(recipientIds.slice(0, 500));
        expect(first.page.nextCursor).not.toBeNull();
        expect(first.page.summary).toEqual({
            prepared: 1,
            pending: 0,
            invalid: 0,
            recipientKeyUnavailable: recipientIds.length,
        });

        const continuation = await readSessionDataKeyEnvelopePage({
            actorAccountId: owner.id,
            sessionId: session.id,
            authentication,
            query: {
                state: "action_required",
                limit: SESSION_DATA_KEY_ENVELOPE_PAGE_MAX_ENTRIES_V1,
                cursor: first.page.nextCursor!,
            },
        });
        if (!continuation.ok || continuation.page.status !== "required") {
            throw new Error("expected a continuation page");
        }
        expect(continuation.page.items.map(item => item.recipientAccountId)).toEqual(recipientIds.slice(500));
        expect(continuation.page.nextCursor).toBeNull();
        expect(continuation.page.summary).toBeNull();
    });

    it("rejects an unparseable cursor rather than silently restarting the page", async () => {
        const { owner, session } = await managedSession();

        expect(await readSessionDataKeyEnvelopePage({
            actorAccountId: owner.id, sessionId: session.id,
            authentication,
            query: { state: "action_required", limit: 24, cursor: "not-a-cursor" },
        })).toEqual({ ok: false, error: "invalid_cursor" });
    });

    it("publishes the owner share wake when a Team recipient finishes encryption setup", async () => {
        const { owner, session } = await managedSession();
        const binding = signedBinding();
        const recipient = await db.account.create({ data: { publicKey: binding.publicKey, encryptionMode: "e2ee" } });
        const team = await db.team.create({ data: { name: crypto.randomUUID() } });
        await db.teamMembership.create({ data: {
            teamId: team.id, accountId: recipient.id, role: "member", sessionAccessStartsAt: null,
        } });
        await db.sessionGrant.create({ data: {
            principalKind: "team", sessionId: session.id, teamId: team.id, accessLevel: "view",
            effectiveAt: new Date(),
        } });
        const ownerWake = () => db.accountChange.findFirst({
            where: { accountId: owner.id, kind: "share", entityId: session.id },
            select: { cursor: true },
        });
        await withAuthenticatedTestApp(registerSessionDataKeyEnvelopeRoutes, async app => {
            const url = `/v2/sessions/${session.id}/data-key/envelopes`;
            const headers = { "x-test-user-id": owner.id };
            const readOwed = () => app.inject({ method: "GET", url: `${url}?state=owed`, headers });
            const pending = await app.inject({ method: "GET", url, headers });
            expect(pending.statusCode, pending.body).toBe(200);
            expect(pending.json().items).toEqual([
                expect.objectContaining({ recipientAccountId: recipient.id, contentKey: { status: "unavailable", reason: "encryption_setup_required" } }),
            ]);
            expect(await ownerWake()).toBeNull();

            const admitBinding = () => inTx(tx => admitAccountContentKey(tx, {
                accountId: recipient.id,
                contentPublicKey: binding.contentPublicKey,
                contentPublicKeySignature: binding.contentPublicKeySig,
            }));
            expect((await admitBinding()).status).toBe("initialized");
            await expect.poll(ownerWake).not.toBeNull();
            const wake = await ownerWake();

            const owed = await readOwed();
            expect(owed.statusCode, owed.body).toBe(200);
            expect(owed.json().items).toEqual([
                expect.objectContaining({ recipientAccountId: recipient.id, contentKey: expect.objectContaining({ status: "available" }) }),
            ]);
            const applied = await app.inject({ method: "PATCH", url, headers, payload: {
                entries: [{ recipientAccountId: recipient.id, encryptedDataKey: encodeBase64(envelopeFor(binding.contentPublicKey)) }],
            } });
            expect(applied.statusCode, applied.body).toBe(200);
            expect((await readOwed()).json()).toMatchObject({ items: [], nextCursor: null });
            expect((await admitBinding()).status).toBe("unchanged");
            expect(await ownerWake()).toEqual(wake);
        });
    });

    it("prepares a Team-only recipient through mounted routes and rejects nested authority input", async () => {
        const { owner, session } = await managedSession();
        const recipient = await e2eeAccount();
        const team = await db.team.create({ data: { name: crypto.randomUUID() } });
        await db.teamMembership.create({ data: {
            teamId: team.id, accountId: recipient.id, role: "member", sessionAccessStartsAt: null,
        } });
        await db.sessionGrant.create({ data: { principalKind: 'team',
            sessionId: session.id, teamId: team.id, accessLevel: "view", effectiveAt: new Date(),
        } });
        const dataKey = tweetnacl.randomBytes(32);
        await db.sessionDataKeyEnvelope.update({
            where: { sessionId_recipientAccountId: { sessionId: session.id, recipientAccountId: owner.id } },
            data: { encryptedDataKey: new Uint8Array(sealEncryptedDataKeyEnvelopeV1({
                dataKey, recipientPublicKey: owner.binding.contentPublicKey,
                randomBytes: length => tweetnacl.randomBytes(length),
            })) },
        });
        const encryptedDataKey = encodeBase64(new Uint8Array(sealEncryptedDataKeyEnvelopeV1({
            dataKey, recipientPublicKey: recipient.binding.contentPublicKey,
            randomBytes: length => tweetnacl.randomBytes(length),
        })));
        await withAuthenticatedTestApp(sessionRoutes, async app => {
            const url = `/v2/sessions/${session.id}/data-key/envelopes`;
            const headers = { "x-test-user-id": owner.id };
            const page = await app.inject({ method: "GET", url, headers });
            expect(page.statusCode, page.body).toBe(200);
            expect(page.json().items).toEqual([expect.objectContaining({ recipientAccountId: recipient.id })]);
            const rejected = await app.inject({ method: "PATCH", url, headers, payload: {
                entries: [{ recipientAccountId: recipient.id, encryptedDataKey, teamId: team.id }],
            } });
            expect(rejected.statusCode, rejected.body).toBe(400);
            expect(await db.sessionDataKeyEnvelope.count({ where: {
                sessionId: session.id, recipientAccountId: recipient.id,
            } })).toBe(0);
            const applied = await app.inject({ method: "PATCH", url, headers, payload: {
                entries: [{ recipientAccountId: recipient.id, encryptedDataKey }],
            } });
            expect(applied.statusCode, applied.body).toBe(200);
            expect(applied.json()).toEqual({ appliedCount: 1 });
        });
        const stored = await db.sessionDataKeyEnvelope.findUniqueOrThrow({ where: {
            sessionId_recipientAccountId: { sessionId: session.id, recipientAccountId: recipient.id },
        } });
        expect(openEncryptedDataKeyEnvelopeV1({
            envelope: new Uint8Array(stored.encryptedDataKey),
            recipientSecretKeyOrSeed: recipient.binding.contentSecretKey,
        })).toEqual(dataKey);
        expect(await db.accountChange.findMany({ where: { accountId: recipient.id }, select: { kind: true, entityId: true } }))
            .toEqual([{ kind: "session", entityId: session.id }]);
    });

    it("prepares a Group-only recipient with the same DEK and proves the wrong recipient cannot open it", async () => {
        const { owner, session } = await managedSession();
        const recipient = await e2eeAccount();
        const other = await e2eeAccount();
        const team = await db.team.create({ data: { name: crypto.randomUUID() } });
        const membership = await db.teamMembership.create({ data: {
            teamId: team.id, accountId: recipient.id, role: "member", sessionAccessStartsAt: null,
        } });
        const group = await db.teamGroup.create({ data: {
            teamId: team.id, name: storedPlainPrivateLabel("Group-only"),
        } });
        await db.teamGroupMembership.create({ data: {
            teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id, sessionAccessStartsAt: null,
        } });
        await db.sessionGrant.create({ data: { principalKind: 'group',
            sessionId: session.id, teamGroupId: group.id, accessLevel: "view", effectiveAt: new Date(),
        } });
        const dataKey = tweetnacl.randomBytes(32);
        await db.sessionDataKeyEnvelope.update({
            where: { sessionId_recipientAccountId: { sessionId: session.id, recipientAccountId: owner.id } },
            data: { encryptedDataKey: new Uint8Array(sealEncryptedDataKeyEnvelopeV1({
                dataKey, recipientPublicKey: owner.binding.contentPublicKey,
                randomBytes: length => tweetnacl.randomBytes(length),
            })) },
        });
        const sealed = encodeBase64(new Uint8Array(sealEncryptedDataKeyEnvelopeV1({
            dataKey, recipientPublicKey: recipient.binding.contentPublicKey,
            randomBytes: length => tweetnacl.randomBytes(length),
        })));
        const applied = await applySessionDataKeyEnvelopes({
            actorAccountId: owner.id, sessionId: session.id,
            authentication,
            entries: [{ recipientAccountId: recipient.id, encryptedDataKey: sealed }],
        });
        expect(applied).toEqual({ ok: true, appliedCount: 1 });
        const stored = await db.sessionDataKeyEnvelope.findUniqueOrThrow({ where: {
            sessionId_recipientAccountId: { sessionId: session.id, recipientAccountId: recipient.id },
        } });
        expect(openEncryptedDataKeyEnvelopeV1({
            envelope: new Uint8Array(stored.encryptedDataKey),
            recipientSecretKeyOrSeed: recipient.binding.contentSecretKey,
        })).toEqual(dataKey);
        expect(openEncryptedDataKeyEnvelopeV1({
            envelope: new Uint8Array(stored.encryptedDataKey),
            recipientSecretKeyOrSeed: other.binding.contentSecretKey,
        })).toBeNull();
    });

    it("keeps one tuple across overlapping Team and direct grants and withholds it after final revocation", async () => {
        const { owner, session } = await managedSession();
        const recipient = await e2eeAccount();
        const share = await db.sessionGrant.create({ data: { principalKind: 'account',
            sessionId: session.id, createdByAccountId: owner.id, accountId: recipient.id, accessLevel: "view",
        } });
        const team = await db.team.create({ data: { name: crypto.randomUUID() } });
        await db.teamMembership.create({ data: {
            teamId: team.id, accountId: recipient.id, role: "member", sessionAccessStartsAt: null,
        } });
        await db.sessionGrant.create({ data: { principalKind: 'team',
            sessionId: session.id, teamId: team.id, accessLevel: "view", effectiveAt: new Date(),
        } });
        const sealed = encodeBase64(envelopeFor(recipient.binding.contentPublicKey));
        expect(await applySessionDataKeyEnvelopes({
            actorAccountId: owner.id, sessionId: session.id,
            authentication,
            entries: [{ recipientAccountId: recipient.id, encryptedDataKey: sealed }],
        })).toEqual({ ok: true, appliedCount: 1 });
        await db.sessionGrant.delete({ where: { principalKind: 'account', id: share.id } });
        const stillVisible = await readSessionDataKeyEnvelopePage({
            actorAccountId: owner.id, sessionId: session.id,
            authentication,
            query: { state: "all", limit: 24 },
        });
        expect(stillVisible.ok).toBe(true);
        if (!stillVisible.ok || stillVisible.page.status !== "required") throw new Error("expected a required page");
        expect(stillVisible.page.items.some(item => item.recipientAccountId === recipient.id)).toBe(true);
        await db.sessionGrant.delete({
            where: { principalKind: 'team', sessionId_teamId: { sessionId: session.id, teamId: team.id } },
        });
        expect(await applySessionDataKeyEnvelopes({
            actorAccountId: owner.id, sessionId: session.id,
            authentication,
            entries: [{ recipientAccountId: recipient.id, encryptedDataKey: encodeBase64(envelopeFor(recipient.binding.contentPublicKey)) }],
        })).toEqual({ ok: false, error: "recipient_changed" });
        const retained = await db.sessionDataKeyEnvelope.findUnique({ where: {
            sessionId_recipientAccountId: { sessionId: session.id, recipientAccountId: recipient.id },
        } });
        expect(retained).not.toBeNull();
        const afterRevocation = await readSessionDataKeyEnvelopePage({
            actorAccountId: owner.id, sessionId: session.id,
            authentication,
            query: { state: "all", limit: 24 },
        });
        if (!afterRevocation.ok || afterRevocation.page.status !== "required") throw new Error("expected a required page");
        expect(afterRevocation.page.items.some(item => item.recipientAccountId === recipient.id)).toBe(false);
    });

    it("hides prepared rows by default and returns them only for the explicit all diagnostic", async () => {
        const { owner, session } = await managedSession();
        const recipient = await e2eeAccount();
        await shareWith(session.id, owner.id, recipient.id, "view");
        await applySessionDataKeyEnvelopes({
            actorAccountId: owner.id, sessionId: session.id,
            authentication,
            entries: [{ recipientAccountId: recipient.id, encryptedDataKey: encodeBase64(envelopeFor(recipient.binding.contentPublicKey)) }],
        });
        const working = await readSessionDataKeyEnvelopePage({
            actorAccountId: owner.id, sessionId: session.id,
            authentication,
            query: { state: "action_required", limit: 24 },
        });
        if (!working.ok || working.page.status !== "required") throw new Error("expected a required page");
        expect(working.page.items).toHaveLength(0);
        expect(working.page.summary?.prepared).toBe(2);
        const diagnostic = await readSessionDataKeyEnvelopePage({
            actorAccountId: owner.id, sessionId: session.id,
            authentication,
            query: { state: "all", limit: 24 },
        });
        if (!diagnostic.ok || diagnostic.page.status !== "required") throw new Error("expected a required page");
        expect(diagnostic.page.items.map(item => item.recipientAccountId).sort())
            .toEqual([owner.id, recipient.id].sort());
    });
});
