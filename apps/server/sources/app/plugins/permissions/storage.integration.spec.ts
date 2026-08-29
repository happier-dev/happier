import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import tweetnacl from "tweetnacl";

import { createFakeRouteApp, createReplyStub, getRouteHandler } from "@/app/api/testkit/routeHarness";
import { registerApiRoutes } from "@/app/api/api";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createPluginAvailabilityOperations } from "@/app/plugins/availability/operations";
import {
    createSignedPluginInstallationPublisherHeader,
    createTrustedMachineInstallation,
} from "@/testkit/pluginInstallationPublisherTestkit";
import {
    GENERAL_PLUGIN_PERMISSION_SUBJECT_V1,
    PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1,
    REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
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
const THIRD_PARTY_PLUGIN_ID = "acme.external.review";
const EXTERNAL_PLUGIN_ID = "acme.reviewbot";
const PINNED_SERVER_IDENTITY_ID = "srv_permissionCallerIntegration";
const CURRENT_MATERIALIZATION_ID = "install-epoch-permission-caller-current";
let publisherMachineCounter = 0;

function callerReleaseFacts(pluginId: string) {
    const version = "1.2.3";
    return {
        ref: { pluginId, version },
        archiveDigestSha256: `sha256:${"a".repeat(64)}`,
        normalizedManifest: {
            schemaVersion: 2,
            id: pluginId,
            version,
            displayName: "Permission caller fixture",
            engines: { happier: "^1.0.0" },
            runtime: { apiVersion: 1 },
            contributes: {},
        },
        collectionContracts: [],
        uiSlots: [{
            contributionId: "hosted",
            tier: "hostedWeb",
            platform: "web",
            artifactDigest: `sha256:${"b".repeat(64)}`,
            compatibility: {
                hostUiApiVersion: "1.0.0",
            },
        }],
        packageAssetArchive: {
            archiveDigestSha256: `sha256:${"c".repeat(64)}`,
            resources: [],
        },
    };
}

/**
 * Seeds the exact current Availability generation the caller-materialization
 * owner resolves: one verified release plus one trusted reported
 * materialization bound to the pinned server identity.
 */
async function seedCurrentCallerMaterialization(params: Readonly<{
    accountId: string;
    machineId: string;
    materializationId: string;
    pluginId: string;
}>): Promise<void> {
    const availability = createPluginAvailabilityOperations({
        resolveServerIdentityId: async () => PINNED_SERVER_IDENTITY_ID,
    });
    const facts = callerReleaseFacts(params.pluginId);
    await availability.publishRelease({
        accountId: params.accountId,
        input: { facts, sourceClass: "registryPackage" },
    });
    await availability.reportMaterializations({
        accountId: params.accountId,
        publisherMachineId: params.machineId,
        input: {
            snapshot: {
                serverIdentityId: PINNED_SERVER_IDENTITY_ID,
                machineId: params.machineId,
                revision: 1,
                materializations: [{
                    serverIdentityId: PINNED_SERVER_IDENTITY_ID,
                    machineId: params.machineId,
                    materializationId: params.materializationId,
                    pluginId: params.pluginId,
                    version: facts.ref.version,
                    sourceClass: "registryPackage" as const,
                    portableRelease: true,
                    archiveDigestSha256: facts.archiveDigestSha256,
                    uiArtifacts: facts.uiSlots.map(({ compatibility: _compatibility, ...slot }) => slot),
                    enabled: true,
                    trustState: "trusted" as const,
                    observedAt: 1_700_000_000_000,
                }],
            },
        },
    });
}

async function createPublisherRouteRequest(params: Readonly<{
    accountId: string;
    path: string;
    body: unknown;
}>) {
    const bodyRecord = params.body && typeof params.body === "object" && !Array.isArray(params.body)
        ? params.body as Readonly<Record<string, unknown>>
        : {};
    const pluginId = typeof bodyRecord?.pluginId === "string" ? bodyRecord.pluginId : "";
    if (!pluginId) throw new Error("permission publisher fixture requires a plugin id");
    const keyPair = tweetnacl.sign.keyPair();
    publisherMachineCounter += 1;
    const machineId = `machine-plugin-projection-${publisherMachineCounter}`;
    const installationId = `installation-plugin-projection-${publisherMachineCounter}`;
    const materializationId = `materialization-plugin-projection-${publisherMachineCounter}`;
    await createTrustedMachineInstallation({
        accountId: params.accountId,
        machineId,
        installationId,
        keyPair,
    });
    vi.stubEnv("HAPPIER_SERVER_IDENTITY_ID", PINNED_SERVER_IDENTITY_ID);
    await seedCurrentCallerMaterialization({
        accountId: params.accountId,
        machineId,
        materializationId,
        pluginId,
    });
    const body = {
        ...bodyRecord,
        caller: { machineId, materializationId, pluginId },
    };
    return {
        userId: params.accountId,
        body,
        method: "POST",
        url: params.path,
        headers: {
            [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPluginInstallationPublisherHeader({
                keyPair,
                machineId,
                installationId,
                path: params.path,
                body,
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
            () => db.pluginMachineMaterialization.deleteMany(),
            () => db.accountPluginRelease.deleteMany(),
            () => db.accountPluginIntent.deleteMany(),
            () => db.accountChange.deleteMany(),
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

    it("keeps trusted plugin grant requests valid with a signed exact current materialization caller", async () => {
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
        await createTrustedMachineInstallation({
            accountId: account.id,
            machineId,
            installationId,
            keyPair,
        });
        vi.stubEnv("HAPPIER_SERVER_IDENTITY_ID", PINNED_SERVER_IDENTITY_ID);
        const materializationId = "materialization-plugin-permission-concurrent-request";
        await seedCurrentCallerMaterialization({
            accountId: account.id,
            machineId,
            materializationId,
            pluginId: CODERABBIT_PLUGIN_ID,
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
            caller: { machineId, materializationId, pluginId: CODERABBIT_PLUGIN_ID },
        };
        const requestGrant = getRouteHandler(registerDefaultRoutes(), "POST", path);
        const routeRequest = (nonce: string) => ({
            userId: account.id,
            body,
            method: "POST",
            url: path,
            headers: {
                [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPluginInstallationPublisherHeader({
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

    it("accepts non-reserved external plugin requests from an exact current verified machine materialization", async () => {
        const account = await db.account.create({
            data: {
                id: "account-plugin-permission-third-party",
                publicKey: "pk-plugin-permission-third-party",
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
            pluginId: THIRD_PARTY_PLUGIN_ID,
            capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
            targetScope: { kind: "project", projectId: "project-1" },
            subject: GENERAL_PLUGIN_PERMISSION_SUBJECT_V1,
            reason: "Publish approved review comments directly.",
            requester: { kind: "plugin" as const, pluginId: THIRD_PARTY_PLUGIN_ID },
        };

        const result = await requestGrant(await createPublisherRouteRequest({
            accountId: account.id,
            path: "/v1/plugins/permissions/grants/request",
            body,
        }), reply);

        expect(reply.statusCode).toBe(200);
        expect(result).toMatchObject({
            pendingRequest: {
                pluginId: THIRD_PARTY_PLUGIN_ID,
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

    it("binds grant request/list ingress to the exact signed current materialization caller and refuses spoofed or stale refs", async () => {
        vi.stubEnv("HAPPIER_SERVER_IDENTITY_ID", PINNED_SERVER_IDENTITY_ID);
        const account = await db.account.create({
            data: {
                id: "account-plugin-permission-exact-caller",
                publicKey: "pk-plugin-permission-exact-caller",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const keyPair = tweetnacl.sign.keyPair();
        const machineId = "machine-plugin-permission-exact-caller";
        const installationId = "installation-plugin-permission-exact-caller";
        await createTrustedMachineInstallation({ accountId: account.id, machineId, installationId, keyPair });
        await seedCurrentCallerMaterialization({
            accountId: account.id,
            machineId,
            materializationId: CURRENT_MATERIALIZATION_ID,
            pluginId: CODERABBIT_PLUGIN_ID,
        });

        const routes = registerDefaultRoutes();
        const requestGrant = getRouteHandler(routes, "POST", "/v1/plugins/permissions/grants/request");
        const listGrants = getRouteHandler(routes, "POST", "/v1/plugins/permissions/grants/list");

        const requestBase = {
            capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
            targetScope: { kind: "project", projectId: "project-exact-caller" },
            subject: GENERAL_PLUGIN_PERMISSION_SUBJECT_V1,
            reason: "Publish approved review comments directly.",
        };

        // Spoofed operation plugin identity: the signed proof and materialization
        // name CODERABBIT, the operation names another plugin.
        const spoofedReply = createReplyStub();
        const spoofed = await requestGrant({
            userId: account.id,
            method: "POST",
            url: "/v1/plugins/permissions/grants/request",
            headers: {
                [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPluginInstallationPublisherHeader({
                    keyPair,
                    machineId,
                    installationId,
                    path: "/v1/plugins/permissions/grants/request",
                    body: {
                        ...requestBase,
                        pluginId: EXTERNAL_PLUGIN_ID,
                        requester: { kind: "plugin", pluginId: EXTERNAL_PLUGIN_ID },
                        caller: { machineId, materializationId: CURRENT_MATERIALIZATION_ID, pluginId: CODERABBIT_PLUGIN_ID },
                    },
                }),
            },
            body: {
                ...requestBase,
                pluginId: EXTERNAL_PLUGIN_ID,
                requester: { kind: "plugin", pluginId: EXTERNAL_PLUGIN_ID },
                caller: { machineId, materializationId: CURRENT_MATERIALIZATION_ID, pluginId: CODERABBIT_PLUGIN_ID },
            },
        }, spoofedReply);
        expect(spoofedReply.statusCode).toBe(403);
        expect(spoofed).toMatchObject({ error: "plugin_permission_grant_caller_mismatch" });

        // Stale/unknown materialization under the proven machine: never current.
        const staleReply = createReplyStub();
        const staleBody = {
            ...requestBase,
            pluginId: CODERABBIT_PLUGIN_ID,
            requester: { kind: "plugin", pluginId: CODERABBIT_PLUGIN_ID },
            caller: { machineId, materializationId: "install-epoch-stale", pluginId: CODERABBIT_PLUGIN_ID },
        };
        const stale = await requestGrant({
            userId: account.id,
            method: "POST",
            url: "/v1/plugins/permissions/grants/request",
            headers: {
                [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPluginInstallationPublisherHeader({
                    keyPair,
                    machineId,
                    installationId,
                    path: "/v1/plugins/permissions/grants/request",
                    body: staleBody,
                }),
            },
            body: staleBody,
        }, staleReply);
        expect(staleReply.statusCode).toBe(403);
        expect(stale).toMatchObject({ error: "plugin_permission_grant_caller_mismatch" });

        // Exact current caller with a matching operation identity is admitted.
        const acceptedReply = createReplyStub();
        const acceptedBody = {
            ...requestBase,
            pluginId: CODERABBIT_PLUGIN_ID,
            requester: { kind: "plugin", pluginId: CODERABBIT_PLUGIN_ID },
            caller: { machineId, materializationId: CURRENT_MATERIALIZATION_ID, pluginId: CODERABBIT_PLUGIN_ID },
        };
        const accepted = await requestGrant({
            userId: account.id,
            method: "POST",
            url: "/v1/plugins/permissions/grants/request",
            headers: {
                [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPluginInstallationPublisherHeader({
                    keyPair,
                    machineId,
                    installationId,
                    path: "/v1/plugins/permissions/grants/request",
                    body: acceptedBody,
                }),
            },
            body: acceptedBody,
        }, acceptedReply) as any;
        expect(acceptedReply.statusCode).toBe(200);
        expect(accepted.pendingRequest).toMatchObject({
            pluginId: CODERABBIT_PLUGIN_ID,
            authoritySource: { kind: "machine_installation", machineId, installationId },
        });

        // A signed plugin list rejects a conflicting caller-supplied filter;
        // it must not silently widen or rewrite a spoofed plugin identity.
        const scopedListBody = {
            pluginId: EXTERNAL_PLUGIN_ID,
            caller: { machineId, materializationId: CURRENT_MATERIALIZATION_ID, pluginId: CODERABBIT_PLUGIN_ID },
        };
        const scopedListReply = createReplyStub();
        const scopedList = await listGrants({
            userId: account.id,
            method: "POST",
            url: "/v1/plugins/permissions/grants/list",
            headers: {
                [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPluginInstallationPublisherHeader({
                    keyPair,
                    machineId,
                    installationId,
                    path: "/v1/plugins/permissions/grants/list",
                    body: scopedListBody,
                }),
            },
            body: scopedListBody,
        }, scopedListReply);
        expect(scopedListReply.statusCode).toBe(403);
        expect(scopedList).toMatchObject({ error: "plugin_permission_grant_caller_mismatch" });

        // Omitting the optional filter derives the exact plugin scope from the
        // proven current materialization.
        const exactListBody = {
            caller: { machineId, materializationId: CURRENT_MATERIALIZATION_ID, pluginId: CODERABBIT_PLUGIN_ID },
        };
        const exactListReply = createReplyStub();
        const exactList = await listGrants({
            userId: account.id,
            method: "POST",
            url: "/v1/plugins/permissions/grants/list",
            headers: {
                [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPluginInstallationPublisherHeader({
                    keyPair,
                    machineId,
                    installationId,
                    path: "/v1/plugins/permissions/grants/list",
                    body: exactListBody,
                }),
            },
            body: exactListBody,
        }, exactListReply) as any;
        expect(exactListReply.statusCode).toBe(200);
        expect(exactList.pendingRequests).toEqual([
            expect.objectContaining({
                id: accepted.pendingRequest.id,
                pluginId: CODERABBIT_PLUGIN_ID,
            }),
        ]);

        const staleListBody = {
            caller: { machineId, materializationId: "install-epoch-stale", pluginId: CODERABBIT_PLUGIN_ID },
        };
        const staleListReply = createReplyStub();
        const staleList = await listGrants({
            userId: account.id,
            method: "POST",
            url: "/v1/plugins/permissions/grants/list",
            headers: {
                [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPluginInstallationPublisherHeader({
                    keyPair,
                    machineId,
                    installationId,
                    path: "/v1/plugins/permissions/grants/list",
                    body: staleListBody,
                }),
            },
            body: staleListBody,
        }, staleListReply);
        expect(staleListReply.statusCode).toBe(403);
        expect(staleList).toMatchObject({ error: "plugin_permission_grant_caller_mismatch" });
    });

    it("isolates plugin self-revocation to the proven caller and keeps user-side revocation present-user", async () => {
        vi.stubEnv("HAPPIER_SERVER_IDENTITY_ID", PINNED_SERVER_IDENTITY_ID);
        const account = await db.account.create({
            data: {
                id: "account-plugin-permission-self-revoke",
                publicKey: "pk-plugin-permission-self-revoke",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const ownerKeyPair = tweetnacl.sign.keyPair();
        const ownerMachineId = "machine-plugin-permission-self-revoke-owner";
        const ownerInstallationId = "installation-plugin-permission-self-revoke-owner";
        await createTrustedMachineInstallation({
            accountId: account.id,
            machineId: ownerMachineId,
            installationId: ownerInstallationId,
            keyPair: ownerKeyPair,
        });
        await seedCurrentCallerMaterialization({
            accountId: account.id,
            machineId: ownerMachineId,
            materializationId: CURRENT_MATERIALIZATION_ID,
            pluginId: CODERABBIT_PLUGIN_ID,
        });

        const app = registerDefaultRoutes();
        const requestGrant = getRouteHandler(app, "POST", "/v1/plugins/permissions/grants/request");
        const grant = getRouteHandler(app, "POST", "/v1/plugins/permissions/grants/grant");
        const revoke = getRouteHandler(app, "POST", "/v1/plugins/permissions/grants/revoke");

        const createActiveGrant = async (): Promise<string> => {
            const requestBody = {
                pluginId: CODERABBIT_PLUGIN_ID,
                capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
                targetScope: { kind: "project", projectId: "project-self-revoke" },
                subject: GENERAL_PLUGIN_PERMISSION_SUBJECT_V1,
                reason: "Publish approved review comments directly.",
                requester: { kind: "plugin", pluginId: CODERABBIT_PLUGIN_ID },
                caller: { machineId: ownerMachineId, materializationId: CURRENT_MATERIALIZATION_ID, pluginId: CODERABBIT_PLUGIN_ID },
            };
            const requested = await requestGrant({
                userId: account.id,
                method: "POST",
                url: "/v1/plugins/permissions/grants/request",
                headers: {
                    [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPluginInstallationPublisherHeader({
                        keyPair: ownerKeyPair,
                        machineId: ownerMachineId,
                        installationId: ownerInstallationId,
                        path: "/v1/plugins/permissions/grants/request",
                        body: requestBody,
                    }),
                },
                body: requestBody,
            }, createReplyStub()) as any;
            const granted = await grant({
                userId: account.id,
                body: { requestId: requested.pendingRequest.id },
            }, createReplyStub()) as any;
            return granted.grant.id;
        };

        const ownedGrantId = await createActiveGrant();

        // Self-revocation with the exact proven caller succeeds and attributes
        // the event to the plugin, not to a fabricated user decision.
        const selfRevokeBody = {
            grantId: ownedGrantId,
            caller: { machineId: ownerMachineId, materializationId: CURRENT_MATERIALIZATION_ID, pluginId: CODERABBIT_PLUGIN_ID },
        };
        const selfRevokeReply = createReplyStub();
        await revoke({
            userId: account.id,
            method: "POST",
            url: "/v1/plugins/permissions/grants/revoke",
            headers: {
                [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPluginInstallationPublisherHeader({
                    keyPair: ownerKeyPair,
                    machineId: ownerMachineId,
                    installationId: ownerInstallationId,
                    path: "/v1/plugins/permissions/grants/revoke",
                    body: selfRevokeBody,
                }),
            },
            body: selfRevokeBody,
        }, selfRevokeReply);
        expect(selfRevokeReply.statusCode).toBe(200);
        const selfRevokeEvent = await db.$queryRaw<Array<{ actor_json: string }>>`
            SELECT actor_json FROM plugin_permission_grant_events
            WHERE account_id = ${account.id} AND grant_id = ${ownedGrantId} AND event_kind = 'revoked'
        `;
        expect(JSON.parse(selfRevokeEvent[0]?.actor_json ?? "{}")).toMatchObject({ kind: "plugin", pluginId: CODERABBIT_PLUGIN_ID });
        const revokedRow = await db.$queryRaw<Array<{ revoked_by_user_id: string | null }>>`
            SELECT revoked_by_user_id FROM plugin_permission_grants WHERE id = ${ownedGrantId}
        `;
        expect(revokedRow[0]?.revoked_by_user_id ?? null).toBeNull();

        // A different machine installation cannot revoke the owner's grant.
        const grantIdStillOwned = await createActiveGrant();
        const foreignKeyPair = tweetnacl.sign.keyPair();
        const foreignMachineId = "machine-plugin-permission-self-revoke-foreign";
        const foreignInstallationId = "installation-plugin-permission-self-revoke-foreign";
        await createTrustedMachineInstallation({
            accountId: account.id,
            machineId: foreignMachineId,
            installationId: foreignInstallationId,
            keyPair: foreignKeyPair,
        });
        await seedCurrentCallerMaterialization({
            accountId: account.id,
            machineId: foreignMachineId,
            materializationId: CURRENT_MATERIALIZATION_ID,
            pluginId: CODERABBIT_PLUGIN_ID,
        });
        const foreignBody = {
            grantId: grantIdStillOwned,
            caller: { machineId: foreignMachineId, materializationId: CURRENT_MATERIALIZATION_ID, pluginId: CODERABBIT_PLUGIN_ID },
        };
        const foreignReply = createReplyStub();
        const foreignResult = await revoke({
            userId: account.id,
            method: "POST",
            url: "/v1/plugins/permissions/grants/revoke",
            headers: {
                [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPluginInstallationPublisherHeader({
                    keyPair: foreignKeyPair,
                    machineId: foreignMachineId,
                    installationId: foreignInstallationId,
                    path: "/v1/plugins/permissions/grants/revoke",
                    body: foreignBody,
                }),
            },
            body: foreignBody,
        }, foreignReply) as any;
        expect(foreignReply.statusCode).toBe(403);
        expect(foreignResult).toMatchObject({ error: "plugin_permission_grant_not_owned" });
        const stillActive = await db.$queryRaw<Array<{ status: string }>>`
            SELECT status FROM plugin_permission_grants WHERE id = ${grantIdStillOwned}
        `;
        expect(stillActive[0]?.status).toBe("active");

        // A present user revokes any account grant without a publisher proof.
        const userReply = createReplyStub();
        await revoke({
            userId: account.id,
            authAuthority: "present_user",
            body: { grantId: grantIdStillOwned },
        }, userReply);
        expect(userReply.statusCode).toBe(200);

        // Account-automation authority without a proof is refused.
        const grantIdForAutomation = await createActiveGrant();
        const automationReply = createReplyStub();
        await revoke({
            userId: account.id,
            authAuthority: "account_automation",
            body: { grantId: grantIdForAutomation },
        }, automationReply);
        expect(automationReply.statusCode).toBe(403);
    });
});
