import { describe, expect, it } from "vitest";

import {
    GENERAL_PLUGIN_PERMISSION_SUBJECT_V1,
    PluginPermissionGrantListActionInputV1Schema,
    REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
    type PluginPermissionGrantAuditEventV1,
    type PluginPermissionGrantRequestV1,
    type PluginPermissionGrantV1,
} from "@happier-dev/protocol";

import { createPluginPermissionGrantOperations } from "./operations";
import type { PluginPermissionGrantStore } from "./storage";

const CODERABBIT_PLUGIN_ID = "happier.review.coderabbit";
const PUBLISHER_AUTHORITY = {
    kind: "machine_installation",
    machineId: "machine-1",
    installationId: "installation-1",
} as const;

function pendingRequest(): PluginPermissionGrantRequestV1 {
    return {
        v: 1,
        id: "request-1",
        accountId: "account-1",
        pluginId: CODERABBIT_PLUGIN_ID,
        capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
        targetScope: { kind: "project", projectId: "project-1" },
        subject: GENERAL_PLUGIN_PERMISSION_SUBJECT_V1,
        authoritySource: PUBLISHER_AUTHORITY,
        requester: { kind: "plugin", pluginId: CODERABBIT_PLUGIN_ID },
        reason: "Publish approved review comments directly.",
        status: "pending",
        createdByUserId: "user-1",
        createdAt: 1,
        updatedAt: 1,
    };
}

function activeGrant(request: PluginPermissionGrantRequestV1): PluginPermissionGrantV1 {
    return {
        v: 1,
        id: "grant-winning-race",
        accountId: request.accountId,
        pluginId: request.pluginId,
        capability: request.capability,
        targetScope: request.targetScope,
        subject: request.subject,
        authoritySource: request.authoritySource,
        status: "active",
        requestId: "request-winning-race",
        grantedByUserId: "user-2",
        grantedAt: 2,
        createdAt: 2,
        updatedAt: 2,
    };
}

