import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AccountStatusV1, HomeRoleV1, HomeTeamProviderPolicyV1 } from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { resolveManagedIdentityNetworkPolicy } from "@/app/auth/providers/managed/managedIdentityNetworkPolicy";

import {
    HOME_GOVERNANCE_POLICY_ID,
    readHomeGovernancePolicy,
    resolveTeamProviderKindPolicy,
    setHomeGovernancePolicy,
    setHomeGovernancePolicyInTx,
} from "./governancePolicy";
import {
    PERSONAL_HOME_RUNTIME_PURPOSE,
    claimHomeOwnerInTx,
    reconcilePersonalHomeInitialOwnerInTx,
} from "./ownerAssignment";

let sequence = 0;
let harness: LightSqliteHarness;

async function createAccount(
    homeRole: HomeRoleV1 = "member",
    status: AccountStatusV1 = "active",
): Promise<string> {
    sequence += 1;
    const created = await db.account.create({
        data: { publicKey: `home-policy-${sequence}`, homeRole, status },
        select: { id: true },
    });
    return created.id;
}

const POLICY_ENV: NodeJS.ProcessEnv = {
    HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1",
};

beforeAll(async () => {
    harness = await createLightSqliteHarness({
        tempDirPrefix: "happier-home-governance-policy-",
        initAuth: false,
        initEncrypt: false,
        initFiles: false,
    });
});
afterAll(async () => await harness.close());
afterEach(async () => {
    await db.homeGovernancePolicy.deleteMany({});
    await db.account.deleteMany({});
});

