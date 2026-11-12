import { afterEach, describe, expect, it, vi } from "vitest";
import type { Tx } from "@/storage/inTx";
import { homeConfigSnapshotPostgresQueryMock } from "@/app/home/settings/homeConfigSnapshot.testkit";

import {
    isDirectorySourceAllowedInTx,
    isDirectorySourceCompletedEvidenceAllowedInTx,
    isDirectorySourceProjectionComplete,
} from "./directorySourcePolicy";
import { resolveTeamAdmissionModeApplicabilityInTx } from "../identity/teamAdmissionModeApplicability";

describe("directory source completed evidence", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("accepts only an active source with no observation attempt in flight", () => {
        expect(isDirectorySourceProjectionComplete({ state: "active", activeReconcileRunId: null })).toBe(true);
        expect(isDirectorySourceProjectionComplete({ state: "active", activeReconcileRunId: "attempt-1" })).toBe(false);
        expect(isDirectorySourceProjectionComplete({ state: "initializing", activeReconcileRunId: null })).toBe(false);
        expect(isDirectorySourceProjectionComplete({ state: "needs_attention", activeReconcileRunId: null })).toBe(false);
        expect(isDirectorySourceProjectionComplete({ state: "paused", activeReconcileRunId: null })).toBe(false);
    });

    it.each(["team", "home"] as const)("rereads the current %s provider without coupling directory eligibility to Team SSO enablement", async (owner) => {
        vi.stubEnv("HAPPIER_FEATURE_TEAMS__ENABLED", "1");
        const source = {
            id: "source", teamId: "team", kind: "workos_directory" as const,
            state: "active" as const, activeReconcileRunId: null, teamIdentityConnectionId: "connection",
        };
        const provider = {
            id: "provider", ownerTeamId: owner === "team" ? "team" : null,
            kind: "workos_sso", config: { v: 1, kind: "workos_sso" }, displayName: "WorkOS",
            enabled: true, firstEnabledAt: null, securityRevision: 1, revision: 1,
            lastSuccessfulTestAt: null, lastSuccessfulTestRuntimeFingerprint: null,
            lastSuccessfulTestSecurityRevision: null, encryptedSecrets: null,
            githubAppInstallationId: null, createdByAccountId: null,
            createdAt: new Date("2026-09-26T00:00:00Z"), updatedAt: new Date("2026-09-26T00:00:00Z"),
        };
        const connection = {
            id: "connection", teamId: "team", providerInstanceId: "provider", enabled: false,
            firstEnabledAt: new Date("2026-09-26T00:00:00Z"), revision: 1,
            externalReference: { v: 1, kind: "workos_sso", organizationId: "org_team", connectionId: "conn_team" },
            settings: { v: 1, kind: "workos_sso" }, lastObservation: null,
            lastSuccessfulTestAt: null, createdByAccountId: null,
            createdAt: provider.createdAt, updatedAt: provider.updatedAt,
        };
        // Typed persistence-boundary fixture; policy, provider parsing and
        // runtime eligibility are real. Transactional effects have a SQLite test.
        const tx = {
            ...homeConfigSnapshotPostgresQueryMock,
            homeGovernancePolicy: { findUnique: async () => null },
            // No stored Home settings row: the deployment env decides every feature bit.
            homeSettings: { findUnique: async () => null },
            teamDirectorySource: { findUnique: async () => source, findMany: async () => [source] },
            teamIdentityConnection: {
                findFirst: async () => connection, findMany: async () => [connection], count: async () => 1,
            },
            identityProviderInstance: {
                findUnique: async () => provider,
                findMany: async () => [provider],
            },
        } as unknown as Tx;
        expect(await isDirectorySourceCompletedEvidenceAllowedInTx(tx, source)).toBe(true);
        provider.enabled = false;
        expect(await isDirectorySourceCompletedEvidenceAllowedInTx(tx, source)).toBe(false);
        expect((await resolveTeamAdmissionModeApplicabilityInTx({ tx, env: {}, teamId: "team" })).modes.provisioned)
            .toEqual({ status: "unavailable", reason: "team_connection_unavailable" });
        provider.enabled = true;
        expect(await isDirectorySourceCompletedEvidenceAllowedInTx(tx, source)).toBe(true);
    });

    it("rejects a GitHub projection when its read tuple is no longer current", async () => {
        vi.stubEnv("HAPPIER_FEATURE_TEAMS__ENABLED", "1");
        const source = {
            id: "github-source",
            teamId: "team",
            kind: "github_organization" as const,
            state: "active" as const,
            activeReconcileRunId: null,
        };
        const tx = {
            ...homeConfigSnapshotPostgresQueryMock,
            homeGovernancePolicy: { findUnique: async () => null },
            // No stored Home settings row: the deployment env decides every feature bit.
            homeSettings: { findUnique: async () => null },
            teamDirectorySource: {
                findUnique: async () => ({
                    ...source,
                    githubAppInstallationId: "installation",
                    githubAppInstallation: {
                        id: "installation",
                        githubInstallationId: 901n,
                        githubOrganizationId: 42n,
                        revision: 2,
                        registration: { id: "registration", securityRevision: 1 },
                    },
                }),
            },
        } as unknown as Tx;

        await expect(isDirectorySourceAllowedInTx(tx, source, {
            kind: "github_directory_read",
            directorySourceId: source.id,
            githubInstallationId: 900n,
            registrationSecurityRevision: 1,
            installationRevision: 1,
            networkPolicyFingerprint: "network-v1",
            githubOrganizationId: 42n,
            organizationLogin: "acme",
        })).resolves.toBe(false);
    });
});