describe("plugin permission grant operations", () => {
    it("resolves an exact caller-owned grant outside the bounded newest-grants page", async () => {
        const request = pendingRequest();
        const oldGrant: PluginPermissionGrantV1 = {
            ...activeGrant(request),
            id: "grant-old",
            createdAt: 1,
            updatedAt: 1,
        };
        const newestGrants = Array.from({ length: 200 }, (_, index): PluginPermissionGrantV1 => ({
            ...activeGrant(request),
            id: `grant-new-${index}`,
            createdAt: index + 2,
            updatedAt: index + 2,
        }));
        let broadListCount = 0;
        const store: PluginPermissionGrantStore = {
            async list() {
                broadListCount += 1;
                return { grants: newestGrants, pendingRequests: [] };
            },
            async getRequest() { return null; },
            async getGrant({ grantId }) { return grantId === oldGrant.id ? oldGrant : null; },
            async createPendingRequest() {},
            async grantPendingRequest() {},
            async resolvePendingRequestWithExistingGrant() {},
            async revokeGrant() {},
            async dismissPendingRequest() {},
        };
        const operations = createPluginPermissionGrantOperations(store);
        const input = PluginPermissionGrantListActionInputV1Schema.parse({
            pluginId: request.pluginId,
            grantId: oldGrant.id,
            includeRevoked: true,
            includeResolvedRequests: false,
            limit: 1,
        });

        await expect(operations.list({ accountId: request.accountId, input })).resolves.toEqual({
            grants: [oldGrant],
            pendingRequests: [],
        });
        expect(broadListCount).toBe(0);
    });

    it("returns the durable terminal winner for same grant and dismiss retries without another audit write", async () => {
        const request = pendingRequest();
        const grant = activeGrant(request);
        const grantedRequest: PluginPermissionGrantRequestV1 = {
            ...request,
            status: "granted",
            grantId: grant.id,
            decidedByUserId: "user-1",
            decidedAt: 3,
            updatedAt: 3,
        };
        const dismissedRequest: PluginPermissionGrantRequestV1 = {
            ...request,
            id: "request-dismissed",
            status: "dismissed",
            decidedByUserId: "user-1",
            decidedAt: 3,
            updatedAt: 3,
        };
        let terminalWriteCount = 0;
        const store: PluginPermissionGrantStore = {
            async list() { return { grants: [], pendingRequests: [] }; },
            async getRequest({ requestId }) {
                return requestId === dismissedRequest.id ? dismissedRequest : grantedRequest;
            },
            async getGrant({ grantId }) {
                return grantId === grant.id ? grant : null;
            },
            async createPendingRequest() {},
            async grantPendingRequest() { terminalWriteCount += 1; },
            async resolvePendingRequestWithExistingGrant() { terminalWriteCount += 1; },
            async revokeGrant() {},
            async dismissPendingRequest() { terminalWriteCount += 1; },
        };
        const operations = createPluginPermissionGrantOperations(store);

        await expect(operations.grant({
            accountId: request.accountId,
            userId: "user-1",
            input: { requestId: request.id },
        })).resolves.toEqual({ grant, pendingRequest: grantedRequest });
        await expect(operations.dismissRequest({
            accountId: request.accountId,
            userId: "user-1",
            input: { requestId: dismissedRequest.id },
        })).resolves.toEqual({ pendingRequest: dismissedRequest });
        expect(terminalWriteCount).toBe(0);
    });

    it("returns the durable revoked grant for an exact revoke retry without another audit write", async () => {
        const request = pendingRequest();
        const grant: PluginPermissionGrantV1 = {
            ...activeGrant(request),
            status: "revoked",
            revokedByUserId: "user-1",
            revokedAt: 3,
            updatedAt: 3,
        };
        let revokeWriteCount = 0;
        const store: PluginPermissionGrantStore = {
            async list() { return { grants: [], pendingRequests: [] }; },
            async getRequest() { return null; },
            async getGrant({ grantId }) {
                return grantId === grant.id ? grant : null;
            },
            async createPendingRequest() {},
            async grantPendingRequest() {},
            async resolvePendingRequestWithExistingGrant() {},
            async revokeGrant() { revokeWriteCount += 1; },
            async dismissPendingRequest() {},
        };
        const operations = createPluginPermissionGrantOperations(store);

        await expect(operations.revoke({
            accountId: request.accountId,
            userId: "user-1",
            input: { grantId: grant.id },
        })).resolves.toEqual({ grant });
        expect(revokeWriteCount).toBe(0);
    });

    it("returns the durable revoked winner when an exact concurrent revoke wins the transition", async () => {
        const request = pendingRequest();
        const active = activeGrant(request);
        const revoked: PluginPermissionGrantV1 = {
            ...active,
            status: "revoked",
            revokedByUserId: "user-2",
            revokedAt: 4,
            updatedAt: 4,
        };
        let stored = active;
        const store: PluginPermissionGrantStore = {
            async list() { return { grants: [], pendingRequests: [] }; },
            async getRequest() { return null; },
            async getGrant({ grantId }) {
                return grantId === active.id ? stored : null;
            },
            async createPendingRequest() {},
            async grantPendingRequest() {},
            async resolvePendingRequestWithExistingGrant() {},
            async revokeGrant() {
                stored = revoked;
                throw new Error("concurrent revoke won");
            },
            async dismissPendingRequest() {},
        };
        const operations = createPluginPermissionGrantOperations(store);

        await expect(operations.revoke({
            accountId: request.accountId,
            userId: "user-1",
            input: { grantId: active.id },
        })).resolves.toEqual({ grant: revoked });
    });

    it("reuses the exact pending request without appending another requested audit", async () => {
        const existing = pendingRequest();
        let createPendingRequestCount = 0;
        const store: PluginPermissionGrantStore = {
            async list(params) {
                return {
                    grants: [],
                    pendingRequests: params.accountId === existing.accountId
                        && params.pluginId === existing.pluginId
                        && params.capability === existing.capability
                        && params.targetScope?.kind === "project"
                        && params.targetScope.projectId === "project-1"
                        && params.authoritySource?.kind === "machine_installation"
                        && params.authoritySource.machineId === PUBLISHER_AUTHORITY.machineId
                        && params.authoritySource.installationId === PUBLISHER_AUTHORITY.installationId
                        ? [existing]
                        : [],
                };
            },
            async getRequest() {
                return null;
            },
            async getGrant() {
                return null;
            },
            async createPendingRequest() {
                createPendingRequestCount += 1;
            },
            async grantPendingRequest() {},
            async resolvePendingRequestWithExistingGrant() {},
            async revokeGrant() {},
            async dismissPendingRequest() {},
        };
        const operations = createPluginPermissionGrantOperations(
            store,
            {
                now: () => 3,
                createId: (prefix) => `${prefix}-new`,
            },
            (request) => request.machineId === PUBLISHER_AUTHORITY.machineId
                && request.installationId === PUBLISHER_AUTHORITY.installationId
                ? { source: PUBLISHER_AUTHORITY }
                : null,
        );

        const result = await operations.request({
            accountId: existing.accountId,
            userId: "user-1",
            publisher: PUBLISHER_AUTHORITY,
            input: {
                pluginId: existing.pluginId,
                capability: existing.capability,
                targetScope: existing.targetScope,
                subject: existing.subject,
                requester: {
                    kind: "plugin",
                    pluginId: existing.pluginId,
                    sessionId: "session-2",
                    requestId: "call-2",
                },
                reason: "Retry the approved review-comment write.",
            },
        });

        expect(result.pendingRequest).toEqual(existing);
        expect(createPendingRequestCount).toBe(0);
    });

    it("reuses the active grant when a concurrent grant wins the exact-scope race", async () => {
        const request = pendingRequest();
        let grant: PluginPermissionGrantV1 | null = null;
        let resolvedRequest: PluginPermissionGrantRequestV1 | null = null;
        const store: PluginPermissionGrantStore = {
            async list(params) {
                return {
                    grants: grant
                        && params.accountId === grant.accountId
                        && params.pluginId === grant.pluginId
                        && params.capability === grant.capability
                        ? [grant]
                        : [],
                    pendingRequests: [],
                };
            },
            async getRequest() {
                return resolvedRequest ?? request;
            },
            async getGrant() {
                return null;
            },
            async createPendingRequest() {},
            async grantPendingRequest() {
                grant = activeGrant(request);
                throw Object.assign(new Error("duplicate active grant"), { code: "P2002" });
            },
            async resolvePendingRequestWithExistingGrant(params) {
                resolvedRequest = params.pendingRequest;
            },
            async revokeGrant() {},
            async dismissPendingRequest() {},
        };
        const operations = createPluginPermissionGrantOperations(
            store,
            {
                now: () => 3,
                createId: (prefix) => `${prefix}-1`,
            },
            (authorityRequest) => authorityRequest.machineId === PUBLISHER_AUTHORITY.machineId
                && authorityRequest.installationId === PUBLISHER_AUTHORITY.installationId
                ? { source: PUBLISHER_AUTHORITY }
                : null,
        );

        const result = await operations.grant({
            accountId: request.accountId,
            userId: "user-1",
            input: { requestId: request.id },
        });

        expect(result.grant.id).toBe("grant-winning-race");
        expect(result.pendingRequest).toMatchObject({
            id: request.id,
            status: "granted",
            grantId: "grant-winning-race",
            decidedByUserId: "user-1",
        });
        expect(resolvedRequest).toMatchObject({
            id: request.id,
            status: "granted",
            grantId: "grant-winning-race",
        });
    });

    it("requires exact verified publisher authority for bundled and external plugin requests", async () => {
        const pluginIds = [CODERABBIT_PLUGIN_ID, "acme.reviewbot"] as const;
        for (const pluginId of pluginIds) {
            const observedAuthorityRequests: unknown[] = [];
            const store: PluginPermissionGrantStore = {
                async list() { return { grants: [], pendingRequests: [] }; },
                async getRequest() { return null; },
                async getGrant() { return null; },
                async createPendingRequest() {},
                async grantPendingRequest() {},
                async resolvePendingRequestWithExistingGrant() {},
                async revokeGrant() {},
                async dismissPendingRequest() {},
            };
            const operations = createPluginPermissionGrantOperations(
                store,
                { now: () => 3, createId: (prefix) => `${prefix}-1` },
                (request) => {
                    observedAuthorityRequests.push(request);
                    return request.machineId === PUBLISHER_AUTHORITY.machineId
                        && request.installationId === PUBLISHER_AUTHORITY.installationId
                        ? { source: PUBLISHER_AUTHORITY }
                        : null;
                },
            );
            const input = {
                pluginId,
                capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
                targetScope: { kind: "project" as const, projectId: "project-1" },
                subject: GENERAL_PLUGIN_PERMISSION_SUBJECT_V1,
                requester: { kind: "plugin" as const, pluginId },
                reason: "Write approved review comments directly.",
            };

            await expect(operations.request({ accountId: "account-1", userId: "user-1", input }))
                .rejects.toMatchObject({ code: "plugin_permission_grant_publisher_proof_required" });
            await operations.request({
                accountId: "account-1",
                userId: "user-1",
                publisher: PUBLISHER_AUTHORITY,
                input,
            });

            expect(observedAuthorityRequests).toEqual([{
                accountId: "account-1",
                machineId: PUBLISHER_AUTHORITY.machineId,
                installationId: PUBLISHER_AUTHORITY.installationId,
            }]);
        }
    });
});
