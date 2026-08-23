import axios from "axios";
import { buildProviderAccountUsageRecordId } from "@happier-dev/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from "@/api/clientCompatibility/cliClientCompatibility";

import {
    acquireQualifiedConnectedAccountRefreshLeaseV4,
    deleteQualifiedConnectedAccountCredentialV4,
    listQualifiedConnectedAccountGroupsV4,
    listQualifiedConnectedAccountsV4,
    mutateQualifiedConnectedAccountCredentialHealthV4,
    mutateQualifiedConnectedAccountConfigurationV4,
    readQualifiedConnectedAccountConfigurationV4,
    readQualifiedConnectedAccountCredentialV4,
    readQualifiedConnectedAccountGroupV4,
    readQualifiedConnectedAccountQuotaV4,
    requestQualifiedConnectedAccountQuotaRefreshV4,
    QualifiedConnectedAccountCredentialConflictError,
    QualifiedConnectedAccountGroupConflictError,
    mutateQualifiedConnectedAccountCredentialV4,
    updateQualifiedConnectedAccountGroupRuntimeStateV4,
    setQualifiedConnectedAccountGroupActiveAccountV4,
    unlinkQualifiedConnectedAccountQuotaV4,
    writeQualifiedProviderAccountUsageV4,
} from "./qualifiedConnectedAccountApi";

vi.mock("axios", () => ({
    default: {
        get: vi.fn(),
        patch: vi.fn(),
        post: vi.fn(),
        delete: vi.fn(),
    },
}));
vi.mock("./serverHttpBaseUrl", () => ({
    resolveServerHttpBaseUrl: () => "https://server.example",
}));
vi.mock("./connectedServicesServerApiTimeout", () => ({
    resolveConnectedServicesServerApiTimeoutMs: () => 1_000,
}));

const service = {
    pluginId: "example.connected-accounts",
    localId: "service/with/path",
} as const;

