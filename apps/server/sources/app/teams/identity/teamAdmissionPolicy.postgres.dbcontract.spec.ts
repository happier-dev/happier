import { randomUUID } from "node:crypto";
import { normalizeTeamAuthenticationPolicyV1 } from "@happier-dev/protocol/auth/entry";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { resolveTeamAuthenticationPolicyInTx } from "@/app/auth/entry/resolveTeamAuthenticationPolicy";
import { resolveAuthEntry } from "@/app/auth/entry/resolveAuthEntry";
import { readDirectoryProvisionedIdentityCandidatesInTx } from "@/app/teams/directory/provisionedIdentityBinding";
import { encryptGitHubAppRegistrationSecretsV1 } from "@/app/integrations/github/githubManagedApp";
import * as encryption from "@/modules/encrypt";
import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";

import { resolveTeamAdmissionModeApplicabilityInTx } from "./teamAdmissionModeApplicability";

function observeAcquisitions(tx: Tx) {
    const reads: Array<Readonly<{ model: string; method: string; query: unknown }>> = [];
    // Prisma recreates delegates on access. Wrap the transaction's actual
    // persistence boundary instead of spying on one transient delegate object.
    const observed = new Proxy(tx, { get(target, model, receiver) {
        const delegate: unknown = Reflect.get(target, model, receiver);
        if (typeof model !== "string" || !["teamDirectorySource", "homeGovernancePolicy", "teamIdentityConnection"].includes(model)
            || typeof delegate !== "object" || delegate === null) return delegate;
        return new Proxy(delegate, { get(owner, method, delegateReceiver) {
            const value: unknown = Reflect.get(owner, method, delegateReceiver);
            if (typeof value !== "function" || !["findUnique", "findMany", "findFirst", "count"].includes(String(method))) return value;
            return (...args: unknown[]) => {
                reads.push({ model, method: String(method), query: args[0] });
                return Reflect.apply(value, owner, args);
            };
        } });
    } });
    return { tx: observed, reads };
}

