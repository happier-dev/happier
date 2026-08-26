import {
    BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
    FeaturesResponseSchema,
} from "@happier-dev/protocol";
import { describe, expect, it, vi } from "vitest";

import type { CliServerFeaturesSnapshot } from "@/features/serverFeaturesClient";
import {
    executeQualifiedConnectedAccountNegotiatedOperation,
    resolveQualifiedConnectedAccountAtomicV4Negotiation,
    resolveQualifiedConnectedAccountOperationTransport,
    resolveQualifiedConnectedAccountPeerClass,
    resolveQualifiedConnectedAccountPeerOperationTransport,
} from "./qualifiedConnectedAccountApi";

const builtInService = {
    pluginId: "happier.agent.codex",
    localId: "openai-codex",
} as const;
const novelService = {
    pluginId: "example.external.connected-accounts",
    localId: "novel-service",
} as const;
const githubService =
    BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID.github
        .service;
const bitbucketService =
    BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID.bitbucket
        .service;
function ready(
    connectedServices: Readonly<Record<string, unknown>>,
): CliServerFeaturesSnapshot {
    return {
        status: "ready",
        features: FeaturesResponseSchema.parse({
            features: {},
            capabilities: { connectedServices },
        }),
    };
}

const exactOldServer: CliServerFeaturesSnapshot = {
    status: "ready",
    features: FeaturesResponseSchema.parse({
        features: {
            sharing: {
                pendingQueueV2: { enabled: true },
            },
        },
        capabilities: {},
    }),
};
const exactOldServerContract = {
    mode: "released_server_v0_2_1" as const,
    runtimeActivity: "legacy" as const,
    pendingInput: "released_server_v0_2_1" as const,
    publisherAuthority: "indeterminate" as const,
    sessionConnectionEpoch: 7,
    socket: { connected: true },
};