describe("qualified Connected Account V4 API", () => {
    beforeEach(() => {
        vi.mocked(axios.get).mockReset();
        vi.mocked(axios.patch).mockReset();
        vi.mocked(axios.post).mockReset();
        vi.mocked(axios.delete).mockReset();
    });

    it("uses the shared structured-query codec and validates the response", async () => {
        vi.mocked(axios.get).mockResolvedValue({
            status: 200,
            data: { service, accounts: [] },
        });

        await expect(listQualifiedConnectedAccountsV4({
            token: "token",
            service,
        })).resolves.toEqual({ service, accounts: [] });

        const [url] = vi.mocked(axios.get).mock.calls[0] ?? [];
        expect(url).toContain(
            "/v4/connect/qualified/accounts?service=%7B",
        );
        expect(url).toContain("service%2Fwith%2Fpath");
        const parsed = new URL(String(url));
        expect(parsed.searchParams.getAll("service")).toHaveLength(1);
    });

    it("uses exact structured group list/read queries", async () => {
        vi.mocked(axios.get)
            .mockResolvedValueOnce({
                status: 200,
                data: { groups: [] },
            })
            .mockResolvedValueOnce({
                status: 404,
                data: { error: "connect_group_not_found" },
            });

        await expect(listQualifiedConnectedAccountGroupsV4({
            token: "token",
            service,
        })).resolves.toEqual({ groups: [] });
        await expect(readQualifiedConnectedAccountGroupV4({
            token: "token",
            group: { service, groupId: "primary-group" },
        })).resolves.toBeNull();

        const listUrl = new URL(String(
            vi.mocked(axios.get).mock.calls[0]?.[0],
        ));
        const readUrl = new URL(String(
            vi.mocked(axios.get).mock.calls[1]?.[0],
        ));
        expect(listUrl.pathname).toBe(
            "/v4/connect/qualified/groups",
        );
        expect(listUrl.searchParams.getAll("service")).toHaveLength(1);
        expect(readUrl.pathname).toBe(
            "/v4/connect/qualified/group",
        );
        expect(readUrl.searchParams.getAll("group")).toHaveLength(1);
        expect(readUrl.searchParams.get("group")).toContain(
            "primary-group",
        );
    });

    it("sets the active qualified group account with runtime-state CAS", async () => {
        const group = {
            v: 1 as const,
            ref: { service, groupId: "primary-group" },
            incarnation: "qualified-group-row-primary",
            displayName: null,
            policy: {},
            activeConnectedAccountId: "provider/account",
            generation: 2,
            runtimeStateRevision: 3,
            state: {},
            createdAt: 100,
            updatedAt: 200,
            members: [],
        };
        vi.mocked(axios.post).mockResolvedValue({
            status: 200,
            data: { group },
        });

        await expect(setQualifiedConnectedAccountGroupActiveAccountV4({
            token: "token",
            mutation: {
                group: group.ref,
                connectedAccountId: "provider/account",
                expectedIncarnation: group.incarnation,
                expectedGeneration: 1,
                expectedRuntimeStateRevision: 2,
                expectedSource: {
                    connectedAccountId: "provider/current",
                    credentialRevision:
                        "csr_abcdefghijklmnopqrstuvwxyz",
                    configurationRevision: null,
                },
                overrideRuntimeCooldown: false,
            },
        })).resolves.toMatchObject(group);

        expect(vi.mocked(axios.post)).toHaveBeenCalledWith(
            "https://server.example/v4/connect/qualified/group/active-account",
            {
                group: group.ref,
                connectedAccountId: "provider/account",
                expectedIncarnation: group.incarnation,
                expectedGeneration: 1,
                expectedRuntimeStateRevision: 2,
                expectedSource: {
                    connectedAccountId: "provider/current",
                    credentialRevision:
                        "csr_abcdefghijklmnopqrstuvwxyz",
                    configurationRevision: null,
                },
                overrideRuntimeCooldown: false,
            },
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: "Bearer token",
                }),
            }),
        );
    });

    it("patches qualified group runtime state and exposes revision conflicts", async () => {
        const group = {
            v: 1 as const,
            ref: { service, groupId: "primary-group" },
            incarnation: "qualified-group-row-primary",
            displayName: null,
            policy: {},
            activeConnectedAccountId: "provider/account",
            generation: 2,
            runtimeStateRevision: 3,
            state: {},
            createdAt: 100,
            updatedAt: 200,
            members: [],
        };
        const patch = {
            service,
            groupId: group.ref.groupId,
            expectedIncarnation: group.incarnation,
            expectedRuntimeStateRevision: 2,
            runtimeState: {
                state: { status: "error" as const },
                memberStates: [{
                    connectedAccountId: "provider/account",
                    state: { status: "error" as const },
                }],
            },
        };
        vi.mocked(axios.patch)
            .mockResolvedValueOnce({
                status: 200,
                data: { group },
            })
            .mockResolvedValueOnce({
                status: 409,
                data: {
                    error:
                        "connect_group_runtime_state_revision_conflict",
                    runtimeStateRevision: 3,
                },
            });

        await expect(updateQualifiedConnectedAccountGroupRuntimeStateV4({
            token: "token",
            patch,
        })).resolves.toMatchObject(group);
        await expect(updateQualifiedConnectedAccountGroupRuntimeStateV4({
            token: "token",
            patch,
        })).rejects.toMatchObject({
            name: "QualifiedConnectedAccountGroupConflictError",
            status: 409,
            code: "connect_group_runtime_state_revision_conflict",
            runtimeStateRevision: 3,
            message:
                "connected_service_auth_group_runtime_state_revision_conflict",
        } satisfies Partial<QualifiedConnectedAccountGroupConflictError>);

        expect(vi.mocked(axios.patch).mock.calls[0]?.[0]).toBe(
            "https://server.example/v4/connect/qualified/group/runtime-state",
        );
        expect(vi.mocked(axios.patch).mock.calls[0]?.[1]).toEqual(patch);
    });

    it("preserves the server's closed credential-conflict discriminator at the HTTP boundary", async () => {
        // Every 409 the credential endpoint can return names a DIFFERENT cause.
        // Collapsing them into one settlement conflict hides capacity exhaustion
        // and identity/authentication-mode mismatch from the caller.
        const mutation = {
            ref: { service, accountId: "provider/account" },
            authenticationModeId: "token",
            expectedCredentialRevision: null,
            content: { t: "plain" as const, v: { token: "opaque" } },
            metadata: { scopes: [] },
        };
        for (const error of [
            "connect_connected_account_capacity_exhausted",
            "connect_reconnect_provider_identity_mismatch",
            "connect_authentication_mode_mismatch",
        ]) {
            vi.mocked(axios.post).mockResolvedValueOnce({ status: 409, data: { error } });
            await expect(mutateQualifiedConnectedAccountCredentialV4({
                token: "token",
                mutation,
            })).rejects.toMatchObject({
                name: "QualifiedConnectedAccountCredentialConflictError",
                status: 409,
                // The daemon's status-based policies read `response.status`;
                // keep the Axios-like shape so an unmapped cause still lands on
                // the shared 409 path instead of escaping as an unknown error.
                response: { status: 409 },
                code: error,
            } satisfies Partial<QualifiedConnectedAccountCredentialConflictError>);
        }

        vi.mocked(axios.post).mockResolvedValueOnce({ status: 409, data: { error: "not-a-known-code" } });
        await expect(mutateQualifiedConnectedAccountCredentialV4({
            token: "token",
            mutation,
        })).rejects.toMatchObject({
            name: "QualifiedConnectedAccountCredentialConflictError",
            status: 409,
            code: "connected_account_credential_conflict_response_invalid",
        });
    });

    it("reads exact credential and configuration snapshots and applies configuration CAS", async () => {
        const ref = { service, accountId: "provider/account" };
        const target = { kind: "account" as const, ref };
        const credential = {
            ref,
            authenticationModeId: "token",
            revisionSemantics: "revisioned" as const,
            credentialRevision: "csr_abcdefghijklmnopqrstuvwxyz",
            configurationRevision: "configuration-revision",
            content: { t: "plain" as const, v: { token: "opaque" } },
            metadata: { scopes: [] },
        };
        const configuration = {
            target,
            authenticationModeId: "token",
            revisionSemantics: "revisioned" as const,
            credentialRevision: credential.credentialRevision,
            configurationRevision: "configuration-revision",
            configurationContent: {
                t: "plain" as const,
                v: { region: "eu" },
            },
        };
        vi.mocked(axios.get)
            .mockResolvedValueOnce({ status: 200, data: credential })
            .mockResolvedValueOnce({ status: 200, data: configuration });
        vi.mocked(axios.patch).mockResolvedValue({
            status: 200,
            data: {
                success: true,
                credentialRevision: credential.credentialRevision,
                configurationRevision: "next-configuration-revision",
            },
        });

        await expect(readQualifiedConnectedAccountCredentialV4({
            token: "token",
            ref,
        })).resolves.toEqual(credential);
        await expect(readQualifiedConnectedAccountConfigurationV4({
            token: "token",
            target,
        })).resolves.toEqual(configuration);
        await expect(mutateQualifiedConnectedAccountConfigurationV4({
            token: "token",
            patch: {
                target,
                expectedCredentialRevision: credential.credentialRevision,
                expectedConfigurationRevision: "configuration-revision",
                replacementContentEnvelope: {
                    t: "plain",
                    v: { region: "us" },
                },
            },
        })).resolves.toEqual({
            success: true,
            credentialRevision: credential.credentialRevision,
            configurationRevision: "next-configuration-revision",
        });
        await expect(mutateQualifiedConnectedAccountCredentialHealthV4({
            token: "token",
            patch: {
                ref,
                expectedCredentialRevision:
                    credential.credentialRevision,
                expectedConfigurationRevision:
                    configuration.configurationRevision,
                health: {
                    v: 1,
                    status: "connected",
                },
            },
        })).resolves.toEqual({
            success: true,
            credentialRevision: credential.credentialRevision,
            configurationRevision: "next-configuration-revision",
        });

        expect(vi.mocked(axios.get).mock.calls[0]?.[0]).toContain(
            "/v4/connect/qualified/credential?ref=%7B",
        );
        expect(vi.mocked(axios.get).mock.calls[1]?.[0]).toContain(
            "/v4/connect/qualified/configuration?target=%7B",
        );
        expect(vi.mocked(axios.patch).mock.calls[0]?.[0]).toContain(
            "/v4/connect/qualified/configuration",
        );
        expect(vi.mocked(axios.patch).mock.calls[1]?.[0]).toContain(
            "/v4/connect/qualified/credential/health",
        );
    });

    it("uses exact V4 credential lease, delete, and quota contracts", async () => {
        const ref = { service, accountId: "provider/account" };
        const credentialRevision = "csr_abcdefghijklmnopqrstuvwxyz";
        const recordKey = {
            providerId: "example-provider",
            accountSubjectId: "provider-account",
            subjectKind: "account" as const,
            quotaScope: "account" as const,
        };
        vi.mocked(axios.post)
            .mockResolvedValueOnce({
                status: 200,
                data: {
                    acquired: true,
                    leaseUntil: 123_456,
                    ownerId: "machine:daemon",
                    credentialRevision,
                },
            })
            .mockResolvedValueOnce({
                status: 200,
                data: { success: true },
            })
            .mockResolvedValueOnce({
                status: 200,
                data: { success: true },
            });
        vi.mocked(axios.delete)
            .mockResolvedValueOnce({
                status: 200,
                data: { success: true },
            })
            .mockResolvedValueOnce({
                status: 200,
                data: { success: true },
            });
        vi.mocked(axios.get).mockResolvedValueOnce({
            status: 200,
            data: {
                ref,
                sourceResolution: {
                    source: { ref, bindingKind: "account" },
                    recordId: buildProviderAccountUsageRecordId(recordKey),
                    providerAccountId: recordKey.accountSubjectId,
                    fetchedAt: 100,
                    staleAfterMs: 1_000,
                },
                content: { t: "encrypted", c: "sealed-quota" },
                metadata: {
                    fetchedAt: 100,
                    staleAfterMs: 1_000,
                    status: "ok",
                },
            },
        });

        await expect(acquireQualifiedConnectedAccountRefreshLeaseV4({
            token: "token",
            lease: {
                ref,
                expectedCredentialRevision: credentialRevision,
                ownerId: "machine:daemon",
                ttlMs: 30_000,
            },
        })).resolves.toMatchObject({ acquired: true, credentialRevision });
        await expect(deleteQualifiedConnectedAccountCredentialV4({
            token: "token",
            deletion: {
                ref,
                expectedCredentialRevision: credentialRevision,
                cleanupGroupReferences: false,
            },
        })).resolves.toEqual({ success: true });
        await expect(readQualifiedConnectedAccountQuotaV4({
            token: "token",
            ref,
        })).resolves.toMatchObject({
            ref,
            content: { t: "encrypted", c: "sealed-quota" },
        });
        await expect(unlinkQualifiedConnectedAccountQuotaV4({
            token: "token",
            ref,
        })).resolves.toEqual({ success: true });
        await expect(requestQualifiedConnectedAccountQuotaRefreshV4({
            token: "token",
            ref,
        })).resolves.toEqual({ success: true });
        await expect(writeQualifiedProviderAccountUsageV4({
            token: "token",
            write: {
                source: { ref, bindingKind: "account" },
                expectedCredentialRevision: credentialRevision,
                expectedConfigurationRevision: null,
                recordId: buildProviderAccountUsageRecordId(recordKey),
                recordKey,
                payloadMode: "sealed_account_scoped_v1",
                status: "refresh_requested",
            },
        })).resolves.toEqual({ success: true });

        expect(String(vi.mocked(axios.post).mock.calls[0]?.[0])).toContain(
            "/credential/refresh-lease",
        );
        expect(String(vi.mocked(axios.delete).mock.calls[0]?.[0])).toContain(
            "cleanupGroupReferences=false",
        );
        for (const [, config] of vi.mocked(axios.delete).mock.calls) {
            expect(config?.headers).toEqual({
                ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
                Authorization: "Bearer token",
            });
        }
        expect(String(vi.mocked(axios.get).mock.calls[0]?.[0])).toContain(
            "/v4/connect/qualified/quotas?ref=%7B",
        );
        expect(String(vi.mocked(axios.post).mock.calls[2]?.[0])).toContain(
            "/v4/connect/qualified/provider-account-usage",
        );
    });
});