async function observeTransactionAcquisitions<T>(run: () => Promise<T>) {
    const original = db.$transaction;
    const reads: ReturnType<typeof observeAcquisitions>["reads"] = [];
    db.$transaction = new Proxy(original, { apply(target, receiver, args: unknown[]) {
        const callback = args[0];
        if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
        return Reflect.apply(target, receiver, [async (tx: Tx) => {
            const observed = observeAcquisitions(tx);
            try { return await callback(observed.tx); }
            finally { reads.push(...observed.reads); }
        }, ...args.slice(1)]);
    } });
    try { return { value: await run(), reads }; }
    finally { db.$transaction = original; }
}

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Team admission acquisition cost (PostgreSQL)", () => {
    const env = {
        HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test",
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1",
        HAPPIER_FEATURE_TEAMS__ENABLED: "1",
        WORKOS_API_KEY: "sk_test_admission",
        WORKOS_CLIENT_ID: "client_admission",
    };

    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Use the disposable PostgreSQL DB-contract harness");
        }
        vi.stubEnv("HAPPIER_FEATURE_TEAMS__ENABLED", "1");
        vi.stubEnv("HANDY_MASTER_SECRET", "team-admission-disposable-test-secret");
        initDbPostgres();
        await db.$connect();
        await encryption.initEncrypt();
        const teamProviderPolicy = { v: 1, allowedTeamProviderKinds: ["workos_sso"],
            teamJitAllowed: true, approvedGitHubEnterpriseOrigins: [] };
        await db.homeGovernancePolicy.upsert({ where: { id: "home" },
            create: { id: "home", teamProviderPolicy }, update: { teamProviderPolicy } });
    });
    afterAll(async () => { vi.unstubAllEnvs(); await db.$disconnect(); });

    async function fixture(size: number) {
        const team = await db.team.create({ data: { name: `Admission cost ${randomUUID()}` } });
        const providers = Array.from({ length: size }, () => ({ id: randomUUID(), ownerTeamId: team.id,
            kind: "workos_sso" as const, displayName: "Directory identity", enabled: true,
            config: { v: 1, kind: "workos_sso" } }));
        await db.identityProviderInstance.createMany({ data: providers });
        const connections = providers.map(provider => ({ id: randomUUID(), teamId: team.id,
            providerInstanceId: provider.id, enabled: true,
            externalReference: { v: 1, kind: "workos_sso", organizationId: `org_${provider.id}`, connectionId: `conn_${provider.id}` },
            settings: { v: 1, kind: "workos_sso" } }));
        await db.teamIdentityConnection.createMany({ data: connections });
        return { team, providers, connections };
    }

    it("loads current directory authority in sets rather than once per completed source", async () => {
        const { team, connections } = await fixture(120);
        await db.teamDirectorySource.createMany({ data: connections.map(connection => ({
            teamId: team.id, teamIdentityConnectionId: connection.id, kind: "workos_directory", state: "active",
            displayName: "Completed directory", externalSourceKey: randomUUID(),
            bindingConfig: { v: 1, kind: "workos_directory", workosDirectoryId: `directory_${connection.id}` },
        })) });
        await inTx(async tx => {
            // Observe real database acquisitions; all policy and runtime decisions remain real.
            const observed = observeAcquisitions(tx);
            const result = await resolveTeamAdmissionModeApplicabilityInTx({ tx: observed.tx, env, teamId: team.id });
            expect(result.modes).toMatchObject({ provisioned: { status: "available" }, jit: { status: "available" } });
            expect(observed.reads.filter(read => read.model === "teamDirectorySource" && read.method === "findUnique").length).toBe(0);
            // Provider and directory currentness share the admitted Home snapshot.
            expect(observed.reads.filter(read => read.model === "homeGovernancePolicy")).toHaveLength(1);
        });
        await db.identityProviderInstance.updateMany({
            where: { id: { in: connections.map(connection => connection.providerInstanceId) } }, data: { enabled: false },
        });
        await expect(inTx(tx => resolveTeamAdmissionModeApplicabilityInTx({ tx, env, teamId: team.id }))).resolves.toMatchObject({
            modes: { provisioned: { status: "unavailable" }, jit: { status: "unavailable" } },
        });
    });

    it("reads accepted connection references as one ordered set without hiding unavailable alternatives", async () => {
        const { team, connections } = await fixture(120);
        await db.teamIdentityConnection.update({ where: { id: connections[1]!.id }, data: { enabled: false } });
        await db.teamIdentityConnection.update({ where: { id: connections[2]!.id }, data: { settings: { corrupt: true } } });
        const other = await fixture(1);
        const missingConnectionId = randomUUID();
        const accepted = [
            { kind: "home_method" as const, methodId: "key_challenge" },
            ...connections.map(connection => ({ kind: "team_connection" as const, connectionId: connection.id })),
            { kind: "team_connection" as const, connectionId: other.connections[0]!.id },
            { kind: "team_connection" as const, connectionId: missingConnectionId },
        ];
        await inTx(async tx => {
            const observed = observeAcquisitions(tx);
            const result = await resolveTeamAuthenticationPolicyInTx(observed.tx, { env, teamId: team.id,
                policy: { v: 1, mode: "restricted", accepted } });
            expect(result.resolution.status).toBe("restricted");
            if (result.resolution.status !== "restricted") throw new Error("Native alternative must remain usable");
            expect(result.resolution.choices.map(choice => choice.reference)).toEqual(
                normalizeTeamAuthenticationPolicyV1({ v: 1, mode: "restricted", accepted })!.accepted,
            );
            expect(result.resolution.choices.find(choice => choice.reference.kind === "home_method")?.availability).toBe("usable");
            for (const id of [connections[1]!.id, connections[2]!.id, other.connections[0]!.id, missingConnectionId]) {
                expect(result.resolution.choices.find(choice => choice.reference.kind === "team_connection"
                    && choice.reference.connectionId === id)?.availability).toBe("unavailable");
            }
            const referenceSetReads = observed.reads.filter(read => {
                if (read.model !== "teamIdentityConnection" || read.method !== "findMany") return false;
                const query = read.query;
                return typeof query === "object" && query !== null && "where" in query
                    && typeof query.where === "object" && query.where !== null && "OR" in query.where;
            });
            expect(referenceSetReads).toHaveLength(1);
        });
    });

    it("keeps directory provider authority independent of SSO state and refuses invalid provider authority", async () => {
        const { team, providers, connections } = await fixture(1);
        const provider = providers[0]!;
        const connection = connections[0]!;
        await db.teamDirectorySource.create({ data: {
            teamId: team.id, teamIdentityConnectionId: connection.id, kind: "workos_directory", state: "active",
            displayName: "Directory authority", externalSourceKey: randomUUID(),
            bindingConfig: { v: 1, kind: "workos_directory", workosDirectoryId: `directory_${connection.id}` },
        } });
        const resolve = () => inTx(tx => resolveTeamAdmissionModeApplicabilityInTx({ tx, env, teamId: team.id }));
        // Completed directory evidence uses the provider authority even when
        // SSO is disabled or its connection documents cannot be projected.
        await db.teamIdentityConnection.update({ where: { id: connection.id }, data: {
            enabled: false, settings: { corrupt: true },
            externalReference: { ...connection.externalReference, organizationId: null, connectionId: null },
        } });
        await expect(resolve()).resolves.toMatchObject({ modes: {
            provisioned: { status: "available" }, jit: { status: "unavailable", reason: "team_connection_unavailable" },
        } });
        await db.identityProviderInstance.update({ where: { id: provider.id }, data: { enabled: false } });
        await expect(resolve()).resolves.toMatchObject({ modes: {
            provisioned: { status: "unavailable", reason: "team_connection_unavailable" },
        } });
        await db.identityProviderInstance.update({ where: { id: provider.id }, data: {
            enabled: true, encryptedSecrets: new Uint8Array([1, 2, 3]),
        } });
        await expect(resolve()).resolves.toMatchObject({ modes: {
            provisioned: { status: "unavailable", reason: "team_connection_unavailable" },
        } });
        const other = await fixture(1);
        await db.identityProviderInstance.update({ where: { id: provider.id }, data: {
            encryptedSecrets: null, ownerTeamId: other.team.id,
        } });
        await expect(resolve()).resolves.toMatchObject({ modes: {
            provisioned: { status: "unavailable", reason: "team_connection_unavailable" },
        } });
        await db.identityProviderInstance.update({ where: { id: provider.id }, data: { ownerTeamId: null } });
        await expect(resolve()).resolves.toMatchObject({ modes: { provisioned: { status: "available" } } });
    });

    async function manySources() {
        const current = await fixture(1);
        const sources = Array.from({ length: 120 }, (_, index) => ({
            id: randomUUID(), teamId: current.team.id, teamIdentityConnectionId: current.connections[0]!.id,
            kind: "workos_directory" as const, state: index === 0 ? "paused" as const : "active" as const,
            activeReconcileRunId: index === 1 ? "current-run" : null,
            activeReconcileStartedAt: index === 1 ? new Date() : null,
            displayName: "Bound directory", externalSourceKey: randomUUID(),
            bindingConfig: { v: 1, kind: "workos_directory", workosDirectoryId: `directory_${index}` },
        }));
        await db.teamDirectorySource.createMany({ data: sources });
        return { ...current, sources };
    }

    it("batches completed source admission for a signed-in directory-only Team entry", async () => {
        const current = await manySources();
        await db.team.update({ where: { id: current.team.id }, data: { admissionMode: "provisioned" } });
        const account = await db.account.create({ data: { encryptionMode: "plain" } });
        const readEntry = () => resolveAuthEntry({ v: 1, scope: { kind: "team", teamId: current.team.id } }, {
            env, emailDeliveryReady: false, principal: { accountId: account.id },
        });
        const observed = await observeTransactionAcquisitions(readEntry);
        expect(observed.value).toMatchObject({ state: "admission_required", actions: [expect.objectContaining({
            kind: "authenticate", origin: "team", action: "connect",
        }), expect.objectContaining({ kind: "switch_account" })] });
        expect(observed.reads.filter(read => read.model === "teamDirectorySource" && read.method === "findUnique")).toHaveLength(0);
        await db.identityProviderInstance.update({ where: { id: current.providers[0]!.id }, data: { enabled: false } });
        await expect(readEntry()).resolves.toMatchObject({ state: "unavailable", reason: "directory_delayed" });
    });

    it("batches exact provisioned identity candidates while preserving completeness and order", async () => {
        const current = await manySources();
        const identities = current.sources.map(source => ({ id: randomUUID(), teamId: current.team.id,
            directorySourceId: source.id, externalUserId: "person", externalSubjectId: "subject", state: "active" as const,
            lastSeenReconcileRunId: "complete-run",
        }));
        await db.teamProvisionedIdentity.createMany({ data: identities });
        const read = (tx: Tx) => readDirectoryProvisionedIdentityCandidatesInTx(tx, { teamId: current.team.id,
            match: { kind: "workos_directory", teamIdentityConnectionId: current.connections[0]!.id, externalSubjectId: "subject" },
        });
        await inTx(async tx => {
            const observed = observeAcquisitions(tx);
            const results = await read(observed.tx);
            const completeIds = new Set(current.sources.slice(2).map(source => source.id));
            expect(results.map(result => result.id)).toEqual(identities.filter(identity => completeIds.has(identity.directorySourceId))
                .sort((left, right) => left.directorySourceId.localeCompare(right.directorySourceId)).map(identity => identity.id));
            expect(observed.reads.filter(event => event.model === "teamDirectorySource" && event.method === "findUnique")).toHaveLength(0);
        });
        await db.identityProviderInstance.update({ where: { id: current.providers[0]!.id }, data: { enabled: false } });
        await expect(inTx(read)).resolves.toEqual([]);
    });

    it("keeps distinct GitHub identity and directory secret requirements in a combined admission read", async () => {
        await db.homeGovernancePolicy.update({ where: { id: "home" }, data: { teamProviderPolicy: {
            v: 1, allowedTeamProviderKinds: ["workos_sso", "github_app_identity"],
            teamJitAllowed: true, approvedGitHubEnterpriseOrigins: [],
        } } });
        const team = await db.team.create({ data: { name: "Combined GitHub admission" } });
        const registrationId = randomUUID();
        const secrets = { v: 1 as const, clientSecret: "test-client", privateKey: "test-key" };
        const registration = await db.gitHubAppRegistration.create({ data: {
            id: registrationId, githubHost: "https://github.com",
            githubAppId: BigInt(`0x${registrationId.replaceAll("-", "").slice(0, 12)}`), githubClientId: "Iv1.admission",
            config: { v: 1, secretHealth: { clientSecretConfigured: true, privateKeyConfigured: true, webhookSecretConfigured: false } },
            encryptedSecrets: encryptGitHubAppRegistrationSecretsV1({ registrationId, secrets }),
            state: "verified", securityRevision: 4, lastVerifiedAt: new Date(),
        } });
        const installation = await db.gitHubAppInstallation.create({ data: {
            registrationId, githubInstallationId: 2301n, githubOrganizationId: 2401n,
            githubOrganizationLogin: "Admission", repositorySelection: "all", state: "verified", revision: 5,
            verifiedPermissions: { members: "read" }, lastVerifiedAt: new Date(),
        } });
        const provider = await db.identityProviderInstance.create({ data: {
            ownerTeamId: team.id, kind: "github_app_identity", displayName: "Admission GitHub", enabled: true,
            config: { v: 1, kind: "github_app_identity" }, githubAppInstallationId: installation.id,
        } });
        await db.teamIdentityConnection.create({ data: {
            teamId: team.id, providerInstanceId: provider.id, enabled: true,
            externalReference: { v: 1, kind: "github_app_identity", installationId: installation.id },
            settings: { v: 1, kind: "github_app_identity", organizationLogin: "Admission" },
        } });
        await db.teamDirectorySource.create({ data: {
            teamId: team.id, kind: "github_organization", state: "active", displayName: "Admission GitHub directory",
            githubAppInstallationId: installation.id, externalSourceKey: randomUUID(),
            bindingConfig: { v: 1, kind: "github_organization", githubOrganizationLogin: "Admission" },
        } });
        for (const clientSecretConfigured of [true, false]) {
            if (!clientSecretConfigured) await db.gitHubAppRegistration.update({ where: { id: registration.id }, data: {
                encryptedSecrets: encryptGitHubAppRegistrationSecretsV1({ registrationId, secrets: { v: 1, privateKey: "test-key" } }),
            } });
            const decryptions = vi.spyOn(encryption, "decryptString");
            try {
                const result = await inTx(tx => resolveTeamAdmissionModeApplicabilityInTx({ tx, env, teamId: team.id }));
                const registrationDecryptions = decryptions.mock.calls.filter(([path]) => path[1] === "github_app_registration"
                    && path[2] === registration.id).length;
                console.info("TEAM_ADMISSION_GITHUB_DECRYPTIONS", JSON.stringify({ clientSecretConfigured, registrationDecryptions }));
                expect(result.modes.provisioned).toEqual({ status: "available" });
                expect(result.modes.jit.status).toBe(clientSecretConfigured ? "available" : "unavailable");
                expect(registrationDecryptions).toBe(1);
            } finally { decryptions.mockRestore(); }
        }
    });
});
