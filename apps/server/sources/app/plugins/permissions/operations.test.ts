import { describe, expect, it } from "vitest";

import {
    REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
    type PluginPermissionGrantAuditEventV1,
    type PluginPermissionGrantRequestV1,
    type PluginPermissionGrantV1,
} from "@happier-dev/protocol";

import { createPluginPermissionGrantOperations } from "./operations";
import type { PluginPermissionGrantStore } from "./storage";

const CODERABBIT_PLUGIN_ID = "happier.review.coderabbit";

function pendingRequest(): PluginPermissionGrantRequestV1 {
    return {
        v: 1,
        id: "request-1",
        accountId: "account-1",
        pluginId: CODERABBIT_PLUGIN_ID,
        capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
        targetScope: { kind: "project", projectId: "project-1" },
        authoritySource: { kind: "bundled" },
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
            () => ({
                pluginId: CODERABBIT_PLUGIN_ID,
                source: { kind: "bundled" },
                optionalPermissions: [{
                    capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
                    reason: "Write approved review comments directly.",
                }],
            }),
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
});