describe("qualified Connected Account operation negotiation", () => {
    it("classifies uncertainty separately from proven V4 absence", () => {
        const releasedSnapshotWithoutConnectedServices = {
            status: "ready",
            features: {
                features: {},
                capabilities: {},
            },
        } as unknown as CliServerFeaturesSnapshot;
        expect(resolveQualifiedConnectedAccountAtomicV4Negotiation(
            ready({ qualifiedAccounts: { protocolVersion: 4 } }),
        )).toBe("advertised");
        expect(resolveQualifiedConnectedAccountAtomicV4Negotiation(
            releasedSnapshotWithoutConnectedServices,
        )).toBe("absent");
        expect(resolveQualifiedConnectedAccountPeerClass(
            releasedSnapshotWithoutConnectedServices,
            exactOldServerContract,
        )).toBe("exact_v0_2_1");
        expect(resolveQualifiedConnectedAccountAtomicV4Negotiation(
            ready({ credentialDelete: { revisionGuard: true } }),
        )).toBe("absent");
        expect(resolveQualifiedConnectedAccountAtomicV4Negotiation({
            status: "unsupported",
            reason: "endpoint_missing",
        })).toBe("absent");
        expect(resolveQualifiedConnectedAccountAtomicV4Negotiation({
            status: "unsupported",
            reason: "invalid_payload",
        })).toBe("indeterminate");
        expect(resolveQualifiedConnectedAccountAtomicV4Negotiation({
            status: "error",
            reason: "network",
        })).toBe("indeterminate");
        expect(resolveQualifiedConnectedAccountAtomicV4Negotiation())
            .toBe("indeterminate");
        expect(resolveQualifiedConnectedAccountPeerClass(
            ready({ qualifiedAccounts: { protocolVersion: 4 } }),
        )).toBe("advertised_v4");
        expect(resolveQualifiedConnectedAccountPeerClass(
            exactOldServer,
            exactOldServerContract,
        )).toBe("exact_v0_2_1");
        expect(resolveQualifiedConnectedAccountPeerClass(
            ready({ qualifiedAccounts: { protocolVersion: 4 } }),
            exactOldServerContract,
        )).toBe("indeterminate");
        expect(resolveQualifiedConnectedAccountPeerClass(
            exactOldServer,
        )).toBe("indeterminate");
        expect(resolveQualifiedConnectedAccountPeerClass(
            exactOldServer,
            {
                ...exactOldServerContract,
                socket: { connected: false },
            },
        )).toBe("indeterminate");
        expect(resolveQualifiedConnectedAccountPeerClass(
            ready({ credentialDelete: { revisionGuard: true } }),
        )).toBe("revisioned_v2_v3");
        expect(resolveQualifiedConnectedAccountPeerClass(
            ready({}),
        )).toBe("indeterminate");
        expect(resolveQualifiedConnectedAccountPeerClass({
            status: "unsupported",
            reason: "endpoint_missing",
        })).toBe("indeterminate");
    });

    it("performs neither transport when advertised V4 and exact-old socket proof contradict", async () => {
        const executeV4 = vi.fn(async () => "v4");
        const executeLegacy = vi.fn(async () => "legacy");

        await expect(executeQualifiedConnectedAccountNegotiatedOperation({
            snapshot: ready({
                qualifiedAccounts: { protocolVersion: 4 },
            }),
            serverContract: exactOldServerContract,
            service: builtInService,
            operation: {
                kind: "credential_read",
                configurationState: "unconfigured",
                authenticationModeCardinality: "single",
            },
            executeV4,
            executeLegacy,
        })).rejects.toMatchObject({
            code: "connected_account_capability_indeterminate",
        });
        expect(executeV4).not.toHaveBeenCalled();
        expect(executeLegacy).not.toHaveBeenCalled();
    });

    it("derives old-peer eligibility from the exact operation and account facts", () => {
        const absent = ready({
            credentialDelete: { revisionGuard: true },
        });
        expect(resolveQualifiedConnectedAccountOperationTransport({
            snapshot: absent,
            service: builtInService,
            operation: {
                kind: "credential_read",
                configurationState: "unconfigured",
                authenticationModeCardinality: "single",
            },
        })).toEqual({
            kind: "legacy",
            peerClass: "revisioned_v2_v3",
            serviceId: "openai-codex",
        });
        expect(() => resolveQualifiedConnectedAccountOperationTransport({
            snapshot: absent,
            service: builtInService,
            operation: {
                kind: "credential_read",
                configurationState: "configured",
                authenticationModeCardinality: "single",
            },
        })).toThrow(expect.objectContaining({
            code: "connected_account_legacy_operation_unsupported",
        }));
        expect(() => resolveQualifiedConnectedAccountOperationTransport({
            snapshot: absent,
            service: builtInService,
            operation: {
                kind: "credential_write",
                configurationState: "unconfigured",
                authenticationModeCardinality: "multiple",
            },
        })).toThrow(expect.objectContaining({
            code: "connected_account_legacy_operation_unsupported",
        }));
        expect(() => resolveQualifiedConnectedAccountOperationTransport({
            snapshot: absent,
            service: novelService,
            operation: {
                kind: "credential_read",
                configurationState: "unconfigured",
                authenticationModeCardinality: "single",
            },
        })).toThrow(expect.objectContaining({
            code: "connected_account_service_identity_unsupported",
        }));
    });

    it("admits only passive legacy reads on the exact unfenced server and fails before either mutation transport", async () => {
        expect(resolveQualifiedConnectedAccountOperationTransport({
            snapshot: exactOldServer,
            serverContract: exactOldServerContract,
            service: builtInService,
            operation: { kind: "account_list" },
        })).toEqual({
            kind: "legacy",
            peerClass: "exact_v0_2_1",
            serviceId: "openai-codex",
        });
        expect(resolveQualifiedConnectedAccountOperationTransport({
            snapshot: exactOldServer,
            serverContract: exactOldServerContract,
            service: builtInService,
            operation: {
                kind: "credential_read",
                configurationState: "unconfigured",
                authenticationModeCardinality: "single",
            },
        })).toEqual({
            kind: "legacy",
            peerClass: "exact_v0_2_1",
            serviceId: "openai-codex",
        });

        const executeV4 = vi.fn(async () => "v4");
        const executeLegacy = vi.fn(async () => "legacy");
        await expect(executeQualifiedConnectedAccountNegotiatedOperation({
            snapshot: exactOldServer,
            serverContract: exactOldServerContract,
            service: builtInService,
            operation: {
                kind: "credential_write",
                configurationState: "unconfigured",
                authenticationModeCardinality: "single",
            },
            executeV4,
            executeLegacy,
        })).rejects.toMatchObject({
            code: "connected_account_legacy_operation_unsupported",
        });
        expect(executeV4).not.toHaveBeenCalled();
        expect(executeLegacy).not.toHaveBeenCalled();
    });

    it("keeps guarded mutation on a revisioned V2/V3 peer", () => {
        expect(resolveQualifiedConnectedAccountOperationTransport({
            snapshot: ready({
                credentialDelete: { revisionGuard: true },
            }),
            service: builtInService,
            operation: {
                kind: "credential_write",
                configurationState: "unconfigured",
                authenticationModeCardinality: "single",
            },
        })).toEqual({
            kind: "legacy",
            peerClass: "revisioned_v2_v3",
            serviceId: "openai-codex",
        });
    });

    it("uses distinct exact-old and revisioned operation sets without flattening qualified ids", () => {
        const snapshot = ready({
            credentialDelete: { revisionGuard: true },
        });
        const compatibilityEntries = Object.entries(
            BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
        );
        const exactOldEntries = compatibilityEntries.filter(
            ([, compatibility]) =>
                compatibility.peerOperations.exactV0_2_1.length > 0,
        );
        expect(exactOldEntries.map(([serviceId]) => serviceId)).toEqual([
            "openai-codex",
            "openai",
            "anthropic",
            "claude-subscription",
            "gemini",
        ]);
        for (const [serviceId, compatibility] of exactOldEntries) {
            expect(
                compatibility.peerOperations.exactV0_2_1,
            ).toEqual([
                "account_list",
                "credential_read",
                "one_shot_materialization",
            ]);
            expect(
                compatibility.exactV0_2_1ReaderQuotaProjection,
            ).toBe(true);
            expect(resolveQualifiedConnectedAccountOperationTransport({
                snapshot,
                service: compatibility.service,
                operation: {
                    kind: "credential_read",
                    configurationState: "unconfigured",
                    authenticationModeCardinality: "single",
                },
            })).toEqual({
                kind: "legacy",
                peerClass: "revisioned_v2_v3",
                serviceId,
            });
        }
        expect(resolveQualifiedConnectedAccountOperationTransport({
            snapshot,
            service: githubService,
            operation: {
                kind: "credential_read",
                configurationState: "unconfigured",
                authenticationModeCardinality: "single",
            },
        })).toEqual({
            kind: "legacy",
            peerClass: "revisioned_v2_v3",
            serviceId: "github",
        });
        expect(() => resolveQualifiedConnectedAccountOperationTransport({
            snapshot,
            service: bitbucketService,
            operation: {
                kind: "credential_read",
                configurationState: "unconfigured",
                authenticationModeCardinality: "single",
            },
        })).toThrow(expect.objectContaining({
            code: "connected_account_service_identity_unsupported",
        }));
        expect(() => resolveQualifiedConnectedAccountPeerOperationTransport({
            snapshot: exactOldServer,
            serverContract: exactOldServerContract,
            service: builtInService,
            operation: "legacy_quota_projection" as never,
        })).toThrow(expect.objectContaining({
            code: "connected_account_legacy_operation_unsupported",
        }));
        expect(
            BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID
                .github.exactV0_2_1ReaderQuotaProjection,
        ).toBe(false);
        expect(() => resolveQualifiedConnectedAccountOperationTransport({
            snapshot: exactOldServer,
            serverContract: exactOldServerContract,
            service: githubService,
            operation: {
                kind: "credential_read",
                configurationState: "unconfigured",
                authenticationModeCardinality: "single",
            },
        })).toThrow(expect.objectContaining({
            code: "connected_account_service_identity_unsupported",
        }));
        for (const serviceId of ["openai", "anthropic", "gemini", "github"] as const) {
            const compatibility =
                BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[serviceId];
            expect(() => resolveQualifiedConnectedAccountPeerOperationTransport({
                snapshot,
                service: compatibility.service,
                operation: "request_auth",
            })).toThrow(expect.objectContaining({
                code: "connected_account_legacy_operation_unsupported",
            }));
        }
        expect(Object.keys(
            BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
        )).toEqual([
            "openai-codex",
            "openai",
            "anthropic",
            "claude-subscription",
            "gemini",
            "github",
            "bitbucket",
        ]);
    });

    it("fails before either transport when capability evidence is uncertain", async () => {
        const executeV4 = vi.fn(async () => "v4");
        const executeLegacy = vi.fn(async () => "legacy");

        await expect(executeQualifiedConnectedAccountNegotiatedOperation({
            snapshot: { status: "error", reason: "timeout" },
            service: builtInService,
            operation: {
                kind: "credential_read",
                configurationState: "unconfigured",
                authenticationModeCardinality: "single",
            },
            executeV4,
            executeLegacy,
        })).rejects.toMatchObject({
            code: "connected_account_capability_indeterminate",
        });
        expect(executeV4).not.toHaveBeenCalled();
        expect(executeLegacy).not.toHaveBeenCalled();
    });

    it.each([
        { kind: "configuration_read" as const },
        { kind: "configuration_write" as const },
        { kind: "group_operation" as const },
        { kind: "qualified_usage_operation" as const },
    ])("never invokes legacy for advertised V4-only $kind, including V4 failure", async (operation) => {
        const v4Failure = new Error("advertised V4 route failed");
        const executeV4 = vi.fn(async () => {
            throw v4Failure;
        });
        const executeLegacy = vi.fn(async () => "legacy");

        await expect(executeQualifiedConnectedAccountNegotiatedOperation({
            snapshot: ready({
                qualifiedAccounts: { protocolVersion: 4 },
            }),
            service: novelService,
            operation,
            executeV4,
            executeLegacy,
        })).rejects.toBe(v4Failure);
        expect(executeLegacy).not.toHaveBeenCalled();
    });

    it.each([404, 405, 501])(
        "returns a typed contract violation for advertised V4 route status %i",
        async (status) => {
            const v4Failure = {
                isAxiosError: true,
                response: { status },
            };
            const executeLegacy = vi.fn(async () => "legacy");

            await expect(
                executeQualifiedConnectedAccountNegotiatedOperation({
                    snapshot: ready({
                        qualifiedAccounts: { protocolVersion: 4 },
                    }),
                    service: builtInService,
                    operation: {
                        kind: "credential_read",
                        configurationState: "unconfigured",
                        authenticationModeCardinality: "single",
                    },
                    executeV4: async () => {
                        throw v4Failure;
                    },
                    executeLegacy,
                }),
            ).rejects.toMatchObject({
                code: "connected_account_v4_contract_violation",
            });
            expect(executeLegacy).not.toHaveBeenCalled();
        },
    );

    it("preserves an advertised V4 server failure without legacy fallback", async () => {
        const v4Failure = {
            isAxiosError: true,
            response: { status: 500 },
        };
        const executeLegacy = vi.fn(async () => "legacy");

        await expect(executeQualifiedConnectedAccountNegotiatedOperation({
            snapshot: ready({
                qualifiedAccounts: { protocolVersion: 4 },
            }),
            service: builtInService,
            operation: {
                kind: "credential_write",
                configurationState: "unconfigured",
                authenticationModeCardinality: "single",
            },
            executeV4: async () => {
                throw v4Failure;
            },
            executeLegacy,
        })).rejects.toBe(v4Failure);
        expect(executeLegacy).not.toHaveBeenCalled();
    });

    it("selects the generated built-in legacy owner only for a proven-safe old-peer operation", async () => {
        const executeV4 = vi.fn(async () => "v4");
        const executeLegacy = vi.fn(async (serviceId: string) =>
            `legacy:${serviceId}`);

        await expect(executeQualifiedConnectedAccountNegotiatedOperation({
            snapshot: ready({
                credentialDelete: { revisionGuard: true },
            }),
            service: builtInService,
            operation: {
                kind: "quota_read",
                configurationState: "unconfigured",
                authenticationModeCardinality: "single",
            },
            executeV4,
            executeLegacy,
        })).resolves.toBe("legacy:openai-codex");
        expect(executeV4).not.toHaveBeenCalled();
    });
});
