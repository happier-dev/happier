import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import tweetnacl from "tweetnacl";
import {
    openEncryptedDataKeyEnvelopeV1,
    sealEncryptedDataKeyEnvelopeV1,
    SessionAccessGrantsListResponseV1Schema,
    SessionCurrentProjectionRecordV1Schema,
    V2SessionByIdResponseSchema,
} from "@happier-dev/protocol";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { sessionRoutes } from "./sessionRoutes";

describe("Session access HTTP and initial creation (SQLite integration)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        vi.stubEnv("HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED", "1");
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-access-http-", initAuth: false,
            env: {
                HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1",
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            },
        });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); vi.unstubAllEnvs(); });
    afterEach(async () => {
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(), () => db.userKVStore.deleteMany(),
            () => db.session.deleteMany(), () => db.teamGroupMembership.deleteMany(),
            () => db.teamGroup.deleteMany(), () => db.teamMembership.deleteMany(),
            () => db.team.deleteMany(), () => db.userRelationship.deleteMany(), () => db.account.deleteMany(),
        ]);
    });

    async function fixture() {
        const owner = await db.account.create({ data: { encryptionMode: "plain", publicKey: `owner-${crypto.randomUUID()}` } });
        const recipient = await db.account.create({ data: { encryptionMode: "plain", publicKey: `recipient-${crypto.randomUUID()}` } });
        const team = await db.team.create({ data: { name: "Engineering" } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner.id, role: "owner" },
            { teamId: team.id, accountId: recipient.id, role: "member" },
        ] });
        return { owner, recipient, team };
    }
    const headers = (accountId: string) => ({
        "x-test-user-id": accountId, "x-happier-account-stored-content-protocol": "2",
    });
    const body = (tag: string) => ({
        tag, metadataLayoutVersion: 1,
        sharedMetadata: { ciphertext: JSON.stringify({ v: 1 }) },
        ownerMetadata: { t: "plain", v: { v: 1 } },
        encryptionMode: "plain", dataEncryptionKey: null,
    });

    it("serves serialized owner detail accepted by the current CLI reader schemas", async () => {
        const { owner } = await fixture();
        await withAuthenticatedTestApp(sessionRoutes, async (app) => {
            const created = await app.inject({
                method: "POST", url: "/v1/sessions", headers: headers(owner.id),
                payload: body("cli-current-detail"),
            });
            expect(created.statusCode, created.body).toBe(200);
            const sessionId = created.json().session.id;
            const detail = await app.inject({
                method: "GET", url: `/v2/sessions/${sessionId}?accessProjectionVersion=1`,
                headers: headers(owner.id),
            });
            expect(detail.statusCode, detail.body).toBe(200);
            // These are the exact two schemas used by both CLI detail readers.
            // Real creation, access admission, mapping and serialization stay live.
            const envelope = V2SessionByIdResponseSchema.parse(detail.json());
            expect(SessionCurrentProjectionRecordV1Schema.parse(envelope.session)).toMatchObject({
                id: sessionId, responsibleAccountId: null, responsibleAccount: null,
                effectiveAccess: { level: "owner" },
            });
        });
    });

    it("sets complete desired grants, redacts inspection and removes idempotently through the real routes", async () => {
        const { owner, recipient } = await fixture();
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: "existing", encryptionMode: "plain", metadata: "{}", currentStorageState: "hosted",
        } });
        const grant = { sessionId: session.id, subject: { kind: "account", accountId: recipient.id }, accessLevel: "view", canApprovePermissions: false };
        await withAuthenticatedTestApp(sessionRoutes, async (app) => {
            const first = await app.inject({ method: "POST", url: "/v2/sessions/access-grants/set", headers: headers(owner.id), payload: grant });
            expect(first.statusCode, first.body).toBe(200);
            expect(first.json()).toMatchObject({ changed: true, grant: { subject: grant.subject } });
            const again = await app.inject({ method: "POST", url: "/v2/sessions/access-grants/set", headers: headers(owner.id), payload: grant });
            expect(again.json()).toMatchObject({ changed: false });
            const full = await app.inject({ method: "POST", url: "/v2/sessions/access-grants/list", headers: headers(owner.id), payload: { sessionId: session.id } });
            expect(full.statusCode, full.body).toBe(200);
            expect(SessionAccessGrantsListResponseV1Schema.parse(full.json())).toMatchObject({ visibility: "complete", grants: [{ grant: { subject: grant.subject } }] });
            const own = await app.inject({ method: "POST", url: "/v2/sessions/access-grants/list", headers: headers(recipient.id), payload: { sessionId: session.id } });
            expect(own.statusCode, own.body).toBe(200);
            expect(SessionAccessGrantsListResponseV1Schema.parse(own.json())).toMatchObject({ visibility: "self", grants: [], effectiveAccess: { level: "view" } });
            const denied = await app.inject({ method: "POST", url: "/v2/sessions/access-grants/remove", headers: headers(recipient.id), payload: { sessionId: session.id, subject: grant.subject } });
            expect(denied.statusCode).toBe(403);
            for (const changed of [true, false]) {
                const removed = await app.inject({ method: "POST", url: "/v2/sessions/access-grants/remove", headers: headers(owner.id), payload: { sessionId: session.id, subject: grant.subject } });
                expect(removed.statusCode, removed.body).toBe(200);
                expect(removed.json()).toEqual({ changed, subject: grant.subject });
            }
        });
    });

    it("projects exactly the full writer transitions for every valid stored grant state", async () => {
        const { owner, recipient, team } = await fixture();
        const manager = await db.account.create({
            data: { encryptionMode: "plain", publicKey: `manager-${crypto.randomUUID()}` },
        });
        const editableRecipient = await db.account.create({
            data: { encryptionMode: "plain", publicKey: `editable-${crypto.randomUUID()}` },
        });
        const viewer = await db.account.create({
            data: { encryptionMode: "plain", publicKey: `viewer-${crypto.randomUUID()}` },
        });
        const editor = await db.account.create({
            data: { encryptionMode: "plain", publicKey: `editor-${crypto.randomUUID()}` },
        });
        const administrator = await db.account.create({
            data: { encryptionMode: "plain", publicKey: `administrator-${crypto.randomUUID()}` },
        });
        await db.teamMembership.createMany({
            data: [
                { teamId: team.id, accountId: manager.id, role: "member" },
                { teamId: team.id, accountId: editableRecipient.id, role: "member" },
                { teamId: team.id, accountId: viewer.id, role: "member" },
                { teamId: team.id, accountId: editor.id, role: "member" },
                { teamId: team.id, accountId: administrator.id, role: "member" },
            ],
        });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "delegation-transition-projection",
                encryptionMode: "plain",
                metadata: "{}",
                currentStorageState: "hosted",
            },
        });
        await db.sessionShare.createMany({
            data: [
                {
                    sessionId: session.id,
                    sharedByUserId: owner.id,
                    sharedWithUserId: manager.id,
                    accessLevel: "admin",
                    canApprovePermissions: false,
                },
                {
                    sessionId: session.id,
                    sharedByUserId: owner.id,
                    sharedWithUserId: recipient.id,
                    accessLevel: "admin",
                    canApprovePermissions: true,
                },
                {
                    sessionId: session.id,
                    sharedByUserId: owner.id,
                    sharedWithUserId: editableRecipient.id,
                    accessLevel: "edit",
                    canApprovePermissions: true,
                },
                {
                    sessionId: session.id,
                    sharedByUserId: owner.id,
                    sharedWithUserId: viewer.id,
                    accessLevel: "view",
                    canApprovePermissions: false,
                },
                {
                    sessionId: session.id,
                    sharedByUserId: owner.id,
                    sharedWithUserId: editor.id,
                    accessLevel: "edit",
                    canApprovePermissions: false,
                },
                {
                    sessionId: session.id,
                    sharedByUserId: owner.id,
                    sharedWithUserId: administrator.id,
                    accessLevel: "admin",
                    canApprovePermissions: false,
                },
            ],
        });
        await db.sessionTeamGrant.create({
            data: {
                sessionId: session.id,
                teamId: team.id,
                accessLevel: "admin",
                canApprovePermissions: false,
                effectiveAt: new Date(),
            },
        });

        await withAuthenticatedTestApp(sessionRoutes, async (app) => {
            const response = await app.inject({
                method: "POST",
                url: "/v2/sessions/access-grants/list",
                headers: headers(manager.id),
                payload: { sessionId: session.id },
            });
            expect(response.statusCode, response.body).toBe(200);
            const parsed = SessionAccessGrantsListResponseV1Schema.parse(response.json());
            expect(parsed.visibility).toBe("complete");
            if (parsed.visibility !== "complete") return;
            const byAccountId = new Map(parsed.grants.flatMap((row) =>
                row.grant.subject.kind === "account"
                    ? [[row.grant.subject.accountId, row] as const]
                    : [],
            ));

            const expected = [
                [viewer.id, ["view", "edit", "admin"], false],
                [editor.id, ["view", "edit", "admin"], false],
                [editableRecipient.id, ["view", "edit"], true],
                [administrator.id, ["view", "edit", "admin"], false],
                [recipient.id, ["view", "edit", "admin"], true],
            ] as const;
            for (const [accountId, accessLevels, canChangePermissionDelegation] of expected) {
                expect(byAccountId.get(accountId)?.allowedTransitions, accountId).toEqual({
                    accessLevels,
                    canChangePermissionDelegation,
                    canRemove: true,
                });
            }
            expect(byAccountId.get(manager.id)?.allowedTransitions).toEqual({
                accessLevels: [],
                canChangePermissionDelegation: false,
                canRemove: false,
                reason: "session_access_self_grant_invalid",
            });

            await db.sessionShare.delete({
                where: {
                    sessionId_sharedWithUserId: {
                        sessionId: session.id,
                        sharedWithUserId: manager.id,
                    },
                },
            });
            const absentSelfRemoval = await app.inject({
                method: "POST",
                url: "/v2/sessions/access-grants/remove",
                headers: headers(manager.id),
                payload: {
                    sessionId: session.id,
                    subject: { kind: "account", accountId: manager.id },
                },
            });
            expect(absentSelfRemoval.statusCode, absentSelfRemoval.body).toBe(400);
            expect(absentSelfRemoval.json()).toEqual({
                error: "session_access_self_grant_invalid",
            });
        });
    });

    it("returns Team authentication continuation when direct Edit cannot manage access", async () => {
        const { owner, recipient, team } = await fixture();
        const recipientBinding = createSignedAccountContentBinding();
        await db.account.update({
            where: { id: recipient.id },
            data: {
                encryptionMode: "e2ee",
                publicKey: recipientBinding.publicKey,
                contentPublicKey: Buffer.from(recipientBinding.contentPublicKey),
                contentPublicKeySig: Buffer.from(recipientBinding.contentPublicKeySig),
            },
        });
        const target = await db.account.create({ data: { encryptionMode: "plain", publicKey: `target-${crypto.randomUUID()}` } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: target.id, role: "member" } });
        await db.team.update({
            where: { id: team.id },
            data: { authenticationPolicy: {
                v: 1,
                mode: "restricted",
                accepted: [{ kind: "home_method", methodId: "key_challenge" }],
            } },
        });
        const session = await db.session.create({ data: {
            accountId: owner.id,
            tag: "capability-auth-continuation",
            encryptionMode: "plain",
            metadata: "{}",
            currentStorageState: "hosted",
        } });
        await db.sessionShare.create({ data: {
            sessionId: session.id,
            sharedByUserId: owner.id,
            sharedWithUserId: recipient.id,
            accessLevel: "edit",
        } });
        await db.sessionTeamGrant.create({ data: {
            sessionId: session.id,
            teamId: team.id,
            accessLevel: "admin",
            effectiveAt: new Date(),
        } });
        const payload = {
            sessionId: session.id,
            subject: { kind: "account", accountId: target.id },
            accessLevel: "view",
            canApprovePermissions: false,
        };

        await withAuthenticatedTestApp(sessionRoutes, async (app) => {
            const unqualified = await app.inject({
                method: "POST",
                url: "/v2/sessions/access-grants/set",
                headers: headers(recipient.id),
                payload,
            });
            expect(unqualified.statusCode, unqualified.body).toBe(403);
            expect(unqualified.json()).toEqual({ error: "session_access_authentication_required" });

            vi.stubEnv("HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED", "0");
            const unavailable = await app.inject({
                method: "POST",
                url: "/v2/sessions/access-grants/set",
                headers: headers(recipient.id),
                payload,
            });
            expect(unavailable.statusCode, unavailable.body).toBe(503);
            expect(unavailable.json()).toEqual({ error: "session_access_authentication_unavailable" });

            vi.stubEnv("HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED", "1");
            const qualified = await app.inject({
                method: "POST",
                url: "/v2/sessions/access-grants/set",
                headers: {
                    ...headers(recipient.id),
                    "x-test-authentication-evidence": JSON.stringify([
                        { kind: "home_method", methodId: "key_challenge" },
                    ]),
                },
                payload,
            });
            expect(qualified.statusCode, qualified.body).toBe(200);
            expect(qualified.json()).toMatchObject({ changed: true, grant: { subject: payload.subject } });
        });
    });

    it("returns unavailable when Team-only grant inspection cannot use its accepted authentication method", async () => {
        const { owner, recipient, team } = await fixture();
        await db.team.update({
            where: { id: team.id },
            data: { authenticationPolicy: {
                v: 1,
                mode: "restricted",
                accepted: [{ kind: "home_method", methodId: "key_challenge" }],
            } },
        });
        const session = await db.session.create({ data: {
            accountId: owner.id,
            tag: "grant-inspection-auth-unavailable",
            encryptionMode: "plain",
            metadata: "{}",
            currentStorageState: "hosted",
        } });
        await db.sessionTeamGrant.create({ data: {
            sessionId: session.id,
            teamId: team.id,
            accessLevel: "admin",
            effectiveAt: new Date(),
        } });

        vi.stubEnv("HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED", "0");
        try {
            await withAuthenticatedTestApp(sessionRoutes, async (app) => {
                const response = await app.inject({
                    method: "POST",
                    url: "/v2/sessions/access-grants/list",
                    headers: headers(recipient.id),
                    payload: { sessionId: session.id },
                });
                expect(response.statusCode, response.body).toBe(503);
                expect(response.json()).toEqual({ error: "session_access_authentication_unavailable" });
            });
        } finally {
            vi.stubEnv("HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED", "1");
        }
    });

    it("accepts initial access and Team context on the strict v1 create route", async () => {
        const { owner, team } = await fixture();
        const initialAccess = { grants: [] };
        await withAuthenticatedTestApp(sessionRoutes, async (app) => {
            const created = await app.inject({ method: "POST", url: "/v1/sessions", headers: headers(owner.id), payload: { ...body("atomic"), initialAccess, primaryTeamId: team.id } });
            expect(created.statusCode, created.body).toBe(200);
            expect(await db.session.findFirst({ where: { accountId: owner.id, tag: "atomic" }, select: { primaryTeamId: true } })).toMatchObject({ primaryTeamId: team.id });
        });
    });

    it("serves collaboration wherever Session sharing is enabled; the retired collaboration switch no longer withdraws it", async () => {
        const { owner, team } = await fixture();
        // The server-only `sessions.collaboration` bit is retired: its env switch
        // is not read any more, so setting it cannot close the routes.
        vi.stubEnv("HAPPIER_FEATURE_SESSIONS_COLLABORATION__ENABLED", "0");
        try {
            await withAuthenticatedTestApp(sessionRoutes, async (app) => {
                const created = await app.inject({
                    method: "POST",
                    url: "/v1/sessions",
                    headers: headers(owner.id),
                    payload: {
                        ...body("collaboration-switch-retired"),
                        initialAccess: { grants: [{ subject: { kind: "team", teamId: team.id }, accessLevel: "view", canApprovePermissions: false }] },
                        primaryTeamId: team.id,
                    },
                });
                expect(created.statusCode, created.body).toBe(200);
                const session = await db.session.findUniqueOrThrow({ where: { accountId_tag: { accountId: owner.id, tag: "collaboration-switch-retired" } } });
                const listed = await app.inject({ method: "POST", url: "/v2/sessions/access-grants/list", headers: headers(owner.id), payload: { sessionId: session.id } });
                expect(listed.statusCode, listed.body).toBe(200);
                expect(SessionAccessGrantsListResponseV1Schema.parse(listed.json()).grants.map((row) => row.grant.subject))
                    .toEqual([{ kind: "team", teamId: team.id }]);
            });
        } finally {
            vi.stubEnv("HAPPIER_FEATURE_SESSIONS_COLLABORATION__ENABLED", "");
        }
    });

    it("refuses access-bearing creation and withdraws the grant routes when Session sharing is denied", async () => {
        const { owner, team } = await fixture();
        const session = await db.session.create({ data: { accountId: owner.id, tag: "existing", encryptionMode: "plain", metadata: "{}", currentStorageState: "hosted" } });
        vi.stubEnv("HAPPIER_BUILD_FEATURES_DENY", "sharing.session");
        try {
            await withAuthenticatedTestApp(sessionRoutes, async (app) => {
                const response = await app.inject({
                    method: "POST",
                    url: "/v1/sessions",
                    headers: headers(owner.id),
                    payload: {
                        ...body("sharing-denied"),
                        initialAccess: { grants: [{ subject: { kind: "team", teamId: team.id }, accessLevel: "view", canApprovePermissions: false }] },
                        primaryTeamId: team.id,
                    },
                });
                expect(response.statusCode, response.body).toBe(409);
                // The cause is the Home's own sharing decision, not an older component.
                expect(response.json()).toEqual({ error: "session_access_sharing_unavailable" });
                const listed = await app.inject({ method: "POST", url: "/v2/sessions/access-grants/list", headers: headers(owner.id), payload: { sessionId: session.id } });
                expect(listed.statusCode, listed.body).toBe(404);
            });
            expect(await db.session.findUnique({ where: { accountId_tag: { accountId: owner.id, tag: "sharing-denied" } } })).toBeNull();
        } finally {
            vi.stubEnv("HAPPIER_BUILD_FEATURES_DENY", "");
        }
    });

    it("materializes initial Account and Team grants atomically with fresh creation", async () => {
        const { owner, recipient, team } = await fixture();
        const initialAccess = {
            grants: [
                { subject: { kind: "account", accountId: recipient.id }, accessLevel: "view", canApprovePermissions: false },
                { subject: { kind: "team", teamId: team.id }, accessLevel: "edit", canApprovePermissions: false },
            ],
        } as const;
        await withAuthenticatedTestApp(sessionRoutes, async (app) => {
            const created = await app.inject({ method: "POST", url: "/v1/sessions", headers: headers(owner.id), payload: {
                ...body("atomic-grants"), initialAccess,
            } });
            expect(created.statusCode, created.body).toBe(200);
            const session = await db.session.findUniqueOrThrow({ where: { accountId_tag: { accountId: owner.id, tag: "atomic-grants" } } });
            expect(await db.sessionShare.findUnique({ where: { sessionId_sharedWithUserId: { sessionId: session.id, sharedWithUserId: recipient.id } }, select: { accessLevel: true } }))
                .toEqual({ accessLevel: "view" });
            expect(await db.sessionTeamGrant.findUnique({ where: { sessionId_teamId: { sessionId: session.id, teamId: team.id } }, select: { accessLevel: true } }))
                .toEqual({ accessLevel: "edit" });
            const recipientView = await app.inject({ method: "POST", url: "/v2/sessions/access-grants/list", headers: headers(recipient.id), payload: { sessionId: session.id } });
            expect(recipientView.statusCode, recipientView.body).toBe(200);
            expect(recipientView.json()).toMatchObject({ visibility: "self", effectiveAccess: { level: "edit" } });
        });
    });

    it("commits a ready recipient's openable Session DEK envelope with the fresh Session", async () => {
        const { owner, recipient } = await fixture();
        const recipientKeys = tweetnacl.box.keyPair();
        const recipientBinding = createSignedAccountContentBinding(recipientKeys.publicKey);
        await db.account.update({
            where: { id: recipient.id },
            data: {
                encryptionMode: "e2ee",
                publicKey: recipientBinding.publicKey,
                contentPublicKey: Buffer.from(recipientBinding.contentPublicKey),
                contentPublicKeySig: Buffer.from(recipientBinding.contentPublicKeySig),
            },
        });
        const sessionDataKey = tweetnacl.randomBytes(32);
        const ownerEnvelope = sealEncryptedDataKeyEnvelopeV1({
            dataKey: sessionDataKey,
            recipientPublicKey: tweetnacl.box.keyPair().publicKey,
            randomBytes: length => tweetnacl.randomBytes(length),
        });
        const recipientEnvelope = sealEncryptedDataKeyEnvelopeV1({
            dataKey: sessionDataKey,
            recipientPublicKey: recipientKeys.publicKey,
            randomBytes: length => tweetnacl.randomBytes(length),
        });

        await withAuthenticatedTestApp(sessionRoutes, async (app) => {
            const missingEnvelope = await app.inject({
                method: "POST",
                url: "/v1/sessions",
                headers: headers(owner.id),
                payload: {
                    ...body("atomic-e2ee-missing-envelope"),
                    encryptionMode: "e2ee",
                    dataEncryptionKey: Buffer.from(ownerEnvelope).toString("base64"),
                    initialAccess: {
                        grants: [{
                            subject: { kind: "account", accountId: recipient.id },
                            accessLevel: "view",
                            canApprovePermissions: false,
                        }],
                    },
                },
            });
            expect(missingEnvelope.statusCode, missingEnvelope.body).toBe(400);
            expect(missingEnvelope.json()).toEqual({ error: "recipient_envelope_required" });
            expect(await db.session.findUnique({
                where: {
                    accountId_tag: {
                        accountId: owner.id,
                        tag: "atomic-e2ee-missing-envelope",
                    },
                },
            })).toBeNull();

            const created = await app.inject({
                method: "POST",
                url: "/v1/sessions",
                headers: headers(owner.id),
                payload: {
                    ...body("atomic-e2ee-recipient"),
                    encryptionMode: "e2ee",
                    dataEncryptionKey: Buffer.from(ownerEnvelope).toString("base64"),
                    initialAccess: {
                        grants: [{
                            subject: { kind: "account", accountId: recipient.id },
                            accessLevel: "view",
                            canApprovePermissions: false,
                            accountEnvelopeInput: {
                                v: 1,
                                encryptedDataKey: Buffer.from(recipientEnvelope).toString("base64"),
                            },
                        }],
                    },
                },
            });
            expect(created.statusCode, created.body).toBe(200);
            const session = await db.session.findUniqueOrThrow({
                where: { accountId_tag: { accountId: owner.id, tag: "atomic-e2ee-recipient" } },
            });
            expect(await db.sessionShare.count({
                where: { sessionId: session.id, sharedWithUserId: recipient.id },
            })).toBe(1);
            const storedEnvelope = await db.sessionDataKeyEnvelope.findUniqueOrThrow({
                where: {
                    sessionId_recipientAccountId: {
                        sessionId: session.id,
                        recipientAccountId: recipient.id,
                    },
                },
            });
            expect(openEncryptedDataKeyEnvelopeV1({
                envelope: new Uint8Array(storedEnvelope.encryptedDataKey),
                recipientSecretKeyOrSeed: recipientKeys.secretKey,
            })).toEqual(sessionDataKey);
        });
    });

    it("rejects external initial access with forbidden and leaves no Session when the primary Team disables sharing", async () => {
        const { owner, team } = await fixture();
        const outsider = await db.account.create({
            data: { encryptionMode: "plain", publicKey: `initial-outsider-${crypto.randomUUID()}` },
        });
        await db.userRelationship.create({
            data: { fromUserId: owner.id, toUserId: outsider.id, status: "friend" },
        });
        await db.team.update({
            where: { id: team.id },
            data: { externalSharingPolicy: "disabled" },
        });

        await withAuthenticatedTestApp(sessionRoutes, async (app) => {
            const response = await app.inject({
                method: "POST",
                url: "/v1/sessions",
                headers: headers(owner.id),
                payload: {
                    ...body("external-initial-access-disabled"),
                    primaryTeamId: team.id,
                    initialAccess: {
                        grants: [{
                            subject: { kind: "account", accountId: outsider.id },
                            accessLevel: "view",
                            canApprovePermissions: false,
                        }],
                    },
                },
            });

            expect(response.statusCode, response.body).toBe(403);
            expect(response.json()).toEqual({ error: "session_access_external_sharing_disabled" });
        });
        await expect(db.session.findUnique({
            where: { accountId_tag: { accountId: owner.id, tag: "external-initial-access-disabled" } },
        })).resolves.toBeNull();
    });

    it("returns unavailable for external initial access when the primary Team authentication method is unavailable", async () => {
        const { owner, team } = await fixture();
        const outsider = await db.account.create({
            data: { encryptionMode: "plain", publicKey: `initial-auth-outsider-${crypto.randomUUID()}` },
        });
        await db.userRelationship.create({
            data: { fromUserId: owner.id, toUserId: outsider.id, status: "friend" },
        });
        await db.team.update({
            where: { id: team.id },
            data: {
                externalSharingPolicy: "team_admins_only",
                authenticationPolicy: {
                    v: 1,
                    mode: "restricted",
                    accepted: [{ kind: "home_method", methodId: "key_challenge" }],
                },
            },
        });

        vi.stubEnv("HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED", "0");
        try {
            await withAuthenticatedTestApp(sessionRoutes, async (app) => {
                const response = await app.inject({
                    method: "POST",
                    url: "/v1/sessions",
                    headers: headers(owner.id),
                    payload: {
                        ...body("external-initial-access-auth-unavailable"),
                        primaryTeamId: team.id,
                        initialAccess: {
                            grants: [{
                                subject: { kind: "account", accountId: outsider.id },
                                accessLevel: "view",
                                canApprovePermissions: false,
                            }],
                        },
                    },
                });

                expect(response.statusCode, response.body).toBe(503);
                expect(response.json()).toEqual({ error: "session_access_authentication_unavailable" });
            });
        } finally {
            vi.stubEnv("HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED", "1");
        }
        await expect(db.session.findUnique({
            where: { accountId_tag: { accountId: owner.id, tag: "external-initial-access-auth-unavailable" } },
        })).resolves.toBeNull();
    });

    it("keeps released Team-only list/detail unavailable and resolves them through access projection v1", async () => {
        const { owner, recipient, team } = await fixture();
        await withAuthenticatedTestApp(sessionRoutes, async (app) => {
            const created = await app.inject({ method: "POST", url: "/v1/sessions", headers: headers(owner.id), payload: body("team-by-id") });
            expect(created.statusCode, created.body).toBe(200);
            const session = await db.session.findUniqueOrThrow({ where: { accountId_tag: { accountId: owner.id, tag: "team-by-id" } }, select: { id: true } });
            await db.sessionTeamGrant.create({ data: {
                sessionId: session.id, teamId: team.id, accessLevel: "view", effectiveAt: new Date(1),
            } });
            const releasedDetail = await app.inject({ method: "GET", url: `/v2/sessions/${session.id}`, headers: headers(recipient.id) });
            expect(releasedDetail.statusCode, releasedDetail.body).toBe(404);
            const currentDetail = await app.inject({ method: "GET", url: `/v2/sessions/${session.id}?accessProjectionVersion=1`, headers: headers(recipient.id) });
            expect(currentDetail.statusCode, currentDetail.body).toBe(200);
            expect(currentDetail.json()).toMatchObject({ session: {
                id: session.id,
                effectiveAccess: { v: 1, level: "view", sources: [{ kind: "team", teamId: team.id }] },
            } });

            const releasedList = await app.inject({ method: "GET", url: "/v2/sessions", headers: headers(recipient.id) });
            expect(releasedList.statusCode, releasedList.body).toBe(200);
            expect(releasedList.json()).toMatchObject({ sessions: [] });
            const versionedReleasedList = await app.inject({ method: "GET", url: "/v2/sessions?accessProjectionVersion=1", headers: headers(recipient.id) });
            expect(versionedReleasedList.statusCode, versionedReleasedList.body).toBe(200);
            expect(versionedReleasedList.json()).toMatchObject({ sessions: [] });

            await db.session.update({
                where: { id: session.id },
                data: { active: true, archivedAt: null, lastActiveAt: new Date() },
            });
            const releasedActive = await app.inject({ method: "GET", url: "/v2/sessions/active", headers: headers(recipient.id) });
            expect(releasedActive.statusCode, releasedActive.body).toBe(200);
            expect(releasedActive.json()).toMatchObject({ sessions: [] });
            const versionedReleasedActive = await app.inject({ method: "GET", url: "/v2/sessions/active?accessProjectionVersion=1", headers: headers(recipient.id) });
            expect(versionedReleasedActive.statusCode, versionedReleasedActive.body).toBe(200);
            expect(versionedReleasedActive.json()).toMatchObject({ sessions: [] });

            await db.session.update({
                where: { id: session.id },
                data: { active: false, archivedAt: new Date() },
            });
            const releasedArchived = await app.inject({ method: "GET", url: "/v2/sessions/archived", headers: headers(recipient.id) });
            expect(releasedArchived.statusCode, releasedArchived.body).toBe(200);
            expect(releasedArchived.json()).toMatchObject({ sessions: [] });
            const versionedReleasedArchived = await app.inject({ method: "GET", url: "/v2/sessions/archived?accessProjectionVersion=1", headers: headers(recipient.id) });
            expect(versionedReleasedArchived.statusCode, versionedReleasedArchived.body).toBe(200);
            expect(versionedReleasedArchived.json()).toMatchObject({ sessions: [] });
        });
    });

    it("filters unrepresentable rows before released list pagination while exact detail stays update-scoped", async () => {
        const { owner } = await fixture();
        const createOwned = async (tag: string, activityAt: number, metadataLayoutVersion: 0 | 1) =>
            await db.session.create({ data: {
                accountId: owner.id,
                tag,
                encryptionMode: "plain",
                metadata: metadataLayoutVersion === 1 ? JSON.stringify({ v: 1 }) : "{}",
                metadataLayoutVersion,
                ownerMetadata: metadataLayoutVersion === 1
                    ? JSON.stringify({ t: "plain", v: { v: 1 } })
                    : null,
                currentStorageState: "hosted",
                meaningfulActivityAt: new Date(activityAt),
                updatedAt: new Date(activityAt),
            } });
        const newest = await createOwned("legacy-visible-newest", 4_000, 0);
        const unrepresentable = await createOwned("current-only-interleaved", 3_000, 1);
        const middle = await createOwned("legacy-visible-middle", 2_000, 0);
        const oldest = await createOwned("legacy-visible-oldest", 1_000, 0);
        const legacyHeaders = { "x-test-user-id": owner.id };

        await withAuthenticatedTestApp(sessionRoutes, async (app) => {
            const v1 = await app.inject({
                method: "GET",
                url: "/v1/sessions",
                headers: legacyHeaders,
            });
            expect(v1.statusCode, v1.body).toBe(200);
            expect(v1.json().sessions.map((row: { id: string }) => row.id))
                .toEqual([newest.id, middle.id, oldest.id]);

            const first = await app.inject({
                method: "GET",
                url: "/v2/sessions?limit=2",
                headers: legacyHeaders,
            });
            expect(first.statusCode, first.body).toBe(200);
            expect(first.json().sessions.map((row: { id: string }) => row.id))
                .toEqual([newest.id, middle.id]);
            expect(first.json()).toMatchObject({ hasNext: true, nextCursor: expect.any(String) });

            const second = await app.inject({
                method: "GET",
                url: `/v2/sessions?limit=2&cursor=${encodeURIComponent(first.json().nextCursor)}`,
                headers: legacyHeaders,
            });
            expect(second.statusCode, second.body).toBe(200);
            expect(second.json().sessions.map((row: { id: string }) => row.id))
                .toEqual([oldest.id]);
            expect(second.json()).toMatchObject({ hasNext: false, nextCursor: null });

            await db.session.updateMany({
                where: { id: { in: [newest.id, unrepresentable.id] } },
                data: { active: true, lastActiveAt: new Date() },
            });
            const active = await app.inject({
                method: "GET",
                url: "/v2/sessions/active?limit=2",
                headers: legacyHeaders,
            });
            expect(active.statusCode, active.body).toBe(200);
            expect(active.json().sessions.map((row: { id: string }) => row.id))
                .toEqual([newest.id]);

            await db.session.updateMany({
                where: { id: { in: [newest.id, unrepresentable.id] } },
                data: { active: false, archivedAt: new Date() },
            });
            const archived = await app.inject({
                method: "GET",
                url: "/v2/sessions/archived?limit=2",
                headers: legacyHeaders,
            });
            expect(archived.statusCode, archived.body).toBe(200);
            expect(archived.json().sessions.map((row: { id: string }) => row.id))
                .toEqual([newest.id]);

            const detail = await app.inject({
                method: "GET",
                url: `/v2/sessions/${unrepresentable.id}`,
                headers: legacyHeaders,
            });
            expect(detail.statusCode, detail.body).toBe(426);
            expect(detail.json()).toMatchObject({ error: "client-upgrade-required" });
        });
    });

    it("projects the same stronger overlapping grant in point and relational current reads", async () => {
        const { owner, recipient, team } = await fixture();
        const membership = await db.teamMembership.findUniqueOrThrow({
            where: { teamId_accountId: { teamId: team.id, accountId: recipient.id } },
        });
        const group = await db.teamGroup.create({
            data: { teamId: team.id, name: "Reviewers", nameKey: `reviewers-${crypto.randomUUID()}` },
        });
        await db.teamGroupMembership.create({
            data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id },
        });
        const session = await db.session.create({ data: {
            accountId: owner.id,
            tag: "overlapping-access",
            encryptionMode: "plain",
            metadata: JSON.stringify({ v: 1 }),
            metadataLayoutVersion: 1,
            ownerMetadata: JSON.stringify({ t: "plain", v: { v: 1 } }),
            currentStorageState: "hosted",
        } });
        await db.sessionShare.create({ data: {
            sessionId: session.id,
            sharedByUserId: owner.id,
            sharedWithUserId: recipient.id,
            accessLevel: "view",
        } });
        await db.sessionGroupGrant.create({ data: {
            sessionId: session.id,
            teamGroupId: group.id,
            accessLevel: "edit",
            effectiveAt: new Date(1),
        } });

        await withAuthenticatedTestApp(sessionRoutes, async (app) => {
            const detail = await app.inject({
                method: "GET",
                url: `/v2/sessions/${session.id}?accessProjectionVersion=1`,
                headers: headers(recipient.id),
            });
            expect(detail.statusCode, detail.body).toBe(200);
            expect(detail.json()).toMatchObject({ session: {
                id: session.id,
                share: { accessLevel: "view" },
                effectiveAccess: {
                    v: 1,
                    level: "edit",
                    sources: [{ kind: "group", groupId: group.id, teamId: team.id }],
                },
            } });

            const listed = await app.inject({
                method: "GET",
                url: "/v2/sessions?accessProjectionVersion=1",
                headers: headers(recipient.id),
            });
            expect(listed.statusCode, listed.body).toBe(200);
            expect(listed.json().sessions).toContainEqual(expect.objectContaining({
                id: session.id,
                share: expect.objectContaining({ accessLevel: "view" }),
                effectiveAccess: expect.objectContaining({ v: 1, level: "view" }),
            }));
        });
    });

    it("changes the explicit Team context through the access route without granting access", async () => {
        const { owner, recipient, team } = await fixture();
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: "context", encryptionMode: "plain", metadata: "{}", currentStorageState: "hosted",
        } });
        await withAuthenticatedTestApp(sessionRoutes, async (app) => {
            const first = await app.inject({
                method: "POST", url: "/v2/sessions/access-context/set", headers: headers(owner.id),
                payload: { sessionId: session.id, primaryTeamId: team.id },
            });
            expect(first.statusCode, first.body).toBe(200);
            expect(first.json()).toEqual({ changed: true, primaryTeamId: team.id });
            expect(await db.session.findUnique({ where: { id: session.id }, select: { primaryTeamId: true, teamGrants: true } }))
                .toMatchObject({ primaryTeamId: team.id, teamGrants: [] });

            const again = await app.inject({
                method: "POST", url: "/v2/sessions/access-context/set", headers: headers(owner.id),
                payload: { sessionId: session.id, primaryTeamId: team.id },
            });
            expect(again.statusCode, again.body).toBe(200);
            expect(again.json()).toEqual({ changed: false, primaryTeamId: team.id });

            const denied = await app.inject({
                method: "POST", url: "/v2/sessions/access-context/set", headers: headers(recipient.id),
                payload: { sessionId: session.id, primaryTeamId: null },
            });
            expect(denied.statusCode).toBe(403);

            const cleared = await app.inject({
                method: "POST", url: "/v2/sessions/access-context/set", headers: headers(owner.id),
                payload: { sessionId: session.id, primaryTeamId: null },
            });
            expect(cleared.statusCode, cleared.body).toBe(200);
            expect(cleared.json()).toEqual({ changed: true, primaryTeamId: null });
        });
    });

    it("previews the Team credential selections a grant removal or context move would break", async () => {
        const { owner, recipient, team } = await fixture();
        const other = await db.team.create({ data: { name: "Design" } });
        await db.teamMembership.create({ data: { teamId: other.id, accountId: owner.id, role: "owner" } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: "credential-consequences", encryptionMode: "plain", metadata: "{}",
            currentStorageState: "hosted", primaryTeamId: team.id,
        } });
        await db.sessionTeamGrant.create({ data: {
            sessionId: session.id, teamId: team.id, accessLevel: "view", canApprovePermissions: false,
            effectiveAt: new Date(),
        } });
        const resourceOf = async (input: { teamId: string; displayName: string; sessionUsePolicy: string }) =>
            await db.teamCredentialResource.create({ data: {
                teamId: input.teamId, custodianAccountId: owner.id, displayName: input.displayName,
                disclosureCeiling: "brokered_only", sessionUsePolicy: input.sessionUsePolicy,
                sourceBindingJson: JSON.stringify({ kind: "saved_secret", savedSecretId: "s" }),
            } });
        const bound = await resourceOf({ teamId: team.id, displayName: "Prod deploy key", sessionUsePolicy: "team_visibility_required" });
        const contextual = await resourceOf({ teamId: team.id, displayName: "Prod registry", sessionUsePolicy: "team_context_required" });
        const personal = await resourceOf({ teamId: team.id, displayName: "Personal key", sessionUsePolicy: "personal_allowed" });
        const ungranted = await resourceOf({ teamId: other.id, displayName: "Design key", sessionUsePolicy: "team_visibility_required" });
        let slot = 0;
        for (const resource of [bound, contextual, personal, ungranted]) {
            await db.sessionTeamCredentialBinding.create({ data: {
                sessionId: session.id, slotKind: "agent_provider", slotKey: Buffer.from(`slot-${slot++}`),
                resourceId: resource.id, resourceRevision: resource.revision,
            } });
        }
        await withAuthenticatedTestApp(sessionRoutes, async (app) => {
            const manager = await app.inject({
                method: "POST", url: "/v2/sessions/access-grants/list", headers: headers(owner.id),
                payload: { sessionId: session.id },
            });
            expect(manager.statusCode, manager.body).toBe(200);
            const projection = SessionAccessGrantsListResponseV1Schema.parse(manager.json());
            expect(projection.visibility).toBe("complete");
            expect(projection.visibility === "complete" ? projection.credentialBindingConsequences : undefined)
                .toEqual(expect.arrayContaining([
                    { resourceId: bound.id, teamId: team.id, displayName: "Prod deploy key", policy: "team_visibility_required" },
                    { resourceId: contextual.id, teamId: team.id, displayName: "Prod registry", policy: "team_context_required" },
                ]));
            expect(projection.visibility === "complete" ? projection.credentialBindingConsequences?.length : 0).toBe(2);
            expect(JSON.stringify(projection)).not.toContain(personal.id);
            expect(JSON.stringify(projection)).not.toContain(ungranted.id);

            const viewer = await app.inject({
                method: "POST", url: "/v2/sessions/access-grants/list", headers: headers(recipient.id),
                payload: { sessionId: session.id },
            });
            expect(viewer.statusCode, viewer.body).toBe(200);
            expect(viewer.json()).not.toHaveProperty("credentialBindingConsequences");
        });
    });

    it("returns forbidden when a primary Team disables an external grant increase", async () => {
        const { owner, team } = await fixture();
        const outsider = await db.account.create({
            data: { encryptionMode: "plain", publicKey: `outsider-${crypto.randomUUID()}` },
        });
        await db.userRelationship.create({
            data: { fromUserId: owner.id, toUserId: outsider.id, status: "friend" },
        });
        await db.team.update({
            where: { id: team.id },
            data: { externalSharingPolicy: "disabled" },
        });
        const session = await db.session.create({ data: {
            accountId: owner.id,
            tag: "external-grant-disabled",
            primaryTeamId: team.id,
            encryptionMode: "plain",
            metadata: "{}",
            currentStorageState: "hosted",
        } });

        await withAuthenticatedTestApp(sessionRoutes, async (app) => {
            const response = await app.inject({
                method: "POST",
                url: "/v2/sessions/access-grants/set",
                headers: headers(owner.id),
                payload: {
                    sessionId: session.id,
                    subject: { kind: "account", accountId: outsider.id },
                    accessLevel: "view",
                    canApprovePermissions: false,
                },
            });

            expect(response.statusCode, response.body).toBe(403);
            expect(response.json()).toEqual({ error: "session_access_external_sharing_disabled" });
        });
        await expect(db.sessionShare.findUnique({
            where: {
                sessionId_sharedWithUserId: {
                    sessionId: session.id,
                    sharedWithUserId: outsider.id,
                },
            },
        })).resolves.toBeNull();
    });

    it("returns forbidden when selecting a primary Team would reclassify an existing external audience", async () => {
        const { owner, team } = await fixture();
        const outsider = await db.account.create({
            data: { encryptionMode: "plain", publicKey: `outsider-${crypto.randomUUID()}` },
        });
        await db.team.update({
            where: { id: team.id },
            data: { externalSharingPolicy: "disabled" },
        });
        const session = await db.session.create({ data: {
            accountId: owner.id,
            tag: "external-context-disabled",
            encryptionMode: "plain",
            metadata: "{}",
            currentStorageState: "hosted",
        } });
        await db.sessionShare.create({
            data: {
                sessionId: session.id,
                sharedByUserId: owner.id,
                sharedWithUserId: outsider.id,
                accessLevel: "view",
            },
        });

        await withAuthenticatedTestApp(sessionRoutes, async (app) => {
            const response = await app.inject({
                method: "POST",
                url: "/v2/sessions/access-context/set",
                headers: headers(owner.id),
                payload: { sessionId: session.id, primaryTeamId: team.id },
            });

            expect(response.statusCode, response.body).toBe(403);
            expect(response.json()).toEqual({ error: "session_access_external_sharing_disabled" });
        });
        await expect(db.session.findUnique({
            where: { id: session.id },
            select: { primaryTeamId: true },
        })).resolves.toEqual({ primaryTeamId: null });
    });

    it("atomically applies the required Team Edit floor when selecting a Team that requires one", async () => {
        const { owner, team } = await fixture();
        await db.team.update({ where: { id: team.id }, data: { sessionCreationPolicy: "team_required" } });
        const session = await db.session.create({ data: {
            accountId: owner.id, tag: "required-context", encryptionMode: "plain", metadata: "{}", currentStorageState: "hosted",
        } });
        await withAuthenticatedTestApp(sessionRoutes, async (app) => {
            const response = await app.inject({
                method: "POST", url: "/v2/sessions/access-context/set", headers: headers(owner.id),
                payload: { sessionId: session.id, primaryTeamId: team.id },
            });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toEqual({ changed: true, primaryTeamId: team.id });
            expect(await db.session.findUnique({ where: { id: session.id }, select: { primaryTeamId: true } }))
                .toMatchObject({ primaryTeamId: team.id });
            expect(await db.sessionTeamGrant.findUnique({
                where: { sessionId_teamId: { sessionId: session.id, teamId: team.id } },
                select: { accessLevel: true, canApprovePermissions: true, requiredByTeamPolicy: true },
            })).toMatchObject({ accessLevel: "edit", canApprovePermissions: false, requiredByTeamPolicy: true });

            const accepted = await app.inject({
                method: "POST", url: "/v2/sessions/access-context/set", headers: headers(owner.id),
                payload: { sessionId: session.id, primaryTeamId: team.id },
            });
            expect(accepted.statusCode, accepted.body).toBe(200);
            expect(accepted.json()).toEqual({ changed: false, primaryTeamId: team.id });
            expect(await db.sessionTeamGrant.findUnique({ where: { sessionId_teamId: { sessionId: session.id, teamId: team.id } }, select: { requiredByTeamPolicy: true } }))
                .toMatchObject({ requiredByTeamPolicy: true });

            const blocked = await app.inject({
                method: "POST", url: "/v2/sessions/access-context/set", headers: headers(owner.id),
                payload: { sessionId: session.id, primaryTeamId: null },
            });
            expect(blocked.statusCode, blocked.body).toBe(409);
            expect(blocked.json()).toEqual({ error: "session_access_team_policy_required" });
        });
    });
});
