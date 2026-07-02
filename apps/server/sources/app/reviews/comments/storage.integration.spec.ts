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
    createReviewCommentPrincipalSigningInputV1,
    REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
    REVIEW_COMMENT_PRINCIPAL_HEADER_V1,
    ReviewCommentCreateResponseV1Schema,
    ReviewCommentGetResponseV1Schema,
    ReviewCommentListResponseV1Schema,
    ReviewCommentTransitionResponseV1Schema,
    stringifyPluginInstallationManifestCanonicalJsonV1,
    stringifyReviewCommentPrincipalCanonicalJsonV1,
} from "@happier-dev/protocol";
import { buildReviewCommentTextSnapshotHashes } from "./snapshots";
import { registerReviewCommentRoutes } from "./routes";

const CODERABBIT_PLUGIN_ID = "happier.review.coderabbit";
const EXTERNAL_PLUGIN_ID = "acme.reviewbot";

function textSnapshot() {
    const lines = {
        selectedLines: ["return value.name;"],
        beforeContext: ["function readName(value) {"],
        afterContext: ["}"],
    };
    const hashes = buildReviewCommentTextSnapshotHashes(lines);
    return {
        kind: "text" as const,
        ...lines,
        ...hashes,
        capturedAt: 1,
        fileLength: 3,
        source: "workingTree" as const,
        isUncommitted: true,
        isUntracked: false,
        truncated: false,
        hasBidiControls: false,
        likelyMinified: false,
    };
}

function registerDefaultRoutes() {
    const app = createFakeRouteApp();
    registerReviewCommentRoutes(app as any);
    return app;
}

function registerAllRoutes() {
    const app = createFakeRouteApp();
    registerApiRoutes(app as any);
    return app;
}

