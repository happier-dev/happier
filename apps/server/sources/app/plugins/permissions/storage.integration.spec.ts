import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import tweetnacl from "tweetnacl";

import { createFakeRouteApp, createReplyStub, getRouteHandler } from "@/app/api/testkit/routeHarness";
import { registerApiRoutes } from "@/app/api/api";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import {
    createPluginInstallationManifestPublisherSigningInputV1,
    PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1,
    REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
    stringifyPluginInstallationManifestCanonicalJsonV1,
    type PluginPermissionGrantAuditEventV1,
    type PluginPermissionGrantRequestV1,
    type PluginPermissionGrantV1,
} from "@happier-dev/protocol";
import { createSqlPluginPermissionGrantStore } from "./storage";

function registerDefaultRoutes() {
    const app = createFakeRouteApp();
    registerApiRoutes(app as any);
    return app;
}

const CODERABBIT_PLUGIN_ID = "happier.review.coderabbit";
const UNKNOWN_PLUGIN_ID = "acme.uninstalled.review";
const EXTERNAL_PLUGIN_ID = "acme.reviewbot";
let publisherMachineCounter = 0;

function encodePublisherHeader(value: unknown): string {
    return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function createSignedPublisherHeader(params: Readonly<{
    keyPair: tweetnacl.SignKeyPair;
    machineId: string;
    installationId: string;
    path: string;
    body?: unknown;
    nonce?: string;
}>): string {
    const proof = {
        v: 1 as const,
        alg: "ed25519-machine-installation-v1" as const,
        machineId: params.machineId,
        installationId: params.installationId,
        issuedAt: Date.now(),
        nonce: params.nonce ?? "nonce-1",
        method: "POST" as const,
        path: params.path,
        bodySha256Base64Url: createHash("sha256")
            .update(stringifyPluginInstallationManifestCanonicalJsonV1(params.body ?? null))
            .digest("base64url"),
        signatureBase64Url: "",
    };
    const signingInput = createPluginInstallationManifestPublisherSigningInputV1({
        proof: {
            v: proof.v,
            alg: proof.alg,
            machineId: proof.machineId,
            installationId: proof.installationId,
            issuedAt: proof.issuedAt,
            nonce: proof.nonce,
            method: proof.method,
            path: proof.path,
            bodySha256Base64Url: proof.bodySha256Base64Url,
        },
    });
    return encodePublisherHeader({
        proof: {
            ...proof,
            signatureBase64Url: Buffer.from(tweetnacl.sign.detached(signingInput, params.keyPair.secretKey)).toString("base64url"),
        },
    });
}

async function createTrustedMachine(params: Readonly<{
    accountId: string;
    machineId: string;
    installationId: string;
    keyPair: tweetnacl.SignKeyPair;
}>): Promise<void> {
    const installationPublicKey = new Uint8Array(tweetnacl.sign.publicKeyLength);
    installationPublicKey.set(params.keyPair.publicKey);
    await db.machine.create({
        data: {
            id: params.machineId,
            accountId: params.accountId,
            metadata: "{}",
            installationId: params.installationId,
            installationPublicKey,
        },
    });
}

async function createPublisherRouteRequest(params: Readonly<{
    accountId: string;
    path: string;
    body: unknown;
}>) {
    const keyPair = tweetnacl.sign.keyPair();
    publisherMachineCounter += 1;
    const machineId = `machine-plugin-projection-${publisherMachineCounter}`;
    const installationId = `installation-plugin-projection-${publisherMachineCounter}`;
    await createTrustedMachine({
        accountId: params.accountId,
        machineId,
        installationId,
        keyPair,
    });
    return {
        userId: params.accountId,
        body: params.body,
        method: "POST",
        url: params.path,
        headers: {
            [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPublisherHeader({
                keyPair,
                machineId,
                installationId,
                path: params.path,
                body: params.body,
            }),
        },
    };
}

describe("plugin permission grant durable storage", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-plugin-permission-grants-",
            initAuth: false,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        harness.resetEnv();
        await db.$executeRawUnsafe("DELETE FROM plugin_permission_grant_events").catch(() => undefined);
        await db.$executeRawUnsafe("DELETE FROM plugin_permission_grants").catch(() => undefined);
        await db.$executeRawUnsafe("DELETE FROM plugin_permission_grant_requests").catch(() => undefined);
        await db.$executeRawUnsafe("DELETE FROM account_plugin_manifest_projections").catch(() => undefined);
        await harness.resetDbTables([
            () => db.userKVStore.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("persists pending requests, grants, and audit events outside account settings", async () => {
        const account = await db.account.create({
            data: {
                id: "account-plugin-permission-grants",
                publicKey: "pk-plugin-permission-grants",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const app = registerDefaultRoutes();
        expect(app.routes.has("POST /v1/plugins/permissions/grants/request")).toBe(true);

        const requestGrant = getRouteHandler(app, "POST", "/v1/plugins/permissions/grants/request");
        const requested = await requestGrant({
            userId: account.id,
            body: {
                pluginId: CODERABBIT_PLUGIN_ID,
                capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
                targetScope: { kind: "project", projectId: "project-1" },
                reason: "Publish approved review comments directly.",
                requester: { kind: "plugin", pluginId: CODERABBIT_PLUGIN_ID, sessionId: "session-1" },
            },
        }, createReplyStub()) as any;

        expect(requested.pendingRequest).toMatchObject({
            accountId: account.id,
            pluginId: CODERABBIT_PLUGIN_ID,
            capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
            targetScope: { kind: "project", projectId: "project-1" },
            status: "pending",
        });

        const grant = getRouteHandler(app, "POST", "/v1/plugins/permissions/grants/grant");
        const granted = await grant({
            userId: account.id,
            body: { requestId: requested.pendingRequest.id },
        }, createReplyStub()) as any;

        expect(granted.grant).toMatchObject({
            accountId: account.id,
            pluginId: CODERABBIT_PLUGIN_ID,
            capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
            targetScope: { kind: "project", projectId: "project-1" },
            status: "active",
        });

        const list = getRouteHandler(app, "POST", "/v1/plugins/permissions/grants/list");
        const listed = await list({
            userId: account.id,
            body: {
                pluginId: CODERABBIT_PLUGIN_ID,
                capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
                targetScope: { kind: "project", projectId: "project-1" },
            },
        }, createReplyStub()) as any;

        expect(listed.grants).toEqual([granted.grant]);
        expect(listed.pendingRequests).toEqual([]);
        expect(await db.userKVStore.count({
            where: {
                accountId: account.id,
                key: { startsWith: "plugins/permissions" },
            },
        })).toBe(0);

        const grantRows = await db.$queryRaw<Array<{ id: string; status: string }>>`
            SELECT id, status FROM plugin_permission_grants WHERE account_id = ${account.id}
        `;
        expect(grantRows).toEqual([{ id: granted.grant.id, status: "active" }]);

        const eventRows = await db.$queryRaw<Array<{ event_kind: string }>>`
            SELECT event_kind FROM plugin_permission_grant_events WHERE account_id = ${account.id} ORDER BY created_at ASC
        `;
        expect(eventRows.map((row) => row.event_kind)).toEqual(["requested", "granted"]);
    });

    it("keeps bundled plugin grant requests valid when they include a machine publisher proof", async () => {
        const account = await db.account.create({
            data: {
                id: "account-plugin-permission-bundled-publisher-proof",
                publicKey: "pk-plugin-permission-bundled-publisher-proof",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const requestGrant = getRouteHandler(
            registerDefaultRoutes(),
            "POST",
            "/v1/plugins/permissions/grants/request",
        );
        const body = {
            pluginId: CODERABBIT_PLUGIN_ID,
            capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
            targetScope: { kind: "project", projectId: "project-1" },
            reason: "Publish approved review comments directly.",
            requester: { kind: "plugin" as const, pluginId: CODERABBIT_PLUGIN_ID },
        };
        const reply = createReplyStub();

        const result = await requestGrant(await createPublisherRouteRequest({
            accountId: account.id,
            path: "/v1/plugins/permissions/grants/request",
            body,
        }), reply) as any;

        expect(reply.statusCode).toBe(200);
        expect(result.pendingRequest).toMatchObject({
            accountId: account.id,
            pluginId: CODERABBIT_PLUGIN_ID,
            authoritySource: { kind: "bundled" },
            status: "pending",
        });
    });

    it("revokes active grants and fails closed for non-matching scopes", async () => {
        const account = await db.account.create({
            data: {
                id: "account-plugin-permission-revoke",
                publicKey: "pk-plugin-permission-revoke",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const app = registerDefaultRoutes();
        expect(app.routes.has("POST /v1/plugins/permissions/grants/request")).toBe(true);

        const requestGrant = getRouteHandler(app, "POST", "/v1/plugins/permissions/grants/request");
        const grant = getRouteHandler(app, "POST", "/v1/plugins/permissions/grants/grant");
        const list = getRouteHandler(app, "POST", "/v1/plugins/permissions/grants/list");
        const revoke = getRouteHandler(app, "POST", "/v1/plugins/permissions/grants/revoke");

        const requested = await requestGrant({
            userId: account.id,
            body: {
                pluginId: CODERABBIT_PLUGIN_ID,
                capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
                targetScope: { kind: "project", projectId: "project-1" },
                reason: "Publish approved review comments directly.",
                requester: { kind: "plugin", pluginId: CODERABBIT_PLUGIN_ID },
            },
        }, createReplyStub()) as any;
        const granted = await grant({
            userId: account.id,
            body: { requestId: requested.pendingRequest.id },
        }, createReplyStub()) as any;

        const workspaceList = await list({
            userId: account.id,
            body: {
                pluginId: CODERABBIT_PLUGIN_ID,
                capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
                targetScope: { kind: "workspace", workspaceId: "workspace-1" },
            },
        }, createReplyStub()) as any;
        expect(workspaceList.grants).toEqual([]);

        await revoke({
            userId: account.id,
            body: { grantId: granted.grant.id },
        }, createReplyStub());

        const projectList = await list({
            userId: account.id,
            body: {
                pluginId: CODERABBIT_PLUGIN_ID,
                capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
                targetScope: { kind: "project", projectId: "project-1" },
            },
        }, createReplyStub()) as any;
        expect(projectList.grants).toEqual([]);
    });

    it("does not use account grants for scoped project or workspace lookups", async () => {
        const account = await db.account.create({
            data: {
                id: "account-plugin-permission-exact-scope",
                publicKey: "pk-plugin-permission-exact-scope",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const app = registerDefaultRoutes();
        const requestGrant = getRouteHandler(app, "POST", "/v1/plugins/permissions/grants/request");
        const grant = getRouteHandler(app, "POST", "/v1/plugins/permissions/grants/grant");
        const list = getRouteHandler(app, "POST", "/v1/plugins/permissions/grants/list");

        const requested = await requestGrant({
            userId: account.id,
            body: {
                pluginId: CODERABBIT_PLUGIN_ID,
                capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
                targetScope: { kind: "account" },
                reason: "Publish approved review comments directly.",
                requester: { kind: "plugin", pluginId: CODERABBIT_PLUGIN_ID },
            },
        }, createReplyStub()) as any;
        const granted = await grant({
            userId: account.id,
            body: { requestId: requested.pendingRequest.id },
        }, createReplyStub()) as any;

        const accountList = await list({
            userId: account.id,
            body: {
                pluginId: CODERABBIT_PLUGIN_ID,
                capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
                targetScope: { kind: "account" },
            },
        }, createReplyStub()) as any;
        expect(accountList.grants).toEqual([granted.grant]);

        const projectList = await list({
            userId: account.id,
            body: {
                pluginId: CODERABBIT_PLUGIN_ID,
                capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
                targetScope: { kind: "project", projectId: "project-1" },
            },
        }, createReplyStub()) as any;
        expect(projectList.grants).toEqual([]);

        const workspaceList = await list({
            userId: account.id,
            body: {
                pluginId: CODERABBIT_PLUGIN_ID,
                capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
                targetScope: { kind: "workspace", workspaceId: "workspace-1" },
            },
        }, createReplyStub()) as any;
        expect(workspaceList.grants).toEqual([]);
    });

    it("rejects pending requests with mismatched plugin requester identity", async () => {
        const account = await db.account.create({
            data: {
                id: "account-plugin-permission-requester-spoof",
                publicKey: "pk-plugin-permission-requester-spoof",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const requestGrant = getRouteHandler(
            registerDefaultRoutes(),
            "POST",
            "/v1/plugins/permissions/grants/request",
        );
        const reply = createReplyStub();

        const result = await requestGrant({
            userId: account.id,
            body: {
                pluginId: CODERABBIT_PLUGIN_ID,
                capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
                targetScope: { kind: "project", projectId: "project-1" },
                reason: "Publish approved review comments directly.",
                requester: { kind: "plugin", pluginId: "review-deepsec" },
            },
        }, reply);

        expect(reply.statusCode).toBe(400);
        expect(result).toMatchObject({ error: "plugin_permission_grant_requester_mismatch" });
        expect(await db.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM plugin_permission_grant_requests WHERE account_id = ${account.id}
        `).toEqual([]);
    });

    it("rejects grant requests for plugins without trusted installed authority", async () => {
        const account = await db.account.create({
            data: {
                id: "account-plugin-permission-uninstalled",
                publicKey: "pk-plugin-permission-uninstalled",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const requestGrant = getRouteHandler(
            registerDefaultRoutes(),
            "POST",
            "/v1/plugins/permissions/grants/request",
        );
        const reply = createReplyStub();
        const body = {
            pluginId: UNKNOWN_PLUGIN_ID,
            capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
            targetScope: { kind: "project", projectId: "project-1" },
            reason: "Publish approved review comments directly.",
            requester: { kind: "plugin" as const, pluginId: UNKNOWN_PLUGIN_ID },
        };

        const result = await requestGrant(await createPublisherRouteRequest({
            accountId: account.id,
            path: "/v1/plugins/permissions/grants/request",
            body,
        }), reply);

        expect(reply.statusCode).toBe(400);
        expect(result).toMatchObject({ error: "plugin_permission_grant_plugin_not_trusted" });
        expect(await db.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM plugin_permission_grant_requests WHERE account_id = ${account.id}
        `).toEqual([]);
    });

    it("trusts external plugin optional grants only after host-published installed manifest projection", async () => {
        const account = await db.account.create({
            data: {
                id: "account-plugin-permission-external-installed",
                publicKey: "pk-plugin-permission-external-installed",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const app = registerDefaultRoutes();
        const upsertManifest = getRouteHandler(app, "POST", "/v1/plugins/installations/manifests/upsert");
        const deleteManifest = getRouteHandler(app, "POST", "/v1/plugins/installations/manifests/delete");
        const requestGrant = getRouteHandler(app, "POST", "/v1/plugins/permissions/grants/request");
        const grant = getRouteHandler(app, "POST", "/v1/plugins/permissions/grants/grant");
        const list = getRouteHandler(app, "POST", "/v1/plugins/permissions/grants/list");
        const requestBody = {
            pluginId: EXTERNAL_PLUGIN_ID,
            capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
            targetScope: { kind: "project", projectId: "project-1" },
            reason: "Publish approved review comments directly.",
            requester: { kind: "plugin", pluginId: EXTERNAL_PLUGIN_ID },
        };
        const projectionKeyPair = tweetnacl.sign.keyPair();
        await createTrustedMachine({
            accountId: account.id,
            machineId: "machine-plugin-projection-owner",
            installationId: "installation-plugin-projection-owner",
            keyPair: projectionKeyPair,
        });

        const failBeforeProjectionReply = createReplyStub();
        const failBeforeProjection = await requestGrant({
            userId: account.id,
            body: requestBody,
            method: "POST",
            url: "/v1/plugins/permissions/grants/request",
            headers: {
                [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPublisherHeader({
                    keyPair: projectionKeyPair,
                    machineId: "machine-plugin-projection-owner",
                    installationId: "installation-plugin-projection-owner",
                    path: "/v1/plugins/permissions/grants/request",
                    body: requestBody,
                    nonce: "nonce-request-before-projection",
                }),
            },
        }, failBeforeProjectionReply);
        expect(failBeforeProjectionReply.statusCode).toBe(400);
        expect(failBeforeProjection).toMatchObject({ error: "plugin_permission_grant_plugin_not_trusted" });

        const projectionBody = {
            pluginId: EXTERNAL_PLUGIN_ID,
            manifestVersion: "1.2.3",
            manifestDigest: "sha256:external-reviewbot",
            displayName: "Acme ReviewBot",
            requiredPermissions: [],
            optionalPermissions: [{
                capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
                reason: "Publish review comments directly when explicitly granted.",
            }],
            enabled: true,
        };
        const unauthenticatedPublisherReply = createReplyStub();
        const unauthenticatedPublisher = await upsertManifest({
            userId: account.id,
            body: projectionBody,
            method: "POST",
            url: "/v1/plugins/installations/manifests/upsert",
            headers: {},
        }, unauthenticatedPublisherReply);
        expect(unauthenticatedPublisherReply.statusCode).toBe(403);
        expect(unauthenticatedPublisher).toMatchObject({ error: "plugin_installation_manifest_publisher_proof_required" });

        const projected = await upsertManifest({
            userId: account.id,
            body: projectionBody,
            method: "POST",
            url: "/v1/plugins/installations/manifests/upsert",
            headers: {
                [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPublisherHeader({
                    keyPair: projectionKeyPair,
                    machineId: "machine-plugin-projection-owner",
                    installationId: "installation-plugin-projection-owner",
                    path: "/v1/plugins/installations/manifests/upsert",
                    body: projectionBody,
                }),
            },
        }, createReplyStub()) as any;
        expect(projected.manifest).toMatchObject({
            accountId: account.id,
            machineId: "machine-plugin-projection-owner",
            pluginId: EXTERNAL_PLUGIN_ID,
            manifestVersion: "1.2.3",
            manifestDigest: "sha256:external-reviewbot",
            enabled: true,
        });

        const missingPublisherReply = createReplyStub();
        const missingPublisher = await requestGrant({
            userId: account.id,
            body: requestBody,
        }, missingPublisherReply);
        expect(missingPublisherReply.statusCode).toBe(400);
        expect(missingPublisher).toMatchObject({ error: "plugin_permission_grant_publisher_proof_required" });

        const requested = await requestGrant({
            userId: account.id,
            body: requestBody,
            method: "POST",
            url: "/v1/plugins/permissions/grants/request",
            headers: {
                [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPublisherHeader({
                    keyPair: projectionKeyPair,
                    machineId: "machine-plugin-projection-owner",
                    installationId: "installation-plugin-projection-owner",
                    path: "/v1/plugins/permissions/grants/request",
                    body: requestBody,
                    nonce: "nonce-request-projection-owner",
                }),
            },
        }, createReplyStub()) as any;
        expect(requested.pendingRequest.authoritySource).toEqual({
            kind: "machine_installation",
            machineId: "machine-plugin-projection-owner",
            installationId: "installation-plugin-projection-owner",
        });
        const granted = await grant({
            userId: account.id,
            body: { requestId: requested.pendingRequest.id },
        }, createReplyStub()) as any;
        expect(granted.grant.authoritySource).toEqual(requested.pendingRequest.authoritySource);
        const projectList = await list({
            userId: account.id,
            body: {
                pluginId: EXTERNAL_PLUGIN_ID,
                capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
                targetScope: { kind: "project", projectId: "project-1" },
            },
        }, createReplyStub()) as any;
        expect(projectList.grants).toEqual([granted.grant]);

        const secondProjectionKeyPair = tweetnacl.sign.keyPair();
        await createTrustedMachine({
            accountId: account.id,
            machineId: "machine-plugin-projection-second",
            installationId: "installation-plugin-projection-second",
            keyPair: secondProjectionKeyPair,
        });
        await upsertManifest({
            userId: account.id,
            body: projectionBody,
            method: "POST",
            url: "/v1/plugins/installations/manifests/upsert",
            headers: {
                [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPublisherHeader({
                    keyPair: secondProjectionKeyPair,
                    machineId: "machine-plugin-projection-second",
                    installationId: "installation-plugin-projection-second",
                    path: "/v1/plugins/installations/manifests/upsert",
                    body: projectionBody,
                    nonce: "nonce-upsert-second-projection-owner",
                }),
            },
        }, createReplyStub());
        const secondMachineRequestBody = {
            ...requestBody,
            reason: "Publish approved review comments directly from a second trusted machine.",
        };
        const secondMachineRequested = await requestGrant({
            userId: account.id,
            body: secondMachineRequestBody,
            method: "POST",
            url: "/v1/plugins/permissions/grants/request",
            headers: {
                [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPublisherHeader({
                    keyPair: secondProjectionKeyPair,
                    machineId: "machine-plugin-projection-second",
                    installationId: "installation-plugin-projection-second",
                    path: "/v1/plugins/permissions/grants/request",
                    body: secondMachineRequestBody,
                    nonce: "nonce-request-second-projection-owner",
                }),
            },
        }, createReplyStub()) as any;
        const secondMachineGranted = await grant({
            userId: account.id,
            body: { requestId: secondMachineRequested.pendingRequest.id },
        }, createReplyStub()) as any;
        expect(secondMachineGranted.grant).toMatchObject({
            pluginId: EXTERNAL_PLUGIN_ID,
            targetScope: { kind: "project", projectId: "project-1" },
            authoritySource: {
                kind: "machine_installation",
                machineId: "machine-plugin-projection-second",
                installationId: "installation-plugin-projection-second",
            },
        });
        expect(secondMachineGranted.grant.id).not.toBe(granted.grant.id);

        const deleteBody = { pluginId: EXTERNAL_PLUGIN_ID };
        await deleteManifest({
            userId: account.id,
            body: deleteBody,
            method: "POST",
            url: "/v1/plugins/installations/manifests/delete",
            headers: {
                [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPublisherHeader({
                    keyPair: projectionKeyPair,
                    machineId: "machine-plugin-projection-owner",
                    installationId: "installation-plugin-projection-owner",
                    path: "/v1/plugins/installations/manifests/delete",
                    body: deleteBody,
                    nonce: "nonce-delete-projection-owner",
                }),
            },
        }, createReplyStub());
        const secondRequestReply = createReplyStub();
        const secondRequest = await requestGrant({
            userId: account.id,
            body: {
                ...requestBody,
                targetScope: { kind: "project", projectId: "project-2" },
            },
            method: "POST",
            url: "/v1/plugins/permissions/grants/request",
            headers: {
                [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPublisherHeader({
                    keyPair: projectionKeyPair,
                    machineId: "machine-plugin-projection-owner",
                    installationId: "installation-plugin-projection-owner",
                    path: "/v1/plugins/permissions/grants/request",
                    body: {
                        ...requestBody,
                        targetScope: { kind: "project", projectId: "project-2" },
                    },
                    nonce: "nonce-request-after-deleted-projection",
                }),
            },
        }, secondRequestReply);
        expect(secondRequestReply.statusCode).toBe(400);
        expect(secondRequest).toMatchObject({ error: "plugin_permission_grant_plugin_not_trusted" });
    });

    it("revokes only the matching machine-scoped external grant authority", async () => {
        const account = await db.account.create({
            data: {
                id: "account-plugin-permission-external-revoke-scope",
                publicKey: "pk-plugin-permission-external-revoke-scope",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const app = registerDefaultRoutes();
        const upsertManifest = getRouteHandler(app, "POST", "/v1/plugins/installations/manifests/upsert");
        const requestGrant = getRouteHandler(app, "POST", "/v1/plugins/permissions/grants/request");
        const grant = getRouteHandler(app, "POST", "/v1/plugins/permissions/grants/grant");
        const list = getRouteHandler(app, "POST", "/v1/plugins/permissions/grants/list");
        const revoke = getRouteHandler(app, "POST", "/v1/plugins/permissions/grants/revoke");
        const targetScope = { kind: "project" as const, projectId: "project-1" };
        const projectionBody = {
            pluginId: EXTERNAL_PLUGIN_ID,
            manifestVersion: "1.2.3",
            manifestDigest: "sha256:external-reviewbot-revoke-scope",
            displayName: "Acme ReviewBot",
            requiredPermissions: [],
            optionalPermissions: [{
                capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
                reason: "Publish review comments directly when explicitly granted.",
            }],
            enabled: true,
        };
        const createMachineGrant = async (params: Readonly<{
            machineId: string;
            installationId: string;
            nonce: string;
        }>) => {
            const keyPair = tweetnacl.sign.keyPair();
            await createTrustedMachine({
                accountId: account.id,
                machineId: params.machineId,
                installationId: params.installationId,
                keyPair,
            });
            await upsertManifest({
                userId: account.id,
                body: projectionBody,
                method: "POST",
                url: "/v1/plugins/installations/manifests/upsert",
                headers: {
                    [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPublisherHeader({
                        keyPair,
                        machineId: params.machineId,
                        installationId: params.installationId,
                        path: "/v1/plugins/installations/manifests/upsert",
                        body: projectionBody,
                        nonce: `${params.nonce}-manifest`,
                    }),
                },
            }, createReplyStub());
            const requestBody = {
                pluginId: EXTERNAL_PLUGIN_ID,
                capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
                targetScope,
                reason: "Publish approved review comments directly.",
                requester: { kind: "plugin" as const, pluginId: EXTERNAL_PLUGIN_ID },
            };
            const requested = await requestGrant({
                userId: account.id,
                body: requestBody,
                method: "POST",
                url: "/v1/plugins/permissions/grants/request",
                headers: {
                    [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPublisherHeader({
                        keyPair,
                        machineId: params.machineId,
                        installationId: params.installationId,
                        path: "/v1/plugins/permissions/grants/request",
                        body: requestBody,
                        nonce: `${params.nonce}-request`,
                    }),
                },
            }, createReplyStub()) as any;
            return await grant({
                userId: account.id,
                body: { requestId: requested.pendingRequest.id },
            }, createReplyStub()) as any;
        };

        const firstGrant = await createMachineGrant({
            machineId: "machine-plugin-revoke-scope-one",
            installationId: "installation-plugin-revoke-scope-one",
            nonce: "nonce-revoke-scope-one",
        });
        const secondGrant = await createMachineGrant({
            machineId: "machine-plugin-revoke-scope-two",
            installationId: "installation-plugin-revoke-scope-two",
            nonce: "nonce-revoke-scope-two",
        });

        await revoke({
            userId: account.id,
            body: { grantId: firstGrant.grant.id, reason: "Remove one installation authority." },
        }, createReplyStub());

        const activeAfterRevoke = await list({
            userId: account.id,
            body: {
                pluginId: EXTERNAL_PLUGIN_ID,
                capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
                targetScope,
            },
        }, createReplyStub()) as any;
        expect(activeAfterRevoke.grants).toEqual([secondGrant.grant]);

        const grantRows = await db.$queryRaw<Array<{
            id: string;
            status: string;
            authority_machine_id: string | null;
        }>>`
            SELECT id, status, authority_machine_id
            FROM plugin_permission_grants
            WHERE account_id = ${account.id}
              AND plugin_id = ${EXTERNAL_PLUGIN_ID}
              AND capability = ${REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1}
            ORDER BY authority_machine_id ASC
        `;
        expect(grantRows).toEqual([
            {
                id: firstGrant.grant.id,
                status: "revoked",
                authority_machine_id: "machine-plugin-revoke-scope-one",
            },
            {
                id: secondGrant.grant.id,
                status: "active",
                authority_machine_id: "machine-plugin-revoke-scope-two",
            },
        ]);

        const revokeEvents = await db.$queryRaw<Array<{
            grant_id: string | null;
            authority_machine_id: string | null;
            event_kind: string;
        }>>`
            SELECT grant_id, authority_machine_id, event_kind
            FROM plugin_permission_grant_events
            WHERE account_id = ${account.id}
              AND event_kind = 'revoked'
            ORDER BY created_at ASC
        `;
        expect(revokeEvents).toEqual([{
            grant_id: firstGrant.grant.id,
            authority_machine_id: "machine-plugin-revoke-scope-one",
            event_kind: "revoked",
        }]);
    });

    it("returns a stable validation error for malformed installed manifest projection payloads", async () => {
        const account = await db.account.create({
            data: {
                id: "account-plugin-permission-malformed-projection",
                publicKey: "pk-plugin-permission-malformed-projection",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const app = registerDefaultRoutes();
        const upsertManifest = getRouteHandler(app, "POST", "/v1/plugins/installations/manifests/upsert");
        const malformedBody = {
            pluginId: EXTERNAL_PLUGIN_ID,
            manifestVersion: "",
            manifestDigest: "sha256:external-reviewbot",
            displayName: "Acme ReviewBot",
            requiredPermissions: [],
            optionalPermissions: [],
        };
        const reply = createReplyStub();

        const result = await upsertManifest(await createPublisherRouteRequest({
            accountId: account.id,
            path: "/v1/plugins/installations/manifests/upsert",
            body: malformedBody,
        }), reply);

        expect(reply.statusCode).toBe(400);
        expect(result).toMatchObject({ error: "plugin_installation_manifest_invalid_request" });
    });

    it("rejects external installed manifest projections for reserved first-party plugin ids", async () => {
        const account = await db.account.create({
            data: {
                id: "account-plugin-permission-reserved-projection",
                publicKey: "pk-plugin-permission-reserved-projection",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const upsertManifest = getRouteHandler(
            registerDefaultRoutes(),
            "POST",
            "/v1/plugins/installations/manifests/upsert",
        );
        const reply = createReplyStub();

        const body = {
            pluginId: CODERABBIT_PLUGIN_ID,
            manifestVersion: "1.0.0",
            manifestDigest: "sha256:spoofed-first-party",
            displayName: "Spoofed CodeRabbit",
            requiredPermissions: [],
            optionalPermissions: [{
                capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
                reason: "Spoof a first-party optional permission.",
            }],
        };
        const result = await upsertManifest(await createPublisherRouteRequest({
            accountId: account.id,
            path: "/v1/plugins/installations/manifests/upsert",
            body,
        }), reply);

        expect(reply.statusCode).toBe(400);
        expect(result).toMatchObject({ error: "plugin_installation_manifest_reserved_plugin_id" });
        expect(await db.$queryRaw<Array<{ plugin_id: string }>>`
            SELECT plugin_id FROM account_plugin_manifest_projections WHERE account_id = ${account.id}
        `).toEqual([]);
    });

    it("rejects grant requests for capabilities missing from the trusted plugin optional manifest permissions", async () => {
        const account = await db.account.create({
            data: {
                id: "account-plugin-permission-undeclared",
                publicKey: "pk-plugin-permission-undeclared",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const requestGrant = getRouteHandler(
            registerDefaultRoutes(),
            "POST",
            "/v1/plugins/permissions/grants/request",
        );
        const reply = createReplyStub();

        const result = await requestGrant({
            userId: account.id,
            body: {
                pluginId: CODERABBIT_PLUGIN_ID,
                capability: "env",
                targetScope: { kind: "project", projectId: "project-1" },
                reason: "Read environment variables directly.",
                requester: { kind: "plugin", pluginId: CODERABBIT_PLUGIN_ID },
            },
        }, reply);

        expect(reply.statusCode).toBe(400);
        expect(result).toMatchObject({ error: "plugin_permission_grant_capability_not_declared" });
        expect(await db.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM plugin_permission_grant_requests WHERE account_id = ${account.id}
        `).toEqual([]);
    });

    it("keeps one active grant per scope and revokes the canonical grant", async () => {
        const account = await db.account.create({
            data: {
                id: "account-plugin-permission-canonical-revoke",
                publicKey: "pk-plugin-permission-canonical-revoke",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const app = registerDefaultRoutes();
        const requestGrant = getRouteHandler(app, "POST", "/v1/plugins/permissions/grants/request");
        const grant = getRouteHandler(app, "POST", "/v1/plugins/permissions/grants/grant");
        const list = getRouteHandler(app, "POST", "/v1/plugins/permissions/grants/list");
        const revoke = getRouteHandler(app, "POST", "/v1/plugins/permissions/grants/revoke");
        const requestBody = {
            pluginId: CODERABBIT_PLUGIN_ID,
            capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
            targetScope: { kind: "project", projectId: "project-1" },
            reason: "Publish approved review comments directly.",
            requester: { kind: "plugin", pluginId: CODERABBIT_PLUGIN_ID },
        };

        const firstRequest = await requestGrant({
            userId: account.id,
            body: requestBody,
        }, createReplyStub()) as any;
        const firstGrant = await grant({
            userId: account.id,
            body: { requestId: firstRequest.pendingRequest.id },
        }, createReplyStub()) as any;
        const secondRequest = await requestGrant({
            userId: account.id,
            body: requestBody,
        }, createReplyStub()) as any;
        const secondGrant = await grant({
            userId: account.id,
            body: { requestId: secondRequest.pendingRequest.id },
        }, createReplyStub()) as any;

        expect(secondGrant.grant.id).toBe(firstGrant.grant.id);
        const activeBeforeRevoke = await list({
            userId: account.id,
            body: {
                pluginId: CODERABBIT_PLUGIN_ID,
                capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
                targetScope: { kind: "project", projectId: "project-1" },
            },
        }, createReplyStub()) as any;
        expect(activeBeforeRevoke.grants).toEqual([firstGrant.grant]);

        await revoke({
            userId: account.id,
            body: { grantId: firstGrant.grant.id },
        }, createReplyStub());
        const activeAfterRevoke = await list({
            userId: account.id,
            body: {
                pluginId: CODERABBIT_PLUGIN_ID,
                capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
                targetScope: { kind: "project", projectId: "project-1" },
            },
        }, createReplyStub()) as any;
        expect(activeAfterRevoke.grants).toEqual([]);
    });

    it("enforces one active grant at the durable store layer for duplicate concurrent grant writes", async () => {
        const account = await db.account.create({
            data: {
                id: "account-plugin-permission-concurrent",
                publicKey: "pk-plugin-permission-concurrent",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const store = createSqlPluginPermissionGrantStore();
        const targetScope = { kind: "project" as const, projectId: "project-1" };
        const requester = { kind: "plugin" as const, pluginId: CODERABBIT_PLUGIN_ID };
        const pendingRequests: PluginPermissionGrantRequestV1[] = [1, 2].map((index) => ({
            v: 1,
            id: `request-concurrent-${index}`,
            accountId: account.id,
            pluginId: CODERABBIT_PLUGIN_ID,
            capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
            targetScope,
            authoritySource: { kind: "bundled" },
            requester,
            reason: "Publish approved review comments directly.",
            status: "pending",
            createdByUserId: account.id,
            createdAt: index,
            updatedAt: index,
        }));
        const requestEvent = (pendingRequest: PluginPermissionGrantRequestV1, index: number): PluginPermissionGrantAuditEventV1 => ({
            v: 1,
            eventId: `event-request-concurrent-${index}`,
            accountId: account.id,
            pluginId: pendingRequest.pluginId,
            capability: pendingRequest.capability,
            targetScope: pendingRequest.targetScope,
            authoritySource: pendingRequest.authoritySource,
            eventKind: "requested",
            actor: requester,
            requestId: pendingRequest.id,
            nextState: { requestStatus: pendingRequest.status },
            createdAt: index,
        });
        await Promise.all(pendingRequests.map((pendingRequest, index) => store.createPendingRequest({
            pendingRequest,
            event: requestEvent(pendingRequest, index + 1),
        })));

        const grantFor = (pendingRequest: PluginPermissionGrantRequestV1, index: number): PluginPermissionGrantV1 => ({
            v: 1,
            id: `grant-concurrent-${index}`,
            accountId: account.id,
            pluginId: pendingRequest.pluginId,
            capability: pendingRequest.capability,
            targetScope: pendingRequest.targetScope,
            authoritySource: pendingRequest.authoritySource,
            status: "active",
            requestId: pendingRequest.id,
            grantedByUserId: account.id,
            grantedAt: 10 + index,
            createdAt: 10 + index,
            updatedAt: 10 + index,
        });
        const grantEvent = (
            pendingRequest: PluginPermissionGrantRequestV1,
            grant: PluginPermissionGrantV1,
            index: number,
        ): PluginPermissionGrantAuditEventV1 => ({
            v: 1,
            eventId: `event-grant-concurrent-${index}`,
            accountId: account.id,
            pluginId: grant.pluginId,
            capability: grant.capability,
            targetScope: grant.targetScope,
            authoritySource: grant.authoritySource,
            eventKind: "granted",
            actor: { kind: "user", userId: account.id },
            requestId: pendingRequest.id,
            grantId: grant.id,
            previousState: { requestStatus: "pending" },
            nextState: { requestStatus: "granted", grantStatus: "active" },
            createdAt: 20 + index,
        });

        const results = await Promise.allSettled(pendingRequests.map((pendingRequest, index) => {
            const grant = grantFor(pendingRequest, index + 1);
            return store.grantPendingRequest({
                pendingRequest: {
                    ...pendingRequest,
                    status: "granted",
                    grantId: grant.id,
                    decidedByUserId: account.id,
                    decidedAt: 20 + index,
                    updatedAt: 20 + index,
                },
                grant,
                event: grantEvent(pendingRequest, grant, index + 1),
            });
        }));

        const fulfilled = results.filter((result) => result.status === "fulfilled");
        expect(fulfilled).toHaveLength(1);
        const activeRows = await db.$queryRaw<Array<{ id: string }>>`
            SELECT id
            FROM plugin_permission_grants
            WHERE account_id = ${account.id}
              AND plugin_id = ${CODERABBIT_PLUGIN_ID}
              AND capability = ${REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1}
              AND scope_kind = 'project'
              AND scope_project_id = 'project-1'
              AND status = 'active'
            ORDER BY id ASC
        `;
        expect(activeRows).toHaveLength(1);
    });
});