describe("Home governance policy singleton", () => {
    it("reads the restrictive deployment default without writing a row", async () => {
        await expect(readHomeGovernancePolicy()).resolves.toEqual({
            revision: 0,
            teamCreationPolicy: "managed_only",
            teamsVisibleToMembers: true,
            authentication: { status: "inherited" },
            teamProviders: { status: "inherited" },
            identityNetwork: { status: "inherited" },
        });
        await expect(db.homeGovernancePolicy.count()).resolves.toBe(0);
    });

    it("creates the row on the first patch and advances the revision", async () => {
        const owner = await createAccount("owner");
        const created = await inTx(async (tx) => await setHomeGovernancePolicyInTx(tx, {
            emailDeliveryReady: false,
            actorAccountId: owner,
            env: POLICY_ENV,
            patch: { expectedRevision: 0, teamCreationPolicy: "self_service" },
        }));
        expect(created).toEqual({
            status: "applied",
            policy: {
                revision: 1,
                teamCreationPolicy: "self_service",
                teamsVisibleToMembers: true,
                authentication: { status: "inherited" },
                teamProviders: { status: "inherited" },
                identityNetwork: { status: "inherited" },
            },
        });

        const narrowed = await inTx(async (tx) => await setHomeGovernancePolicyInTx(tx, {
            emailDeliveryReady: false,
            actorAccountId: owner,
            env: POLICY_ENV,
            patch: { expectedRevision: 1, authenticationPolicy: { v: 1, admission: "invitation_only" } },
        }));
        expect(narrowed).toEqual({
            status: "applied",
            policy: {
                revision: 2,
                teamCreationPolicy: "self_service",
                teamsVisibleToMembers: true,
                authentication: { status: "narrowed", policy: { v: 1, admission: "invitation_only" } },
                teamProviders: { status: "inherited" },
                identityNetwork: { status: "inherited" },
            },
        });
    });

    it("inherits the deployment ceiling for a fresh Home and fails an unreadable ceiling closed", async () => {
        // Absent policy means "inherit the deployment ceiling" (teams-lane-01/02 :230, :234):
        // the Home adds no narrowing, while each provider kind's deployment runtime still
        // decides whether it can actually be set up.
        const inherited = await readHomeGovernancePolicy();
        expect(inherited.teamProviders).toEqual({ status: "inherited" });
        expect(resolveTeamProviderKindPolicy(inherited, "oidc")).toBe("allowed");
        expect(resolveTeamProviderKindPolicy(inherited, "workos_sso")).toBe("allowed");

        await db.homeGovernancePolicy.create({
            data: {
                id: HOME_GOVERNANCE_POLICY_ID,
                teamProviderPolicy: { v: 999, allowedTeamProviderKinds: ["oidc"] },
            },
        });
        const unreadable = await readHomeGovernancePolicy();
        expect(resolveTeamProviderKindPolicy(unreadable, "oidc")).toBe("unavailable");
    });

    it("lets a fresh Home save its first Team-provider narrowing within the deployment ceiling", async () => {
        const owner = await createAccount("owner");
        // This deployment serves managed OIDC/GitHub callbacks but has no WorkOS platform.
        const env = { ...POLICY_ENV, HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test" };
        const beyondCeiling = await inTx(async (tx) => await setHomeGovernancePolicyInTx(tx, {
            emailDeliveryReady: false,
            actorAccountId: owner,
            env,
            patch: {
                expectedRevision: 0,
                teamProviderPolicy: {
                    v: 1,
                    allowedTeamProviderKinds: ["oidc", "workos_sso"],
                    teamJitAllowed: false,
                    approvedGitHubEnterpriseOrigins: [],
                },
            },
        }));
        expect(beyondCeiling).toEqual({ status: "invalid_policy" });
        await expect(db.homeGovernancePolicy.count()).resolves.toBe(0);

        const providerPolicy: HomeTeamProviderPolicyV1 = {
            v: 1,
            allowedTeamProviderKinds: ["oidc", "github_app_identity"],
            teamJitAllowed: true,
            approvedGitHubEnterpriseOrigins: ["https://github.corp.example:8443"],
        };
        const created = await inTx(async (tx) => await setHomeGovernancePolicyInTx(tx, {
            emailDeliveryReady: false,
            actorAccountId: owner,
            env,
            patch: { expectedRevision: 0, teamProviderPolicy: providerPolicy },
        }));
        expect(created).toMatchObject({
            status: "applied",
            policy: { revision: 1, teamProviders: { status: "narrowed", policy: providerPolicy } },
        });
        if (created.status !== "applied") throw new Error("expected the first narrowing to apply");
        expect(resolveTeamProviderKindPolicy(created.policy, "oidc")).toBe("allowed");
        expect(resolveTeamProviderKindPolicy(created.policy, "workos_sso")).toBe("prohibited");

        // Resetting to inheritance is always a recoverable write.
        await expect(inTx(async (tx) => await setHomeGovernancePolicyInTx(tx, {
            emailDeliveryReady: false,
            actorAccountId: owner,
            env,
            patch: { expectedRevision: 1, teamProviderPolicy: null },
        }))).resolves.toMatchObject({ status: "applied", policy: { revision: 2, teamProviders: { status: "inherited" } } });
    });

    it("recovers an unreadable Team-provider policy by writing a valid narrowing", async () => {
        const owner = await createAccount("owner");
        await db.homeGovernancePolicy.create({
            data: {
                id: HOME_GOVERNANCE_POLICY_ID,
                revision: 3,
                teamProviderPolicy: { v: 999, allowedTeamProviderKinds: ["oidc"] },
            },
        });
        const providerPolicy: HomeTeamProviderPolicyV1 = {
            v: 1,
            allowedTeamProviderKinds: ["oidc"],
            teamJitAllowed: false,
            approvedGitHubEnterpriseOrigins: [],
        };
        await expect(inTx(async (tx) => await setHomeGovernancePolicyInTx(tx, {
            emailDeliveryReady: false,
            actorAccountId: owner,
            env: { ...POLICY_ENV, HAPPIER_PUBLIC_SERVER_URL: "https://home.example.test" },
            patch: { expectedRevision: 3, teamProviderPolicy: providerPolicy },
        }))).resolves.toMatchObject({
            status: "applied",
            policy: { revision: 4, teamProviders: { status: "narrowed", policy: providerPolicy } },
        });
    });

    it("preserves edits to an already narrowed Team-provider policy", async () => {
        const owner = await createAccount("owner");
        await db.homeGovernancePolicy.create({
            data: {
                id: HOME_GOVERNANCE_POLICY_ID,
                revision: 4,
                teamProviderPolicy: {
                    v: 1,
                    allowedTeamProviderKinds: ["oidc"],
                    teamJitAllowed: false,
                    approvedGitHubEnterpriseOrigins: [],
                },
            },
        });
        const providerPolicy: HomeTeamProviderPolicyV1 = {
            v: 1,
            allowedTeamProviderKinds: ["oidc"],
            teamJitAllowed: false,
            approvedGitHubEnterpriseOrigins: ["https://github.corp.example:8443"],
        };

        const result = await inTx(async (tx) => await setHomeGovernancePolicyInTx(tx, {
            emailDeliveryReady: false,
            actorAccountId: owner,
            env: POLICY_ENV,
            patch: { expectedRevision: 4, teamProviderPolicy: providerPolicy },
        }));

        expect(result).toMatchObject({
            status: "applied",
            policy: { revision: 5, teamProviders: { status: "narrowed", policy: providerPolicy } },
        });
    });

    it("rejects malformed identity-network CIDRs before creating the policy row", async () => {
        const owner = await createAccount("owner");

        const result = await inTx(async (tx) => await setHomeGovernancePolicyInTx(tx, {
            emailDeliveryReady: false,
            actorAccountId: owner,
            env: {
                ...POLICY_ENV,
                HAPPIER_FEATURE_AUTH_MANAGED_IDENTITY__PRIVATE_NETWORK_ENABLED: "1",
            },
            patch: {
                expectedRevision: 0,
                identityNetworkPolicy: {
                    v: 1,
                    mode: "private_allowlist",
                    hostnames: ["issuer.internal.example"],
                    cidrs: ["not-a-cidr"],
                    ports: [443],
                },
            },
        }));

        expect(result).toEqual({ status: "invalid_policy" });
        await expect(db.homeGovernancePolicy.count()).resolves.toBe(0);
        await expect(readHomeGovernancePolicy()).resolves.toMatchObject({
            revision: 0,
            identityNetwork: { status: "inherited" },
        });
    });

    it("rejects a private identity-network policy outside the deployment ceiling without advancing revision", async () => {
        const owner = await createAccount("owner");
        const created = await inTx(async (tx) => await setHomeGovernancePolicyInTx(tx, {
            emailDeliveryReady: false,
            actorAccountId: owner,
            env: POLICY_ENV,
            patch: {
                expectedRevision: 0,
                identityNetworkPolicy: { v: 1, mode: "public_only" },
            },
        }));
        expect(created).toMatchObject({ status: "applied", policy: { revision: 1 } });

        const result = await inTx(async (tx) => await setHomeGovernancePolicyInTx(tx, {
            emailDeliveryReady: false,
            actorAccountId: owner,
            env: POLICY_ENV,
            patch: {
                expectedRevision: 1,
                identityNetworkPolicy: {
                    v: 1,
                    mode: "private_allowlist",
                    hostnames: ["issuer.internal.example"],
                    cidrs: ["10.20.0.0/16"],
                    ports: [443],
                },
            },
        }));

        expect(result).toEqual({ status: "invalid_policy" });
        await expect(readHomeGovernancePolicy()).resolves.toMatchObject({
            revision: 1,
            identityNetwork: {
                status: "narrowed",
                policy: { v: 1, mode: "public_only" },
            },
        });
    });

    it("persists a valid private identity-network policy when the deployment ceiling permits it", async () => {
        const owner = await createAccount("owner");
        const enabledEnv = {
            ...POLICY_ENV,
            HAPPIER_FEATURE_AUTH_MANAGED_IDENTITY__PRIVATE_NETWORK_ENABLED: "true",
        };
        const policy = {
            v: 1 as const,
            mode: "private_allowlist" as const,
            hostnames: ["issuer.internal.example"],
            cidrs: ["10.20.0.0/16"],
            ports: [443],
        };

        const result = await inTx(async (tx) => await setHomeGovernancePolicyInTx(tx, {
            emailDeliveryReady: false,
            actorAccountId: owner,
            env: enabledEnv,
            patch: { expectedRevision: 0, identityNetworkPolicy: policy },
        }));

        expect(result).toMatchObject({
            status: "applied",
            policy: {
                revision: 1,
                identityNetwork: { status: "narrowed", policy },
            },
        });
        if (result.status !== "applied") throw new Error("expected applied policy");
        expect(resolveManagedIdentityNetworkPolicy({
            env: enabledEnv,
            timeoutSeconds: 30,
            home: result.policy,
        }).policy.address).toEqual({
            kind: "privateAllowlist",
            hostnames: policy.hostnames,
            cidrs: policy.cidrs,
        });
        expect(resolveManagedIdentityNetworkPolicy({
            env: POLICY_ENV,
            timeoutSeconds: 30,
            home: result.policy,
        }).policy.address).toEqual({ kind: "publicOnly" });
    });

    it("refuses a stale revision and preserves the current policy", async () => {
        const owner = await createAccount("owner");
        await inTx(async (tx) => await setHomeGovernancePolicyInTx(tx, {
            emailDeliveryReady: false,
            actorAccountId: owner,
            env: POLICY_ENV,
            patch: { expectedRevision: 0, teamCreationPolicy: "self_service" },
        }));

        const conflict = await inTx(async (tx) => await setHomeGovernancePolicyInTx(tx, {
            emailDeliveryReady: false,
            actorAccountId: owner,
            env: POLICY_ENV,
            patch: { expectedRevision: 0, teamCreationPolicy: "disabled" },
        }));
        expect(conflict).toEqual({
            status: "revision_conflict",
            policy: {
                revision: 1,
                teamCreationPolicy: "self_service",
                teamsVisibleToMembers: true,
                authentication: { status: "inherited" },
                teamProviders: { status: "inherited" },
                identityNetwork: { status: "inherited" },
            },
        });
        await expect(readHomeGovernancePolicy()).resolves.toMatchObject({
            revision: 1,
            teamCreationPolicy: "self_service",
        });
    });

    it("reports a stale authentication-policy editor as a revision conflict before validating its draft", async () => {
        const owner = await createAccount("owner");
        await inTx(async (tx) => await setHomeGovernancePolicyInTx(tx, {
            emailDeliveryReady: false,
            actorAccountId: owner,
            env: POLICY_ENV,
            patch: { expectedRevision: 0, teamCreationPolicy: "self_service" },
        }));

        const conflict = await inTx(async (tx) => await setHomeGovernancePolicyInTx(tx, {
            emailDeliveryReady: false,
            actorAccountId: owner,
            env: POLICY_ENV,
            patch: {
                expectedRevision: 0,
                authenticationPolicy: { v: 1, enabledMethodIds: ["unknown-method"] },
            },
        }));

        expect(conflict).toEqual({
            status: "revision_conflict",
            policy: {
                revision: 1,
                teamCreationPolicy: "self_service",
                teamsVisibleToMembers: true,
                authentication: { status: "inherited" },
                teamProviders: { status: "inherited" },
                identityNetwork: { status: "inherited" },
            },
        });
        await expect(readHomeGovernancePolicy()).resolves.toMatchObject({
            revision: 1,
            authentication: { status: "inherited" },
        });
    });

    it("lets only one of two editors at the same revision win", async () => {
        const owner = await createAccount("owner");
        await inTx(async (tx) => await setHomeGovernancePolicyInTx(tx, {
            emailDeliveryReady: false,
            actorAccountId: owner,
            env: POLICY_ENV,
            patch: { expectedRevision: 0, teamCreationPolicy: "managed_only" },
        }));

        const outcomes = await Promise.all([
            inTx(async (tx) => await setHomeGovernancePolicyInTx(tx, {
                emailDeliveryReady: false,
                actorAccountId: owner,
                env: POLICY_ENV,
                patch: { expectedRevision: 1, teamCreationPolicy: "self_service" },
            }), { isolationLevel: "Serializable" }),
            inTx(async (tx) => await setHomeGovernancePolicyInTx(tx, {
                emailDeliveryReady: false,
                actorAccountId: owner,
                env: POLICY_ENV,
                patch: { expectedRevision: 1, teamCreationPolicy: "disabled" },
            }), { isolationLevel: "Serializable" }),
        ]);

        expect(outcomes.filter((outcome) => outcome.status === "applied")).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome.status === "revision_conflict")).toHaveLength(1);
        await expect(readHomeGovernancePolicy()).resolves.toMatchObject({ revision: 2 });
    });

    it("settles two concurrent first-writer CAS attempts after the losing transaction rolls back", async () => {
        const owner = await createAccount("owner");
        const outcomes = await Promise.all([
            setHomeGovernancePolicy({
                actorAccountId: owner,
                env: POLICY_ENV,
                patch: { expectedRevision: 0, teamCreationPolicy: "self_service" },
            }),
            setHomeGovernancePolicy({
                actorAccountId: owner,
                env: POLICY_ENV,
                patch: { expectedRevision: 0, teamCreationPolicy: "disabled" },
            }),
        ]);

        expect(outcomes.filter((outcome) => outcome.status === "applied")).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome.status === "revision_conflict")).toHaveLength(1);
        await expect(readHomeGovernancePolicy()).resolves.toMatchObject({ revision: 1 });
    });

    it("checks every changed field before applying any of them", async () => {
        const admin = await createAccount("admin");
        const rejected = await inTx(async (tx) => await setHomeGovernancePolicyInTx(tx, {
            emailDeliveryReady: false,
            actorAccountId: admin,
            env: POLICY_ENV,
            patch: {
                expectedRevision: 0,
                teamCreationPolicy: "self_service",
                authenticationPolicy: { v: 1, admission: "closed" },
            },
        }));

        expect(rejected).toEqual({ status: "forbidden" });
        await expect(db.homeGovernancePolicy.count()).resolves.toBe(0);
        await expect(readHomeGovernancePolicy()).resolves.toMatchObject({ teamCreationPolicy: "managed_only" });
    });

    it("clears an authentication narrowing back to inheritance", async () => {
        const owner = await createAccount("owner");
        await inTx(async (tx) => await setHomeGovernancePolicyInTx(tx, {
            emailDeliveryReady: false,
            actorAccountId: owner,
            env: POLICY_ENV,
            patch: { expectedRevision: 0, authenticationPolicy: { v: 1, admission: "closed" } },
        }));

        const cleared = await inTx(async (tx) => await setHomeGovernancePolicyInTx(tx, {
            emailDeliveryReady: false,
            actorAccountId: owner,
            env: POLICY_ENV,
            // Clearing a narrowing re-offers what it closed: a widening the owner confirms (§3.4).
            patch: { expectedRevision: 1, confirmWidening: true, authenticationPolicy: null },
        }));
        expect(cleared).toMatchObject({
            status: "applied",
            policy: { revision: 2, authentication: { status: "inherited" } },
        });
    });

    it("rejects a policy that strands an active member even while the owner keeps a route", async () => {
        const owner = await createAccount("owner");
        sequence += 1;
        const member = await db.account.create({
            data: {
                publicKey: null,
                homeRole: "member",
                status: "active",
                encryptionMode: "plain",
                AccountIdentity: {
                    create: {
                        provider: "email",
                        providerUserId: `member-password-only-${sequence}@example.test`,
                        eligibilityStatus: "eligible",
                    },
                },
                AccountPasswordCredential: {
                    create: {
                        credential: { v: 1, kind: "plain_password_hash", hash: "test-only" },
                    },
                },
            },
            select: { id: true },
        });

        const result = await inTx(async (tx) => await setHomeGovernancePolicyInTx(tx, {
            emailDeliveryReady: false,
            actorAccountId: owner,
            env: {
                ...POLICY_ENV,
                HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: "1",
                HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            },
            patch: {
                expectedRevision: 0,
                authenticationPolicy: { v: 1, enabledMethodIds: ["key_challenge"] },
            },
        }));

        expect(result).toEqual({ status: "invalid_policy" });
        await expect(db.account.findUnique({ where: { id: member.id } })).resolves.not.toBeNull();
        await expect(db.homeGovernancePolicy.count()).resolves.toBe(0);
    });

    it("rejects a policy that strands the last active Home administrator", async () => {
        sequence += 1;
        const owner = await db.account.create({
            data: {
                publicKey: null,
                homeRole: "owner",
                status: "active",
                encryptionMode: "plain",
                AccountIdentity: {
                    create: {
                        provider: "email",
                        providerUserId: `last-admin-password-only-${sequence}@example.test`,
                        eligibilityStatus: "eligible",
                    },
                },
                AccountPasswordCredential: {
                    create: {
                        credential: { v: 1, kind: "plain_password_hash", hash: "test-only" },
                    },
                },
            },
            select: { id: true },
        });

        const result = await inTx(async (tx) => await setHomeGovernancePolicyInTx(tx, {
            emailDeliveryReady: false,
            actorAccountId: owner.id,
            env: {
                ...POLICY_ENV,
                HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: "1",
                HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            },
            patch: {
                expectedRevision: 0,
                authenticationPolicy: { v: 1, enabledMethodIds: ["key_challenge"] },
            },
        }));

        expect(result).toEqual({ status: "invalid_policy" });
        await expect(db.account.findUnique({ where: { id: owner.id } })).resolves.not.toBeNull();
        await expect(db.homeGovernancePolicy.count()).resolves.toBe(0);
    });

    it("allows an already-stranded Home to repair its authentication policy", async () => {
        sequence += 1;
        const owner = await db.account.create({
            data: {
                publicKey: null,
                homeRole: "owner",
                status: "active",
                encryptionMode: "plain",
                AccountIdentity: {
                    create: {
                        provider: "email",
                        providerUserId: `stranded-owner-${sequence}@example.test`,
                        eligibilityStatus: "eligible",
                    },
                },
                AccountPasswordCredential: {
                    create: {
                        credential: { v: 1, kind: "plain_password_hash", hash: "test-only" },
                    },
                },
            },
            select: { id: true },
        });
        await db.homeGovernancePolicy.create({
            data: {
                id: HOME_GOVERNANCE_POLICY_ID,
                revision: 1,
                authenticationPolicy: { v: 1, enabledMethodIds: ["key_challenge"] },
            },
        });

        const repaired = await inTx(async (tx) => await setHomeGovernancePolicyInTx(tx, {
            emailDeliveryReady: false,
            actorAccountId: owner.id,
            env: {
                ...POLICY_ENV,
                HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: "1",
                HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            },
            patch: {
                expectedRevision: 1,
                // Repairing restores a sign-in route, which widens: the owner confirms it (§3.4).
                confirmWidening: true,
                authenticationPolicy: { v: 1, enabledMethodIds: ["email_password"] },
            },
        }));

        expect(repaired).toMatchObject({
            status: "applied",
            policy: {
                revision: 2,
                authentication: {
                    status: "narrowed",
                    policy: { enabledMethodIds: ["email_password"] },
                },
            },
        });
    });

    it("never reads a stored document it cannot parse as inherited or self-service", async () => {
        await db.homeGovernancePolicy.create({
            data: {
                id: HOME_GOVERNANCE_POLICY_ID,
                revision: 4,
                teamCreationPolicy: "managed_only",
                authenticationPolicy: { v: 9, enabledMethodIds: [] },
            },
        });

        await expect(readHomeGovernancePolicy()).resolves.toEqual({
            revision: 4,
            teamCreationPolicy: "managed_only",
            teamsVisibleToMembers: true,
            authentication: { status: "unreadable" },
            teamProviders: { status: "inherited" },
            identityNetwork: { status: "inherited" },
        });
    });
});

