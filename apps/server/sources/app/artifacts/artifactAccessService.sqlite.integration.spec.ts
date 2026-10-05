import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io";
import * as privacyKit from "privacy-kit";
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, encodePlainArtifactStoredContent, sealEncryptedDataKeyEnvelopeV1 } from "@happier-dev/protocol";
import tweetnacl from "tweetnacl";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { artifactsRoutes } from "@/app/api/routes/artifacts/artifactsRoutes";
import { auth } from "@/app/auth/auth";
import { artifactUpdateHandler } from "@/app/api/socket/artifactUpdateHandler";
import { createFakeSocket, getSocketHandler } from "@/app/api/testkit/socketHarness";
import { deleteArtifact, migrateArtifactAccountEncryptionInTx, updateArtifactTx } from "./artifactWriteService";

describe("Artifact document grants (real SQLite)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-artifact-grants-", initEncrypt: true, initAuth: true,
            env: { HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST: "server_sealed" } });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    async function plainAccount() {
        return db.account.create({ data: { encryptionMode: "plain" } });
    }

    async function plainArtifact(ownerAccountId: string) {
        const id = crypto.randomUUID();
        return db.artifact.create({ data: {
            id, accountId: ownerAccountId,
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: "workflow-definition.v1" })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ value: "original" })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
            headerVersion: 1, bodyVersion: 1,
        } });
    }

    const protocolHeaders = { "x-happier-account-stored-content-protocol": String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION) };

    it.each(["account", "team", "group"] as const)("reports committed %s self-revocation without disclosing the remaining grants", async kind => {
        const owner = await db.account.create({ data: { encryptionMode: "e2ee", ...createSignedAccountContentBinding() } });
        const admin = await db.account.create({ data: { encryptionMode: "e2ee", ...createSignedAccountContentBinding() } });
        const remaining = await db.account.create({ data: { encryptionMode: "e2ee", ...createSignedAccountContentBinding() } });
        const dataKey = tweetnacl.randomBytes(32);
        const wrap = (publicKey: Uint8Array) => new Uint8Array(sealEncryptedDataKeyEnvelopeV1({
            dataKey, recipientPublicKey: publicKey, randomBytes: tweetnacl.randomBytes,
        }));
        const artifact = await db.artifact.create({ data: {
            id: crypto.randomUUID(), accountId: owner.id, header: new Uint8Array([1]), body: new Uint8Array([2]),
            dataEncryptionKey: wrap(owner.contentPublicKey!), headerVersion: 1, bodyVersion: 1,
        } });
        await db.artifactAccountGrant.create({ data: { artifactId: artifact.id, accountId: remaining.id,
            accessLevel: "view", createdByAccountId: owner.id } });
        const team = await db.team.create({ data: { name: "Self-revocation team" } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: admin.id, role: "member" } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: "Administrators", nameKey: crypto.randomUUID() } });
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id,
            nativeContribution: true } });
        const principal = kind === "account" ? { kind, accountId: admin.id }
            : kind === "team" ? { kind, teamId: team.id } : { kind, teamId: team.id, groupId: group.id };
        const { readArtifactRecipientCensusInTx, resolveArtifactAccessInTx, setArtifactAccessGrantInTx } = await import("./artifactAccessService");
        expect(await inTx(tx => setArtifactAccessGrantInTx(tx, {
            actorAccountId: owner.id, artifactId: artifact.id, principal, accessLevel: "admin",
        }))).toMatchObject({ ok: true });
        const census = await inTx(tx => readArtifactRecipientCensusInTx(tx, { actorAccountId: owner.id, artifactId: artifact.id }));
        if (!census.ok) throw new Error(census.error);
        for (const recipient of [admin, remaining]) {
            const fingerprint = census.value.recipients.find(row => row.recipientAccountId === recipient.id)!.contentPublicKeyFingerprint!;
            await db.artifactKeyEnvelope.create({ data: { artifactId: artifact.id, recipientAccountId: recipient.id,
                encryptedDataKey: wrap(recipient.contentPublicKey!), recipientContentPublicKeyFingerprint: fingerprint } });
        }
        await withAuthenticatedTestApp(app => artifactsRoutes(app), async app => {
            const grantsUrl = `/v1/artifacts/${artifact.id}/access/grants`;
            const revoked = await app.inject({ method: "DELETE", url: grantsUrl, headers: { "x-test-user-id": admin.id },
                payload: { artifactId: artifact.id, principal } });
            expect(await inTx(tx => resolveArtifactAccessInTx(tx, { actorAccountId: admin.id, artifactId: artifact.id }))).toBeNull();
            expect(await db.artifactKeyEnvelope.findMany({ where: { artifactId: artifact.id }, select: { recipientAccountId: true } }))
                .toEqual([{ recipientAccountId: remaining.id }]);
            expect(revoked.statusCode).toBe(200);
            expect(revoked.json()).toEqual({ artifactId: artifact.id, ownerAccountId: owner.id, access: null, grants: [], changed: true });
            for (const url of [grantsUrl, `/v1/artifacts/${artifact.id}`, `/v1/artifacts/${artifact.id}/access/recipients`]) {
                expect((await app.inject({ method: "GET", url, headers: { "x-test-user-id": admin.id } })).statusCode).toBe(404);
            }
            const ownerList = await app.inject({ method: "GET", url: grantsUrl, headers: { "x-test-user-id": owner.id } });
            expect(ownerList.json()).toMatchObject({ access: "owner", grants: [
                { principal: { kind: "account", accountId: remaining.id }, accessLevel: "view" },
            ] });
        });
    });

    it("projects remaining Team access after self-revocation and refuses further grant writes", async () => {
        const owner = await plainAccount();
        const admin = await plainAccount();
        const artifact = await plainArtifact(owner.id);
        const team = await db.team.create({ data: { name: "Remaining access" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: admin.id, role: "member" } });
        await db.artifactTeamGrant.create({ data: { artifactId: artifact.id, teamId: team.id,
            accessLevel: "view", createdByAccountId: owner.id } });
        await db.artifactAccountGrant.create({ data: { artifactId: artifact.id, accountId: admin.id,
            accessLevel: "admin", createdByAccountId: owner.id } });
        await withAuthenticatedTestApp(app => artifactsRoutes(app), async app => {
            const grantsUrl = `/v1/artifacts/${artifact.id}/access/grants`;
            const payload = { artifactId: artifact.id, principal: { kind: "account", accountId: admin.id } };
            const removed = await app.inject({ method: "DELETE", url: grantsUrl,
                headers: { "x-test-user-id": admin.id }, payload });
            expect(removed.statusCode).toBe(200);
            expect(removed.json()).toMatchObject({ access: "view", changed: true, grants: [
                { principal: { kind: "team", teamId: team.id }, accessLevel: "view" },
            ] });
            expect((await app.inject({ method: "DELETE", url: grantsUrl,
                headers: { "x-test-user-id": admin.id }, payload })).statusCode).toBe(403);
            const repeated = await app.inject({ method: "DELETE", url: grantsUrl,
                headers: { "x-test-user-id": owner.id }, payload });
            expect(repeated.statusCode).toBe(200);
            expect(repeated.json()).toMatchObject({ access: "owner", changed: false });
        });
    });

    it("rotates a shared Artifact key and retains only prepared recipients with live access and current keys", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "e2ee", ...createSignedAccountContentBinding() } });
        const recipients = await Promise.all([0, 1, 2].map(() => db.account.create({
            data: { encryptionMode: "e2ee", ...createSignedAccountContentBinding() },
        })));
        const oldKey = tweetnacl.randomBytes(32);
        const replacementKey = tweetnacl.randomBytes(32);
        const wrap = (key: Uint8Array, publicKey: Uint8Array) => Buffer.from(sealEncryptedDataKeyEnvelopeV1({
            dataKey: key, recipientPublicKey: publicKey, randomBytes: tweetnacl.randomBytes,
        })).toString('base64');
        const sourceOwnerEnvelope = wrap(oldKey, owner.contentPublicKey!);
        const artifact = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            header: new Uint8Array([1, 2, 3]), body: new Uint8Array([4, 5, 6]),
            dataEncryptionKey: Buffer.from(sourceOwnerEnvelope, 'base64'), headerVersion: 1, bodyVersion: 1,
        } });
        for (const recipient of recipients) {
            await db.artifactAccountGrant.create({ data: { artifactId: artifact.id, accountId: recipient.id,
                accessLevel: "view", createdByAccountId: owner.id } });
        }
        const { readArtifactRecipientCensusInTx } = await import("./artifactAccessService");
        const census = await inTx(tx => readArtifactRecipientCensusInTx(tx, { actorAccountId: owner.id, artifactId: artifact.id }));
        if (!census.ok) throw new Error(census.error);
        const prepared = recipients.map(recipient => ({ recipientAccountId: recipient.id,
            recipientContentPublicKeyFingerprint: census.value.recipients.find(row => row.recipientAccountId === recipient.id)!.contentPublicKeyFingerprint!,
            encryptedDataKey: wrap(replacementKey, recipient.contentPublicKey!),
        }));
        for (const envelope of prepared) {
            await db.artifactKeyEnvelope.create({ data: { artifactId: artifact.id, recipientAccountId: envelope.recipientAccountId,
                encryptedDataKey: privacyKit.decodeBase64(wrap(oldKey, recipients.find(row => row.id === envelope.recipientAccountId)!.contentPublicKey!)),
                recipientContentPublicKeyFingerprint: envelope.recipientContentPublicKeyFingerprint } });
        }
        await db.account.update({ where: { id: recipients[1]!.id }, data: createSignedAccountContentBinding() });
        await db.artifactAccountGrant.deleteMany({ where: { artifactId: artifact.id, accountId: recipients[2]!.id } });
        const directive = { action: "migrate" as const, items: [{ artifactId: artifact.id,
            expectedHeaderVersion: 1, expectedBodyVersion: 1,
            expectedDataEncryptionKey: sourceOwnerEnvelope,
            header: privacyKit.encodeBase64(new Uint8Array([7, 8, 9])), body: privacyKit.encodeBase64(new Uint8Array([10, 11, 12])),
            dataEncryptionKey: wrap(replacementKey, owner.contentPublicKey!), recipientKeyEnvelopes: prepared, revisions: [], blobs: [],
        }] };
        expect(await inTx(tx => migrateArtifactAccountEncryptionInTx({ tx, accountId: owner.id, fromMode: "e2ee", toMode: "e2ee",
            directive: { ...directive, items: [{ ...directive.items[0]!, expectedDataEncryptionKey: wrap(oldKey, owner.contentPublicKey!) }] } })))
            .toEqual({ status: "migration_incomplete" });
        const invalidEnvelope = Buffer.from(prepared[0]!.encryptedDataKey, 'base64');
        invalidEnvelope[0] = 255; // An unsupported format, not a well-sized legacy V0 envelope.
        expect(await inTx(tx => migrateArtifactAccountEncryptionInTx({ tx, accountId: owner.id, fromMode: "e2ee", toMode: "e2ee",
            directive: { ...directive, items: [{ ...directive.items[0]!, recipientKeyEnvelopes: [{ ...prepared[0]!,
                encryptedDataKey: invalidEnvelope.toString('base64') }] }] } })))
            .toEqual({ status: "invalid_content" });
        expect(await inTx(tx => migrateArtifactAccountEncryptionInTx({ tx, accountId: owner.id, fromMode: "e2ee", toMode: "e2ee", directive })))
            .toEqual({ status: "applied" });
        const envelopes = await db.artifactKeyEnvelope.findMany({ where: { artifactId: artifact.id } });
        expect(envelopes.map(row => row.recipientAccountId)).toEqual([recipients[0]!.id]);
        expect(privacyKit.encodeBase64(new Uint8Array(envelopes[0]!.encryptedDataKey))).toBe(prepared[0]!.encryptedDataKey);
        expect(await db.accountChange.count({ where: { accountId: recipients[1]!.id, kind: 'artifact', entityId: artifact.id } })).toBe(1);
        expect(await db.accountChange.count({ where: { accountId: recipients[2]!.id, kind: 'artifact', entityId: artifact.id } })).toBe(0);
        expect(await inTx(tx => migrateArtifactAccountEncryptionInTx({ tx, accountId: owner.id, fromMode: "e2ee", toMode: "plain", directive: {
            action: "migrate", items: [{ artifactId: artifact.id, expectedHeaderVersion: 2, expectedBodyVersion: 2,
                expectedDataEncryptionKey: directive.items[0]!.dataEncryptionKey,
                header: encodePlainArtifactStoredContent({ title: 'Shared' }), body: encodePlainArtifactStoredContent({ body: 'Content' }),
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, recipientKeyEnvelopes: [], revisions: [], blobs: [] }],
        } }))).toEqual({ status: "applied" });
        expect(await db.artifactKeyEnvelope.count({ where: { artifactId: artifact.id } })).toBe(0);
    });

    it("socket reads and writes resolve the same live grants as HTTP", async () => {
        const owner = await plainAccount();
        const editor = await plainAccount();
        const artifact = await plainArtifact(owner.id);
        await db.artifactAccountGrant.create({ data: { artifactId: artifact.id, accountId: editor.id,
            accessLevel: "edit", createdByAccountId: owner.id } });
        const token = await auth.createToken(editor.id, undefined, { kind: "account", authority: "present_user" });
        const socket = Object.assign(createFakeSocket({ data: {
            clientType: "user-scoped", accountStoredContentCompatibility: {
                supportsCurrentProtocol: true, outcome: "accepted", declaration: null, upgradeRequired: null,
            },
        } }), { handshake: { auth: { token } }, disconnect: vi.fn() });
        artifactUpdateHandler(editor.id, socket as unknown as Socket);
        const read = vi.fn();
        await getSocketHandler(socket, "artifact-read")({ artifactId: artifact.id }, read);
        expect(read).toHaveBeenCalledWith(expect.objectContaining({ result: "success", artifact: expect.objectContaining({
            ownerAccountId: owner.id, access: "edit", header: privacyKit.encodeBase64(artifact.header),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        }) }));
        const write = vi.fn();
        await getSocketHandler(socket, "artifact-update")({ artifactId: artifact.id, body: {
            data: encodePlainArtifactStoredContent({ value: "socket edit" }), expectedVersion: 1,
        } }, write);
        expect(write).toHaveBeenCalledWith(expect.objectContaining({ result: "success", body: { version: 2,
            data: encodePlainArtifactStoredContent({ value: "socket edit" }) } }));
        await db.artifactAccountGrant.deleteMany({ where: { artifactId: artifact.id, accountId: editor.id } });
        const revoked = vi.fn();
        await getSocketHandler(socket, "artifact-read")({ artifactId: artifact.id }, revoked);
        expect(revoked).toHaveBeenCalledWith({ result: "error", message: "Artifact not found" });
    });

    it("owner and admin grant routes expose shared plain headers and revoke reads without key material", async () => {
        const owner = await plainAccount();
        const admin = await plainAccount();
        const outsider = await plainAccount();
        const artifact = await plainArtifact(owner.id);
        await withAuthenticatedTestApp(app => artifactsRoutes(app), async app => {
            const grantsUrl = `/v1/artifacts/${artifact.id}/access/grants`;
            const set = await app.inject({ method: "PUT", url: grantsUrl, headers: { "x-test-user-id": owner.id },
                payload: { artifactId: artifact.id, principal: { kind: "account", accountId: admin.id }, accessLevel: "admin" } });
            expect(set.statusCode).toBe(200);
            expect(set.json()).toMatchObject({ access: "owner", changed: true });
            const list = await app.inject({ method: "GET", url: grantsUrl, headers: { "x-test-user-id": admin.id } });
            expect(list.statusCode).toBe(200);
            expect(list.json()).toMatchObject({ ownerAccountId: owner.id, access: "admin", grants: [
                { principal: { kind: "account", accountId: admin.id }, accessLevel: "admin", display: { name: null, username: null } },
            ] });
            const delegated = await app.inject({ method: "PUT", url: grantsUrl, headers: { "x-test-user-id": admin.id },
                payload: { artifactId: artifact.id, principal: { kind: "account", accountId: outsider.id }, accessLevel: "view" } });
            expect(delegated.statusCode).toBe(200);
            const refused = await app.inject({ method: "PUT", url: grantsUrl, headers: { "x-test-user-id": admin.id },
                payload: { artifactId: artifact.id, principal: { kind: "account", accountId: outsider.id }, accessLevel: "admin" } });
            expect(refused.statusCode).toBe(403);
            const removed = await app.inject({ method: "DELETE", url: grantsUrl, headers: { "x-test-user-id": admin.id },
                payload: { artifactId: artifact.id, principal: { kind: "account", accountId: outsider.id } } });
            expect(removed.statusCode).toBe(200);
            const read = await app.inject({ method: "GET", url: `/v1/artifacts/${artifact.id}`,
                headers: { "x-test-user-id": admin.id, ...protocolHeaders } });
            expect(read.statusCode).toBe(200);
            expect(read.json()).toMatchObject({ ownerAccountId: owner.id, access: "admin", encryptionMode: "plain",
                header: privacyKit.encodeBase64(artifact.header), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER });
            const shared = await app.inject({ method: "GET", url: "/v1/artifacts",
                headers: { "x-test-user-id": admin.id, ...protocolHeaders } });
            expect(shared.statusCode).toBe(200);
            expect(shared.json()).toMatchObject([{ id: artifact.id, ownerAccountId: owner.id, access: "admin" }]);
            const absent = await app.inject({ method: "GET", url: grantsUrl, headers: { "x-test-user-id": outsider.id } });
            expect(absent.statusCode).toBe(404);
            const keyless = await app.inject({ method: "POST", url: `/v1/artifacts/${artifact.id}/access/key-envelopes`,
                headers: { "x-test-user-id": owner.id }, payload: { artifactId: artifact.id,
                    expectedDataEncryptionKey: privacyKit.encodeBase64(new Uint8Array(105)), recipientKeyEnvelopes: [] } });
            expect(keyless.statusCode).toBe(400);
            expect(keyless.json()).toEqual({ error: "data_key_not_required" });
            const revoked = await app.inject({ method: "DELETE", url: grantsUrl, headers: { "x-test-user-id": owner.id },
                payload: { artifactId: artifact.id, principal: { kind: "account", accountId: admin.id } } });
            expect(revoked.statusCode).toBe(200);
            expect((await app.inject({ method: "GET", url: `/v1/artifacts/${artifact.id}`,
                headers: { "x-test-user-id": admin.id, ...protocolHeaders } })).statusCode).toBe(404);
        });
        expect(await db.artifactKeyEnvelope.count({ where: { artifactId: artifact.id } })).toBe(0);
    });

    it("Team and Group grants use live membership and highest access, including removal and archival", async () => {
        const owner = await plainAccount();
        const member = await plainAccount();
        const team = await db.team.create({ data: { name: "Document team" } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: member.id, role: "member" } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: "Editors", nameKey: crypto.randomUUID() } });
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id,
            nativeContribution: true } });
        const artifact = await plainArtifact(owner.id);
        await withAuthenticatedTestApp(app => artifactsRoutes(app), async app => {
            const grantsUrl = `/v1/artifacts/${artifact.id}/access/grants`;
            for (const grant of [
                { principal: { kind: "team", teamId: team.id }, accessLevel: "view" },
                { principal: { kind: "group", teamId: team.id, groupId: group.id }, accessLevel: "edit" },
            ]) {
                const set = await app.inject({ method: "PUT", url: grantsUrl, headers: { "x-test-user-id": owner.id },
                    payload: { artifactId: artifact.id, ...grant } });
                expect(set.statusCode).toBe(200);
            }
            const read = () => app.inject({ method: "GET", url: `/v1/artifacts/${artifact.id}`,
                headers: { "x-test-user-id": member.id, ...protocolHeaders } });
            expect((await read()).json()).toMatchObject({ access: "edit" });
            await db.teamGroup.update({ where: { id: group.id }, data: { archivedAt: new Date() } });
            expect((await read()).json()).toMatchObject({ access: "view" });
            await db.teamMembership.update({ where: { id: membership.id }, data: { status: "suspended" } });
            expect((await read()).statusCode).toBe(404);
            await db.teamMembership.update({ where: { id: membership.id }, data: { status: "active" } });
            expect((await read()).json()).toMatchObject({ access: "view" });
            await db.team.update({ where: { id: team.id }, data: { archivedAt: new Date() } });
            expect((await read()).statusCode).toBe(404);
        });
    });

    it("recipient preparation rechecks keys and memberships and never projects the owner's envelope to a grantee", async () => {
        const owner = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" } });
        const editor = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" } });
        const late = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" } });
        const plain = await plainAccount();
        const team = await db.team.create({ data: { name: "Encrypted documents" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: editor.id, role: "member" } });
        const dataKey = tweetnacl.randomBytes(32);
        const ownerKey = new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: owner.contentPublicKey!, randomBytes: tweetnacl.randomBytes }));
        const artifact = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            header: new TextEncoder().encode("opaque header"), body: new TextEncoder().encode("opaque body"), dataEncryptionKey: ownerKey,
            headerVersion: 1, bodyVersion: 1 } });
        await db.artifactTeamGrant.create({ data: { artifactId: artifact.id, teamId: team.id, accessLevel: "edit", createdByAccountId: owner.id } });
        await db.artifactAccountGrant.create({ data: { artifactId: artifact.id, accountId: plain.id, accessLevel: "view", createdByAccountId: owner.id } });
        await withAuthenticatedTestApp(app => artifactsRoutes(app), async app => {
            const headers = { "x-test-user-id": owner.id };
            const censusUrl = `/v1/artifacts/${artifact.id}/access/recipients`;
            const commitUrl = `/v1/artifacts/${artifact.id}/access/key-envelopes`;
            const census = () => app.inject({ method: "GET", url: censusUrl, headers });
            const before = (await census()).json();
            expect(before.recipients).toContainEqual(expect.objectContaining({ recipientAccountId: plain.id,
                contentKey: { status: "unavailable", reason: "plain_account" } }));
            const editorRow = before.recipients.find((row: { recipientAccountId: string }) => row.recipientAccountId === editor.id);
            const editorKey = privacyKit.encodeBase64(new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey,
                recipientPublicKey: editor.contentPublicKey!, randomBytes: tweetnacl.randomBytes })));
            const commit = await app.inject({ method: "POST", url: commitUrl, headers, payload: { artifactId: artifact.id,
                expectedDataEncryptionKey: privacyKit.encodeBase64(ownerKey), recipientKeyEnvelopes: [{ recipientAccountId: editor.id,
                    encryptedDataKey: editorKey, recipientContentPublicKeyFingerprint: editorRow.contentPublicKeyFingerprint }] } });
            expect(commit.statusCode).toBe(200);
            expect(commit.json()).toEqual({ appliedRecipientAccountIds: [editor.id], skippedRecipientAccountIds: [] });
            const opened = await app.inject({ method: "GET", url: `/v1/artifacts/${artifact.id}`, headers: { "x-test-user-id": editor.id } });
            expect(opened.json()).toMatchObject({ dataEncryptionKey: editorKey, ownerAccountId: owner.id, access: "edit" });
            const editedCiphertext = new TextEncoder().encode("opaque edited body");
            expect(await inTx(tx => updateArtifactTx(tx, { actorUserId: editor.id, artifactId: artifact.id,
                body: { bytes: editedCiphertext, expectedVersion: 1 } })))
                .toMatchObject({ ok: true, body: { version: 2 } });
            expect((await db.artifact.findUniqueOrThrow({ where: { id: artifact.id } })).body)
                .toEqual(editedCiphertext);
            expect((await app.inject({ method: "GET", url: `/v1/artifacts/${artifact.id}`, headers: { "x-test-user-id": plain.id } })).statusCode).toBe(409);
            const lateMembership = await db.teamMembership.create({ data: { teamId: team.id, accountId: late.id, role: "member" } });
            const editorCensus = await app.inject({ method: "GET", url: censusUrl, headers: { "x-test-user-id": editor.id } });
            expect(editorCensus.statusCode).toBe(200);
            const lateRow = editorCensus.json().recipients.find((row: { recipientAccountId: string }) => row.recipientAccountId === late.id);
            expect(lateRow.encryptedDataKey).toBeNull();
            await db.teamMembership.delete({ where: { id: lateMembership.id } });
            const lateEnvelope = privacyKit.encodeBase64(new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey,
                recipientPublicKey: late.contentPublicKey!, randomBytes: tweetnacl.randomBytes })));
            const removed = await app.inject({ method: "POST", url: commitUrl, headers: { "x-test-user-id": editor.id }, payload: {
                artifactId: artifact.id, expectedDataEncryptionKey: privacyKit.encodeBase64(ownerKey), recipientKeyEnvelopes: [{
                    recipientAccountId: late.id, encryptedDataKey: lateEnvelope, recipientContentPublicKeyFingerprint: lateRow.contentPublicKeyFingerprint,
                }],
            } });
            expect(removed.json()).toEqual({ appliedRecipientAccountIds: [], skippedRecipientAccountIds: [late.id] });
            expect(await db.artifactKeyEnvelope.count({ where: { artifactId: artifact.id, recipientAccountId: late.id } })).toBe(0);
            await db.account.update({ where: { id: editor.id }, data: { ...createSignedAccountContentBinding() } });
            expect((await app.inject({ method: "GET", url: `/v1/artifacts/${artifact.id}`, headers: { "x-test-user-id": editor.id } })).statusCode).toBe(409);
            expect(await inTx(tx => updateArtifactTx(tx, { actorUserId: editor.id, artifactId: artifact.id,
                body: { bytes: editedCiphertext, expectedVersion: 2 } })))
                .toMatchObject({ ok: false, error: "not-found" });
            const transition = await inTx(async tx => migrateArtifactAccountEncryptionInTx({
                tx, accountId: owner.id, fromMode: "e2ee", toMode: "plain", directive: { action: "migrate", items: [{
                    artifactId: artifact.id, expectedHeaderVersion: 1, expectedBodyVersion: 2,
                    expectedDataEncryptionKey: privacyKit.encodeBase64(ownerKey), recipientKeyEnvelopes: [],
                    header: encodePlainArtifactStoredContent({ kind: "workflow-definition.v1" }),
                    body: encodePlainArtifactStoredContent({ value: "plain replacement" }),
                    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                    blobs: [],
                    revisions: (await tx.artifactRevision.findMany({ where: { artifactId: artifact.id } })).map(revision => ({
                        bodyVersion: revision.bodyVersion, expectedBody: privacyKit.encodeBase64(new Uint8Array(revision.body)),
                        body: encodePlainArtifactStoredContent({ body: "Retained content" }),
                    })),
                }] },
            }));
            expect(transition).toEqual({ status: "applied" });
            expect(await db.artifactKeyEnvelope.count({ where: { artifactId: artifact.id } })).toBe(0);
        });
    });

    it("an editor CAS uses the owner's plain storage path and notifies every current recipient", async () => {
        const owner = await plainAccount();
        const editor = await plainAccount();
        const viewer = await plainAccount();
        const artifact = await plainArtifact(owner.id);
        await db.artifactAccountGrant.createMany({ data: [
            { artifactId: artifact.id, accountId: editor.id, accessLevel: "edit", createdByAccountId: owner.id },
            { artifactId: artifact.id, accountId: viewer.id, accessLevel: "view", createdByAccountId: owner.id },
        ] });
        const body = privacyKit.decodeBase64(encodePlainArtifactStoredContent({ value: "edited" }));
        const write = await inTx(tx => updateArtifactTx(tx, {
            actorUserId: editor.id, artifactId: artifact.id, body: { bytes: body, expectedVersion: 1 },
        }));
        expect(write).toMatchObject({ ok: true, body: { version: 2 } });
        expect((await db.artifact.findUniqueOrThrow({ where: { id: artifact.id } })).body).not.toEqual(body);
        const notices = await db.accountChange.findMany({ where: { artifactId: artifact.id }, select: { accountId: true } });
        expect(notices.map(row => row.accountId).sort()).toEqual([owner.id, editor.id, viewer.id].sort());
        await expect(inTx(tx => updateArtifactTx(tx, {
            actorUserId: editor.id, artifactId: artifact.id, body: { bytes: body, expectedVersion: 1 },
        }))).resolves.toMatchObject({ ok: false, error: "version-mismatch", current: { bodyVersion: 2, body } });
        await expect(inTx(tx => updateArtifactTx(tx, {
            actorUserId: viewer.id, artifactId: artifact.id, body: { bytes: body, expectedVersion: 2 },
        }))).resolves.toMatchObject({ ok: false, error: "not-found" });
        await expect(deleteArtifact({ actorUserId: editor.id, artifactId: artifact.id }))
            .resolves.toMatchObject({ ok: false, error: "not-found" });
        expect(await db.artifact.count({ where: { id: artifact.id } })).toBe(1);
        const beforeDelete = await db.accountChange.findMany({ where: { entityId: artifact.id },
            select: { accountId: true, cursor: true } });
        await expect(deleteArtifact({ actorUserId: owner.id, artifactId: artifact.id,
            expectedRevision: { headerVersion: 1, bodyVersion: 1 } }))
            .resolves.toMatchObject({ ok: false, error: "version-mismatch" });
        expect(await db.accountChange.findMany({ where: { entityId: artifact.id },
            select: { accountId: true, cursor: true } })).toEqual(beforeDelete);
        await expect(deleteArtifact({ actorUserId: owner.id, artifactId: artifact.id }))
            .resolves.toMatchObject({ ok: true });
        const deletedNotices = await db.accountChange.findMany({ where: { entityId: artifact.id },
            select: { accountId: true, cursor: true } });
        expect(deletedNotices.map(row => row.accountId).sort()).toEqual([owner.id, editor.id, viewer.id].sort());
        for (const notice of deletedNotices) {
            expect(notice.cursor).toBeGreaterThan(beforeDelete.find(row => row.accountId === notice.accountId)!.cursor);
        }
    });
});
