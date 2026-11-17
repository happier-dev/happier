import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IdentityProviderInstanceView } from "@/app/auth/providers/managed/identityProviderInstanceLifecycle";
import { readHomeGovernancePolicyInTx } from "@/app/home/governance/governancePolicy";
import { listDirectorySourceSetupOptionsForActor } from "@/app/teams/directory/directorySourceAdministration";
import * as encryption from "@/modules/encrypt";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { encryptGitHubAppRegistrationSecretsV1 } from "./githubManagedApp";
import {
    resolveManagedGitHubIdentityProviderModuleInTx,
    resolveManagedGitHubIdentityProviderConnectionDraftsInTx,
    resolveManagedGitHubIdentityProviderModulesInTx,
    resolveManagedGitHubIdentityProviderRuntimeFactsInTx,
    resolveManagedGitHubIdentityProviderRuntimeMetadataBatchInTx,
} from "./githubManagedIdentityProvider";
import { resolveStoredGitHubDirectoryReadinessBatch } from "./githubManagedDirectory";
import { createDbMaintenanceClient, onDbClientQuery, type PrismaClientType } from "@/storage/prisma";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("managed GitHub batch runtime PostgreSQL", () => {
    const statements: Prisma.QueryEvent[] = [];
    let measuredClient: PrismaClientType;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Run with the disposable PostgreSQL DB-contract harness");
        }
        vi.stubEnv("HANDY_MASTER_SECRET", "managed-github-batch-disposable-test-secret");
        vi.stubEnv("HAPPIER_FEATURE_TEAMS__ENABLED", "1");
        vi.stubEnv("HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED", "1");
        initDbPostgres();
        await db.$connect();
        measuredClient = await createDbMaintenanceClient("postgres", undefined, { log: [{ emit: "event", level: "query" }] });
        onDbClientQuery(measuredClient, event => statements.push(event));
        await measuredClient.$connect();
        await encryption.initEncrypt();
    });
    afterAll(async () => { await measuredClient?.$disconnect(); await db.$disconnect(); vi.unstubAllEnvs(); });

    async function fixture() {
        const id = randomUUID();
        const registration = await db.gitHubAppRegistration.create({ data: {
            id,
            githubHost: "https://github.com",
            githubAppId: BigInt(`0x${id.replaceAll("-", "").slice(0, 12)}`),
            githubClientId: "Iv1.batch",
            config: { v: 1, secretHealth: {
                clientSecretConfigured: true, privateKeyConfigured: true, webhookSecretConfigured: false,
            } },
            encryptedSecrets: encryptGitHubAppRegistrationSecretsV1({
                registrationId: id, secrets: { v: 1, clientSecret: "test-client", privateKey: "test-key" },
            }),
            state: "verified", securityRevision: 4, lastVerifiedAt: new Date(),
        } });
        const installation = await db.gitHubAppInstallation.create({ data: {
            registrationId: id, githubInstallationId: 1301n, githubOrganizationId: 1401n,
            githubOrganizationLogin: "Batch", repositorySelection: "all", state: "verified", revision: 5,
            verifiedPermissions: { members: "read" }, lastVerifiedAt: new Date(),
        } });
        const provider: IdentityProviderInstanceView = {
            id: randomUUID(), owner: { kind: "home" }, kind: "github_app_identity", displayName: "Batch GitHub",
            enabled: true, firstEnabledAt: new Date(), securityRevision: 3, revision: 1, lastSuccessfulTest: null,
            config: { v: 1, kind: "github_app_identity" }, githubAppInstallationId: installation.id,
            createdByAccountId: null, createdAt: new Date(), updatedAt: new Date(),
        };
        const input = {
            key: provider.id, env: {}, context: { kind: "home" as const }, provider,
            connectionId: null, connectionRevision: null, publicServerUrl: "https://home.example.test",
        };
        return { registration, installation, input };
    }

    it("decrypts one registration once when listing a full page of directory setup choices", async () => {
        const { registration, installation } = await fixture();
        const owner = await db.account.create({ data: { publicKey: randomUUID() } });
        const team = await db.team.create({ data: { name: "GitHub setup batch" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        await db.gitHubAppRegistration.update({ where: { id: registration.id }, data: { ownerTeamId: team.id } });
        await db.gitHubAppInstallation.update({ where: { id: installation.id }, data: { githubOrganizationLogin: "setup-shared-000" } });
        await db.gitHubAppInstallation.createMany({ data: Array.from({ length: 49 }, (_, index) => ({
            registrationId: registration.id, githubInstallationId: BigInt(5000 + index), githubOrganizationId: BigInt(6000 + index),
            githubOrganizationLogin: `setup-shared-${String(index + 1).padStart(3, "0")}`,
            repositorySelection: "all", state: "verified", verifiedPermissions: { members: "read" }, lastVerifiedAt: new Date(),
        })) });
        const teamProviderPolicy = { v: 1, allowedTeamProviderKinds: ["github_app_identity"],
            teamJitAllowed: true, approvedGitHubEnterpriseOrigins: [] };
        await db.homeGovernancePolicy.upsert({ where: { id: "home" },
            create: { id: "home", teamProviderPolicy }, update: { teamProviderPolicy } });
        const decryptions = vi.spyOn(encryption, "decryptString");
        try {
            const result = await listDirectorySourceSetupOptionsForActor({
                v: 1, actorAccountId: owner.id, teamId: team.id, env: process.env, limit: 50, query: "setup-shared-",
            });
            expect(result).toMatchObject({ ok: true, value: { complete: true } });
            if (!result.ok) throw new Error("Expected verified GitHub setup choices");
            expect(result.value.items).toHaveLength(50);
            expect(decryptions.mock.calls.filter(([path]) => path[1] === "github_app_registration"
                && path[2] === registration.id)).toHaveLength(1);
        } finally { vi.restoreAllMocks(); }
    });

    it("keeps SQL acquisition constant and decrypts each registration once for 128 provider runtimes", async () => {
        const { input, registration } = await fixture();
        const secondInstallation = await db.gitHubAppInstallation.create({ data: {
            registrationId: registration.id, githubInstallationId: 1302n, githubOrganizationId: 1402n,
            githubOrganizationLogin: "Second", repositorySelection: "all", state: "verified", revision: 5,
            verifiedPermissions: { members: "read" }, lastVerifiedAt: new Date(),
        } });
        for (const count of [128, 1]) {
            await measuredClient.$transaction(async tx => {
                // Observe engine-emitted SQL and genuine crypto; no domain logic is replaced.
                const decryptions = vi.spyOn(encryption, "decryptString");
                try {
                    const inputs = Array.from({ length: count }, (_, index) => ({
                        ...input, key: `provider-${index}`, provider: { ...input.provider, id: `provider-${index}`,
                            githubAppInstallationId: index % 2 ? secondInstallation.id : input.provider.githubAppInstallationId },
                    }));
                    statements.length = 0;
                    const startedAt = performance.now();
                    const results = await resolveManagedGitHubIdentityProviderModulesInTx(tx, { inputs });
                    await new Promise<void>(done => setImmediate(done));
                    const selects = statements.filter(({ query }) => /^SELECT\b/.test(query));
                    console.info("MANAGED_GITHUB_BATCH_WORK", JSON.stringify({
                        providers: count, selects: selects.length, decryptions: decryptions.mock.calls.length,
                        elapsedMs: performance.now() - startedAt,
                    }));
                    expect(results.size).toBe(count);
                    expect(selects).toHaveLength(2);
                    expect(decryptions).toHaveBeenCalledTimes(1);
                    for (const candidate of inputs) {
                        expect(results.get(candidate.key)).toMatchObject({
                            module: { id: candidate.provider.id, oauth: { callbackProviderId: "github-app" } },
                            runtimeFingerprint: expect.stringContaining(":3:4:5:home:"), connectionRevision: null,
                        });
                    }
                } finally { vi.restoreAllMocks(); }
            });
        }
        await measuredClient.$transaction(async tx => {
            const decryptions = vi.spyOn(encryption, "decryptString");
            try {
                statements.length = 0;
                expect((await resolveManagedGitHubIdentityProviderModulesInTx(tx, { inputs: [] })).size).toBe(0);
                expect(statements.filter(({ query }) => /^SELECT\b/.test(query))).toHaveLength(0);
                const metadata = await resolveManagedGitHubIdentityProviderRuntimeMetadataBatchInTx(tx, { inputs: [input] });
                expect(metadata.has(input.key)).toBe(true);
                await new Promise<void>(done => setImmediate(done));
                const selects = statements.filter(({ query }) => /^SELECT\b/.test(query));
                expect(selects.filter(({ query }) => query.includes('"GitHubAppInstallation"'))).toHaveLength(1);
                expect(selects.some(({ query }) => query.includes("encryptedSecrets"))).toBe(false);
                expect(decryptions).not.toHaveBeenCalled();
                statements.length = 0;
                const drafts = await resolveManagedGitHubIdentityProviderConnectionDraftsInTx(tx, {
                    inputs: Array.from({ length: 128 }, (_, index) => ({ ...input, key: `draft-${index}` })),
                });
                await new Promise<void>(done => setImmediate(done));
                const draftSelects = statements.filter(({ query }) => /^SELECT\b/.test(query));
                console.info("MANAGED_GITHUB_DRAFT_BATCH_WORK", JSON.stringify({
                    providers: drafts.size, selects: draftSelects.length, decryptions: decryptions.mock.calls.length,
                }));
                expect(drafts.size).toBe(128);
                expect(draftSelects).toHaveLength(2);
                expect(draftSelects.some(({ query }) => query.includes("encryptedSecrets"))).toBe(false);
                expect(decryptions).not.toHaveBeenCalled();
            } finally { vi.restoreAllMocks(); }
        });
    });

    it("crosses the portable bind boundary without truncating valid providers at the end", async () => {
        const { input } = await fixture();
        // Cross two complete 999-bind transport budgets, with the real row last.
        const inputs = Array.from({ length: 999 * 2 + 1 }, (_, index) => ({
            ...input, key: `boundary-${index}`, provider: { ...input.provider,
                githubAppInstallationId: index === 999 * 2 ? input.provider.githubAppInstallationId : `absent-${index}` },
        }));
        await measuredClient.$transaction(async tx => {
            statements.length = 0;
            const results = await resolveManagedGitHubIdentityProviderModulesInTx(tx, { inputs });
            await new Promise<void>(done => setImmediate(done));
            expect([...results.keys()]).toEqual([`boundary-${999 * 2}`]);
            const installationReads = statements.filter(({ query }) => /^SELECT\b/.test(query)
                && query.includes('"GitHubAppInstallation"'));
            expect(installationReads).toHaveLength(3);
            expect(installationReads.every(({ params }) => {
                const values: unknown = JSON.parse(params);
                return Array.isArray(values) && values.length <= 999;
            })).toBe(true);
        });
    });

    it.each(["secret", "config"] as const)("keeps each registration revision's %s facts across ReadCommitted query chunks", async kind => {
        const { registration, input } = await fixture();
        const secondInstallation = await db.gitHubAppInstallation.create({ data: {
            registrationId: registration.id, githubInstallationId: 1302n, githubOrganizationId: 1402n,
            githubOrganizationLogin: "New revision", repositorySelection: "all", state: "verified",
            verifiedPermissions: { members: "read" }, lastVerifiedAt: new Date(),
        } });
        const inputs = [
            { ...input, key: "old" },
            ...Array.from({ length: 997 }, (_, index) => ({ ...input, key: `absent-${index}`,
                provider: { ...input.provider, id: `absent-provider-${index}`, githubAppInstallationId: `absent-${index}` } })),
            { ...input, key: "new", provider: { ...input.provider, id: "new-provider", githubAppInstallationId: secondInstallation.id } },
        ];
        await measuredClient.$transaction(async tx => {
            let completeUpdate!: () => void;
            const updated = new Promise<void>(done => { completeUpdate = done; });
            let reads = 0;
            // Schedule a genuine external registration update between the two
            // real SELECTs, without replacing normalization or readiness logic.
            const observed = new Proxy(tx, { get(target, model, receiver) {
                const delegate: unknown = Reflect.get(target, model, receiver);
                if (model !== "gitHubAppInstallation" || typeof delegate !== "object" || delegate === null) return delegate;
                return new Proxy(delegate, { get(owner, method, delegateReceiver) {
                    const value: unknown = Reflect.get(owner, method, delegateReceiver);
                    if (method !== "findMany" || typeof value !== "function") return value;
                    return async (...args: unknown[]) => {
                        const readIndex = reads++;
                        if (readIndex !== 0) await updated;
                        try {
                            const rows: unknown = await Reflect.apply(value, owner, args);
                            if (readIndex === 0) {
                                await db.gitHubAppRegistration.update({ where: { id: registration.id }, data: {
                                    securityRevision: registration.securityRevision + 1,
                                    ...(kind === "secret" ? {
                                        encryptedSecrets: encryptGitHubAppRegistrationSecretsV1({
                                            registrationId: registration.id, secrets: { v: 1, privateKey: "new-private-key" },
                                        }),
                                    } : { config: { v: 1, secretHealth: {
                                        clientSecretConfigured: false, privateKeyConfigured: true, webhookSecretConfigured: false,
                                    } } }),
                                } });
                            }
                            return rows;
                        } finally { if (readIndex === 0) completeUpdate(); }
                    };
                } });
            } });
            const facts = await resolveManagedGitHubIdentityProviderRuntimeFactsInTx(observed, { inputs });
            expect(reads).toBe(2);
            expect(facts.modules.has("old")).toBe(true);
            expect(facts.modules.has("new")).toBe(false);
            if (kind === "secret") {
                expect(facts.registrationSecretHealthByKey.get("new")).toMatchObject({
                    registrationId: registration.id, securityRevision: registration.securityRevision + 1,
                    secretHealth: { clientSecretConfigured: false, privateKeyConfigured: true },
                });
            } else expect(facts.registrationSecretHealthByKey.has("new")).toBe(false);
        }, { isolationLevel: "ReadCommitted", timeout: 60_000 });
    });

    it("keeps metadata secret-free and preserves fresh state, permission, owner and ciphertext refusals", async () => {
        const { registration, installation, input } = await fixture();
        const resolve = () => inTx(tx => resolveManagedGitHubIdentityProviderModuleInTx(tx, input));
        expect(await resolve()).not.toBeNull();
        await db.gitHubAppInstallation.update({ where: { id: installation.id }, data: { suspendedAt: new Date() } });
        expect(await resolve()).toBeNull();
        await db.gitHubAppInstallation.update({ where: { id: installation.id }, data: { suspendedAt: null, state: "unverified" } });
        expect(await resolve()).toBeNull();
        await db.gitHubAppInstallation.update({ where: { id: installation.id }, data: { state: "verified", verifiedPermissions: {} } });
        expect(await resolve()).toBeNull();
        await db.gitHubAppInstallation.update({ where: { id: installation.id }, data: { verifiedPermissions: { members: "read" } } });
        const team = await db.team.create({ data: { name: "Different registration owner" } });
        await db.gitHubAppRegistration.update({ where: { id: registration.id }, data: { ownerTeamId: team.id } });
        expect(await resolve()).toBeNull();
        await db.gitHubAppRegistration.update({ where: { id: registration.id }, data: {
            ownerTeamId: null, encryptedSecrets: Uint8Array.from([1, 2, 3]),
        } });
        const unaffected = await fixture();
        await inTx(async tx => {
            const decryptions = vi.spyOn(encryption, "decryptString");
            try {
                const metadata = await resolveManagedGitHubIdentityProviderRuntimeMetadataBatchInTx(tx, { inputs: [input] });
                expect(metadata.has(input.key)).toBe(true);
                expect(decryptions).not.toHaveBeenCalled();
                const results = await resolveManagedGitHubIdentityProviderModulesInTx(tx, {
                    inputs: [input, { ...input, key: "second-provider" }, unaffected.input],
                });
                expect([...results.keys()]).toEqual([unaffected.input.key]);
                expect(decryptions).toHaveBeenCalledTimes(2);
            } finally { vi.restoreAllMocks(); }
        });
    });

    it("shares only revision-bound health with directory admission for full, partial and unreadable credentials", async () => {
        const { registration, installation, input } = await fixture();
        const cases = [
            { secrets: { v: 1 as const, clientSecret: "test-client", privateKey: "test-key" }, oauth: true,
                secretHealth: { clientSecretConfigured: true, privateKeyConfigured: true, webhookSecretConfigured: false } },
            { secrets: { v: 1 as const, privateKey: "test-key" }, oauth: false,
                secretHealth: { clientSecretConfigured: false, privateKeyConfigured: true, webhookSecretConfigured: false } },
            { secrets: null, oauth: false, secretHealth: null },
        ];
        for (const [index, candidate] of cases.entries()) {
            const current = await db.gitHubAppRegistration.update({ where: { id: registration.id }, data: {
                securityRevision: registration.securityRevision + index,
                encryptedSecrets: candidate.secrets === null ? Uint8Array.from([1, 2, 3])
                    : encryptGitHubAppRegistrationSecretsV1({ registrationId: registration.id, secrets: candidate.secrets }),
            } });
            await inTx(async tx => {
                const home = await readHomeGovernancePolicyInTx(tx);
                const decryptions = vi.spyOn(encryption, "decryptString");
                try {
                    const facts = await resolveManagedGitHubIdentityProviderRuntimeFactsInTx(tx, {
                        home, inputs: [input, { ...input, key: "another-provider" }],
                    });
                    expect(facts.modules.size).toBe(candidate.oauth ? 2 : 0);
                    const fact = facts.registrationSecretHealthByKey.get(input.key);
                    expect(fact).toEqual({ registrationId: registration.id,
                        securityRevision: current.securityRevision, secretHealth: candidate.secretHealth });
                    const directory = resolveStoredGitHubDirectoryReadinessBatch([{
                        key: "directory", teamId: "home-registration-consumer", home, registrationSecretHealth: fact,
                        installation: { ...installation, registration: { ...current,
                            encryptedSecrets: Uint8Array.from(current.encryptedSecrets) } },
                    }]);
                    expect(directory.get("directory")?.ok).toBe(candidate.secretHealth !== null);
                    expect(decryptions).toHaveBeenCalledTimes(1);
                } finally { vi.restoreAllMocks(); }
            });
        }
    });

    it("binds each result to its exact context and connection revision, and reuses only same-transaction Home policy", async () => {
        const { input } = await fixture();
        const team = await db.team.create({ data: { name: "Provider context" } });
        await inTx(async tx => {
            const home = await readHomeGovernancePolicyInTx(tx);
            const policies = vi.spyOn(tx.homeGovernancePolicy, "findUnique");
            try {
                const connectionInput = {
                    ...input, key: "team", context: { kind: "team" as const, teamId: team.id },
                    connectionId: "connection-one", connectionRevision: 7,
                };
                const results = await resolveManagedGitHubIdentityProviderModulesInTx(tx, { home, inputs: [
                    input, connectionInput,
                    { ...connectionInput, key: "missing-revision", connectionRevision: null },
                    { ...connectionInput, key: "invalid-revision", connectionRevision: 0 },
                    { ...connectionInput, key: "missing-connection", connectionId: null },
                    { ...input, key: "home-with-connection", connectionId: "connection-one", connectionRevision: 7 },
                    { ...input, key: "team-provider-at-home", provider: { ...input.provider, owner: { kind: "team", teamId: team.id } } },
                    { ...connectionInput, key: "other-team-provider", provider: { ...input.provider, owner: { kind: "team", teamId: "another-team" } } },
                ] });
                expect([...results.keys()]).toEqual([input.key, "team"]);
                expect(results.get("team")).toMatchObject({ connectionRevision: 7,
                    runtimeFingerprint: expect.stringContaining(":3:4:5:7:") });
                expect(policies).not.toHaveBeenCalled();
            } finally { vi.restoreAllMocks(); }
        });
    });
});