describe("Zero-owner claim service", () => {
    it("assigns one explicit active Account as the first owner", async () => {
        const account = await createAccount("member");

        await expect(inTx(async (tx) => await claimHomeOwnerInTx(tx, { targetAccountId: account, via: "deployment_command" })))
            .resolves.toEqual({ status: "claimed", ownerAccountId: account });
        await expect(db.account.findUniqueOrThrow({ where: { id: account }, select: { homeRole: true } }))
            .resolves.toEqual({ homeRole: "owner" });
    });

    it("keeps trusted Account creation, owner claim, and invalidation in one transaction", async () => {
        sequence += 1;
        const publicKey = `managed-home-provision-${sequence}`;
        let rolledBackAccountId = "";

        await expect(inTx(async (tx) => {
            const account = await tx.account.create({
                data: { publicKey, homeRole: "member", status: "active", encryptionMode: "plain" },
                select: { id: true },
            });
            rolledBackAccountId = account.id;
            await expect(claimHomeOwnerInTx(tx, { targetAccountId: account.id, via: "deployment_command" }))
                .resolves.toEqual({ status: "claimed", ownerAccountId: account.id });
            throw new Error("simulate provisioner failure after owner claim");
        }, { isolationLevel: "Serializable" })).rejects.toThrow("simulate provisioner failure");

        expect(rolledBackAccountId).not.toBe("");
        await expect(db.account.findUnique({ where: { id: rolledBackAccountId } })).resolves.toBeNull();
        await expect(db.accountChange.count({ where: { accountId: rolledBackAccountId } })).resolves.toBe(0);

        const committed = await inTx(async (tx) => {
            const account = await tx.account.create({
                data: { publicKey, homeRole: "member", status: "active", encryptionMode: "plain" },
                select: { id: true },
            });
            return {
                accountId: account.id,
                claim: await claimHomeOwnerInTx(tx, { targetAccountId: account.id, via: "deployment_command" }),
            };
        }, { isolationLevel: "Serializable" });

        expect(committed.claim).toEqual({ status: "claimed", ownerAccountId: committed.accountId });
        await expect(db.account.findUniqueOrThrow({
            where: { id: committed.accountId },
            select: { homeRole: true, status: true },
        })).resolves.toEqual({ homeRole: "owner", status: "active" });
        await expect(db.accountChange.count({ where: { accountId: committed.accountId } })).resolves.toBe(1);
    });

    it("refuses an inactive or absent target", async () => {
        const suspended = await createAccount("member", "suspended");
        const retired = await createAccount("member", "disabled");

        await expect(inTx(async (tx) => await claimHomeOwnerInTx(tx, { targetAccountId: suspended, via: "deployment_command" })))
            .resolves.toEqual({ status: "target_inactive" });
        await expect(inTx(async (tx) => await claimHomeOwnerInTx(tx, { targetAccountId: retired, via: "deployment_command" })))
            .resolves.toEqual({ status: "target_inactive" });
        await expect(inTx(async (tx) => await claimHomeOwnerInTx(tx, { targetAccountId: "missing", via: "deployment_command" })))
            .resolves.toEqual({ status: "target_not_found" });
        await expect(db.account.count({ where: { homeRole: "owner" } })).resolves.toBe(0);
    });

    it("refuses to claim a Home that already has an active owner", async () => {
        await createAccount("owner");
        const other = await createAccount("member");

        await expect(inTx(async (tx) => await claimHomeOwnerInTx(tx, { targetAccountId: other, via: "deployment_command" })))
            .resolves.toEqual({ status: "already_owned", activeOwnerCount: 1 });
        await expect(db.account.findUniqueOrThrow({ where: { id: other }, select: { homeRole: true } }))
            .resolves.toEqual({ homeRole: "member" });
    });

    it("still claims when the only owner row is inactive, which is the recovery path", async () => {
        await createAccount("owner", "disabled");
        const candidate = await createAccount("member");

        await expect(inTx(async (tx) => await claimHomeOwnerInTx(tx, { targetAccountId: candidate, via: "deployment_command" })))
            .resolves.toEqual({ status: "claimed", ownerAccountId: candidate });
    });

    it("yields exactly one owner transition under concurrent claims", async () => {
        const first = await createAccount("member");
        const second = await createAccount("member");

        const outcomes = await Promise.all([
            inTx(async (tx) => await claimHomeOwnerInTx(tx, { targetAccountId: first, via: "deployment_command" }), { isolationLevel: "Serializable" }),
            inTx(async (tx) => await claimHomeOwnerInTx(tx, { targetAccountId: second, via: "deployment_command" }), { isolationLevel: "Serializable" }),
        ]);

        expect(outcomes.filter((outcome) => outcome.status === "claimed")).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome.status === "already_owned")).toHaveLength(1);
        await expect(db.account.count({ where: { homeRole: "owner", status: "active" } })).resolves.toBe(1);
    });
});

