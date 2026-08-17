import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import tweetnacl from "tweetnacl";

import { createFakeRouteApp, createReplyStub, getRouteHandler } from "@/app/api/testkit/routeHarness";
import { registerApiRoutes } from "@/app/api/api";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import {
    createPluginInstallationManifestPublisherSigningInputV1,
    GENERAL_PLUGIN_PERMISSION_SUBJECT_V1,
    PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1,
    REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
    stringifyPluginInstallationManifestCanonicalJsonV1,
    type PluginPermissionGrantAuditEventV1,
    type PluginPermissionGrantRequestV1,
    type PluginPermissionGrantV1,
} from "@happier-dev/protocol";
import { createPluginPermissionGrantOperations } from "./operations";
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
        const requestBody = {
            pluginId: CODERABBIT_PLUGIN_ID,
            capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
            targetScope: { kind: "project" as const, projectId: "project-1" },
            subject: GENERAL_PLUGIN_PERMISSION_SUBJECT_V1,
            reason: "Publish approved review comments directly.",
            requester: { kind: "plugin" as const, pluginId: CODERABBIT_PLUGIN_ID, sessionId: "session-1" },
        };
        const requested = await requestGrant(await createPublisherRouteRequest({
            accountId: account.id,
            path: "/v1/plugins/permissions/grants/request",
            body: requestBody,
        }), createReplyStub()) as any;

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
            subject: GENERAL_PLUGIN_PERMISSION_SUBJECT_V1,
            reason: "Publish approved review comments directly.",
            requester: { kind: "plugin" as const, pluginId: CODERABBIT_PLUGIN_ID },
        };
        const missingPublisherReply = createReplyStub();
        const missingPublisher = await requestGrant({ userId: account.id, body }, missingPublisherReply);
        expect(missingPublisherReply.statusCode).toBe(400);
        expect(missingPublisher).toMatchObject({ error: "plugin_permission_grant_publisher_proof_required" });

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
            authoritySource: {
                kind: "machine_installation",
                machineId: expect.any(String),
                installationId: expect.any(String),
            },
            status: "pending",
        });
    });

    it("reuses one pending request for concurrent signed requests from the same machine installation and scope", async () => {
        const account = await db.account.create({
            data: {
                id: "account-plugin-permission-concurrent-request",
                publicKey: "pk-plugin-permission-concurrent-request",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const keyPair = tweetnacl.sign.keyPair();
        const machineId = "machine-plugin-permission-concurrent-request";
        const installationId = "installation-plugin-permission-concurrent-request";
        await createTrustedMachine({
            accountId: account.id,
            machineId,
            installationId,
            keyPair,
        });
        const path = "/v1/plugins/permissions/grants/request";
        const body = {
            pluginId: CODERABBIT_PLUGIN_ID,
            capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
            targetScope: { kind: "project" as const, projectId: "project-concurrent" },
            subject: GENERAL_PLUGIN_PERMISSION_SUBJECT_V1,
            reason: "Publish approved review comments directly.",
            requester: {
                kind: "plugin" as const,
                pluginId: CODERABBIT_PLUGIN_ID,
                sessionId: "session-concurrent",
                requestId: "call-concurrent",
            },
        };
        const requestGrant = getRouteHandler(registerDefaultRoutes(), "POST", path);
        const routeRequest = (nonce: string) => ({
            userId: account.id,
            body,
            method: "POST",
            url: path,
            headers: {
                [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPublisherHeader({
                    keyPair,
                    machineId,
                    installationId,
                    path,
                    body,
                    nonce,
                }),
            },
        });

        const [first, second] = await Promise.all([
            requestGrant(routeRequest("nonce-concurrent-request-1"), createReplyStub()),
            requestGrant(routeRequest("nonce-concurrent-request-2"), createReplyStub()),
        ]) as any[];

        expect(second.pendingRequest.id).toBe(first.pendingRequest.id);
        const pendingRows = await db.$queryRaw<Array<{ id: string }>>`
            SELECT id
            FROM plugin_permission_grant_requests
            WHERE account_id = ${account.id}
              AND plugin_id = ${CODERABBIT_PLUGIN_ID}
              AND capability = ${REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1}
              AND scope_kind = 'project'
              AND scope_project_id = 'project-concurrent'
              AND authority_kind = 'machine_installation'
              AND authority_machine_id = ${machineId}
              AND authority_installation_id = ${installationId}
              AND status = 'pending'
        `;
        expect(pendingRows).toEqual([{ id: first.pendingRequest.id }]);
        const requestedEvents = await db.$queryRaw<Array<{ request_id: string }>>`
            SELECT request_id
            FROM plugin_permission_grant_events
            WHERE account_id = ${account.id}
              AND event_kind = 'requested'
        `;
        expect(requestedEvents).toEqual([{ request_id: first.pendingRequest.id }]);
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

        const requestBody = {
            pluginId: CODERABBIT_PLUGIN_ID,
            capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
            targetScope: { kind: "project" as const, projectId: "project-1" },
            subject: GENERAL_PLUGIN_PERMISSION_SUBJECT_V1,
            reason: "Publish approved review comments directly.",
            requester: { kind: "plugin" as const, pluginId: CODERABBIT_PLUGIN_ID },
        };
        const requested = await requestGrant(await createPublisherRouteRequest({
            accountId: account.id,
            path: "/v1/plugins/permissions/grants/request",
            body: requestBody,
        }), createReplyStub()) as any;
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

    it("accepts account scopes through the generic permission authority", async () => {
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
        const body = {
            pluginId: CODERABBIT_PLUGIN_ID,
            capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
            targetScope: { kind: "account" as const },
            subject: GENERAL_PLUGIN_PERMISSION_SUBJECT_V1,
            reason: "Publish approved review comments directly.",
            requester: { kind: "plugin" as const, pluginId: CODERABBIT_PLUGIN_ID },
        };
        const reply = createReplyStub();
        const accepted = await requestGrant(await createPublisherRouteRequest({
            accountId: account.id,
            path: "/v1/plugins/permissions/grants/request",
            body,
        }), reply);
        expect(reply.statusCode).toBe(200);
        expect(accepted).toMatchObject({ pendingRequest: { targetScope: { kind: "account" } } });
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
                subject: GENERAL_PLUGIN_PERMISSION_SUBJECT_V1,
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

    it("accepts non-reserved external plugin requests from an exact verified machine installation", async () => {
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
            subject: GENERAL_PLUGIN_PERMISSION_SUBJECT_V1,
            reason: "Publish approved review comments directly.",
            requester: { kind: "plugin" as const, pluginId: UNKNOWN_PLUGIN_ID },
        };

        const result = await requestGrant(await createPublisherRouteRequest({
            accountId: account.id,
            path: "/v1/plugins/permissions/grants/request",
            body,
        }), reply);

        expect(reply.statusCode).toBe(200);
        expect(result).toMatchObject({
            pendingRequest: {
                pluginId: UNKNOWN_PLUGIN_ID,
                targetScope: { kind: "project", projectId: "project-1" },
                authoritySource: {
                    kind: "machine_installation",
                    machineId: expect.any(String),
                    installationId: expect.any(String),
                },
            },
        });
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
            subject: GENERAL_PLUGIN_PERMISSION_SUBJECT_V1,
            reason: "Publish approved review comments directly.",
            requester: { kind: "plugin", pluginId: CODERABBIT_PLUGIN_ID },
        };
        const publisherRequest = await createPublisherRouteRequest({
            accountId: account.id,
            path: "/v1/plugins/permissions/grants/request",
            body: requestBody,
        });

        const firstRequest = await requestGrant(publisherRequest, createReplyStub()) as any;
        await db.$executeRaw`
            UPDATE plugin_permission_grant_requests
            SET active_identity_key = NULL
            WHERE account_id = ${account.id} AND id = ${firstRequest.pendingRequest.id}
        `;
        const legacyPendingReplay = await requestGrant(publisherRequest, createReplyStub()) as any;
        expect(legacyPendingReplay.pendingRequest.id).toBe(firstRequest.pendingRequest.id);
        const firstGrant = await grant({
            userId: account.id,
            body: { requestId: firstRequest.pendingRequest.id },
        }, createReplyStub()) as any;
        await db.$executeRaw`
            UPDATE plugin_permission_grants
            SET active_identity_key = ${"legacy\u001Fraw\u001Factive-key"}
            WHERE account_id = ${account.id} AND id = ${firstGrant.grant.id}
        `;
        const secondRequest = await requestGrant(publisherRequest, createReplyStub()) as any;
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
        const pendingRequest: PluginPermissionGrantRequestV1 = {
            v: 1,
            id: "request-concurrent",
            accountId: account.id,
            pluginId: CODERABBIT_PLUGIN_ID,
            capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
            targetScope,
            subject: GENERAL_PLUGIN_PERMISSION_SUBJECT_V1,
            authoritySource: { kind: "bundled" },
            requester,
            reason: "Publish approved review comments directly.",
            status: "pending",
            createdByUserId: account.id,
            createdAt: 1,
            updatedAt: 1,
        };
        const requestEvent = (pendingRequest: PluginPermissionGrantRequestV1, index: number): PluginPermissionGrantAuditEventV1 => ({
            v: 1,
            eventId: `event-request-concurrent-${index}`,
            accountId: account.id,
            pluginId: pendingRequest.pluginId,
            capability: pendingRequest.capability,
            targetScope: pendingRequest.targetScope,
            subject: pendingRequest.subject,
            authoritySource: pendingRequest.authoritySource,
            eventKind: "requested",
            actor: requester,
            requestId: pendingRequest.id,
            nextState: { requestStatus: pendingRequest.status },
            createdAt: index,
        });
        await store.createPendingRequest({
            pendingRequest,
            event: requestEvent(pendingRequest, 1),
        });

        const grantFor = (pendingRequest: PluginPermissionGrantRequestV1, index: number): PluginPermissionGrantV1 => ({
            v: 1,
            id: `grant-concurrent-${index}`,
            accountId: account.id,
            pluginId: pendingRequest.pluginId,
            capability: pendingRequest.capability,
            targetScope: pendingRequest.targetScope,
            subject: pendingRequest.subject,
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
            subject: grant.subject,
            authoritySource: grant.authoritySource,
            eventKind: "granted",
            actor: { kind: "user", userId: account.id },
            requestId: pendingRequest.id,
            grantId: grant.id,
            previousState: { requestStatus: "pending" },
            nextState: { requestStatus: "granted", grantStatus: "active" },
            createdAt: 20 + index,
        });

        const results = await Promise.allSettled([1, 2].map((index) => {
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

    it("commits exactly one terminal decision when grant and dismiss race from the same pending read", async () => {
        const account = await db.account.create({
            data: {
                id: "account-plugin-permission-terminal-race",
                publicKey: "pk-plugin-permission-terminal-race",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const baseStore = createSqlPluginPermissionGrantStore();
        const authoritySource = {
            kind: "machine_installation" as const,
            machineId: "machine-terminal-race",
            installationId: "installation-terminal-race",
        };
        const pendingRequest: PluginPermissionGrantRequestV1 = {
            v: 1,
            id: "request-terminal-race",
            accountId: account.id,
            pluginId: CODERABBIT_PLUGIN_ID,
            capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
            targetScope: { kind: "project", projectId: "project-1" },
            subject: GENERAL_PLUGIN_PERMISSION_SUBJECT_V1,
            authoritySource,
            requester: { kind: "plugin", pluginId: CODERABBIT_PLUGIN_ID },
            reason: "Publish approved review comments directly.",
            status: "pending",
            createdByUserId: account.id,
            createdAt: 1,
            updatedAt: 1,
        };
        await baseStore.createPendingRequest({
            pendingRequest,
            event: {
                v: 1,
                eventId: "event-request-terminal-race",
                accountId: account.id,
                pluginId: pendingRequest.pluginId,
                capability: pendingRequest.capability,
                targetScope: pendingRequest.targetScope,
                subject: pendingRequest.subject,
                authoritySource,
                eventKind: "requested",
                actor: pendingRequest.requester,
                requestId: pendingRequest.id,
                nextState: { requestStatus: "pending" },
                createdAt: 1,
            },
        });

        let readCount = 0;
        let releaseReads!: () => void;
        const bothRead = new Promise<void>((resolve) => {
            releaseReads = resolve;
        });
        const store = {
            ...baseStore,
            async getRequest(params: Parameters<typeof baseStore.getRequest>[0]) {
                const request = await baseStore.getRequest(params);
                readCount += 1;
                if (readCount === 2) releaseReads();
                await bothRead;
                return request;
            },
        };
        let idSequence = 0;
        const operations = createPluginPermissionGrantOperations(
            store,
            {
                now: () => 10,
                createId: (prefix) => `${prefix}-terminal-race-${++idSequence}`,
            },
            (request) => request.machineId === authoritySource.machineId
                && request.installationId === authoritySource.installationId
                ? { source: authoritySource }
                : null,
        );

        const results = await Promise.allSettled([
            operations.grant({
                accountId: account.id,
                userId: account.id,
                input: { requestId: pendingRequest.id },
            }),
            operations.dismissRequest({
                accountId: account.id,
                userId: account.id,
                input: { requestId: pendingRequest.id },
            }),
        ]);

        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
        const storedRequest = await baseStore.getRequest({
            accountId: account.id,
            requestId: pendingRequest.id,
        });
        const terminalEvents = await db.$queryRaw<Array<{ event_kind: string }>>`
            SELECT event_kind
            FROM plugin_permission_grant_events
            WHERE account_id = ${account.id}
              AND request_id = ${pendingRequest.id}
              AND event_kind IN ('granted', 'dismissed')
        `;
        expect(terminalEvents).toHaveLength(1);
        if (storedRequest?.status === "granted") {
            expect((await baseStore.list({
                accountId: account.id,
                pluginId: pendingRequest.pluginId,
                capability: pendingRequest.capability,
                targetScope: pendingRequest.targetScope,
                subject: pendingRequest.subject,
                authoritySource,
                includeRevoked: false,
                includeResolvedRequests: false,
                limit: 10,
            })).grants).toHaveLength(1);
        } else {
            expect(storedRequest?.status).toBe("dismissed");
        }
    });
});