function encodePrincipalHeader(value: unknown): string {
    return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function createSignedPrincipalHeader(params: Readonly<{
    actor: { kind: "plugin"; pluginId: string };
    keyPair: tweetnacl.SignKeyPair;
    machineId: string;
    installationId: string;
    method?: "GET" | "POST" | "PATCH";
    path?: string;
    body?: unknown;
    issuedAt?: number;
    nonce?: string;
}>): string {
    const header = {
        actor: params.actor,
        grants: [],
        proof: {
            v: 1 as const,
            alg: "ed25519-machine-installation-v1" as const,
            machineId: params.machineId,
            installationId: params.installationId,
            issuedAt: params.issuedAt ?? Date.now(),
            nonce: params.nonce ?? "nonce-1",
            method: params.method ?? "POST",
            path: params.path ?? "/v1/reviews/comments",
            bodySha256Base64Url: createHash("sha256")
                .update(stringifyReviewCommentPrincipalCanonicalJsonV1(params.body ?? null))
                .digest("base64url"),
            signatureBase64Url: "",
        },
    };
    const signingInput = createReviewCommentPrincipalSigningInputV1({
        actor: header.actor,
        proof: {
            v: header.proof.v,
            alg: header.proof.alg,
            machineId: header.proof.machineId,
            installationId: header.proof.installationId,
            issuedAt: header.proof.issuedAt,
            nonce: header.proof.nonce,
            method: header.proof.method,
            path: header.proof.path,
            bodySha256Base64Url: header.proof.bodySha256Base64Url,
        },
    });
    return encodePrincipalHeader({
        ...header,
        proof: {
            ...header.proof,
            signatureBase64Url: Buffer.from(tweetnacl.sign.detached(signingInput, params.keyPair.secretKey)).toString("base64url"),
        },
    });
}

function createSignedPublisherHeader(params: Readonly<{
    keyPair: tweetnacl.SignKeyPair;
    machineId: string;
    installationId: string;
    path: string;
    body?: unknown;
    issuedAt?: number;
    nonce?: string;
}>): string {
    const header = {
        proof: {
            v: 1 as const,
            alg: "ed25519-machine-installation-v1" as const,
            machineId: params.machineId,
            installationId: params.installationId,
            issuedAt: params.issuedAt ?? Date.now(),
            nonce: params.nonce ?? "publisher-nonce-1",
            method: "POST" as const,
            path: params.path,
            bodySha256Base64Url: createHash("sha256")
                .update(stringifyPluginInstallationManifestCanonicalJsonV1(params.body ?? null))
                .digest("base64url"),
            signatureBase64Url: "",
        },
    };
    const signingInput = createPluginInstallationManifestPublisherSigningInputV1({
        proof: {
            v: header.proof.v,
            alg: header.proof.alg,
            machineId: header.proof.machineId,
            installationId: header.proof.installationId,
            issuedAt: header.proof.issuedAt,
            nonce: header.proof.nonce,
            method: header.proof.method,
            path: header.proof.path,
            bodySha256Base64Url: header.proof.bodySha256Base64Url,
        },
    });
    return encodePrincipalHeader({
        proof: {
            ...header.proof,
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

describe("review comment durable storage", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-review-comments-storage-",
            initAuth: false,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        harness.resetEnv();
        await db.$executeRawUnsafe("DELETE FROM review_comment_events").catch(() => undefined);
        await db.$executeRawUnsafe("DELETE FROM review_comments").catch(() => undefined);
        await harness.resetDbTables([
            () => db.machine.deleteMany(),
            () => db.userKVStore.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("persists current state and append-only events in review-comment tables, not userKV", async () => {
        const account = await db.account.create({
            data: {
                id: "account-review-comments-storage",
                publicKey: "pk-review-comments-storage",
                encryptionMode: "plain",
            },
            select: { id: true },
        });

        const create = getRouteHandler(registerDefaultRoutes(), "POST", "/v1/reviews/comments");
        const created = ReviewCommentCreateResponseV1Schema.parse(await create({
            userId: account.id,
            body: {
                projectId: "project-1",
                runId: "run-1",
                engineId: "review-coderabbit",
                anchor: { kind: "line", filePath: "src/example.ts", line: 2 },
                snapshot: textSnapshot(),
                body: "Null-check this value.",
                clientMutationId: "mutation-create",
                authorDeviceId: "device-1",
                clientLamport: 7,
            },
        }, createReplyStub()));

        expect(await db.userKVStore.count({
            where: {
                accountId: account.id,
                key: { startsWith: "reviews/comments/v1" },
            },
        })).toBe(0);

        const get = getRouteHandler(registerDefaultRoutes(), "GET", "/v1/reviews/comments/:commentId");
        const reloaded = ReviewCommentGetResponseV1Schema.parse(await get({
            userId: account.id,
            params: { commentId: created.comment.id },
        }, createReplyStub()));
        expect(reloaded.comment).toEqual(created.comment);

        const transition = getRouteHandler(registerDefaultRoutes(), "POST", "/v1/reviews/comments/:commentId/transition");
        const transitioned = ReviewCommentTransitionResponseV1Schema.parse(await transition({
            userId: account.id,
            params: { commentId: created.comment.id },
            body: {
                toState: "open",
                clientMutationId: "mutation-transition",
            },
        }, createReplyStub()));
        expect(transitioned.comment.serverRevision).toBe(2);

        const rows = await db.$queryRaw<Array<{
            id: string;
            body_envelope_json: string;
            snapshot_envelope_json: string;
            server_revision: number | bigint;
        }>>`SELECT id, body_envelope_json, snapshot_envelope_json, server_revision FROM review_comments WHERE account_id = ${account.id}`;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            id: created.comment.id,
            server_revision: 2,
        });
        expect(JSON.parse(rows[0]!.body_envelope_json)).toEqual({ t: "plain", v: transitioned.comment.body });
        expect(JSON.parse(rows[0]!.snapshot_envelope_json)).toEqual({ t: "plain", v: transitioned.comment.snapshot });

        const events = await db.$queryRaw<Array<{
            event_kind: string;
            event_envelope_json: string;
            server_revision: number | bigint;
            client_mutation_id: string | null;
            author_device_id: string | null;
            client_lamport: number | bigint | null;
        }>>`SELECT event_kind, event_envelope_json, server_revision, client_mutation_id, author_device_id, client_lamport FROM review_comment_events WHERE comment_id = ${created.comment.id} ORDER BY server_revision ASC`;
        expect(events.map((event) => ({
            kind: event.event_kind,
            revision: Number(event.server_revision),
            mutation: event.client_mutation_id,
        }))).toEqual([
            { kind: "created", revision: 1, mutation: "mutation-create" },
            { kind: "transitioned", revision: 2, mutation: "mutation-transition" },
        ]);
        expect(events[0]).toMatchObject({
            author_device_id: "device-1",
        });
        expect(Number(events[0]!.client_lamport)).toBe(7);
        expect(JSON.parse(events[0]!.event_envelope_json)).toMatchObject({
            t: "plain",
            v: { comment: { id: created.comment.id } },
        });
    });

    it("rejects unsigned plugin principal headers instead of trusting client-claimed actor identity", async () => {
        const account = await db.account.create({
            data: {
                id: "account-review-comments-plugin-principal",
                publicKey: "pk-review-comments-plugin-principal",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const app = registerDefaultRoutes();
        const create = getRouteHandler(app, "POST", "/v1/reviews/comments");
        const principalHeader = encodePrincipalHeader({
            actor: { kind: "plugin", pluginId: "review-coderabbit" },
            grants: [REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1],
        });

        const reply = createReplyStub();
        const rejected = await create({
            userId: account.id,
            headers: { [REVIEW_COMMENT_PRINCIPAL_HEADER_V1]: principalHeader },
            body: {
                projectId: "project-1",
                anchor: { kind: "line", filePath: "src/example.ts", line: 3 },
                snapshot: textSnapshot(),
                body: "Null-check this value.",
                authorIntent: "propose",
                clientMutationId: "mutation-plugin-propose",
            },
        }, reply);

        expect(reply.statusCode).toBe(400);
        expect(rejected).toMatchObject({ error: "review_comment_permission_denied" });
        expect(await db.$queryRaw<Array<{ id: string }>>`SELECT id FROM review_comments WHERE account_id = ${account.id}`)
            .toEqual([]);
    });

    it("lists file-anchored comments under folderPath filters from SQL storage", async () => {
        const account = await db.account.create({
            data: {
                id: "account-review-comments-folder-filter",
                publicKey: "pk-review-comments-folder-filter",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const app = registerDefaultRoutes();
        const create = getRouteHandler(app, "POST", "/v1/reviews/comments");
        const list = getRouteHandler(app, "GET", "/v1/reviews/comments");

        const created = ReviewCommentCreateResponseV1Schema.parse(await create({
            userId: account.id,
            body: {
                projectId: "project-1",
                anchor: { kind: "line", filePath: "src/security/auth.ts", line: 3 },
                snapshot: textSnapshot(),
                body: "Check auth flow.",
                authorIntent: "open",
                clientMutationId: "mutation-folder-filter",
            },
        }, createReplyStub()));

        const listed = ReviewCommentListResponseV1Schema.parse(await list({
            userId: account.id,
            query: {
                projectId: "project-1",
                folderPath: "src/security",
            },
        }, createReplyStub()));

        expect(listed.items.map((comment) => comment.id)).toEqual([created.comment.id]);
    });

    it("allows signed plugin principal headers and direct writes only through trusted server-owned grants", async () => {
        const installationKeyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
        const account = await db.account.create({
            data: {
                id: "account-review-comments-trusted-grant",
                publicKey: "pk-review-comments-trusted-grant",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        await createTrustedMachine({
            accountId: account.id,
            machineId: "machine-review-comments-trusted-grant",
            installationId: "installation-review-comments-trusted-grant",
            keyPair: installationKeyPair,
        });
        const app = registerAllRoutes();
        expect(app.routes.has("POST /v1/plugins/permissions/grants/request")).toBe(true);

        const requestGrant = getRouteHandler(app, "POST", "/v1/plugins/permissions/grants/request");
        const grant = getRouteHandler(app, "POST", "/v1/plugins/permissions/grants/grant");
        const create = getRouteHandler(app, "POST", "/v1/reviews/comments");

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
        await grant({
            userId: account.id,
            body: { requestId: requested.pendingRequest.id },
        }, createReplyStub());

        const createBody = {
            projectId: "project-1",
            anchor: { kind: "line", filePath: "src/example.ts", line: 3 },
            snapshot: textSnapshot(),
            body: "Open this directly.",
            authorIntent: "open",
            clientMutationId: "mutation-plugin-open-trusted",
        };
        const principalHeader = createSignedPrincipalHeader({
            actor: { kind: "plugin", pluginId: CODERABBIT_PLUGIN_ID },
            keyPair: installationKeyPair,
            machineId: "machine-review-comments-trusted-grant",
            installationId: "installation-review-comments-trusted-grant",
            body: createBody,
        });
        const created = ReviewCommentCreateResponseV1Schema.parse(await create({
            userId: account.id,
            headers: { [REVIEW_COMMENT_PRINCIPAL_HEADER_V1]: principalHeader },
            body: createBody,
        }, createReplyStub()));

        expect(created.comment).toMatchObject({
            author: { kind: "plugin", pluginId: CODERABBIT_PLUGIN_ID },
            state: "open",
            projectId: "project-1",
        });

        const tamperedBodyReply = createReplyStub();
        const tamperedBody = await create({
            userId: account.id,
            headers: { [REVIEW_COMMENT_PRINCIPAL_HEADER_V1]: principalHeader },
            body: {
                ...createBody,
                body: "Tampered after the principal proof was signed.",
                clientMutationId: "mutation-plugin-open-tampered-body",
            },
        }, tamperedBodyReply);
        expect(tamperedBodyReply.statusCode).toBe(400);
        expect(tamperedBody).toMatchObject({ error: "review_comment_permission_denied" });

        const wrongPathReply = createReplyStub();
        const wrongPathHeader = createSignedPrincipalHeader({
            actor: { kind: "plugin", pluginId: CODERABBIT_PLUGIN_ID },
            keyPair: installationKeyPair,
            machineId: "machine-review-comments-trusted-grant",
            installationId: "installation-review-comments-trusted-grant",
            path: "/v1/reviews/comments/wrong",
            body: createBody,
            nonce: "nonce-wrong-path",
        });
        const wrongPath = await create({
            userId: account.id,
            headers: { [REVIEW_COMMENT_PRINCIPAL_HEADER_V1]: wrongPathHeader },
            body: {
                ...createBody,
                clientMutationId: "mutation-plugin-open-wrong-path",
            },
        }, wrongPathReply);
        expect(wrongPathReply.statusCode).toBe(400);
        expect(wrongPath).toMatchObject({ error: "review_comment_permission_denied" });

        const mismatchBody = {
            projectId: "project-2",
            anchor: { kind: "line", filePath: "src/example.ts", line: 3 },
            snapshot: textSnapshot(),
            body: "Open this directly in another project.",
            authorIntent: "open",
            clientMutationId: "mutation-plugin-open-mismatch",
        };
        const mismatchPrincipalHeader = createSignedPrincipalHeader({
            actor: { kind: "plugin", pluginId: CODERABBIT_PLUGIN_ID },
            keyPair: installationKeyPair,
            machineId: "machine-review-comments-trusted-grant",
            installationId: "installation-review-comments-trusted-grant",
            body: mismatchBody,
            nonce: "nonce-2",
        });
        const mismatchReply = createReplyStub();
        const mismatch = await create({
            userId: account.id,
            headers: { [REVIEW_COMMENT_PRINCIPAL_HEADER_V1]: mismatchPrincipalHeader },
            body: mismatchBody,
        }, mismatchReply);

        expect(mismatchReply.statusCode).toBe(400);
        expect(mismatch).toMatchObject({ error: "review_comment_direct_write_permission_required" });
    });

    it("stops trusting external direct-write grants after the installed manifest projection is deleted", async () => {
        const installationKeyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
        const account = await db.account.create({
            data: {
                id: "account-review-comments-external-grant-projection",
                publicKey: "pk-review-comments-external-grant-projection",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        await createTrustedMachine({
            accountId: account.id,
            machineId: "machine-review-comments-external-grant-projection",
            installationId: "installation-review-comments-external-grant-projection",
            keyPair: installationKeyPair,
        });
        const app = registerAllRoutes();
        const upsertManifest = getRouteHandler(app, "POST", "/v1/plugins/installations/manifests/upsert");
        const deleteManifest = getRouteHandler(app, "POST", "/v1/plugins/installations/manifests/delete");
        const requestGrant = getRouteHandler(app, "POST", "/v1/plugins/permissions/grants/request");
        const grant = getRouteHandler(app, "POST", "/v1/plugins/permissions/grants/grant");
        const create = getRouteHandler(app, "POST", "/v1/reviews/comments");

        const upsertManifestBody = {
            pluginId: EXTERNAL_PLUGIN_ID,
            manifestVersion: "1.0.0",
            manifestDigest: "sha256:external-reviewbot",
            displayName: "Acme ReviewBot",
            requiredPermissions: [],
            optionalPermissions: [{
                capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
                reason: "Publish review comments directly when explicitly granted.",
            }],
        };
        await upsertManifest({
            userId: account.id,
            method: "POST",
            url: "/v1/plugins/installations/manifests/upsert",
            headers: {
                [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPublisherHeader({
                    keyPair: installationKeyPair,
                    machineId: "machine-review-comments-external-grant-projection",
                    installationId: "installation-review-comments-external-grant-projection",
                    path: "/v1/plugins/installations/manifests/upsert",
                    body: upsertManifestBody,
                }),
            },
            body: upsertManifestBody,
        }, createReplyStub());
        const requestGrantBody = {
            pluginId: EXTERNAL_PLUGIN_ID,
            capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
            targetScope: { kind: "project", projectId: "project-1" },
            reason: "Publish approved review comments directly.",
            requester: { kind: "plugin" as const, pluginId: EXTERNAL_PLUGIN_ID, sessionId: "session-1" },
        };
        const requested = await requestGrant({
            userId: account.id,
            method: "POST",
            url: "/v1/plugins/permissions/grants/request",
            headers: {
                [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPublisherHeader({
                    keyPair: installationKeyPair,
                    machineId: "machine-review-comments-external-grant-projection",
                    installationId: "installation-review-comments-external-grant-projection",
                    path: "/v1/plugins/permissions/grants/request",
                    body: requestGrantBody,
                    nonce: "nonce-review-comments-external-grant-projection-request",
                }),
            },
            body: requestGrantBody,
        }, createReplyStub()) as any;
        await grant({
            userId: account.id,
            body: { requestId: requested.pendingRequest.id },
        }, createReplyStub());

        const firstBody = {
            projectId: "project-1",
            anchor: { kind: "line", filePath: "src/example.ts", line: 3 },
            snapshot: textSnapshot(),
            body: "Open this directly before uninstall.",
            authorIntent: "open",
            clientMutationId: "mutation-plugin-open-external-before-delete",
        };
        const firstHeader = createSignedPrincipalHeader({
            actor: { kind: "plugin", pluginId: EXTERNAL_PLUGIN_ID },
            keyPair: installationKeyPair,
            machineId: "machine-review-comments-external-grant-projection",
            installationId: "installation-review-comments-external-grant-projection",
            body: firstBody,
        });
        const created = ReviewCommentCreateResponseV1Schema.parse(await create({
            userId: account.id,
            headers: { [REVIEW_COMMENT_PRINCIPAL_HEADER_V1]: firstHeader },
            body: firstBody,
        }, createReplyStub()));
        expect(created.comment).toMatchObject({
            author: { kind: "plugin", pluginId: EXTERNAL_PLUGIN_ID },
            state: "open",
        });

        const deleteManifestBody = { pluginId: EXTERNAL_PLUGIN_ID };
        await deleteManifest({
            userId: account.id,
            method: "POST",
            url: "/v1/plugins/installations/manifests/delete",
            headers: {
                [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPublisherHeader({
                    keyPair: installationKeyPair,
                    machineId: "machine-review-comments-external-grant-projection",
                    installationId: "installation-review-comments-external-grant-projection",
                    path: "/v1/plugins/installations/manifests/delete",
                    body: deleteManifestBody,
                    nonce: "publisher-nonce-delete",
                }),
            },
            body: deleteManifestBody,
        }, createReplyStub());
        const secondBody = {
            ...firstBody,
            body: "Open this directly after uninstall.",
            clientMutationId: "mutation-plugin-open-external-after-delete",
        };
        const secondHeader = createSignedPrincipalHeader({
            actor: { kind: "plugin", pluginId: EXTERNAL_PLUGIN_ID },
            keyPair: installationKeyPair,
            machineId: "machine-review-comments-external-grant-projection",
            installationId: "installation-review-comments-external-grant-projection",
            body: secondBody,
            nonce: "nonce-after-delete",
        });
        const deniedReply = createReplyStub();
        const denied = await create({
            userId: account.id,
            headers: { [REVIEW_COMMENT_PRINCIPAL_HEADER_V1]: secondHeader },
            body: secondBody,
        }, deniedReply);
        expect(deniedReply.statusCode).toBe(400);
        expect(denied).toMatchObject({ error: "review_comment_direct_write_permission_required" });
    });

    it("requires external direct-write authority to come from the same trusted machine grant as the plugin principal proof", async () => {
        const projectionKeyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(10));
        const callerKeyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(11));
        const account = await db.account.create({
            data: {
                id: "account-review-comments-external-machine-bound",
                publicKey: "pk-review-comments-external-machine-bound",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        await createTrustedMachine({
            accountId: account.id,
            machineId: "machine-review-comments-projection-owner",
            installationId: "installation-review-comments-projection-owner",
            keyPair: projectionKeyPair,
        });
        await createTrustedMachine({
            accountId: account.id,
            machineId: "machine-review-comments-unprojected-caller",
            installationId: "installation-review-comments-unprojected-caller",
            keyPair: callerKeyPair,
        });
        const app = registerAllRoutes();
        const upsertManifest = getRouteHandler(app, "POST", "/v1/plugins/installations/manifests/upsert");
        const requestGrant = getRouteHandler(app, "POST", "/v1/plugins/permissions/grants/request");
        const grant = getRouteHandler(app, "POST", "/v1/plugins/permissions/grants/grant");
        const create = getRouteHandler(app, "POST", "/v1/reviews/comments");

        const upsertManifestBody = {
            pluginId: EXTERNAL_PLUGIN_ID,
            manifestVersion: "1.0.0",
            manifestDigest: "sha256:external-reviewbot-machine-bound",
            displayName: "Acme ReviewBot",
            requiredPermissions: [],
            optionalPermissions: [{
                capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
                reason: "Publish review comments directly when explicitly granted.",
            }],
        };
        await upsertManifest({
            userId: account.id,
            method: "POST",
            url: "/v1/plugins/installations/manifests/upsert",
            headers: {
                [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPublisherHeader({
                    keyPair: projectionKeyPair,
                    machineId: "machine-review-comments-projection-owner",
                    installationId: "installation-review-comments-projection-owner",
                    path: "/v1/plugins/installations/manifests/upsert",
                    body: upsertManifestBody,
                }),
            },
            body: upsertManifestBody,
        }, createReplyStub());
        const requested = await requestGrant({
            userId: account.id,
            method: "POST",
            url: "/v1/plugins/permissions/grants/request",
            headers: {
                [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPublisherHeader({
                    keyPair: projectionKeyPair,
                    machineId: "machine-review-comments-projection-owner",
                    installationId: "installation-review-comments-projection-owner",
                    path: "/v1/plugins/permissions/grants/request",
                    body: {
                        pluginId: EXTERNAL_PLUGIN_ID,
                        capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
                        targetScope: { kind: "project", projectId: "project-1" },
                        reason: "Publish approved review comments directly.",
                        requester: { kind: "plugin", pluginId: EXTERNAL_PLUGIN_ID, sessionId: "session-1" },
                    },
                }),
            },
            body: {
                pluginId: EXTERNAL_PLUGIN_ID,
                capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
                targetScope: { kind: "project", projectId: "project-1" },
                reason: "Publish approved review comments directly.",
                requester: { kind: "plugin", pluginId: EXTERNAL_PLUGIN_ID, sessionId: "session-1" },
            },
        }, createReplyStub()) as any;
        await grant({
            userId: account.id,
            body: { requestId: requested.pendingRequest.id },
        }, createReplyStub());
        await upsertManifest({
            userId: account.id,
            method: "POST",
            url: "/v1/plugins/installations/manifests/upsert",
            headers: {
                [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPublisherHeader({
                    keyPair: callerKeyPair,
                    machineId: "machine-review-comments-unprojected-caller",
                    installationId: "installation-review-comments-unprojected-caller",
                    path: "/v1/plugins/installations/manifests/upsert",
                    body: upsertManifestBody,
                    nonce: "publisher-nonce-caller-projection",
                }),
            },
            body: upsertManifestBody,
        }, createReplyStub());

        const createBody = {
            projectId: "project-1",
            anchor: { kind: "line", filePath: "src/example.ts", line: 3 },
            snapshot: textSnapshot(),
            body: "This unprojected machine should not direct-write.",
            authorIntent: "open",
            clientMutationId: "mutation-plugin-open-external-wrong-machine",
        };
        const principalHeader = createSignedPrincipalHeader({
            actor: { kind: "plugin", pluginId: EXTERNAL_PLUGIN_ID },
            keyPair: callerKeyPair,
            machineId: "machine-review-comments-unprojected-caller",
            installationId: "installation-review-comments-unprojected-caller",
            body: createBody,
        });
        const reply = createReplyStub();

        const denied = await create({
            userId: account.id,
            headers: { [REVIEW_COMMENT_PRINCIPAL_HEADER_V1]: principalHeader },
            body: createBody,
        }, reply);

        expect(reply.statusCode).toBe(400);
        expect(denied).toMatchObject({ error: "review_comment_direct_write_permission_required" });
    });

    it("accepts encrypted body snapshot and event envelopes for effective e2ee accounts", async () => {
        const account = await db.account.create({
            data: {
                id: "account-review-comments-e2ee",
                publicKey: "pk-review-comments-e2ee",
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });

        const create = getRouteHandler(registerDefaultRoutes(), "POST", "/v1/reviews/comments");
        const created = ReviewCommentCreateResponseV1Schema.parse(await create({
            userId: account.id,
            body: {
                projectId: "project-1",
                runId: "run-1",
                engineId: "review-coderabbit",
                anchor: { kind: "line", filePath: "src/example.ts", line: 2 },
                snapshot: { t: "encrypted", c: "snapshot-ciphertext" },
                body: { t: "encrypted", c: "body-ciphertext" },
                eventEnvelope: { t: "encrypted", c: "created-event-ciphertext" },
                clientMutationId: "mutation-create",
            },
        }, createReplyStub()));

        expect(created.comment.body).toEqual({ t: "encrypted", c: "body-ciphertext" });
        expect(created.comment.snapshot).toEqual({ t: "encrypted", c: "snapshot-ciphertext" });

        const rows = await db.$queryRaw<Array<{
            body_envelope_json: string;
            snapshot_envelope_json: string;
        }>>`SELECT body_envelope_json, snapshot_envelope_json FROM review_comments WHERE account_id = ${account.id}`;
        expect(rows).toHaveLength(1);
        expect(JSON.parse(rows[0]!.body_envelope_json)).toEqual({ t: "encrypted", c: "body-ciphertext" });
        expect(JSON.parse(rows[0]!.snapshot_envelope_json)).toEqual({ t: "encrypted", c: "snapshot-ciphertext" });

        const events = await db.$queryRaw<Array<{
            event_envelope_json: string;
        }>>`SELECT event_envelope_json FROM review_comment_events WHERE account_id = ${account.id}`;
        expect(events).toHaveLength(1);
        expect(JSON.parse(events[0]!.event_envelope_json)).toEqual({ t: "encrypted", c: "created-event-ciphertext" });
    });

    it("keeps e2ee redaction writes envelope-compatible when the server cannot synthesize ciphertext", async () => {
        const account = await db.account.create({
            data: {
                id: "account-review-comments-e2ee-redact",
                publicKey: "pk-review-comments-e2ee-redact",
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });

        const app = registerDefaultRoutes();
        const create = getRouteHandler(app, "POST", "/v1/reviews/comments");
        const redact = getRouteHandler(app, "POST", "/v1/reviews/comments/:commentId/redact");
        const created = ReviewCommentCreateResponseV1Schema.parse(await create({
            userId: account.id,
            body: {
                projectId: "project-1",
                anchor: { kind: "line", filePath: "src/example.ts", line: 2 },
                snapshot: { t: "encrypted", c: "snapshot-ciphertext" },
                body: { t: "encrypted", c: "body-ciphertext" },
                eventEnvelope: { t: "encrypted", c: "created-event-ciphertext" },
                clientMutationId: "mutation-create",
            },
        }, createReplyStub()));

        const redacted = await redact({
            userId: account.id,
            params: { commentId: created.comment.id },
            body: {
                redactBody: true,
                eventEnvelope: { t: "encrypted", c: "redacted-event-ciphertext" },
                clientMutationId: "mutation-redact",
            },
        }, createReplyStub());

        expect(redacted).toMatchObject({
            comment: {
                id: created.comment.id,
                body: { t: "encrypted", c: "body-ciphertext" },
                flags: { redacted: true },
            },
        });

        const rows = await db.$queryRaw<Array<{ body_envelope_json: string }>>`
            SELECT body_envelope_json FROM review_comments WHERE account_id = ${account.id}
        `;
        expect(rows).toHaveLength(1);
        expect(JSON.parse(rows[0]!.body_envelope_json)).toEqual({ t: "encrypted", c: "body-ciphertext" });
    });

    it("rejects mixed envelope modes at durable review-comment write choke points", async () => {
        const account = await db.account.create({
            data: {
                id: "account-review-comments-e2ee-mixed",
                publicKey: "pk-review-comments-e2ee-mixed",
                encryptionMode: "e2ee",
            },
            select: { id: true },
        });

        const create = getRouteHandler(registerDefaultRoutes(), "POST", "/v1/reviews/comments");
        const reply = createReplyStub();
        const result = await create({
            userId: account.id,
            body: {
                projectId: "project-1",
                anchor: { kind: "line", filePath: "src/example.ts", line: 2 },
                snapshot: textSnapshot(),
                body: { t: "encrypted", c: "body-ciphertext" },
                eventEnvelope: { t: "encrypted", c: "created-event-ciphertext" },
                clientMutationId: "mutation-create",
            },
        }, reply);

        expect(reply.statusCode).toBe(400);
        expect(result).toMatchObject({ error: "review_comment_encryption_mode_mismatch" });
        expect(await db.$queryRaw<Array<{ id: string }>>`SELECT id FROM review_comments WHERE account_id = ${account.id}`)
            .toEqual([]);
        expect(await db.$queryRaw<Array<{ event_id: string }>>`SELECT event_id FROM review_comment_events WHERE account_id = ${account.id}`)
            .toEqual([]);
    });
});
