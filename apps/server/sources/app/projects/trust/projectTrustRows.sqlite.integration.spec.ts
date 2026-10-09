import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sealAccountScopedBlobCiphertext } from "@happier-dev/protocol/crypto/accountScopedCipher";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";

import type { Fastify } from "@/app/api/types";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { classifyAccountScopedKvKey } from "@/app/kv/accountScopedKv";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

async function createTestApp() {
    const { accountRoutes } = await import("@/app/api/routes/account/accountRoutes");
    const app = createAuthenticatedTestApp() as Fastify;
    accountRoutes(app);
    return app;
}

describe("Project Trust reserved Account rows", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: "happier-project-trust-" }); }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it("identifies a persisted trust row by qualified Project IDs rather than as an unknown reserved domain", async () => {
        const account = await db.account.create({ data: { id: randomUUID(), encryptionMode: "plain" } });
        const project = { serverId: "home", projectId: randomUUID() };
        const key = `@happier/account/project-trust/v1/home/${project.projectId}`;
        const row = await db.userKVStore.create({ data: { accountId: account.id, key, version: 0,
            value: new TextEncoder().encode(JSON.stringify({ t: "plain", v: { project, reviewedEffectDigest: "effect", approvedAtMs: 1 } })),
        } });
        expect(classifyAccountScopedKvKey(row.key)).toEqual({ kind: "accountProjectTrust", project });
    });

    it("replaces one approving Account's Project grant, isolates Projects and Accounts, and revokes through CAS without settings writes", async () => {
        const requester = await db.account.create({ data: { id: randomUUID(), encryptionMode: "plain" } });
        const custodian = await db.account.create({ data: { id: randomUUID(), encryptionMode: "plain" } });
        const project = { serverId: "home", projectId: randomUUID() };
        const otherProject = { ...project, projectId: randomUUID() };
        const value = { project, reviewedEffectDigest: "effect-one", approvedAtMs: 1 };
        const app = await createTestApp();
        try {
            const headers = { "x-test-user-id": requester.id };
            const mutate = (payload: unknown) => app.inject({ method: "POST", url: "/v1/account/project-trust/mutate", headers, payload: payload as Record<string, unknown> });
            const automatedGrant = await app.inject({ method: "POST", url: "/v1/account/project-trust/mutate",
                headers: { ...headers, "x-test-auth-token-kind": "terminal" },
                payload: { project, expectedRevision: "absent", content: { t: "plain", v: value } },
            });
            expect(automatedGrant.statusCode).toBe(403);
            expect(automatedGrant.json()).toEqual({ error: "present_user_required" });
            expect(await db.userKVStore.count({ where: { accountId: requester.id } })).toBe(0);
            const initial = await mutate({ project, expectedRevision: "absent", content: { t: "plain", v: value } });
            expect(initial.statusCode).toBe(200);
            expect(initial.json()).toMatchObject({ status: "updated", revision: 0 });
            expect((await mutate({ project, expectedRevision: 0, content: { t: "plain", v: { ...value, reviewedEffectDigest: "effect-two", approvedAtMs: 2 } } })).json())
                .toMatchObject({ status: "updated", revision: 1 });
            await mutate({ project: otherProject, expectedRevision: "absent", content: { t: "plain", v: { ...value, project: otherProject } } });
            expect(await db.userKVStore.count({ where: { accountId: requester.id } })).toBe(2);
            expect((await app.inject({ method: "POST", url: "/v1/account/project-trust/read", headers: { "x-test-user-id": custodian.id }, payload: { project } })).json()).toEqual({ status: "absent" });
            const listed = await app.inject({ method: "POST", url: "/v1/account/project-trust/list", headers, payload: { project } });
            expect(listed.json()).toEqual({ rows: [{ project, revision: 1, content: { t: "plain", v: { ...value, reviewedEffectDigest: "effect-two", approvedAtMs: 2 } } }] });
            expect((await mutate({ project, expectedRevision: 0, content: null })).json()).toEqual({ status: "conflict", revision: 1 });
            expect((await app.inject({ method: "POST", url: "/v1/account/project-trust/mutate",
                headers: { ...headers, "x-test-auth-token-kind": "terminal" },
                payload: { project, expectedRevision: 1, content: null },
            })).json()).toMatchObject({ status: "updated", revision: 2 });
            expect((await app.inject({ method: "POST", url: "/v1/account/project-trust/read", headers, payload: { project } })).json()).toEqual({ status: "deleted", revision: 2 });
            const current = await db.account.findUniqueOrThrow({ where: { id: requester.id } });
            expect(current.settingsVersion).toBe(requester.settingsVersion);
            expect(current.settings).toEqual(requester.settings);
            expect(await db.accountSettingsSnapshot.count({ where: { accountId: requester.id } })).toBe(0);
            const changes = await db.accountChange.findMany({ where: { accountId: requester.id } });
            expect(changes).toHaveLength(2);
            expect(changes.find(change => change.hint && JSON.stringify(change.hint).includes(project.projectId))?.hint)
                .toEqual({ projectTrust: true, project, revision: 2 });
        } finally { await app.close(); }
    });

    it("projects additive stored fields, rejects noncanonical writes and binds the plain payload to the qualified row", async () => {
        const account = await db.account.create({ data: { id: randomUUID(), encryptionMode: "plain" } });
        const project = { serverId: "home", projectId: randomUUID() };
        const value = { project, reviewedEffectDigest: "effect", approvedAtMs: 1 };
        const key = `@happier/account/project-trust/v1/home/${project.projectId}`;
        const bytes = new TextEncoder().encode(JSON.stringify({ t: "plain", v: { ...value, project: { ...project, futureId: true }, futureValue: true }, futureEnvelope: true }));
        await db.userKVStore.create({ data: { accountId: account.id, key, version: 4, value: bytes } });
        const app = await createTestApp();
        try {
            const headers = { "x-test-user-id": account.id };
            expect((await app.inject({ method: "POST", url: "/v1/account/project-trust/read", headers, payload: { project } })).json())
                .toEqual({ status: "present", revision: 4, content: { t: "plain", v: value } });
            const invalid = await app.inject({ method: "POST", url: "/v1/account/project-trust/mutate", headers,
                payload: { project, expectedRevision: 4, content: { t: "plain", v: { ...value, futureValue: true } } } });
            expect(invalid.statusCode).toBe(400);
            const wrongIdentity = await app.inject({ method: "POST", url: "/v1/account/project-trust/mutate", headers,
                payload: { project, expectedRevision: 4, content: { t: "plain", v: { ...value, project: { ...project, serverId: "other-home" } } } } });
            expect(wrongIdentity.statusCode).toBe(503);
            expect(wrongIdentity.json()).toEqual({ error: "project_trust_storage_unavailable", reason: "invalid-stored-content" });
            expect((await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: account.id, key } } })).value).toEqual(bytes);
            const replacement = await app.inject({ method: "POST", url: "/v1/account/project-trust/mutate", headers,
                payload: { project, expectedRevision: 4, content: { t: "plain", v: value } } });
            expect(replacement.statusCode).toBe(200);
            expect(JSON.parse(new TextDecoder().decode((await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: account.id, key } } })).value!)))
                .toEqual({ t: "plain", v: value });
        } finally { await app.close(); }
    });

    it("returns typed mode mismatch before disclosing or revoking inconsistent content, and never treats unavailable E2EE as absent", async () => {
        const account = await db.account.create({ data: { id: randomUUID(), encryptionMode: "e2ee", ...createSignedAccountContentBinding() } });
        const locked = await db.account.create({ data: { id: randomUUID(), encryptionMode: "e2ee" } });
        const project = { serverId: "home", projectId: randomUUID() };
        const key = `@happier/account/project-trust/v1/home/${project.projectId}`;
        const bytes = new TextEncoder().encode(JSON.stringify({ t: "plain", v: { project, reviewedEffectDigest: "private-effect", approvedAtMs: 1 } }));
        await db.userKVStore.create({ data: { accountId: account.id, key, version: 3, value: bytes } });
        const app = await createTestApp();
        try {
            const headers = { "x-test-user-id": account.id };
            for (const [operation, payload] of [["read", { project }], ["list", { project }], ["mutate", { project, expectedRevision: 3, content: null }]] as const) {
                const response = await app.inject({ method: "POST", url: `/v1/account/project-trust/${operation}`, headers, payload });
                expect(response.statusCode).toBe(503);
                expect(response.json()).toEqual({ error: "project_trust_storage_unavailable", reason: "account-mode-mismatch" });
                expect(response.body).not.toContain("private-effect");
            }
            const unavailable = await app.inject({ method: "POST", url: "/v1/account/project-trust/read", headers: { "x-test-user-id": locked.id }, payload: { project } });
            expect(unavailable.statusCode).toBe(503);
            expect(unavailable.json()).toMatchObject({ error: "project_trust_storage_unavailable", reason: "account-inconsistent" });
            expect((await db.userKVStore.findUniqueOrThrow({ where: { accountId_key: { accountId: account.id, key } } })).value).toEqual(bytes);
        } finally { await app.close(); }
    });

    it("transports opaque E2EE trust under its own cipher purpose without putting the digest in the key or change hint", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const account = await db.account.create({ data: { id: randomUUID(), encryptionMode: "e2ee", ...createSignedAccountContentBinding() } });
        const project = { serverId: "home", projectId: randomUUID() };
        const value = { project, reviewedEffectDigest: "private-reviewed-effect", approvedAtMs: 1 };
        const material = { type: "dataKey" as const, machineKey: new Uint8Array(32).fill(7) };
        const content = { t: "encrypted" as const, c: sealAccountScopedBlobCiphertext({
            kind: "project_setup_trust", material, payload: value, randomBytes: length => new Uint8Array(length).fill(11),
        }) };
        const app = await createTestApp();
        try {
            const headers = { "x-test-user-id": account.id };
            expect((await app.inject({ method: "POST", url: "/v1/account/project-trust/mutate", headers,
                payload: { project, expectedRevision: "absent", content },
            })).json()).toMatchObject({ status: "updated", revision: 0 });
            expect((await app.inject({ method: "POST", url: "/v1/account/project-trust/read", headers, payload: { project } })).json())
                .toEqual({ status: "present", revision: 0, content });
            const legacySwitch = await app.inject({ method: 'PATCH', url: '/v1/account/encryption', headers, payload: { mode: 'plain' } });
            expect(legacySwitch.statusCode).toBe(400);
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).encryptionMode).toBe('e2ee');
            const row = await db.userKVStore.findFirstOrThrow({ where: { accountId: account.id } });
            expect(row.key).toBe(`@happier/account/project-trust/v1/home/${project.projectId}`);
            expect(new TextDecoder().decode(row.value!)).not.toContain(value.reviewedEffectDigest);
            const hint = await db.accountChange.findFirstOrThrow({ where: { accountId: account.id } });
            expect(hint.hint).toEqual({ projectTrust: true, project, revision: 0 });
            const wrongPurpose = { t: "encrypted", c: sealAccountScopedBlobCiphertext({
                kind: "account_settings", material, payload: value, randomBytes: length => new Uint8Array(length).fill(12),
            }) };
            expect((await app.inject({ method: "POST", url: "/v1/account/project-trust/mutate", headers,
                payload: { project, expectedRevision: 0, content: wrongPurpose },
            })).json()).toEqual({ error: "project_trust_storage_unavailable", reason: "account-mode-mismatch" });
        } finally { await app.close(); }
    });
});
