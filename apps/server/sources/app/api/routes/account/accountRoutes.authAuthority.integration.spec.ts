import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { buildAccountStoredContentCompatibilityHttpHeadersV1 } from "@happier-dev/protocol";

import { auth } from "@/app/auth/auth";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { accountRoutes } from "./accountRoutes";
import { currentAccountStoredContentCompatibilityHeaders } from "../../testkit/accountStoredContentCompatibility";
import { homeDomainActionPathForMethod } from '../actions/homeDomainActionRoute';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    enableAuthentication(typed);
    accountRoutes(typed);
    return typed;
}

describe("accountRoutes (direct-route auth authority) (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-account-route-authority-",
            initAuth: true,
            initEncrypt: true,
            env: {
                AUTH_REQUIRED_LOGIN_PROVIDERS: "",
                AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: "0",
            },
        });
    }, 120_000);

    afterEach(async () => {
        harness.resetEnv();
        await db.accountEncryptionTransitionCollectionStage.deleteMany();
        await db.accountEncryptionTransition.deleteMany();
        await db.accountSettingsSnapshot.deleteMany();
        await db.accountChange.deleteMany();
        await db.repeatKey.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    it('requires present-user authority for SSH resource packets while retaining terminal host metadata CRUD', async () => {
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain', settingsVersion: 0,
            terminalPresentUserPolicy: 'disallowed' } });
        const [presentToken, terminalToken] = await Promise.all([
            auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' }),
            auth.createToken(account.id, { session: 'ssh-authority-terminal' }, { kind: 'terminal', authority: 'account_automation' }),
        ]);
        const app = createTestApp();
        await app.ready();
        const headers = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json',
            ...currentAccountStoredContentCompatibilityHeaders });
        const route = '/v1/account/entity-rows/remote-hosts';
        const host = { id: 'ssh-authority-host', name: 'Host', ssh: { target: 'dev@example.test', authMode: 'agent' },
            createdAt: 1, updatedAt: 1, lastUsedAt: null };
        const resource = { resourceId: 'ssh-authority-password', displayName: 'SSH password', kind: 'password', encryptionMode: 'plain',
            storedContent: { t: 'plain', v: { v: 1, name: 'SSH password', kind: 'password', value: 'authority-private-fixture' } } };
        const mutation = { expectedRevision: 0, referencedSavedSecretRevisions: [{ resourceId: resource.resourceId, revision: 1 }],
            content: { t: 'plain', v: { v: 1, hosts: [{ ...host, ssh: { ...host.ssh, authMode: 'password',
                passwordSecretRef: formatSharedSavedSecretRefV1(resource.resourceId) } }] } } };
        const referenceCensus = { scope: 'catalogs', accountMode: 'plain', catalogs: {}, remoteHosts: { revision: 0, resourceRefs: [] } };
        try {
            // Real signed terminal provenance, not client headers or a substituted authority stamp.
            const metadata = await app.inject({ method: 'POST', url: route, headers: headers(terminalToken),
                payload: { mutation: { expectedRevision: 'absent', sourceSettingsVersion: 0, referencedSavedSecretRevisions: [],
                    content: { t: 'plain', v: { v: 1, hosts: [host] } } } } });
            expect(metadata.statusCode).toBe(200);
            expect(metadata.json()).toMatchObject({ status: 'updated', revision: 0 });
            const incumbent = await app.inject({ method: 'POST', url: homeDomainActionPathForMethod('secrets.shared.promote', 'POST'),
                headers: headers(terminalToken), payload: { ...resource, nextSettings: null, profileMutations: [], referenceCensus,
                    remoteHostMutation: mutation } });
            expect({ status: incumbent.statusCode, body: incumbent.json() })
                .toEqual({ status: 403, body: { error: 'present_user_required' } });
            const automation = await app.inject({ method: 'POST', url: route, headers: headers(terminalToken),
                payload: { mutation, savedSecretResources: [resource], referenceCensus } });
            expect({ status: automation.statusCode, body: automation.json() })
                .toEqual({ status: 403, body: { error: 'present_user_required' } });
            expect(await db.savedSecretResource.count({ where: { ownerAccountId: account.id } })).toBe(0);
            expect((await app.inject({ method: 'GET', url: route, headers: headers(terminalToken) })).json())
                .toEqual({ status: 'present', revision: 0, content: { t: 'plain', v: { v: 1, hosts: [host] } } });
            const interactive = await app.inject({ method: 'POST', url: route, headers: headers(presentToken),
                payload: { mutation, savedSecretResources: [resource], referenceCensus } });
            expect(interactive.statusCode).toBe(200);
            expect(interactive.json()).toMatchObject({ status: 'updated', revision: 1 });
            expect(await db.savedSecretResource.count({ where: { ownerAccountId: account.id } })).toBe(1);
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settingsVersion).toBe(0);
            expect(await db.accountSettingsSnapshot.count({ where: { accountId: account.id } })).toBe(0);
        } finally {
            await app.close();
            await db.savedSecretResource.deleteMany({ where: { ownerAccountId: account.id } });
            await db.userKVStore.deleteMany({ where: { accountId: account.id } });
        }
    });

    it('preserves the provider-required auth response for host metadata and SSH resource packets', async () => {
        harness.resetEnv({ AUTH_REQUIRED_LOGIN_PROVIDERS: 'github', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0' });
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain', settingsVersion: 0 } });
        const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const app = createTestApp();
        await app.ready();
        const route = '/v1/account/entity-rows/remote-hosts';
        const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json',
            ...currentAccountStoredContentCompatibilityHeaders };
        const host = { id: 'ssh-provider-required', name: 'Host', ssh: { target: 'dev@example.test', authMode: 'agent' },
            createdAt: 1, updatedAt: 1, lastUsedAt: null };
        const metadataMutation = { expectedRevision: 'absent', sourceSettingsVersion: 0, referencedSavedSecretRevisions: [],
            content: { t: 'plain', v: { v: 1, hosts: [host] } } };
        const resource = { resourceId: 'ssh-provider-required-password', displayName: 'SSH password', kind: 'password', encryptionMode: 'plain',
            storedContent: { t: 'plain', v: { v: 1, name: 'SSH password', kind: 'password', value: 'eligibility-private-fixture' } } };
        const resourceMutation = { ...metadataMutation, referencedSavedSecretRevisions: [{ resourceId: resource.resourceId, revision: 1 }],
            content: { t: 'plain', v: { v: 1, hosts: [{ ...host, ssh: { ...host.ssh, authMode: 'password',
                passwordSecretRef: formatSharedSavedSecretRefV1(resource.resourceId) } }] } } };
        const refusal = { status: 403, body: { error: 'provider-required', provider: 'github' } };
        try {
            // Missing required identity is resolved by the real provider catalog/DB owner, without upstream calls.
            const read = await app.inject({ method: 'GET', url: route, headers });
            expect({ status: read.statusCode, body: read.json() }).toEqual(refusal);
            for (const payload of [{ mutation: metadataMutation }, { mutation: resourceMutation, savedSecretResources: [resource] }]) {
                const response = await app.inject({ method: 'POST', url: route, headers, payload });
                expect({ status: response.statusCode, body: response.json() }).toEqual(refusal);
            }
            expect(await db.savedSecretResource.count({ where: { ownerAccountId: account.id } })).toBe(0);
            expect(await db.userKVStore.count({ where: { accountId: account.id } })).toBe(0);
            expect((await db.account.findUniqueOrThrow({ where: { id: account.id } })).settingsVersion).toBe(0);
            expect(await db.accountSettingsSnapshot.count({ where: { accountId: account.id } })).toBe(0);
        } finally {
            await app.close();
        }
    });

    it("allows an interactive signed session to update Settings but refuses a PAT before the direct write", async () => {
        const account = await db.account.create({
            data: {
                publicKey: null,
                encryptionMode: "plain",
                settings: null,
                settingsVersion: 0,
            },
            select: { id: true },
        });
        const [signedToken, pat] = await Promise.all([
            auth.createToken(account.id, undefined, { kind: "account", authority: "present_user" }),
            auth.createApiToken({
                accountId: account.id,
                tokenId: crypto.randomUUID(),
                label: "Settings automation regression",
            }),
        ]);
        const app = createTestApp();
        await app.ready();

        try {
            const interactiveWrite = await app.inject({
                method: "POST",
                url: "/v2/account/settings",
                headers: {
                    authorization: `Bearer ${signedToken}`,
                    "content-type": "application/json",
                    ...currentAccountStoredContentCompatibilityHeaders,
                },
                payload: {
                    content: { t: "plain", v: { schemaVersion: 2 } },
                    expectedVersion: 0,
                },
            });
            expect(interactiveWrite.statusCode).toBe(200);
            expect(interactiveWrite.json()).toEqual({ success: true, version: 1 });

            const automationWrite = await app.inject({
                method: "POST",
                url: "/v2/account/settings",
                headers: {
                    authorization: `Bearer ${pat.token}`,
                    "content-type": "application/json",
                    ...currentAccountStoredContentCompatibilityHeaders,
                },
                payload: {
                    content: { t: "plain", v: { schemaVersion: 3 } },
                    expectedVersion: 1,
                },
            });

            expect(automationWrite.statusCode).toBe(403);
            expect(automationWrite.json()).toEqual({ error: "present_user_required" });
            await expect(db.account.findUniqueOrThrow({
                where: { id: account.id },
                select: { settingsVersion: true },
            })).resolves.toEqual({ settingsVersion: 1 });
        } finally {
            await app.close();
        }
    });

    it("refuses a PAT before an encryption migration control operation", async () => {
        const account = await db.account.create({
            data: {
                publicKey: null,
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const pat = await auth.createApiToken({
            accountId: account.id,
            tokenId: crypto.randomUUID(),
            label: "Encryption migration regression",
        });
        const app = createTestApp();
        await app.ready();

        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate/transition/prepare",
                headers: {
                    authorization: `Bearer ${pat.token}`,
                    "content-type": "application/json",
                    ...buildAccountStoredContentCompatibilityHttpHeadersV1({
                        v: 1,
                        protocolVersion: 5,
                    }),
                },
                payload: {
                    toMode: "e2ee",
                    expectedAccountVersion: 0,
                    expectedSigningKeyFingerprint: null,
                    expectedContentKeyFingerprint: null,
                },
            });

            expect(response.statusCode).toBe(403);
            expect(response.json()).toEqual({ error: "present_user_required" });
            await expect(db.accountEncryptionTransition.count({
                where: { accountId: account.id },
            })).resolves.toBe(0);
        } finally {
            await app.close();
        }
    });

    it("denies a PAT from legacy direct reads while missing and invalid credentials still use authentication refusal", async () => {
        const account = await db.account.create({
            data: {
                publicKey: null,
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const pat = await auth.createApiToken({
            accountId: account.id,
            tokenId: crypto.randomUUID(),
            label: "Read-only automation",
        });
        const app = createTestApp();
        await app.ready();

        try {
            const [automationRead, missingCredential, invalidCredential] = await Promise.all([
                app.inject({
                    method: "GET",
                    url: "/v1/account/encryption",
                    headers: { authorization: `Bearer ${pat.token}` },
                }),
                app.inject({ method: "GET", url: "/v1/account/encryption" }),
                app.inject({
                    method: "GET",
                    url: "/v1/account/encryption",
                    headers: { authorization: "Bearer not-a-real-token" },
                }),
            ]);

            expect(automationRead.statusCode).toBe(403);
            expect(automationRead.json()).toEqual({ error: "present_user_required" });
            expect(missingCredential.statusCode).toBe(401);
            expect(missingCredential.json()).toEqual({ error: "Missing authorization header" });
            expect(invalidCredential.statusCode).toBe(401);
            expect(invalidCredential.json()).toEqual({ error: "invalid_token" });
        } finally {
            await app.close();
        }
    });
});