describe("Personal Home initial owner reconciliation", () => {
    it("refuses any runtime that is not positively a Personal Home", async () => {
        const account = await createAccount("member");

        for (const runtimePurpose of [null, "", "personal_home", "generic-relay"]) {
            await expect(inTx(async (tx) => await reconcilePersonalHomeInitialOwnerInTx(tx, {
                runtimePurpose,
                accountId: account,
            }))).resolves.toEqual({ status: "not_personal_home" });
        }
        await expect(db.account.count({ where: { homeRole: "owner" } })).resolves.toBe(0);
    });

    it("assigns the sole bootstrap Account and then does nothing", async () => {
        const account = await createAccount("member");

        await expect(inTx(async (tx) => await reconcilePersonalHomeInitialOwnerInTx(tx, {
            runtimePurpose: PERSONAL_HOME_RUNTIME_PURPOSE,
            accountId: account,
        }))).resolves.toEqual({ status: "claimed", ownerAccountId: account });

        const invited = await createAccount("member");
        await expect(inTx(async (tx) => await reconcilePersonalHomeInitialOwnerInTx(tx, {
            runtimePurpose: PERSONAL_HOME_RUNTIME_PURPOSE,
            accountId: invited,
        }))).resolves.toEqual({ status: "already_owned", activeOwnerCount: 1 });
        await expect(db.account.findUniqueOrThrow({ where: { id: invited }, select: { homeRole: true } }))
            .resolves.toEqual({ homeRole: "member" });
    });

    it("never promotes an Account in a multi-Account ownerless Home", async () => {
        const first = await createAccount("member");
        await createAccount("member");

        await expect(inTx(async (tx) => await reconcilePersonalHomeInitialOwnerInTx(tx, {
            runtimePurpose: PERSONAL_HOME_RUNTIME_PURPOSE,
            accountId: first,
        }))).resolves.toEqual({ status: "setup_required", accountCount: 2 });
        await expect(db.account.count({ where: { homeRole: "owner" } })).resolves.toBe(0);
    });

    it("reconciles the sole active legacy Account even when retired Accounts remain", async () => {
        await createAccount("owner", "disabled");
        await createAccount("member", "suspended");
        const soleActive = await createAccount("member", "active");

        await expect(inTx(async (tx) => await reconcilePersonalHomeInitialOwnerInTx(tx, {
            runtimePurpose: PERSONAL_HOME_RUNTIME_PURPOSE,
            accountId: soleActive,
        }))).resolves.toEqual({ status: "claimed", ownerAccountId: soleActive });
        await expect(db.account.findUniqueOrThrow({
            where: { id: soleActive },
            select: { homeRole: true },
        })).resolves.toEqual({ homeRole: "owner" });
    });

    it("reports setup required when no active legacy Account can own the Home", async () => {
        const suspended = await createAccount("member", "suspended");
        await createAccount("owner", "disabled");

        await expect(inTx(async (tx) => await reconcilePersonalHomeInitialOwnerInTx(tx, {
            runtimePurpose: PERSONAL_HOME_RUNTIME_PURPOSE,
            accountId: suspended,
        }))).resolves.toEqual({ status: "setup_required", accountCount: 0 });
        await expect(db.account.count({ where: { homeRole: "owner", status: "active" } })).resolves.toBe(0);
    });
});
