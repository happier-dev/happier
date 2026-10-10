import { FeaturesResponseSchema } from "@happier-dev/protocol";
import { describe, expect, it, vi } from "vitest";

import type { CliServerFeaturesSnapshot } from "@/features/serverFeaturesClient";
import {
    executeQualifiedConnectedAccountNegotiatedOperation,
    resolveQualifiedConnectedAccountAtomicV4Negotiation,
    resolveQualifiedConnectedAccountRemovalReviewNegotiation,
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

function ready(connectedServices: Readonly<Record<string, unknown>>): CliServerFeaturesSnapshot {
    return {
        status: "ready",
        features: FeaturesResponseSchema.parse({
            features: {},
            capabilities: { connectedServices },
        }),
    };
}

const exactOldServer = ready({});
const exactOldServerContract = {
    mode: "released_server_v0_2_1" as const,
    runtimeActivity: "legacy" as const,
    pendingInput: "released_server_v0_2_1" as const,
    publisherAuthority: "indeterminate" as const,
    sessionConnectionEpoch: 7,
    socket: { connected: true },
};
const credentialRead = {
    kind: "credential_read",
    configurationState: "unconfigured",
    authenticationModeCardinality: "single",
} as const;

describe("qualified Connected Account current transport admission", () => {
    it("negotiates removal review separately from the released strict V4 descriptor", () => {
        expect(resolveQualifiedConnectedAccountRemovalReviewNegotiation(ready({ qualifiedAccounts: { protocolVersion: 4 } }))).toBe("absent");
        expect(resolveQualifiedConnectedAccountRemovalReviewNegotiation(ready({ qualifiedAccounts: { protocolVersion: 4 }, credentialRemovalReview: { protocolVersion: 1 } }))).toBe("advertised");
        expect(resolveQualifiedConnectedAccountRemovalReviewNegotiation(undefined)).toBe("indeterminate");
        expect(resolveQualifiedConnectedAccountRemovalReviewNegotiation({ status: "error", reason: "network" })).toBe("indeterminate");
    });
    it.each([
        { label: "exact 0.2.1", snapshot: exactOldServer, serverContract: exactOldServerContract },
        { label: "revisioned V2/V3", snapshot: ready({ credentialDelete: { revisionGuard: true } }) },
    ])("current V4 transport is required even with $label evidence", async ({ snapshot, ...evidence }) => {
        // This callback represents the consumer's HTTP operation boundary.
        const executeV4 = vi.fn(async () => "v4");
        await expect(executeQualifiedConnectedAccountNegotiatedOperation({
            snapshot,
            ...("serverContract" in evidence ? { serverContract: evidence.serverContract } : {}),
            service: builtInService,
            operation: credentialRead,
            executeV4,
        })).rejects.toMatchObject({ code: "connected_account_capability_indeterminate" });
        expect(executeV4).not.toHaveBeenCalled();
        expect(() => resolveQualifiedConnectedAccountPeerOperationTransport({
            snapshot,
            ...("serverContract" in evidence ? { serverContract: evidence.serverContract } : {}),
            service: builtInService,
            operation: "account_list",
        })).toThrow(expect.objectContaining({ code: "connected_account_capability_indeterminate" }));
    });

    it("keeps absence diagnostic without authorizing an old peer", () => {
        expect(resolveQualifiedConnectedAccountAtomicV4Negotiation(ready({}))).toBe("absent");
        expect(resolveQualifiedConnectedAccountAtomicV4Negotiation({
            status: "unsupported", reason: "endpoint_missing",
        })).toBe("absent");
        expect(resolveQualifiedConnectedAccountPeerClass(exactOldServer, exactOldServerContract)).toBe("indeterminate");
        expect(resolveQualifiedConnectedAccountPeerClass(ready({ credentialDelete: { revisionGuard: true } }))).toBe("indeterminate");
        expect(resolveQualifiedConnectedAccountPeerClass(ready({ qualifiedAccounts: { protocolVersion: 4 } }))).toBe("advertised_v4");
    });

    it.each([
        undefined,
        { status: "unsupported", reason: "invalid_payload" } as const,
        { status: "error", reason: "network" } as const,
        { status: "error", reason: "timeout" } as const,
    ])("refuses uncertain capability evidence before HTTP: %j", async (snapshot) => {
        const executeV4 = vi.fn(async () => "v4");
        expect(resolveQualifiedConnectedAccountAtomicV4Negotiation(snapshot)).toBe("indeterminate");
        await expect(executeQualifiedConnectedAccountNegotiatedOperation({
            snapshot,
            service: builtInService,
            operation: credentialRead,
            executeV4,
        })).rejects.toMatchObject({ code: "connected_account_capability_indeterminate" });
        expect(executeV4).not.toHaveBeenCalled();
    });

    it("refuses contradictory V4 advertisement and exact-old socket proof", async () => {
        const executeV4 = vi.fn(async () => "v4");
        await expect(executeQualifiedConnectedAccountNegotiatedOperation({
            snapshot: ready({ qualifiedAccounts: { protocolVersion: 4 } }),
            serverContract: exactOldServerContract,
            service: builtInService,
            operation: credentialRead,
            executeV4,
        })).rejects.toMatchObject({ code: "connected_account_capability_indeterminate" });
        expect(executeV4).not.toHaveBeenCalled();
    });

    it("admits qualified identities and multi-mode configuration through V4", async () => {
        const snapshot = ready({ qualifiedAccounts: { protocolVersion: 4 } });
        const operation = {
            kind: "credential_write",
            configurationState: "configured",
            authenticationModeCardinality: "multiple",
        } as const;
        expect(resolveQualifiedConnectedAccountOperationTransport({
            snapshot, service: novelService, operation,
        })).toEqual({ kind: "v4" });
        await expect(executeQualifiedConnectedAccountNegotiatedOperation({
            snapshot,
            service: novelService,
            operation,
            executeV4: async () => ({ written: true }),
        })).resolves.toEqual({ written: true });
    });

    it.each([
        { kind: "configuration_read" as const },
        { kind: "configuration_write" as const },
        { kind: "group_operation" as const },
        { kind: "qualified_usage_operation" as const },
    ])("preserves HTTP failures for advertised $kind", async (operation) => {
        const v4Failure = new Error("advertised V4 route failed");
        await expect(executeQualifiedConnectedAccountNegotiatedOperation({
            snapshot: ready({ qualifiedAccounts: { protocolVersion: 4 } }),
            service: novelService,
            operation,
            executeV4: async () => { throw v4Failure; },
        })).rejects.toBe(v4Failure);
    });

    it.each([404, 405, 501])("types an advertised V4 contract violation for HTTP %i", async (status) => {
        await expect(executeQualifiedConnectedAccountNegotiatedOperation({
            snapshot: ready({ qualifiedAccounts: { protocolVersion: 4 } }),
            service: builtInService,
            operation: credentialRead,
            executeV4: async () => { throw { isAxiosError: true, response: { status } }; },
        })).rejects.toMatchObject({ code: "connected_account_v4_contract_violation" });
    });

    it("preserves an advertised V4 server failure", async () => {
        const v4Failure = { isAxiosError: true, response: { status: 500 } };
        await expect(executeQualifiedConnectedAccountNegotiatedOperation({
            snapshot: ready({ qualifiedAccounts: { protocolVersion: 4 } }),
            service: builtInService,
            operation: credentialRead,
            executeV4: async () => { throw v4Failure; },
        })).rejects.toBe(v4Failure);
    });
});
