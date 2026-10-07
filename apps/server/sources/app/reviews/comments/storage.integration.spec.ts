import { createHash, randomBytes } from "node:crypto";
import { claimReviewCommentPublication } from "@/testkit/reviewCommentPublicationTestkit";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import tweetnacl from "tweetnacl";
import * as privacyKit from "privacy-kit";

import { createFakeRouteApp, createReplyStub, getRouteEntry, getRouteHandler } from "@/app/api/testkit/routeHarness";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { registerApiRoutes } from "@/app/api/api";
import { createPluginAvailabilityOperations } from "@/app/plugins/availability/operations";
import { updateAccountEncryptionMode } from "@/app/api/routes/account/updateAccountEncryptionMode";
import {
    acquireAccountEncryptionTransitionFenceInTx,
    applyAccountEncryptionTransitionInTx,
} from "@/app/encryption/accountEncryptionTransition";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import {
    createSignedPluginInstallationPublisherHeader,
    createTrustedMachineInstallation,
} from "@/testkit/pluginInstallationPublisherTestkit";
import {
    signAccountContentKeyBindingV1,
    bindReviewCommentEventSensitiveEnvelopeV1,
    buildReviewCommentEventRequestBindingV1,
    sealReviewCommentEventSensitiveEnvelopeV1,
    GENERAL_PLUGIN_PERMISSION_SUBJECT_V1,
    buildReviewCommentPublicationTransportRequestV1,
    openReviewCommentPublicationTransportResponseV1,
    PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1,
    PluginPermissionGrantRequestActionOutputV1Schema,
    createReviewCommentPrincipalSigningInputV1,
    REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
    REVIEW_COMMENT_PRINCIPAL_HEADER_V1,
    ReviewCommentCreateResponseV1Schema,
    ReviewCommentGetResponseV1Schema,
    ReviewCommentListResponseV1Schema,
    ReviewCommentTransitionResponseV1Schema,
    stringifyReviewCommentPrincipalCanonicalJsonV1,
    reviewCommentMutationInputWithoutEventEnvelopeV1,
    type ReviewCommentActorRefV1,
    type ReviewCommentCurrentIntentV1,
    type ReviewCommentPublicationPlanV1,
} from "@happier-dev/protocol";
import { buildReviewCommentTextSnapshotHashes } from "./snapshots";
import { initEncrypt } from "@/modules/encrypt";
import {
    projectReviewCommentStructuralMutationV1, applyReviewCommentPreparedSensitiveMutationV1,
    sealReviewCommentSensitiveEnvelopeV1, buildReviewCommentMutationEventEnvelopeV1,
    ReviewCommentPrepareMutationResponseV1Schema, openReviewCommentSensitiveMigrationSourceV1,
    ReviewCommentCommitMutationResponseV1Schema,
    executeReviewCommentTransportV1, ReviewCommentV1Schema, ReviewCommentBulkTransitionResponseV1Schema,
    type ReviewCommentMutationActionIdV1,
} from "@happier-dev/protocol";
import { createReviewCommentOperations } from "./operations";
import { registerReviewCommentRoutes } from "./routes";
import { createReviewCommentAccountEncryptionMigrationPersistenceInTx } from "./accountEncryptionMigrationPersistence";
import {
    createSqlReviewCommentStore,
    type ReviewCommentStore,
} from "./store";

const CODERABBIT_PLUGIN_ID = "happier.review.coderabbit";
const EXTERNAL_PLUGIN_ID = "acme.reviewbot";
const REVIEW_PERMISSION_SERVER_IDENTITY_ID = "srv_reviewPermissionCaller";

function e2eeAccountFields(seedByte: number) {
    const signing = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(seedByte));
    const content = tweetnacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(seedByte + 1));
    const contentPublicKey = new Uint8Array(content.publicKey);
    const contentPublicKeySig = signAccountContentKeyBindingV1({
        accountSigningSecretKey: signing.secretKey,
        contentPublicKey: contentPublicKey,
    });
    return {
        publicKey: Buffer.from(signing.publicKey).toString("hex"),
        encryptionMode: "e2ee" as const,
        contentPublicKey: Buffer.from(contentPublicKey),
        contentPublicKeySig: Buffer.from(contentPublicKeySig),
    };
}

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

function deferred(): Readonly<{
    promise: Promise<void>;
    resolve: () => void;
}> {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
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
    actor: ReviewCommentActorRefV1;
    currentIntent?: ReviewCommentCurrentIntentV1;
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
        ...(params.currentIntent ? { currentIntent: params.currentIntent } : {}),
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
        ...(params.currentIntent ? { currentIntent: params.currentIntent } : {}),
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

function createCurrentIntent(params: Readonly<{
    pluginId: string;
    agentId?: string;
    body: Readonly<Record<string, unknown>>;
    fingerprintCharacter?: string;
}>): ReviewCommentCurrentIntentV1 {
    const agentId = params.agentId ?? "claude";
    return {
        v: 1,
        kind: "execution_run_host_action",
        actionId: "reviews.comments.create",
        subjectFingerprint: (params.fingerprintCharacter ?? "a").repeat(64),
        effectBodySha256Base64Url: createHash("sha256")
            .update(stringifyReviewCommentPrincipalCanonicalJsonV1(params.body))
            .digest("base64url"),
        sessionId: String(params.body.sessionId),
        runId: String(params.body.runId),
        callId: "call-1",
        profileId: `${params.pluginId}/review`,
        pluginId: params.pluginId,
        agentId,
        projectId: String(params.body.projectId),
        workspaceId: String(params.body.workspaceId),
        sourceCustody: {
            kind: "bundled_first_party",
            packagedRuntime: {
                kind: "cli_version_root",
                versionRootId: "review-coderabbit-test-cli-root",
            },
        },
    };
}

async function seedCurrentPermissionCaller(params: Readonly<{
    accountId: string;
    machineId: string;
    materializationId: string;
    pluginId: string;
}>): Promise<void> {
    await db.session.create({ data: { id: "session-1", accountId: params.accountId, tag: "review-session", metadata: "{}", encryptionMode: "plain" } });
    vi.stubEnv("HAPPIER_SERVER_IDENTITY_ID", REVIEW_PERMISSION_SERVER_IDENTITY_ID);
    const version = "1.2.3";
    const archiveDigestSha256 = `sha256:${"a".repeat(64)}`;
    const availability = createPluginAvailabilityOperations({
        resolveServerIdentityId: async () => REVIEW_PERMISSION_SERVER_IDENTITY_ID,
    });
    await availability.publishRelease({
        accountId: params.accountId,
        input: {
            sourceClass: "registryPackage",
            facts: {
                ref: { pluginId: params.pluginId, version },
                archiveDigestSha256,
                normalizedManifest: {
                    schemaVersion: 2,
                    id: params.pluginId,
                    version,
                    displayName: "Review permission caller fixture",
                    engines: { happier: "^1.0.0" },
                    runtime: { apiVersion: 1 },
                    contributes: {},
                },
                collectionContracts: [],
                uiSlots: [],
                packageAssetArchive: {
                    archiveDigestSha256: `sha256:${"b".repeat(64)}`,
                    resources: [],
                },
            },
        },
    });
    await availability.reportMaterializations({
        accountId: params.accountId,
        publisherMachineId: params.machineId,
        input: {
            expectedRevision: null,
            snapshot: {
                serverIdentityId: REVIEW_PERMISSION_SERVER_IDENTITY_ID,
                machineId: params.machineId,
                materializations: [{
                    serverIdentityId: REVIEW_PERMISSION_SERVER_IDENTITY_ID,
                    machineId: params.machineId,
                    materializationId: params.materializationId,
                    pluginId: params.pluginId,
                    version,
                    sourceClass: "registryPackage",
                    portableRelease: true,
                    archiveDigestSha256,
                    uiArtifacts: [],
                    enabled: true,
                    trustState: "trusted",
                    observedAt: 1_700_000_000_000,
                }],
            },
        },
    });
}

describe("review comment durable storage", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-review-comments-storage-",
            initAuth: false,
            sqliteConnectionLimit: 2,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        harness.resetEnv();
        await db.$executeRawUnsafe("DELETE FROM review_comment_publication_correlations").catch(() => undefined);
        await db.$executeRawUnsafe("DELETE FROM review_comment_events").catch(() => undefined);
        await db.$executeRawUnsafe("DELETE FROM review_comments").catch(() => undefined);
        await harness.resetDbTables([
            () => db.session.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.userKVStore.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("reads the complete Account migration inventory beyond former comment and event count cutoffs", async () => {
        const account = await db.account.create({ data: {
            id: "account-complete-review-inventory", publicKey: "complete-review-inventory", encryptionMode: "plain",
        } });
        const actor = { kind: "user", userId: account.id } as const;
        const commentIds = Array.from({ length: 203 }, (_, index) => `inventory-comment-${index}`);
        await db.reviewComment.createMany({ data: commentIds.map((id) => ({
            id, accountId: account.id, projectId: "project-1", threadId: id,
            state: "open", flagsJson: "{}", authorJson: JSON.stringify(actor),
            anchorJson: JSON.stringify({ kind: "file" }),
            snapshotEnvelopeJson: JSON.stringify({ v: 1, layout: "review_comment_sensitive_in_body_v1" }),
            bodyEnvelopeJson: JSON.stringify({ t: "plain", v: {} }),
            bodyVersion: 1, serverRevision: 1, editsJson: "[]", dispositionsJson: "{}",
            transitionsJson: "[]", createdAt: 1n, updatedAt: 1n,
        })) });
        const events = Array.from({ length: 2_101 }, (_, index) => {
            const eventId = `inventory-event-${index}`;
            const commentId = commentIds[index % commentIds.length]!;
            const clientMutationId = `mutation-${eventId}`;
            const requestBinding = buildReviewCommentEventRequestBindingV1({
                accountId: account.id, projectId: "project-1", actor, actionId: "reviews.comments.edit",
                input: { projectId: "project-1", commentId, expectedServerRevision: 1,
                    expectedBodyVersion: 1, clientMutationId },
            });
            const event = { eventId, commentId, accountId: account.id, projectId: "project-1",
                eventKind: "edited" as const, actor, createdAt: 1, serverRevision: 1,
                event: { clientMutationId } };
            const envelope = bindReviewCommentEventSensitiveEnvelopeV1({ event, requestBinding,
                sensitive: sealReviewCommentEventSensitiveEnvelopeV1({
                    payload: { v: 1, requestBinding, details: event.event }, mode: "plain",
                }),
            });
            return { eventId, commentId, accountId: account.id, projectId: "project-1",
                eventKind: event.eventKind, eventEnvelopeJson: JSON.stringify(envelope), clientMutationId,
                actorJson: JSON.stringify(actor), serverRevision: 1, createdAt: 1n };
        });
        await db.reviewCommentEvent.createMany({ data: events });

        const inventory = await inTx(async (tx) => createReviewCommentAccountEncryptionMigrationPersistenceInTx(tx)
            .readInventory(account.id));

        expect(inventory.map((row) => row.commentId).sort()).toEqual([...commentIds].sort());
        expect(inventory.flatMap((row) => row.events.map((entry) => entry.event.eventId)).sort())
            .toEqual(events.map((entry) => entry.eventId).sort());
    });

    it("prepares and commits canonical E2EE records over HTTP without plaintext sensitive columns", async () => {
        const account = await db.account.create({ data: { id: "account-encrypted-canonical", ...e2eeAccountFields(73) } });
        await initEncrypt();
        const actor = { kind: "user", userId: account.id } as const;
        const material = { type: "dataKey", machineKey: new Uint8Array(32).fill(74) } as const;
        const input = { workspace: { machineId: "machine-canonical", path: "/repo" },
            anchor: { kind: "file", filePath: "private.ts" }, snapshot: textSnapshot(), body: "private canonical body",
            metadata: { tags: ["private canonical tag"] }, authorIntent: "open", clientMutationId: "canonical-e2ee-1" };
        const mutation = projectReviewCommentStructuralMutationV1("reviews.comments.create", input);
        await withAuthenticatedTestApp(registerReviewCommentRoutes, async (app) => {
            const request = { v: 1, mutation, contentCommitment: "a".repeat(43), createRequestFingerprint: "b".repeat(43) };
            const response = await app.inject({ method: "POST", url: "/v1/reviews/comments/mutations/prepare", headers: { "x-test-user-id": account.id }, payload: request });
            expect(response.statusCode, response.body).toBe(200);
            const preparation = ReviewCommentPrepareMutationResponseV1Schema.parse(response.json());
            expect(JSON.stringify(preparation)).not.toContain("private canonical");
            const prepared = preparation.records[0]!;
            const sensitive = applyReviewCommentPreparedSensitiveMutationV1({ mutation, input, prepared });
            const commitInput = { v: 1, receipt: preparation.receipt, records: [{ commentId: prepared.structural.id,
                sensitiveEnvelope: sealReviewCommentSensitiveEnvelopeV1({ structural: prepared.structural, sensitive, mode: "e2ee", material, randomBytes: (length) => new Uint8Array(length).fill(31) }),
                eventEnvelope: buildReviewCommentMutationEventEnvelopeV1({ accountId: account.id, actor, actionId: mutation.actionId, input, mode: "e2ee", material, randomBytes: (length) => new Uint8Array(length).fill(32) }),
            }] };
            const committed = await app.inject({ method: "POST", url: "/v1/reviews/comments/mutations/commit", headers: { "x-test-user-id": account.id }, payload: commitInput });
            expect(committed.statusCode, committed.body).toBe(200);
            const stored = ReviewCommentCommitMutationResponseV1Schema.parse(committed.json()).comments[0]!;
            const opened = await openReviewCommentSensitiveMigrationSourceV1({ structural: stored.structural, source: "source" in stored ? stored.source : { v: 1, layout: "canonical_v1", envelope: stored.sensitiveEnvelope }, material });
            expect(opened.status).toBe("available");
            if (opened.status === "available") expect(opened.comment.body).toBe(input.body);
            const rows = await db.$queryRaw<Array<{ body_envelope_json: string; metadata_json: string | null; snapshot_envelope_json: string }>>`SELECT body_envelope_json, metadata_json, snapshot_envelope_json FROM review_comments WHERE id = ${stored.structural.id}`;
            expect(JSON.stringify(rows)).not.toContain("private canonical");
            expect(rows[0]?.metadata_json).toBeNull();
            const replay = await app.inject({ method: "POST", url: "/v1/reviews/comments/mutations/commit", headers: { "x-test-user-id": account.id }, payload: commitInput });
            expect(replay.statusCode, replay.body).toBe(200);
            expect(replay.json()).toMatchObject({ replayed: true, comments: [{ structural: { id: stored.structural.id } }] });
            const tamperedBytes = privacyKit.decodeBase64(preparation.receipt);
            tamperedBytes[0] = tamperedBytes[0]! ^ 1;
            const tampered = await app.inject({ method: "POST", url: "/v1/reviews/comments/mutations/commit", headers: { "x-test-user-id": account.id }, payload: { ...commitInput, receipt: privacyKit.encodeBase64(tamperedBytes) } });
            expect(tampered.statusCode).toBe(400);
        });
    });

    it("keeps retained split E2EE secrets off ordinary reads and preparation while allowing plain legacy records", async () => {
        const encryptedAccount = await db.account.create({ data: { id: "account-retained-private", ...e2eeAccountFields(77) } });
        const plainAccount = await db.account.create({ data: { id: "account-retained-plain", publicKey: "retained-plain-key", encryptionMode: "plain" } });
        for (const [account, mode] of [[encryptedAccount, "e2ee"], [plainAccount, "plain"]] as const) {
            const id = `retained-${mode}`;
            await db.reviewComment.create({ data: {
                id, accountId: account.id, projectId: "project-1", threadId: id,
                state: "open", flagsJson: "{}", authorJson: JSON.stringify({ kind: "user", userId: account.id }),
                anchorJson: JSON.stringify({ kind: "file", filePath: "PRIVATE-retained.ts" }),
                snapshotEnvelopeJson: JSON.stringify(mode === "e2ee" ? { t: "encrypted", c: "retained-snapshot-cipher" } : { t: "plain", v: { kind: "none", capturedAt: 1000 } }),
                bodyEnvelopeJson: JSON.stringify(mode === "e2ee" ? { t: "encrypted", c: "retained-body-cipher" } : { t: "plain", v: "PRIVATE-retained-body" }),
                bodyVersion: 1, serverRevision: 1, editsJson: "[]", dispositionsJson: "{}",
                transitionsJson: JSON.stringify([{ transitionId: `${id}-transition`, toState: "open", transitionedAt: 1000,
                    transitionedBy: { kind: "user", userId: account.id }, serverRevision: 1, reason: "PRIVATE-retained-reason" }]),
                evidenceJson: JSON.stringify([{ kind: "reasoning", message: "PRIVATE-retained-evidence" }]),
                metadataJson: JSON.stringify({ tags: ["PRIVATE-retained-metadata"] }), createdAt: 1000n, updatedAt: 1000n,
            } });
        }
        await withAuthenticatedTestApp(registerReviewCommentRoutes, async (app) => {
            const headers = { "x-test-user-id": encryptedAccount.id };
            for (const url of ["/v1/reviews/comments/retained-e2ee?stored=true", "/v1/reviews/comments?stored=true&projectId=project-1",
                "/v1/reviews/comments/retained-e2ee", "/v1/reviews/comments?projectId=project-1"]) {
                const response = await app.inject({ method: "GET", url, headers });
                expect(response.statusCode, response.body).toBe(400);
                expect(response.json()).toMatchObject({ error: "review_comment_encryption_mode_mismatch" });
                expect(response.body).not.toContain("PRIVATE-");
            }
            const prepare = await app.inject({ method: "POST", url: "/v1/reviews/comments/mutations/prepare", headers,
                payload: { v: 1, contentCommitment: "a".repeat(43), mutation: projectReviewCommentStructuralMutationV1("reviews.comments.setDisposition", {
                    projectId: "project-1", commentId: "retained-e2ee", expectedServerRevision: 1, disposition: "working", clientMutationId: "retained-prepare" }) } });
            expect(prepare.statusCode, prepare.body).toBe(400);
            expect(prepare.json()).toMatchObject({ error: "review_comment_encryption_mode_mismatch" });
            expect(prepare.body).not.toContain("PRIVATE-");
            const plain = await app.inject({ method: "GET", url: "/v1/reviews/comments/retained-plain", headers: { "x-test-user-id": plainAccount.id } });
            expect(plain.statusCode, plain.body).toBe(200);
            expect(plain.json()).toMatchObject({ comment: { body: "PRIVATE-retained-body", anchor: { filePath: "PRIVATE-retained.ts" } } });
            const edited = await app.inject({ method: "PATCH", url: "/v1/reviews/comments/retained-plain", headers: { "x-test-user-id": plainAccount.id },
                payload: { projectId: "project-1", expectedServerRevision: 1, expectedBodyVersion: 1, nextBody: "PRIVATE-retained-edit", clientMutationId: "plain-retained-edit" } });
            expect(edited.statusCode, edited.body).toBe(200);
            expect(edited.json()).toMatchObject({ comment: { body: "PRIVATE-retained-edit", serverRevision: 2 } });
            // Account mode remains the authority even if retained plaintext rows are inconsistent with it.
            await db.account.update({ where: { id: plainAccount.id }, data: e2eeAccountFields(79) });
            for (const url of ["/v1/reviews/comments/retained-plain", "/v1/reviews/comments?projectId=project-1"]) {
                const inconsistent = await app.inject({ method: "GET", url, headers: { "x-test-user-id": plainAccount.id } });
                expect(inconsistent.statusCode, inconsistent.body).toBe(400);
                expect(inconsistent.json()).toMatchObject({ error: "review_comment_encryption_mode_mismatch" });
                expect(inconsistent.body).not.toContain("PRIVATE-");
            }
        });
        // Explicit migration recovery retains the original source; ordinary admission must not mutate or destroy it.
        const retained = await createSqlReviewCommentStore().getSource({ accountId: encryptedAccount.id, commentId: "retained-e2ee" });
        expect(retained?.source).toMatchObject({ layout: "legacy_split_v1", sourceMode: "e2ee", anchor: { filePath: "PRIVATE-retained.ts" } });
    });

    it("runs the E2EE CRUD lifecycle through real HTTP and retains partial bulk CAS outcomes", async () => {
        const account = await db.account.create({ data: { id: "account-encrypted-lifecycle", ...e2eeAccountFields(75) } });
        await initEncrypt();
        const actor = { kind: "user", userId: account.id } as const;
        const context = { accountId: account.id, mode: "e2ee", material: { type: "dataKey", machineKey: new Uint8Array(32).fill(76) } } as const;
        const workspace = { machineId: "machine-lifecycle", path: "/repo" };
        await withAuthenticatedTestApp(registerReviewCommentRoutes, async (app) => {
            const run = async (actionId: ReviewCommentMutationActionIdV1, input: Record<string, unknown>) => executeReviewCommentTransportV1({
                actionId, input, context, actor, randomBytes,
                request: async (request) => {
                    expect(JSON.stringify(request)).not.toContain("PRIVATE-");
                    const response = await app.inject({ method: request.method === "get" ? "GET" : "POST", url: request.path,
                        headers: { "x-test-user-id": account.id }, payload: request.body });
                    if (response.statusCode !== 200) throw new Error(response.body);
                    return response.json();
                },
            });
            const commentFrom = (value: unknown) => {
                if (!value || typeof value !== "object" || !("comment" in value)) throw new Error("Expected Review Comment result");
                return ReviewCommentV1Schema.parse(value.comment);
            };
            const original = commentFrom(await run("reviews.comments.create", { workspace,
                anchor: { kind: "file", filePath: "PRIVATE-file.ts" }, snapshot: textSnapshot(),
                body: "PRIVATE-body", metadata: { tags: ["PRIVATE-tag"] }, authorIntent: "open", clientMutationId: "crud-create" }));
            const second = commentFrom(await run("reviews.comments.create", { workspace,
                anchor: { kind: "workspace", workspaceId: "workspace-1" }, snapshot: { kind: "none", capturedAt: 1000 },
                body: "PRIVATE-second", authorIntent: "open", clientMutationId: "crud-second" }));
            const edited = commentFrom(await run("reviews.comments.edit", { workspace, commentId: original.id,
                expectedServerRevision: 1, expectedBodyVersion: 1, nextBody: "PRIVATE-edited", reason: "PRIVATE-edit-reason", clientMutationId: "crud-edit" }));
            expect(edited.edits[0]).toMatchObject({ previousBody: "PRIVATE-body", nextBody: "PRIVATE-edited" });
            const reply = commentFrom(await run("reviews.comments.reply", { workspace, parentCommentId: edited.id,
                expectedParentServerRevision: edited.serverRevision, body: "PRIVATE-reply", clientMutationId: "crud-reply" }));
            expect(reply.parentCommentId).toBe(edited.id);
            const disposed = commentFrom(await run("reviews.comments.setDisposition", { workspace, commentId: edited.id,
                expectedServerRevision: edited.serverRevision, disposition: "working", clientMutationId: "crud-disposition" }));
            const evidenced = commentFrom(await run("reviews.comments.attachEvidence", { workspace, commentId: disposed.id,
                expectedServerRevision: disposed.serverRevision, evidence: [{ kind: "reasoning", message: "PRIVATE-evidence" }], clientMutationId: "crud-evidence" }));
            let interleaved = false;
            const bulk = ReviewCommentBulkTransitionResponseV1Schema.parse(await executeReviewCommentTransportV1({
                actionId: "reviews.comments.bulkTransition", context, actor, randomBytes,
                input: { workspace, commentIds: [evidenced.id, second.id], expectedServerRevisions: { [evidenced.id]: evidenced.serverRevision, [second.id]: second.serverRevision },
                    expectedState: "open", toState: "dismissed", reason: "PRIVATE-dismiss", clientMutationId: "crud-bulk" },
                request: async (request) => {
                    const response = await app.inject({ method: "POST", url: request.path, headers: { "x-test-user-id": account.id }, payload: request.body });
                    expect(response.statusCode, response.body).toBe(200);
                    if (!interleaved && request.path.endsWith("/prepare")) {
                        interleaved = true;
                        await run("reviews.comments.setDisposition", { workspace, commentId: second.id, expectedServerRevision: second.serverRevision,
                            disposition: "working", clientMutationId: "crud-race" });
                    }
                    return response.json();
                },
            }));
            expect(bulk.updated).toMatchObject([{ id: original.id, state: "dismissed" }]);
            expect(bulk.failed).toMatchObject([{ commentId: second.id, errorCode: "review_comment_conflict" }]);
            const redacted = commentFrom(await run("reviews.comments.redact", { workspace, commentId: original.id,
                expectedServerRevision: bulk.updated[0]!.serverRevision, reason: "PRIVATE-redact", clientMutationId: "crud-redact" }));
            expect(redacted).toMatchObject({ body: "", edits: [], flags: { redacted: true } });
            const wrongScope = await app.inject({ method: "POST", url: "/v1/reviews/comments/mutations/prepare", headers: { "x-test-user-id": account.id },
                payload: { v: 1, contentCommitment: "a".repeat(43), mutation: projectReviewCommentStructuralMutationV1("reviews.comments.setDisposition", {
                    workspace: { ...workspace, path: "/other" }, commentId: second.id, expectedServerRevision: 2, disposition: "working", clientMutationId: "wrong-scope" }) } });
            expect(wrongScope.statusCode).toBe(400);
            expect(wrongScope.json()).toMatchObject({ error: "review_comment_conflict" });
            const rows = await db.$queryRaw<Array<Record<string, unknown>>>`SELECT anchor_json, anchor_file_path, body_envelope_json, snapshot_envelope_json, edits_json, evidence_json, transitions_json, metadata_json, tombstone_json FROM review_comments WHERE account_id = ${account.id}`;
            expect(JSON.stringify(rows)).not.toContain("PRIVATE-");
            expect(rows.every((row) => row.anchor_file_path === null && row.evidence_json === null && row.metadata_json === null)).toBe(true);
            const events = await db.$queryRaw<Array<{ event_envelope_json: string }>>`SELECT event_envelope_json FROM review_comment_events WHERE account_id = ${account.id}`;
            expect(JSON.stringify(events)).not.toContain("PRIVATE-");
        });
    });

    it("persists and isolates workspace-only review comments and their events", async () => {
        const account = await db.account.create({ data: {
            id: "account-workspace-review", publicKey: "pk-workspace-review", encryptionMode: "plain",
        } });
        const app = registerDefaultRoutes();
        const create = getRouteHandler(app, "POST", "/v1/reviews/comments");
        const workspace = { machineId: "machine-workspace-review", path: "/work/repo" };
        const createReply = createReplyStub();
        const created = ReviewCommentCreateResponseV1Schema.parse(await create({
            userId: account.id,
            body: { workspace, sessionId: "session-workspace-review", findingIdentity: "a".repeat(64),
                findingSeverity: "high", anchor: { kind: "line", filePath: "src/example.ts", line: 2 },
                snapshot: textSnapshot(), body: "Check null.", authorIntent: "open", clientMutationId: "workspace-review-create" },
        }, createReply));
        expect(createReply.statusCode).toBe(200);
        const store = createSqlReviewCommentStore();
        expect(await store.get({ accountId: account.id, commentId: created.comment.id })).toMatchObject({
            workspace, findingIdentity: "a".repeat(64), findingSeverity: "high",
        });
        expect(await store.list({ accountId: account.id, filters: { workspace,
            states: [], taxonomyIds: [], includeHistory: false, limit: 50 } })).toMatchObject({ items: [{ id: created.comment.id }] });
        expect(await store.list({ accountId: account.id, filters: { workspace: { ...workspace, path: "/other" },
            states: [], taxonomyIds: [], includeHistory: false, limit: 50 } })).toMatchObject({ items: [] });
        expect(await store.listEvents({ accountId: account.id, commentId: created.comment.id })).toMatchObject([{ workspace }]);
    });

    it("admits only exact signed host findings with ordinary Session access and coalesces durable identities", async () => {
        const account = await db.account.create({ data: { id: "account-host-review", publicKey: "pk-host-review", encryptionMode: "plain" } });
        await db.session.create({ data: { id: "session-host-review", accountId: account.id, tag: "review-session", metadata: "{}", encryptionMode: "plain" } });
        const keyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(33));
        await createTrustedMachineInstallation({ accountId: account.id, machineId: "machine-host-review", installationId: "installation-host-review", keyPair });
        const app = registerDefaultRoutes();
        const create = getRouteHandler(app, "POST", "/v1/reviews/comments");
        const body = { workspace: { machineId: "machine-host-review", path: "/repo" }, sessionId: "session-host-review",
            runId: "review-round-1", engineId: "codex", findingId: "finding-1", findingIdentity: "c".repeat(64),
            anchor: { kind: "file" as const, filePath: "src/example.ts" }, snapshot: textSnapshot(),
            body: "Guard this value", metadata: { reviewGroupIds: ["host-panel-1"] }, authorIntent: "propose" as const, clientMutationId: "host-finding-1" };
        const header = createSignedPrincipalHeader({ actor: { kind: "agent", agentId: "codex", sessionId: body.sessionId },
            currentIntent: { v: 1, kind: "review_findings_materialization", actionId: "reviews.comments.create",
                sessionId: body.sessionId, runId: body.runId, callId: "call-review-1", agentId: "codex", workspace: body.workspace,
                effectBodySha256Base64Url: createHash("sha256").update(stringifyReviewCommentPrincipalCanonicalJsonV1(body)).digest("base64url") },
            keyPair, machineId: "machine-host-review", installationId: "installation-host-review", body });
        const request = { userId: account.id, authAuthority: "present_user" as const, headers: { [REVIEW_COMMENT_PRINCIPAL_HEADER_V1]: header }, body };
        const comment = ReviewCommentCreateResponseV1Schema.parse(await create(request, createReplyStub())).comment;
        expect(comment).toMatchObject({ state: "proposed", workspace: body.workspace, findingIdentity: body.findingIdentity });
        expect((await createSqlReviewCommentStore().get({ accountId: account.id, commentId: comment.id }))?.metadata?.reviewGroupIds).toEqual(["host-panel-1"]);
        const denied = createReplyStub();
        // Invoke the post-auth boundary directly: the route harness otherwise supplies present_user.
        await getRouteEntry(app, "POST", "/v1/reviews/comments").handler({ ...request, authAuthority: undefined }, denied);
        expect(denied.send).toHaveBeenCalledWith(expect.objectContaining({ error: "review_comment_permission_denied" }));
        const operations = createReviewCommentOperations(createSqlReviewCommentStore(), { now: () => 1234, createId: (prefix) => `${prefix}-${tweetnacl.randomBytes(8).join("-")}` });
        const duplicateBody = { ...body, engineId: "claude", runId: "review-round-2", clientMutationId: "host-finding-2" };
        const duplicates = await Promise.all([0, 1].map((index) => operations.create({ accountId: account.id,
            actor: { kind: "user", userId: account.id }, input: { ...duplicateBody, clientMutationId: `host-duplicate-${index}` } })));
        expect(duplicates.map((value) => value.comment.id)).toEqual([comment.id, comment.id]);
        expect(await createSqlReviewCommentStore().listEvents({ accountId: account.id, commentId: comment.id })).toHaveLength(1);
        const concurrent = await Promise.all([0, 1].map((index) => operations.create({ accountId: account.id,
            actor: { kind: "user", userId: account.id }, input: { ...duplicateBody, findingIdentity: "d".repeat(64),
                engineId: index === 0 ? "codex" : "claude", clientMutationId: `host-concurrent-${index}` } })));
        expect(concurrent[0]!.comment.id).toBe(concurrent[1]!.comment.id);
        expect(await createSqlReviewCommentStore().listEvents({ accountId: account.id, commentId: concurrent[0]!.comment.id })).toHaveLength(1);
    });

    it("keeps encrypted finding re-raises separate from signed CAS dispute events", async () => {
        const account = await db.account.create({ data: { id: "account-encrypted-reraise", ...e2eeAccountFields(40) } });
        const sessionId = "session-encrypted-reraise";
        await db.session.create({ data: { id: sessionId, accountId: account.id, tag: sessionId, metadata: "{}", encryptionMode: "e2ee" } });
        const keyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(42));
        const machineId = "machine-encrypted-reraise";
        const installationId = "installation-encrypted-reraise";
        await createTrustedMachineInstallation({ accountId: account.id, machineId, installationId, keyPair });
        const app = registerDefaultRoutes();
        const actor = { kind: "agent", agentId: "codex", sessionId } as const;
        const workspace = { machineId, path: "/repo" };
        await initEncrypt();
        const context = { accountId: account.id, mode: "e2ee", material: { type: "dataKey", machineKey: new Uint8Array(32).fill(41) } } as const;
        const input = { workspace, sessionId, runId: "encrypted-round-1", engineId: "codex", findingIdentity: "9".repeat(64),
            anchor: { kind: "file" as const, filePath: "src/example.ts" }, snapshot: textSnapshot(),
            body: "Private finding",
            authorIntent: "open" as const, clientMutationId: "encrypted-create" };
        const signedRequest = (actingActor: ReviewCommentActorRefV1, logicalCreate?: typeof input) => async (request: Parameters<Parameters<typeof executeReviewCommentTransportV1>[0]["request"]>[0]) => {
            const handler = getRouteHandler(app, "POST", request.path);
            const reply = createReplyStub();
            const result = await handler({ userId: account.id, authAuthority: "present_user", method: "POST", url: request.path, body: request.body,
                headers: { [REVIEW_COMMENT_PRINCIPAL_HEADER_V1]: createSignedPrincipalHeader({ actor: actingActor, keyPair, machineId, installationId, body: request.body, path: request.path,
                    ...(logicalCreate ? { currentIntent: { v: 1, kind: "review_findings_materialization", actionId: "reviews.comments.create", sessionId,
                        runId: logicalCreate.runId, callId: `call-${logicalCreate.runId}`, agentId: actor.agentId, workspace,
                        effectBodySha256Base64Url: request.contentCommitment! } as ReviewCommentCurrentIntentV1 } : {}) }) },
            }, reply);
            expect(reply.statusCode).toBe(200);
            return result;
        };
        const materialize = async (body: typeof input) => ReviewCommentCreateResponseV1Schema.parse(await executeReviewCommentTransportV1({
            actionId: "reviews.comments.create", input: body, actor, context, randomBytes, request: signedRequest(actor, body),
        }));
        const created = await materialize(input);
        const transitionInput = { workspace, commentId: created.comment.id, expectedServerRevision: 1, expectedState: "open", toState: "dismissed", reason: "Verified no issue",
            clientMutationId: "encrypted-dismiss" };
        const mutate = (body: typeof transitionInput) => {
            const actingActor = body.expectedState === "open" ? { ...actor, agentId: "builder" } : actor;
            return executeReviewCommentTransportV1({ actionId: "reviews.comments.transition", input: body, actor: actingActor, context, randomBytes, request: signedRequest(actingActor) });
        };
        expect(await mutate(transitionInput)).toMatchObject({ comment: { state: "dismissed", serverRevision: 2 } });
        const duplicate = await materialize({ ...input, engineId: "claude", runId: "encrypted-round-2", clientMutationId: "encrypted-reraise" });
        expect(duplicate.comment).toMatchObject({ id: created.comment.id, state: "dismissed", serverRevision: 2 });
        expect(await createSqlReviewCommentStore().listEvents({ accountId: account.id, commentId: created.comment.id })).toHaveLength(2);
        expect(await mutate({ ...transitionInput, expectedServerRevision: 2, expectedState: "dismissed", toState: "open",
            clientMutationId: "encrypted-reopen" }))
            .toMatchObject({ comment: { state: "open", serverRevision: 3, flags: { disputed: true } } });
        const events = await db.$queryRaw<Array<{ event_kind: string; event_envelope_json: string }>>`
            SELECT event_kind, event_envelope_json FROM review_comment_events WHERE account_id = ${account.id} ORDER BY server_revision`;
        expect(events.map((event) => event.event_kind)).toEqual(["created", "transitioned", "transitioned"]);
        expect(events.map((event) => JSON.parse(event.event_envelope_json))).toMatchObject([
            { binding: { eventKind: "created", requestBinding: { actionId: "reviews.comments.create" } }, sensitive: { t: "encrypted" } },
            { binding: { eventKind: "transitioned", requestBinding: { actionId: "reviews.comments.transition" } }, sensitive: { t: "encrypted" } },
            { binding: { eventKind: "transitioned", requestBinding: { actionId: "reviews.comments.transition" } }, sensitive: { t: "encrypted" } },
        ]);
    });

    it("admits signed lead review verdicts only for currently readable led Sessions", async () => {
        const account = await db.account.create({ data: { id: "account-lead-review", publicKey: "pk-lead-review", encryptionMode: "plain" } });
        const foreign = await db.account.create({ data: { id: "account-foreign-review", publicKey: "pk-foreign-review", encryptionMode: "plain" } });
        const leadId = "session-review-lead";
        const childId = "session-review-child";
        const unrelatedId = "session-review-unrelated";
        const unreadableId = "session-review-unreadable";
        const readOnlyId = "session-review-read-only";
        const nestedId = "session-review-nested";
        for (const sessionId of [leadId, childId, unrelatedId, unreadableId, readOnlyId, nestedId]) {
            await db.session.create({ data: { id: sessionId, accountId: [unreadableId, readOnlyId].includes(sessionId) ? foreign.id : account.id,
                tag: sessionId, metadata: "{}", encryptionMode: "plain" } });
        }
        await db.sessionReportsTo.createMany({ data: [childId, unreadableId, readOnlyId].map((sessionId) => ({ sessionId, leadSessionId: leadId })) });
        await db.sessionReportsTo.create({ data: { sessionId: nestedId, leadSessionId: unreadableId } });
        await db.sessionShare.create({ data: { sessionId: readOnlyId, sharedByUserId: foreign.id, sharedWithUserId: account.id, accessLevel: "view" } });
        const keyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(36));
        const machineId = "machine-lead-review";
        const installationId = "installation-lead-review";
        await createTrustedMachineInstallation({ accountId: account.id, machineId, installationId, keyPair });
        await withAuthenticatedTestApp(registerReviewCommentRoutes, async (app) => {
            const workspace = { machineId, path: "/repo" };
            const comments = new Map<string, { id: string }>();
            for (const sessionId of [childId, unrelatedId, unreadableId, readOnlyId, nestedId]) {
                const response = await app.inject({ method: "POST", url: "/v1/reviews/comments", headers: { "x-test-user-id": account.id },
                    payload: { workspace, sessionId, anchor: { kind: "file", filePath: "src/example.ts" }, snapshot: textSnapshot(),
                        body: "Check this value", authorIntent: "open", clientMutationId: `lead-comment-${sessionId}` },
                });
                expect(response.statusCode, response.body).toBe(200);
                const created = ReviewCommentCreateResponseV1Schema.parse(response.json());
                comments.set(sessionId, created.comment);
            }
            const actor = { kind: "agent", agentId: "codex", sessionId: leadId } as const;
            const signedRequest = (path: string, body?: unknown, method: "GET" | "POST" = "POST", principalActor: ReviewCommentActorRefV1 = actor) => ({
                headers: { "x-test-user-id": account.id, [REVIEW_COMMENT_PRINCIPAL_HEADER_V1]: createSignedPrincipalHeader({ actor: principalActor, keyPair, machineId, installationId, path, body, method }) },
            });
            const list = (sessionId: string) => app.inject({ ...signedRequest("/v1/reviews/comments", undefined, "GET"),
                method: "GET", url: `/v1/reviews/comments?sessionId=${sessionId}` });
            const listResponse = await list(childId);
            expect(listResponse.statusCode, listResponse.body).toBe(200);
            const listed = ReviewCommentListResponseV1Schema.parse(listResponse.json());
            const childCommentId = comments.get(childId)!.id;
            expect(listed.items.map((comment) => comment.id)).toEqual([childCommentId]);
            for (const sessionId of [readOnlyId, nestedId]) {
                const response = await list(sessionId);
                expect(response.statusCode, response.body).toBe(200);
                expect(ReviewCommentListResponseV1Schema.parse(response.json()).items.map((comment) => comment.id)).toEqual([comments.get(sessionId)!.id]);
            }
            const disposition = (commentId: string, body: Record<string, unknown>, principalActor: ReviewCommentActorRefV1 = actor) => app.inject({
                ...signedRequest(`/v1/reviews/comments/${commentId}/disposition`, body, "POST", principalActor),
                method: "POST", url: `/v1/reviews/comments/${commentId}/disposition`, payload: body });
            const body = { workspace, expectedServerRevision: 1, disposition: "blocking", clientMutationId: "lead-uphold" };
            const verdict = await disposition(childCommentId, body);
            expect(verdict.statusCode, verdict.body).toBe(200);
            expect(verdict.json()).toMatchObject({ comment: { serverRevision: 2, dispositions: { [`agent:codex:${leadId}`]: "blocking" } } });
            const dismissed = { workspace, expectedServerRevision: 2, expectedState: "open", toState: "dismissed",
                reason: "Verified no issue", clientMutationId: "lead-dismiss" };
            const dismissedResponse = await app.inject({ ...signedRequest(`/v1/reviews/comments/${childCommentId}/transition`, dismissed),
                method: "POST", url: `/v1/reviews/comments/${childCommentId}/transition`, payload: dismissed });
            expect(dismissedResponse.statusCode, dismissedResponse.body).toBe(200);
            expect(dismissedResponse.json()).toMatchObject({ comment: { state: "dismissed", serverRevision: 3 } });
            const replyBody = { workspace, expectedParentServerRevision: 3, body: "A reply is not a verdict", clientMutationId: "lead-reply-denied" };
            const replyResponse = await app.inject({ ...signedRequest(`/v1/reviews/comments/${childCommentId}/reply`, replyBody),
                method: "POST", url: `/v1/reviews/comments/${childCommentId}/reply`, payload: replyBody });
            expect(replyResponse.json()).toMatchObject({ error: "review_comment_permission_denied" });
            for (const sessionId of [unrelatedId, unreadableId]) {
                expect((await list(sessionId)).json()).toMatchObject({ error: "review_comment_permission_denied" });
                const commentId = comments.get(sessionId)!.id;
                expect((await disposition(commentId, body)).json()).toMatchObject({ error: "review_comment_permission_denied" });
            }
            const readOnlyCommentId = comments.get(readOnlyId)!.id;
            expect((await disposition(readOnlyCommentId, body)).json()).toMatchObject({ error: "review_comment_permission_denied" });
            const workflowRunId = "b25c232a-aa68-4343-90c7-9b4b0b980a01";
            await db.automationRun.create({ data: { id: workflowRunId, accountId: account.id, originKind: "direct", causeKind: null, originSessionId: leadId,
                scheduledAt: new Date(), dueAt: new Date(), workflowCustodyState: "pending", workflowAcceptedSnapshotEnvelope: "{}",
                assignments: { create: { machineId } } } });
            const workflowBody = { ...body, expectedServerRevision: 3, clientMutationId: "workflow-child-denied" };
            expect((await disposition(childCommentId, workflowBody, { kind: "workflow", runId: workflowRunId })).json()).toMatchObject({ error: "review_comment_permission_denied" });
            await db.sessionReportsTo.delete({ where: { sessionId: childId } });
            const detachedBody = { ...body, expectedServerRevision: 3, clientMutationId: "detached-lead-uphold" };
            expect((await disposition(childCommentId, detachedBody)).json()).toMatchObject({ error: "review_comment_permission_denied" });
        });
    });

    it("persists the trusted workflow origin when signed detached finding input has no Session", async () => {
        const account = await db.account.create({ data: { id: "account-detached-review-origin", publicKey: "pk-detached-review-origin", encryptionMode: "plain" } });
        const keyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(35));
        const machineId = "machine-detached-review-origin";
        const installationId = "installation-detached-review-origin";
        await createTrustedMachineInstallation({ accountId: account.id, machineId, installationId, keyPair });
        const app = registerDefaultRoutes();
        const create = getRouteHandler(app, "POST", "/v1/reviews/comments");
        const workspace = { machineId, path: "/repo" };
        const sessionIds = ["session-review-origin-one", "session-review-origin-two"];
        const workflowRunIds = ["1740f2d2-b283-4acb-bd4f-2a9ff26b7db1", "1740f2d2-b283-4acb-bd4f-2a9ff26b7db2"];
        const commentIds: string[] = [];
        for (const [index, sessionId] of sessionIds.entries()) {
            const workflowRunId = workflowRunIds[index]!;
            await db.session.create({ data: { id: sessionId, accountId: account.id, tag: `origin-${index}`, metadata: "{}", encryptionMode: "plain" } });
            await db.automationRun.create({ data: { id: workflowRunId, accountId: account.id, originKind: "direct", causeKind: null, originSessionId: sessionId,
                scheduledAt: new Date(), dueAt: new Date(), workflowCustodyState: "pending", workflowAcceptedSnapshotEnvelope: "{}",
                assignments: { create: { machineId } } } });
            const body = { workspace, runId: `detached-review-leaf-${index}`, engineId: "codex", findingId: `finding-${index}`,
                findingIdentity: "f".repeat(64), anchor: { kind: "file" as const, filePath: "src/example.ts" }, snapshot: textSnapshot(),
                body: "Guard this value", authorIntent: "propose" as const, clientMutationId: `detached-review-create-${index}` };
            const header = createSignedPrincipalHeader({ actor: { kind: "workflow", runId: workflowRunId },
                currentIntent: { v: 1, kind: "review_findings_materialization", actionId: "reviews.comments.create", workflowRunId,
                    runId: body.runId, callId: `detached-review-call-${index}`, agentId: "codex", workspace,
                    effectBodySha256Base64Url: createHash("sha256").update(stringifyReviewCommentPrincipalCanonicalJsonV1(body)).digest("base64url") },
                keyPair, machineId, installationId, body });
            const created = ReviewCommentCreateResponseV1Schema.parse(await create({ userId: account.id, authAuthority: "present_user",
                headers: { [REVIEW_COMMENT_PRINCIPAL_HEADER_V1]: header }, body }, createReplyStub()));
            expect(created.comment.sessionId).toBe(sessionId);
            expect(await db.reviewComment.findUniqueOrThrow({ where: { id: created.comment.id }, select: { sessionId: true } })).toEqual({ sessionId });
            if (index === 0) {
                const wrongBody = { ...body, sessionId: "session-from-mutable-effect", clientMutationId: "wrong-workflow-origin" };
                const wrongHeader = createSignedPrincipalHeader({ actor: { kind: "workflow", runId: workflowRunId },
                    currentIntent: { v: 1, kind: "review_findings_materialization", actionId: "reviews.comments.create", workflowRunId,
                        sessionId: wrongBody.sessionId, runId: wrongBody.runId, callId: "wrong-origin-call", agentId: "codex", workspace,
                        effectBodySha256Base64Url: createHash("sha256").update(stringifyReviewCommentPrincipalCanonicalJsonV1(wrongBody)).digest("base64url") },
                    keyPair, machineId, installationId, body: wrongBody });
                const wrongReply = createReplyStub();
                await create({ userId: account.id, authAuthority: "present_user", headers: { [REVIEW_COMMENT_PRINCIPAL_HEADER_V1]: wrongHeader }, body: wrongBody }, wrongReply);
                expect(wrongReply.send).toHaveBeenCalledWith(expect.objectContaining({ error: "review_comment_permission_denied" }));
            }
            commentIds.push(created.comment.id);
        }
        expect(commentIds[0]).not.toBe(commentIds[1]);
        const actor = { kind: "workflow", runId: workflowRunIds[0]! } as const;
        const listHeader = createSignedPrincipalHeader({ actor, keyPair, machineId, installationId, method: "GET", path: "/v1/reviews/comments" });
        const listed = ReviewCommentListResponseV1Schema.parse(await getRouteHandler(app, "GET", "/v1/reviews/comments")({
            userId: account.id, authAuthority: "present_user", headers: { [REVIEW_COMMENT_PRINCIPAL_HEADER_V1]: listHeader }, query: {},
        }, createReplyStub()));
        expect(listed.items.map((comment) => comment.id)).toEqual([commentIds[0]]);
        const body = { workspace, expectedServerRevision: 1, disposition: "blocking", clientMutationId: "detached-review-verdict" };
        const header = createSignedPrincipalHeader({ actor, keyPair, machineId, installationId,
            path: `/v1/reviews/comments/${commentIds[0]!}/disposition`, body });
        const verdict = await getRouteHandler(app, "POST", "/v1/reviews/comments/:commentId/disposition")({ userId: account.id, authAuthority: "present_user",
            headers: { [REVIEW_COMMENT_PRINCIPAL_HEADER_V1]: header }, params: { commentId: commentIds[0]! }, body }, createReplyStub());
        expect(verdict).toMatchObject({ comment: { sessionId: sessionIds[0], serverRevision: 2, dispositions: { [`workflow:${workflowRunIds[0]!}`]: "blocking" } } });
    });

    it("admits originless workflow findings only on the assigned signed host and keeps moderation scope closed", async () => {
        const account = await db.account.create({ data: { id: "account-workflow-host-review", publicKey: "pk-workflow-host-review", encryptionMode: "plain" } });
        const keyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(34));
        await createTrustedMachineInstallation({ accountId: account.id, machineId: "machine-workflow-review", installationId: "installation-workflow-review", keyPair });
        const workflowRunId = "13e56f2e-28b0-4baf-9f5a-b1e1c49a3e57";
        await db.automationRun.create({ data: { id: workflowRunId, accountId: account.id, originKind: "direct", causeKind: null,
            scheduledAt: new Date(), dueAt: new Date(), workflowCustodyState: "pending", workflowAcceptedSnapshotEnvelope: "{}",
            assignments: { create: { machineId: "machine-workflow-review" } } } });
        const app = registerDefaultRoutes();
        const create = getRouteHandler(app, "POST", "/v1/reviews/comments");
        const body = { workspace: { machineId: "machine-workflow-review", path: "/repo" }, runId: "workflow-review-leaf",
            engineId: "codex", findingId: "finding-1", findingIdentity: "e".repeat(64), anchor: { kind: "file" as const, filePath: "src/example.ts" },
            snapshot: textSnapshot(), body: "Guard this value", authorIntent: "propose" as const, clientMutationId: "workflow-host-finding" };
        const actor = { kind: "workflow", runId: workflowRunId } as const;
        const header = createSignedPrincipalHeader({ actor, currentIntent: { v: 1, kind: "review_findings_materialization", actionId: "reviews.comments.create",
            workflowRunId, runId: body.runId, callId: "workflow-review-call", agentId: "codex", workspace: body.workspace,
            effectBodySha256Base64Url: createHash("sha256").update(stringifyReviewCommentPrincipalCanonicalJsonV1(body)).digest("base64url") },
            keyPair, machineId: "machine-workflow-review", installationId: "installation-workflow-review", body });
        const created = ReviewCommentCreateResponseV1Schema.parse(await create({ userId: account.id, authAuthority: "present_user",
            headers: { [REVIEW_COMMENT_PRINCIPAL_HEADER_V1]: header }, body }, createReplyStub()));
        expect(created.comment.sessionId).toBeUndefined();
        await db.automationRunAssignment.update({ where: { runId_machineId: { runId: workflowRunId, machineId: "machine-workflow-review" } }, data: { machineId: "another-machine" } });
        const wrongHostReply = createReplyStub();
        await create({ userId: account.id, authAuthority: "present_user", headers: { [REVIEW_COMMENT_PRINCIPAL_HEADER_V1]: header }, body }, wrongHostReply);
        expect(wrongHostReply.send).toHaveBeenCalledWith(expect.objectContaining({ error: "review_comment_permission_denied" }));
        const listHeader = createSignedPrincipalHeader({ actor, keyPair, machineId: "machine-workflow-review", installationId: "installation-workflow-review",
            method: "GET", path: "/v1/reviews/comments", body: null });
        const listReply = createReplyStub();
        await getRouteHandler(app, "GET", "/v1/reviews/comments")({ userId: account.id, authAuthority: "present_user",
            headers: { [REVIEW_COMMENT_PRINCIPAL_HEADER_V1]: listHeader }, query: {} }, listReply);
        expect(listReply.send).toHaveBeenCalledWith(expect.objectContaining({ error: "review_comment_permission_denied" }));
    });

    it("persists one first-dispatch claim across simultaneous SQL-store callers", async () => {
        const account = await db.account.create({
            data: {
                id: "account-review-comment-publication",
                publicKey: "pk-review-comment-publication",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const create = getRouteHandler(registerDefaultRoutes(), "POST", "/v1/reviews/comments");
        const created = ReviewCommentCreateResponseV1Schema.parse(await create({
            userId: account.id,
            body: {
                projectId: "project-1",
                anchor: { kind: "line", filePath: "src/example.ts", line: 2 },
                snapshot: textSnapshot(),
                body: "Null-check this value.",
                clientMutationId: "mutation-publication-correlation",
            },
        }, createReplyStub()));
        const operations = createReviewCommentOperations(createSqlReviewCommentStore(), {
            now: () => 1234,
            createId: (prefix) => `${prefix}-unused`,
        });
        const request = {
            accountId: account.id,
            actor: { kind: "user", userId: account.id } as const,
            input: {
                target: {
                    providerId: "github",
                    configuredAccountId: "github-account-1",
                    entryRef: {
                        sourceId: "github",
                        kindId: "pull-request",
                        collisionScope: "github:repository-1",
                        entryId: "42",
                    },
                    subtarget: null,
                },
                baseRevision: "base-1",
                headRevision: "head-1",
                entries: [{
                    happierCommentId: created.comment.id,
                    expectedServerRevision: created.comment.serverRevision,
                    anchor: created.comment.anchor,
                    snapshot: textSnapshot(),
                    body: "Null-check this value.",
                }],
                verdict: { kind: "comment" as const, body: "Review summary" },
            },
        };

        const outcomes = await Promise.all([
            claimReviewCommentPublication(operations, request),
            claimReviewCommentPublication(operations, request),
        ]);

        expect(outcomes.map(({ disposition }) => disposition).sort())
            .toEqual(["dispatch", "reconcile"]);
        expect(new Set(outcomes.map(({ publicationPlanId }) => publicationPlanId)).size)
            .toBe(1);
        const [row] = await db.$queryRaw<Array<{ count: bigint }>>`
            SELECT COUNT(*) AS count FROM review_comment_publication_correlations
            WHERE account_id = ${account.id} AND comment_id = ${created.comment.id}
        `;
        expect(Number(row?.count ?? 0)).toBe(1);
    });

    it("releases only the failed and unattempted suffix after a partial publication", async () => {
        const account = await db.account.create({
            data: {
                id: "account-review-comment-publication-partial",
                publicKey: "pk-review-comment-publication-partial",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const create = getRouteHandler(registerDefaultRoutes(), "POST", "/v1/reviews/comments");
        const comments = await Promise.all(["first", "second", "third"].map(async (label) => (
            ReviewCommentCreateResponseV1Schema.parse(await create({
                userId: account.id,
                body: {
                    projectId: "project-1",
                    anchor: { kind: "line", filePath: `src/${label}.ts`, line: 2 },
                    snapshot: textSnapshot(),
                    body: `${label} comment`,
                    clientMutationId: `mutation-publication-${label}`,
                },
            }, createReplyStub())).comment
        )));
        let dispatchSequence = 0;
        const operations = createReviewCommentOperations(createSqlReviewCommentStore(), {
            now: () => 1234,
            createId: (prefix) => `${prefix}-${dispatchSequence += 1}`,
        });
        const request = {
            accountId: account.id,
            actor: { kind: "user", userId: account.id } as const,
            input: {
                target: {
                    providerId: "github",
                    configuredAccountId: "github-account-1",
                    entryRef: {
                        sourceId: "github",
                        kindId: "pull-request",
                        collisionScope: "github:repository-1",
                        entryId: "42",
                    },
                    subtarget: null,
                },
                baseRevision: "base-1",
                headRevision: "head-1",
                entries: comments.map((comment, index) => ({
                    happierCommentId: comment.id,
                    expectedServerRevision: comment.serverRevision,
                    anchor: comment.anchor,
                    snapshot: textSnapshot(),
                    body: `${["first", "second", "third"][index]!} comment`,
                })),
                verdict: { kind: "comment" as const, body: "Review summary" },
            },
        };

        const first = await claimReviewCommentPublication(operations, request);
        expect(first).toMatchObject({
            disposition: "dispatch",
            instructions: {
                entries: ["dispatch", "dispatch", "dispatch"],
                verdict: "dispatch",
            },
            priorResult: null,
        });
        expect(first.dispatchToken).toEqual(expect.any(String));

        await claimReviewCommentPublication(operations, {
            ...request,
            input: {
                ...request.input,
                settlement: {
                    dispatchToken: first.dispatchToken,
                    result: {
                        publicationPlanId: first.publicationPlanId,
                        entries: [
                            { ...first.entries[0]!, outcome: { kind: "published" as const, externalRef: "native-1" } },
                            { ...first.entries[1]!, outcome: { kind: "failed" as const, code: "provider/rejected" } },
                            { ...first.entries[2]!, outcome: { kind: "skippedPriorFailure" as const } },
                        ],
                        verdict: {
                            publicationCorrelationId: first.verdict!.publicationCorrelationId,
                            outcome: { kind: "skippedPriorFailure" as const },
                        },
                    },
                },
            },
        });

        const retry = await claimReviewCommentPublication(operations, request);
        expect(retry).toMatchObject({
            disposition: "dispatch",
            instructions: {
                entries: ["confirmed", "dispatch", "dispatch"],
                verdict: "dispatch",
            },
            priorResult: {
                entries: [
                    { outcome: { kind: "published", externalRef: "native-1" } },
                    { outcome: { kind: "failed", code: "provider/rejected" } },
                    { outcome: { kind: "skippedPriorFailure" } },
                ],
                verdict: { outcome: { kind: "skippedPriorFailure" } },
            },
        });
        expect(retry.dispatchToken).not.toBe(first.dispatchToken);
    });

    it("keeps an uncertain suffix held until tokenless reconciliation proves no effect", async () => {
        const account = await db.account.create({
            data: {
                id: "account-review-comment-publication-uncertain",
                publicKey: "pk-review-comment-publication-uncertain",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const create = getRouteHandler(registerDefaultRoutes(), "POST", "/v1/reviews/comments");
        const comments = await Promise.all(["first", "second", "third"].map(async (label) => (
            ReviewCommentCreateResponseV1Schema.parse(await create({
                userId: account.id,
                body: {
                    projectId: "project-1",
                    anchor: { kind: "line", filePath: `src/${label}.ts`, line: 2 },
                    snapshot: textSnapshot(),
                    body: `${label} comment`,
                    clientMutationId: `mutation-uncertain-${label}`,
                },
            }, createReplyStub())).comment
        )));
        let dispatchSequence = 0;
        const operations = createReviewCommentOperations(createSqlReviewCommentStore(), {
            now: () => 1234,
            createId: (prefix) => `${prefix}-${dispatchSequence += 1}`,
        });
        const request = {
            accountId: account.id,
            actor: { kind: "user", userId: account.id } as const,
            input: {
                target: {
                    providerId: "gitlab",
                    configuredAccountId: "gitlab-account-1",
                    entryRef: {
                        sourceId: "gitlab",
                        kindId: "merge-request",
                        collisionScope: "gitlab:project-1",
                        entryId: "42",
                    },
                    subtarget: null,
                },
                baseRevision: "base-1",
                headRevision: "head-1",
                entries: comments.map((comment, index) => ({
                    happierCommentId: comment.id,
                    expectedServerRevision: comment.serverRevision,
                    anchor: comment.anchor,
                    snapshot: textSnapshot(),
                    body: `${["first", "second", "third"][index]!} comment`,
                })),
                verdict: null,
            },
        };
        const first = await claimReviewCommentPublication(operations, request);

        await claimReviewCommentPublication(operations, {
            ...request,
            input: {
                ...request.input,
                settlement: {
                    dispatchToken: first.dispatchToken,
                    result: {
                        publicationPlanId: first.publicationPlanId,
                        entries: [
                            { ...first.entries[0]!, outcome: { kind: "published" as const, externalRef: "native-1" } },
                            { ...first.entries[1]!, outcome: { kind: "uncertain" as const } },
                            { ...first.entries[2]!, outcome: { kind: "skippedPriorFailure" as const } },
                        ],
                        verdict: { kind: "notRequested" as const },
                    },
                },
            },
        });

        const retry = await claimReviewCommentPublication(operations, request);
        expect(retry).toMatchObject({
            disposition: "reconcile",
            dispatchToken: null,
            instructions: {
                entries: ["confirmed", "reconcile", "held"],
                verdict: null,
            },
            priorResult: {
                entries: [
                    { outcome: { kind: "published", externalRef: "native-1" } },
                    { outcome: { kind: "uncertain" } },
                    { outcome: { kind: "skippedPriorFailure" } },
                ],
            },
        });

        const reconciled = await claimReviewCommentPublication(operations, {
            ...request,
            input: {
                ...request.input,
                settlement: {
                    dispatchToken: null,
                    result: {
                        publicationPlanId: first.publicationPlanId,
                        entries: [
                            { ...first.entries[0]!, outcome: { kind: "published" as const, externalRef: "native-1" } },
                            { ...first.entries[1]!, outcome: { kind: "failed" as const, code: "gitlab-pending-draft" } },
                            { ...first.entries[2]!, outcome: { kind: "skippedPriorFailure" as const } },
                        ],
                        verdict: { kind: "notRequested" as const },
                    },
                },
            },
        });
        expect(reconciled).toMatchObject({
            priorResult: {
                entries: [
                    { outcome: { kind: "published", externalRef: "native-1" } },
                    { outcome: { kind: "failed", code: "gitlab-pending-draft" } },
                    { outcome: { kind: "skippedPriorFailure" } },
                ],
            },
        });
        await expect(claimReviewCommentPublication(operations, request)).resolves.toMatchObject({
            disposition: "dispatch",
            instructions: {
                entries: ["confirmed", "dispatch", "dispatch"],
                verdict: null,
            },
        });
    });

    it("admits keyless plain publication after an Account transition retains its public binding", async () => {
        const account = await db.account.create({
            data: { id: "account-publication-plain-retained-binding", ...e2eeAccountFields(81) },
            select: { id: true },
        });
        await expect(updateAccountEncryptionMode({ accountId: account.id, mode: "plain" }))
            .resolves.toMatchObject({ status: "updated", mode: "plain" });
        const transitioned = await db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: { encryptionMode: true, contentPublicKey: true, contentPublicKeySig: true },
        });
        expect(transitioned.encryptionMode).toBe("plain");
        expect(transitioned.contentPublicKey).not.toBeNull();
        expect(transitioned.contentPublicKeySig).not.toBeNull();

        const context = { accountId: account.id, mode: "plain" as const, material: null };
        const plan: ReviewCommentPublicationPlanV1 = {
            target: { providerId: "github", configuredAccountId: "github-account-1",
                entryRef: { sourceId: "github", kindId: "pull-request", collisionScope: "repository-1", entryId: "42" }, subtarget: null },
            baseRevision: "base", headRevision: "head", entries: [], verdict: { kind: "comment", body: "Review summary." },
        };
        const wire = buildReviewCommentPublicationTransportRequestV1({
            input: plan, context, randomBytes: (length) => tweetnacl.randomBytes(length),
        });
        expect(wire.contentPublicKeyFingerprint).toBeNull();
        const route = getRouteHandler(registerDefaultRoutes(), "POST", "/v1/reviews/comments/publication/claim");
        const reply = createReplyStub();
        const response = await route({ userId: account.id, body: wire }, reply);
        expect(reply.statusCode).toBe(200);
        const first = openReviewCommentPublicationTransportResponseV1({ plan, context, response });
        expect(first.disposition).toBe("dispatch");
        const rejoined = openReviewCommentPublicationTransportResponseV1({ plan, context,
            response: await route({ userId: account.id, body: wire }, createReplyStub()) });
        expect(rejoined.disposition).toBe("reconcile");
        expect(rejoined.publicationPlanId).toBe(first.publicationPlanId);
    });

    it("keeps E2EE publication retries private in HTTP and durable claims and rejects stale Account material", async () => {
        const account = await db.account.create({ data: {
            id: "account-publication-private", ...e2eeAccountFields(71),
        }, select: { id: true } });
        const context = { accountId: account.id, mode: "e2ee" as const,
            material: { type: "dataKey" as const, machineKey: new Uint8Array(32).fill(72) } };
        const plan: ReviewCommentPublicationPlanV1 = {
            target: { providerId: "github", configuredAccountId: "private-account-canary",
                entryRef: { sourceId: "github", kindId: "pull-request", collisionScope: "private-repository-canary", entryId: "private-pr-canary" }, subtarget: null },
            baseRevision: "private-base-canary", headRevision: "private-head-canary", entries: [],
            verdict: { kind: "comment", body: "private-summary-canary" },
        };
        const route = getRouteHandler(registerDefaultRoutes(), "POST", "/v1/reviews/comments/publication/claim");
        const build = (input: Parameters<typeof buildReviewCommentPublicationTransportRequestV1>[0]["input"]) =>
            buildReviewCommentPublicationTransportRequestV1({ input, context, randomBytes: (length) => tweetnacl.randomBytes(length) });
        const firstWire = build(plan);
        const first = openReviewCommentPublicationTransportResponseV1({ plan, context,
            response: await route({ userId: account.id, body: firstWire }, createReplyStub()) });
        const failureWire = build({ ...plan, settlement: { dispatchToken: first.dispatchToken, result: {
            publicationPlanId: first.publicationPlanId, entries: [], verdict: { publicationCorrelationId: first.verdict!.publicationCorrelationId,
                outcome: { kind: "failed", code: "private-provider-error-canary", message: "private-provider-message-canary" } },
        } } });
        await route({ userId: account.id, body: failureWire }, createReplyStub());
        const retry = openReviewCommentPublicationTransportResponseV1({ plan, context,
            response: await route({ userId: account.id, body: firstWire }, createReplyStub()) });
        expect(retry.instructions.verdict).toBe("dispatch");
        expect(retry.priorResult?.verdict).toMatchObject({ outcome: { kind: "failed", code: "private-provider-error-canary" } });
        const publishedWire = build({ ...plan, settlement: { dispatchToken: retry.dispatchToken, result: {
            publicationPlanId: retry.publicationPlanId, entries: [], verdict: { publicationCorrelationId: retry.verdict!.publicationCorrelationId,
                outcome: { kind: "published", externalRef: "https://private-provider-canary/review/7" } },
        } } });
        await route({ userId: account.id, body: publishedWire }, createReplyStub());
        const rejoined = openReviewCommentPublicationTransportResponseV1({ plan, context,
            response: await route({ userId: account.id, body: firstWire }, createReplyStub()) });
        expect(rejoined.instructions.verdict).toBe("confirmed");
        expect(rejoined.priorResult?.verdict).toMatchObject({ outcome: { kind: "published", externalRef: "https://private-provider-canary/review/7" } });
        await expect(updateAccountEncryptionMode({ accountId: account.id, mode: "plain" }))
            .resolves.toMatchObject({ status: "migration_required" });
        expect((await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { encryptionMode: true } })).encryptionMode)
            .toBe("e2ee");
        const rows = await db.$queryRaw<Array<{ target_json: string; target_key: string }>>`
            SELECT target_json, target_key FROM review_comment_publication_correlations WHERE account_id = ${account.id}`;
        expect(rows).toHaveLength(1);
        const storedAndHttp = JSON.stringify([firstWire, failureWire, publishedWire, rows]);
        for (const canary of ["private-account-canary", "private-repository-canary", "private-pr-canary", "private-base-canary",
            "private-head-canary", "private-summary-canary", "private-provider-error-canary", "private-provider-message-canary", "private-provider-canary"]) {
            expect(storedAndHttp).not.toContain(canary);
        }
        const staleKeyWire = buildReviewCommentPublicationTransportRequestV1({ input: plan,
            context: { ...context, material: { type: "dataKey", machineKey: new Uint8Array(32).fill(73) } },
            randomBytes: (length) => tweetnacl.randomBytes(length) });
        const staleKeyReply = createReplyStub();
        await route({ userId: account.id, body: staleKeyWire }, staleKeyReply);
        expect(staleKeyReply.send).toHaveBeenCalledWith(expect.objectContaining({ error: "review_comment_encryption_mode_mismatch" }));
        const wrongModeReply = createReplyStub();
        await route({ userId: account.id, body: buildReviewCommentPublicationTransportRequestV1({ input: plan,
            context: { accountId: account.id, mode: "plain", material: null }, randomBytes: (length) => tweetnacl.randomBytes(length) }) }, wrongModeReply);
        expect(wrongModeReply.send).toHaveBeenCalledWith(expect.objectContaining({ error: "review_comment_encryption_mode_mismatch" }));
    });

    it("admits one concurrent retry and rejects a stale completion token", async () => {
        const account = await db.account.create({
            data: {
                id: "account-review-comment-publication-retry",
                publicKey: "pk-review-comment-publication-retry",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const create = getRouteHandler(registerDefaultRoutes(), "POST", "/v1/reviews/comments");
        const comment = ReviewCommentCreateResponseV1Schema.parse(await create({
            userId: account.id,
            body: {
                projectId: "project-1",
                anchor: { kind: "line", filePath: "src/retry.ts", line: 2 },
                snapshot: textSnapshot(),
                body: "Retry this comment.",
                clientMutationId: "mutation-publication-retry",
            },
        }, createReplyStub())).comment;
        let dispatchSequence = 0;
        const operations = createReviewCommentOperations(createSqlReviewCommentStore(), {
            now: () => 1234,
            createId: (prefix) => `${prefix}-${dispatchSequence += 1}`,
        });
        const request = {
            accountId: account.id,
            actor: { kind: "user", userId: account.id } as const,
            input: {
                target: {
                    providerId: "bitbucket",
                    configuredAccountId: "bitbucket-account-1",
                    entryRef: {
                        sourceId: "bitbucket",
                        kindId: "pull-request",
                        collisionScope: "bitbucket:repository-1",
                        entryId: "42",
                    },
                    subtarget: null,
                },
                baseRevision: "base-1",
                headRevision: "head-1",
                entries: [{
                    happierCommentId: comment.id,
                    expectedServerRevision: comment.serverRevision,
                    anchor: comment.anchor,
                    snapshot: textSnapshot(),
                    body: "Retry this comment.",
                }],
                verdict: null,
            },
        };
        const first = await claimReviewCommentPublication(operations, request);
        const failedResult = {
            publicationPlanId: first.publicationPlanId,
            entries: [{
                happierCommentId: first.entries[0]!.happierCommentId,
                publicationCorrelationId: first.entries[0]!.publicationCorrelationId,
                outcome: { kind: "failed" as const, code: "provider/rejected" },
            }],
            verdict: { kind: "notRequested" as const },
        };
        // Model an intervening edit at the real persistence boundary: a frozen
        // publication rejoin must not re-admit against the live revision.
        await db.$executeRaw`UPDATE review_comments SET server_revision = server_revision + 1
            WHERE account_id = ${account.id} AND id = ${comment.id}`;
        await expect(claimReviewCommentPublication(operations, request)).resolves.toMatchObject({
            disposition: "reconcile",
            publicationPlanId: first.publicationPlanId,
            instructions: { entries: ["reconcile"], verdict: null },
        });
        await claimReviewCommentPublication(operations, {
            ...request,
            input: { ...request.input, settlement: { dispatchToken: first.dispatchToken, result: failedResult } },
        });

        const concurrent = await Promise.all([
            claimReviewCommentPublication(operations, request),
            claimReviewCommentPublication(operations, request),
        ]);
        expect(concurrent.map((claim) => claim.disposition).sort()).toEqual(["dispatch", "reconcile"]);
        const active = concurrent.find((claim) => claim.disposition === "dispatch")!;
        expect(active.dispatchToken).not.toBe(first.dispatchToken);

        await expect(claimReviewCommentPublication(operations, {
            ...request,
            input: { ...request.input, settlement: { dispatchToken: first.dispatchToken, result: failedResult } },
        })).rejects.toMatchObject({ code: "review_comment_idempotency_conflict" });
        const afterStaleCompletion = await claimReviewCommentPublication(operations, request);
        expect(afterStaleCompletion).toMatchObject({ disposition: "reconcile", dispatchToken: null });
    });

    it("coalesces one frozen verdict plan while allowing a later verdict on the same head", async () => {
        const account = await db.account.create({
            data: {
                id: "account-review-verdict-publication",
                publicKey: "pk-review-verdict-publication",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const operations = createReviewCommentOperations(createSqlReviewCommentStore(), {
            now: () => 1234,
            createId: (prefix) => `${prefix}-unused`,
        });
        const request = {
            accountId: account.id,
            actor: { kind: "user", userId: account.id } as const,
            input: {
                target: {
                    providerId: "github",
                    configuredAccountId: "github-account-1",
                    entryRef: {
                        sourceId: "github",
                        kindId: "pull-request",
                        collisionScope: "github:repository-1",
                        entryId: "42",
                    },
                    subtarget: null,
                },
                baseRevision: "base-1",
                headRevision: "head-1",
                entries: [],
                verdict: { kind: "approve" as const, body: "Looks good." },
            },
        };

        const outcomes = await Promise.all([
            claimReviewCommentPublication(operations, request),
            claimReviewCommentPublication(operations, request),
        ]);

        expect(outcomes.map(({ disposition }) => disposition).sort())
            .toEqual(["dispatch", "reconcile"]);
        const laterVerdict = await claimReviewCommentPublication(operations, {
            ...request,
            input: {
                ...request.input,
                verdict: { kind: "requestChanges" as const, body: "Please revise this." },
            },
        });
        expect(laterVerdict.disposition).toBe("dispatch");
        expect(laterVerdict.publicationPlanId).not.toBe(outcomes[0]!.publicationPlanId);
        const [row] = await db.$queryRaw<Array<{ count: bigint }>>`
            SELECT COUNT(*) AS count FROM review_comment_publication_correlations
            WHERE account_id = ${account.id} AND comment_id IS NULL
        `;
        expect(Number(row?.count ?? 0)).toBe(2);
    });

    it("atomically replays concurrent and restarted creates by account-scoped client mutation", async () => {
        const account = await db.account.create({
            data: {
                id: "account-review-comments-idempotency",
                publicKey: "pk-review-comments-idempotency",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const body = {
            projectId: "project-1",
            runId: "run-1",
            engineId: "review-coderabbit",
            anchor: { kind: "line", filePath: "src/example.ts", line: 2 },
            snapshot: textSnapshot(),
            body: "Null-check this value.",
            clientMutationId: "mutation-create-concurrent",
        };

        const concurrent = await Promise.all(Array.from({ length: 8 }, () => {
            const create = getRouteHandler(registerDefaultRoutes(), "POST", "/v1/reviews/comments");
            return create({ userId: account.id, body }, createReplyStub());
        }));
        const parsed = concurrent.map((response) => ReviewCommentCreateResponseV1Schema.parse(response));

        expect(new Set(parsed.map((response) => response.comment.id)).size).toBe(1);
        expect(parsed.filter((response) => response.replayed === false)).toHaveLength(1);
        expect(parsed.filter((response) => response.replayed === true)).toHaveLength(7);

        const restartedCreate = getRouteHandler(registerDefaultRoutes(), "POST", "/v1/reviews/comments");
        const restartedReplay = ReviewCommentCreateResponseV1Schema.parse(await restartedCreate({
            userId: account.id,
            body,
        }, createReplyStub()));
        expect(restartedReplay).toEqual({ comment: parsed[0]!.comment, replayed: true });

        const rows = await db.$queryRaw<Array<{
            id: string;
            create_client_mutation_id: string | null;
            create_request_fingerprint: string | null;
        }>>`SELECT id, create_client_mutation_id, create_request_fingerprint FROM review_comments WHERE account_id = ${account.id}`;
        expect(rows).toEqual([expect.objectContaining({
            id: parsed[0]!.comment.id,
            create_client_mutation_id: body.clientMutationId,
            create_request_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        })]);
        expect(await db.reviewCommentEvent.count({
            where: { accountId: account.id, commentId: parsed[0]!.comment.id },
        })).toBe(1);

        const conflictReply = createReplyStub();
        const conflict = await restartedCreate({
            userId: account.id,
            body: { ...body, body: "Different immutable body." },
        }, conflictReply);
        expect(conflictReply.statusCode).toBe(409);
        expect(conflict).toMatchObject({ error: "review_comment_idempotency_conflict" });

        const caseDistinct = ReviewCommentCreateResponseV1Schema.parse(await restartedCreate({
            userId: account.id,
            body: {
                ...body,
                clientMutationId: body.clientMutationId.toUpperCase(),
            },
        }, createReplyStub()));
        expect(caseDistinct.replayed).toBe(false);
        expect(caseDistinct.comment.id).not.toBe(parsed[0]!.comment.id);
        expect(await db.reviewComment.count({ where: { accountId: account.id } })).toBe(2);
        expect(await db.reviewCommentEvent.count({ where: { accountId: account.id } })).toBe(2);

        const trailingSpaceDistinct = ReviewCommentCreateResponseV1Schema.parse(await restartedCreate({
            userId: account.id,
            body: {
                ...body,
                clientMutationId: `${body.clientMutationId} `,
            },
        }, createReplyStub()));
        expect(trailingSpaceDistinct.replayed).toBe(false);
        expect(trailingSpaceDistinct.comment.id).not.toBe(parsed[0]!.comment.id);
        expect(await db.reviewComment.count({ where: { accountId: account.id } })).toBe(3);
        expect(await db.reviewCommentEvent.count({ where: { accountId: account.id } })).toBe(3);
    });

    it("refuses a stale plain create after the Account transition commits E2EE before persistence", async () => {
        const binding = e2eeAccountFields(31);
        const account = await db.account.create({
            data: {
                id: "account-review-comments-transition-race",
                ...binding,
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const writerReachedPersistence = deferred();
        const releaseWriter = deferred();
        const sqlStore = createSqlReviewCommentStore();
        const latchedStore: ReviewCommentStore = {
            ...sqlStore,
            async create(params) {
                writerReachedPersistence.resolve();
                await releaseWriter.promise;
                return await sqlStore.create(params);
            },
        };
        let id = 0;
        const operations = createReviewCommentOperations(latchedStore, {
            now: () => 1_000,
            createId: (prefix) => `${prefix}-${++id}`,
        });
        const app = createFakeRouteApp();
        registerReviewCommentRoutes(app as any, { operations });
        const create = getRouteHandler(app, "POST", "/v1/reviews/comments");
        const reply = createReplyStub();
        const pendingCreate = create({
            userId: account.id,
            body: {
                projectId: "project-1",
                anchor: { kind: "file", filePath: "src/example.ts" },
                snapshot: textSnapshot(),
                body: "This stale plain write must not survive the transition.",
                clientMutationId: "mutation-transition-race",
            },
        }, reply);
        await writerReachedPersistence.promise;

        await inTx(async (tx) => {
            const fence = await acquireAccountEncryptionTransitionFenceInTx(
                tx,
                account.id,
            );
            expect(fence.status).toBe("ready");
            if (fence.status !== "ready") return;
            await applyAccountEncryptionTransitionInTx(tx, {
                accountId: account.id,
                expectedVersion: fence.account.version,
                toMode: "e2ee",
                contentKey: { kind: "preserve" },
            });
        });

        releaseWriter.resolve();
        await expect(pendingCreate).resolves.toMatchObject({
            error: "review_comment_encryption_mode_mismatch",
        });
        expect(reply.statusCode).toBe(400);
        await expect(db.reviewComment.count({
            where: { accountId: account.id },
        })).resolves.toBe(0);
        await expect(db.reviewCommentEvent.count({
            where: { accountId: account.id },
        })).resolves.toBe(0);
    });

    it("refuses an E2EE create when the Account key binding changes after route resolution", async () => {
        const originalBinding = e2eeAccountFields(41);
        const replacementBinding = e2eeAccountFields(43);
        const account = await db.account.create({
            data: {
                id: "account-review-comments-binding-race",
                ...originalBinding,
            },
            select: { id: true },
        });
        const writerReachedPersistence = deferred();
        const releaseWriter = deferred();
        const sqlStore = createSqlReviewCommentStore();
        const latchedStore: ReviewCommentStore = {
            ...sqlStore,
            async create(params) {
                writerReachedPersistence.resolve();
                await releaseWriter.promise;
                return await sqlStore.create(params);
            },
        };
        let id = 0;
        const operations = createReviewCommentOperations(latchedStore, {
            now: () => 2_000,
            createId: (prefix) => `${prefix}-${++id}`,
        });
        const app = createFakeRouteApp();
        registerReviewCommentRoutes(app as any, { operations });
        const create = getRouteHandler(app, "POST", "/v1/reviews/comments");
        const reply = createReplyStub();
        const pendingCreate = create({
            userId: account.id,
            body: {
                projectId: "project-1",
                anchor: { kind: "file", filePath: "src/example.ts" },
                snapshot: { t: "encrypted", c: "snapshot-ciphertext" },
                body: { t: "encrypted", c: "body-ciphertext" },
                eventEnvelope: { t: "encrypted", c: "event-ciphertext" },
                clientMutationId: "mutation-binding-race",
            },
        }, reply);
        await writerReachedPersistence.promise;

        await inTx(async (tx) => {
            const fence = await acquireAccountEncryptionTransitionFenceInTx(
                tx,
                account.id,
            );
            expect(fence.status).toBe("ready");
            await tx.account.update({
                where: { id: account.id },
                data: {
                    publicKey: replacementBinding.publicKey,
                    contentPublicKey: replacementBinding.contentPublicKey,
                    contentPublicKeySig: replacementBinding.contentPublicKeySig,
                },
            });
        });

        releaseWriter.resolve();
        await expect(pendingCreate).resolves.toMatchObject({
            error: "review_comment_encryption_mode_mismatch",
        });
        expect(reply.statusCode).toBe(400);
        await expect(db.reviewComment.count({
            where: { accountId: account.id },
        })).resolves.toBe(0);
        await expect(db.reviewCommentEvent.count({
            where: { accountId: account.id },
        })).resolves.toBe(0);
    });

    it("allows the same create client mutation in distinct accounts", async () => {
        const accounts = await Promise.all([
            db.account.create({
                data: { id: "account-review-comments-idempotency-a", publicKey: "pk-review-comments-idempotency-a", encryptionMode: "plain" },
                select: { id: true },
            }),
            db.account.create({
                data: { id: "account-review-comments-idempotency-b", publicKey: "pk-review-comments-idempotency-b", encryptionMode: "plain" },
                select: { id: true },
            }),
        ]);
        const create = getRouteHandler(registerDefaultRoutes(), "POST", "/v1/reviews/comments");
        const body = {
            projectId: "project-1",
            anchor: { kind: "file", filePath: "src/example.ts" },
            snapshot: textSnapshot(),
            body: "Account-local comment.",
            clientMutationId: "mutation-shared-across-accounts",
        };

        const created = await Promise.all(accounts.map((account) => create({
            userId: account.id,
            body,
        }, createReplyStub())));
        const parsed = created.map((response) => ReviewCommentCreateResponseV1Schema.parse(response));

        expect(parsed.map((response) => response.replayed)).toEqual([false, false]);
        expect(new Set(parsed.map((response) => response.comment.id)).size).toBe(2);
    });

    it("rolls back the comment when event persistence fails and permits a clean retry", async () => {
        const account = await db.account.create({
            data: {
                id: "account-review-comments-idempotency-rollback",
                publicKey: "pk-review-comments-idempotency-rollback",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const body = {
            projectId: "project-1",
            anchor: { kind: "file", filePath: "src/example.ts" },
            snapshot: textSnapshot(),
            body: "Rollback this attempted write.",
            clientMutationId: "mutation-create-rollback",
        };
        await db.$executeRawUnsafe(`
            CREATE TRIGGER fail_review_comment_event_insert
            BEFORE INSERT ON review_comment_events
            WHEN NEW.client_mutation_id = 'mutation-create-rollback'
            BEGIN
                SELECT RAISE(ABORT, 'forced review event failure');
            END
        `);

        const create = getRouteHandler(registerDefaultRoutes(), "POST", "/v1/reviews/comments");
        let failedCreate: unknown = null;
        try {
            await create({ userId: account.id, body }, createReplyStub());
        } catch (error) {
            failedCreate = error;
        } finally {
            await db.$executeRawUnsafe("DROP TRIGGER IF EXISTS fail_review_comment_event_insert");
        }
        expect(failedCreate).toBeInstanceOf(Error);
        expect(await db.reviewComment.count({ where: { accountId: account.id } })).toBe(0);
        expect(await db.reviewCommentEvent.count({ where: { accountId: account.id } })).toBe(0);

        const retried = ReviewCommentCreateResponseV1Schema.parse(await create({
            userId: account.id,
            body,
        }, createReplyStub()));
        expect(retried.replayed).toBe(false);
        expect(await db.reviewComment.count({ where: { accountId: account.id } })).toBe(1);
        expect(await db.reviewCommentEvent.count({ where: { accountId: account.id } })).toBe(1);
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
                projectId: "project-1",
                expectedState: "proposed",
                expectedServerRevision: 1,
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
        expect(JSON.parse(rows[0]!.body_envelope_json)).toMatchObject({ t: "plain", v: { sensitive: { body: transitioned.comment.body, snapshot: transitioned.comment.snapshot } } });
        expect(JSON.parse(rows[0]!.snapshot_envelope_json)).toEqual({ v: 1, layout: "review_comment_sensitive_in_body_v1" });

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
            v: 1,
            binding: {
                eventKind: "created",
                commentId: created.comment.id,
                accountId: account.id,
                clientMutationId: "mutation-create",
            },
            sensitive: {
                t: "plain",
                v: {
                    v: 1,
                    details: { comment: { id: created.comment.id } },
                },
            },
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
        });

        const reply = createReplyStub();
        const rejected = await create({
            userId: account.id,
            authAuthority: "present_user",
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

    it("requires matching current intent in addition to a signed principal and durable direct-write grant", async () => {
        const installationKeyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
        const account = await db.account.create({
            data: {
                id: "account-review-comments-trusted-grant",
                publicKey: "pk-review-comments-trusted-grant",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        await createTrustedMachineInstallation({
            accountId: account.id,
            machineId: "machine-review-comments-trusted-grant",
            installationId: "installation-review-comments-trusted-grant",
            keyPair: installationKeyPair,
        });
        const permissionMaterializationId = "materialization-review-comments-trusted-grant";
        await seedCurrentPermissionCaller({
            accountId: account.id,
            machineId: "machine-review-comments-trusted-grant",
            materializationId: permissionMaterializationId,
            pluginId: CODERABBIT_PLUGIN_ID,
        });
        const app = registerAllRoutes();
        expect(app.routes.has("POST /v1/plugins/permissions/grants/request")).toBe(true);

        const requestGrant = getRouteHandler(app, "POST", "/v1/plugins/permissions/grants/request");
        const grant = getRouteHandler(app, "POST", "/v1/plugins/permissions/grants/grant");
        const create = getRouteHandler(app, "POST", "/v1/reviews/comments");

        const requestGrantBody = {
            pluginId: CODERABBIT_PLUGIN_ID,
            capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
            targetScope: { kind: "project" as const, projectId: "project-1" },
            subject: GENERAL_PLUGIN_PERMISSION_SUBJECT_V1,
            reason: "Publish approved review comments directly.",
            requester: { kind: "plugin" as const, pluginId: CODERABBIT_PLUGIN_ID, sessionId: "session-1" },
            caller: {
                machineId: "machine-review-comments-trusted-grant",
                materializationId: permissionMaterializationId,
                pluginId: CODERABBIT_PLUGIN_ID,
            },
        };
        const requestReply = createReplyStub();
        const requested = PluginPermissionGrantRequestActionOutputV1Schema.parse(await requestGrant({
            userId: account.id,
            method: "POST",
            url: "/v1/plugins/permissions/grants/request",
            headers: {
                [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPluginInstallationPublisherHeader({
                    keyPair: installationKeyPair,
                    machineId: "machine-review-comments-trusted-grant",
                    installationId: "installation-review-comments-trusted-grant",
                    path: "/v1/plugins/permissions/grants/request",
                    body: requestGrantBody,
                }),
            },
            body: requestGrantBody,
        }, requestReply));
        expect(requested).toMatchObject({ pendingRequest: { pluginId: CODERABBIT_PLUGIN_ID } });
        expect(requestReply.statusCode).toBe(200);
        await grant({
            userId: account.id,
            authAuthority: "present_user",
            authTokenKind: "account",
            body: { requestId: requested.pendingRequest.id },
        }, createReplyStub());

        const missingIntentBody = {
            projectId: "project-1",
            anchor: { kind: "line" as const, filePath: "src/example.ts", line: 3 },
            snapshot: textSnapshot(),
            body: "This direct write has a durable grant but no current intent.",
            authorIntent: "open" as const,
            clientMutationId: "mutation-plugin-open-missing-current-intent",
        };
        const missingIntentHeader = createSignedPrincipalHeader({
            actor: { kind: "plugin", pluginId: CODERABBIT_PLUGIN_ID },
            keyPair: installationKeyPair,
            machineId: "machine-review-comments-trusted-grant",
            installationId: "installation-review-comments-trusted-grant",
            body: missingIntentBody,
            nonce: "nonce-missing-current-intent",
        });
        const missingIntentReply = createReplyStub();
        const missingIntent = await create({
            userId: account.id,
            authAuthority: "present_user",
            headers: { [REVIEW_COMMENT_PRINCIPAL_HEADER_V1]: missingIntentHeader },
            body: missingIntentBody,
        }, missingIntentReply);

        expect(missingIntentReply.statusCode).toBe(400);
        expect(missingIntent).toMatchObject({ error: "review_comment_permission_denied" });
        expect(await db.reviewComment.count({ where: { accountId: account.id } })).toBe(0);
        expect(await db.reviewCommentEvent.count({ where: { accountId: account.id } })).toBe(0);

        const createBody = {
            projectId: "project-1",
            workspaceId: "workspace-1",
            sessionId: "session-1",
            runId: "run-1",
            engineId: CODERABBIT_PLUGIN_ID,
            anchor: { kind: "line", filePath: "src/example.ts", line: 3 },
            snapshot: textSnapshot(),
            body: "Open this directly.",
            authorIntent: "open",
            clientMutationId: "mutation-plugin-open-trusted",
        };
        const currentIntent = createCurrentIntent({ pluginId: CODERABBIT_PLUGIN_ID, body: createBody });
        const principalHeader = createSignedPrincipalHeader({
            actor: { kind: "agent", agentId: "claude", sessionId: "session-1" },
            currentIntent,
            keyPair: installationKeyPair,
            machineId: "machine-review-comments-trusted-grant",
            installationId: "installation-review-comments-trusted-grant",
            body: createBody,
        });
        const created = ReviewCommentCreateResponseV1Schema.parse(await create({
            userId: account.id,
            authAuthority: "present_user",
            headers: { [REVIEW_COMMENT_PRINCIPAL_HEADER_V1]: principalHeader },
            body: createBody,
        }, createReplyStub()));

        expect(created.comment).toMatchObject({
            author: { kind: "agent", agentId: "claude", sessionId: "session-1" },
            state: "open",
            projectId: "project-1",
        });

        const tamperedBodyReply = createReplyStub();
        const tamperedBody = await create({
            userId: account.id,
            authAuthority: "present_user",
            headers: { [REVIEW_COMMENT_PRINCIPAL_HEADER_V1]: principalHeader },
            body: {
                ...createBody,
                body: "Tampered after the principal proof was signed.",
                clientMutationId: "mutation-plugin-open-tampered-body",
            },
        }, tamperedBodyReply);
        expect(tamperedBodyReply.statusCode).toBe(400);
        expect(tamperedBody).toMatchObject({ error: "review_comment_permission_denied" });

        const mismatchedIntentBody = {
            ...createBody,
            body: "This body has a fresh request signature but stale current intent.",
            clientMutationId: "mutation-plugin-open-stale-current-intent",
        };
        const mismatchedIntentHeader = createSignedPrincipalHeader({
            actor: { kind: "agent", agentId: "claude", sessionId: "session-1" },
            currentIntent,
            keyPair: installationKeyPair,
            machineId: "machine-review-comments-trusted-grant",
            installationId: "installation-review-comments-trusted-grant",
            body: mismatchedIntentBody,
            nonce: "nonce-stale-current-intent",
        });
        const mismatchedIntentReply = createReplyStub();
        const mismatchedIntent = await create({
            userId: account.id,
            authAuthority: "present_user",
            headers: { [REVIEW_COMMENT_PRINCIPAL_HEADER_V1]: mismatchedIntentHeader },
            body: mismatchedIntentBody,
        }, mismatchedIntentReply);
        expect(mismatchedIntentReply.statusCode).toBe(400);
        expect(mismatchedIntent).toMatchObject({ error: "review_comment_permission_denied" });

        const wrongPathReply = createReplyStub();
        const wrongPathHeader = createSignedPrincipalHeader({
            actor: { kind: "agent", agentId: "claude", sessionId: "session-1" },
            currentIntent,
            keyPair: installationKeyPair,
            machineId: "machine-review-comments-trusted-grant",
            installationId: "installation-review-comments-trusted-grant",
            path: "/v1/reviews/comments/wrong",
            body: createBody,
            nonce: "nonce-wrong-path",
        });
        const wrongPath = await create({
            userId: account.id,
            authAuthority: "present_user",
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
            workspaceId: "workspace-2",
            sessionId: "session-1",
            runId: "run-1",
            engineId: CODERABBIT_PLUGIN_ID,
            anchor: { kind: "line", filePath: "src/example.ts", line: 3 },
            snapshot: textSnapshot(),
            body: "Open this directly in another project.",
            authorIntent: "open",
            clientMutationId: "mutation-plugin-open-mismatch",
        };
        const mismatchPrincipalHeader = createSignedPrincipalHeader({
            actor: { kind: "agent", agentId: "claude", sessionId: "session-1" },
            currentIntent: createCurrentIntent({ pluginId: CODERABBIT_PLUGIN_ID, body: mismatchBody, fingerprintCharacter: "d" }),
            keyPair: installationKeyPair,
            machineId: "machine-review-comments-trusted-grant",
            installationId: "installation-review-comments-trusted-grant",
            body: mismatchBody,
            nonce: "nonce-2",
        });
        const mismatchReply = createReplyStub();
        const mismatch = await create({
            userId: account.id,
            authAuthority: "present_user",
            headers: { [REVIEW_COMMENT_PRINCIPAL_HEADER_V1]: mismatchPrincipalHeader },
            body: mismatchBody,
        }, mismatchReply);

        expect(mismatchReply.statusCode).toBe(400);
        expect(mismatch).toMatchObject({ error: "review_comment_direct_write_permission_required" });
    });

    it("stops trusting external direct-write grants after the exact machine installation is revoked", async () => {
        const installationKeyPair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
        const account = await db.account.create({
            data: {
                id: "account-review-comments-external-grant-projection",
                publicKey: "pk-review-comments-external-grant-projection",
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        await createTrustedMachineInstallation({
            accountId: account.id,
            machineId: "machine-review-comments-external-grant-projection",
            installationId: "installation-review-comments-external-grant-projection",
            keyPair: installationKeyPair,
        });
        const permissionMaterializationId = "materialization-review-comments-external-grant-projection";
        await seedCurrentPermissionCaller({
            accountId: account.id,
            machineId: "machine-review-comments-external-grant-projection",
            materializationId: permissionMaterializationId,
            pluginId: EXTERNAL_PLUGIN_ID,
        });
        const app = registerAllRoutes();
        const requestGrant = getRouteHandler(app, "POST", "/v1/plugins/permissions/grants/request");
        const grant = getRouteHandler(app, "POST", "/v1/plugins/permissions/grants/grant");
        const create = getRouteHandler(app, "POST", "/v1/reviews/comments");

        const requestGrantBody = {
            pluginId: EXTERNAL_PLUGIN_ID,
            capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
            targetScope: { kind: "project", projectId: "project-1" },
            subject: GENERAL_PLUGIN_PERMISSION_SUBJECT_V1,
            reason: "Publish approved review comments directly.",
            requester: { kind: "plugin" as const, pluginId: EXTERNAL_PLUGIN_ID, sessionId: "session-1" },
            caller: {
                machineId: "machine-review-comments-external-grant-projection",
                materializationId: permissionMaterializationId,
                pluginId: EXTERNAL_PLUGIN_ID,
            },
        };
        const requested = PluginPermissionGrantRequestActionOutputV1Schema.parse(await requestGrant({
            userId: account.id,
            method: "POST",
            url: "/v1/plugins/permissions/grants/request",
            headers: {
                [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPluginInstallationPublisherHeader({
                    keyPair: installationKeyPair,
                    machineId: "machine-review-comments-external-grant-projection",
                    installationId: "installation-review-comments-external-grant-projection",
                    path: "/v1/plugins/permissions/grants/request",
                    body: requestGrantBody,
                    nonce: "nonce-review-comments-external-grant-projection-request",
                }),
            },
            body: requestGrantBody,
        }, createReplyStub()));
        await grant({
            userId: account.id,
            authAuthority: "present_user",
            authTokenKind: "account",
            body: { requestId: requested.pendingRequest.id },
        }, createReplyStub());

        const firstBody = {
            projectId: "project-1",
            workspaceId: "workspace-1",
            sessionId: "session-1",
            runId: "run-1",
            engineId: EXTERNAL_PLUGIN_ID,
            anchor: { kind: "line", filePath: "src/example.ts", line: 3 },
            snapshot: textSnapshot(),
            body: "Open this directly before uninstall.",
            authorIntent: "open",
            clientMutationId: "mutation-plugin-open-external-before-delete",
        };
        const firstHeader = createSignedPrincipalHeader({
            actor: { kind: "agent", agentId: "claude", sessionId: "session-1" },
            currentIntent: createCurrentIntent({ pluginId: EXTERNAL_PLUGIN_ID, body: firstBody }),
            keyPair: installationKeyPair,
            machineId: "machine-review-comments-external-grant-projection",
            installationId: "installation-review-comments-external-grant-projection",
            body: firstBody,
        });
        const created = ReviewCommentCreateResponseV1Schema.parse(await create({
            userId: account.id,
            authAuthority: "present_user",
            headers: { [REVIEW_COMMENT_PRINCIPAL_HEADER_V1]: firstHeader },
            body: firstBody,
        }, createReplyStub()));
        expect(created.comment).toMatchObject({
            author: { kind: "agent", agentId: "claude", sessionId: "session-1" },
            state: "open",
        });

        await db.machine.update({
            where: {
                accountId_id: {
                    accountId: account.id,
                    id: "machine-review-comments-external-grant-projection",
                },
            },
            data: { revokedAt: new Date() },
        });
        const secondBody = {
            ...firstBody,
            body: "Open this directly after uninstall.",
            clientMutationId: "mutation-plugin-open-external-after-delete",
        };
        const secondHeader = createSignedPrincipalHeader({
            actor: { kind: "agent", agentId: "claude", sessionId: "session-1" },
            currentIntent: createCurrentIntent({ pluginId: EXTERNAL_PLUGIN_ID, body: secondBody, fingerprintCharacter: "d" }),
            keyPair: installationKeyPair,
            machineId: "machine-review-comments-external-grant-projection",
            installationId: "installation-review-comments-external-grant-projection",
            body: secondBody,
            nonce: "nonce-after-delete",
        });
        const deniedReply = createReplyStub();
        const denied = await create({
            userId: account.id,
            authAuthority: "present_user",
            headers: { [REVIEW_COMMENT_PRINCIPAL_HEADER_V1]: secondHeader },
            body: secondBody,
        }, deniedReply);
        expect(deniedReply.statusCode).toBe(400);
        expect(denied).toMatchObject({ error: "review_comment_permission_denied" });
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
        await createTrustedMachineInstallation({
            accountId: account.id,
            machineId: "machine-review-comments-projection-owner",
            installationId: "installation-review-comments-projection-owner",
            keyPair: projectionKeyPair,
        });
        await createTrustedMachineInstallation({
            accountId: account.id,
            machineId: "machine-review-comments-wrong-grant-caller",
            installationId: "installation-review-comments-wrong-grant-caller",
            keyPair: callerKeyPair,
        });
        const permissionMaterializationId = "materialization-review-comments-projection-owner";
        await seedCurrentPermissionCaller({
            accountId: account.id,
            machineId: "machine-review-comments-projection-owner",
            materializationId: permissionMaterializationId,
            pluginId: EXTERNAL_PLUGIN_ID,
        });
        const app = registerAllRoutes();
        const requestGrant = getRouteHandler(app, "POST", "/v1/plugins/permissions/grants/request");
        const grant = getRouteHandler(app, "POST", "/v1/plugins/permissions/grants/grant");
        const create = getRouteHandler(app, "POST", "/v1/reviews/comments");

        const requestGrantBody = {
            pluginId: EXTERNAL_PLUGIN_ID,
            capability: REVIEW_COMMENT_DIRECT_WRITE_SCOPE_V1,
            targetScope: { kind: "project" as const, projectId: "project-1" },
            subject: GENERAL_PLUGIN_PERMISSION_SUBJECT_V1,
            reason: "Publish approved review comments directly.",
            requester: { kind: "plugin" as const, pluginId: EXTERNAL_PLUGIN_ID, sessionId: "session-1" },
            caller: {
                machineId: "machine-review-comments-projection-owner",
                materializationId: permissionMaterializationId,
                pluginId: EXTERNAL_PLUGIN_ID,
            },
        };
        const requested = PluginPermissionGrantRequestActionOutputV1Schema.parse(await requestGrant({
            userId: account.id,
            method: "POST",
            url: "/v1/plugins/permissions/grants/request",
            headers: {
                [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPluginInstallationPublisherHeader({
                    keyPair: projectionKeyPair,
                    machineId: "machine-review-comments-projection-owner",
                    installationId: "installation-review-comments-projection-owner",
                    path: "/v1/plugins/permissions/grants/request",
                    body: requestGrantBody,
                }),
            },
            body: requestGrantBody,
        }, createReplyStub()));
        await grant({
            userId: account.id,
            authAuthority: "present_user",
            authTokenKind: "account",
            body: { requestId: requested.pendingRequest.id },
        }, createReplyStub());
        const createBody = {
            projectId: "project-1",
            workspaceId: "workspace-1",
            sessionId: "session-1",
            runId: "run-1",
            engineId: EXTERNAL_PLUGIN_ID,
            anchor: { kind: "line", filePath: "src/example.ts", line: 3 },
            snapshot: textSnapshot(),
            body: "This differently granted machine should not direct-write.",
            authorIntent: "open",
            clientMutationId: "mutation-plugin-open-external-wrong-machine",
        };
        const principalHeader = createSignedPrincipalHeader({
            actor: { kind: "agent", agentId: "claude", sessionId: "session-1" },
            currentIntent: createCurrentIntent({ pluginId: EXTERNAL_PLUGIN_ID, body: createBody, fingerprintCharacter: "e" }),
            keyPair: callerKeyPair,
            machineId: "machine-review-comments-wrong-grant-caller",
            installationId: "installation-review-comments-wrong-grant-caller",
            body: createBody,
        });
        const reply = createReplyStub();

        const denied = await create({
            userId: account.id,
            authAuthority: "present_user",
            headers: { [REVIEW_COMMENT_PRINCIPAL_HEADER_V1]: principalHeader },
            body: createBody,
        }, reply);

        expect(reply.statusCode).toBe(400);
        expect(denied).toMatchObject({ error: "review_comment_direct_write_permission_required" });
    });

    it("rejects obsolete split-cipher CRUD instead of retaining a second encrypted writer", async () => {
        const account = await db.account.create({
            data: {
                id: "account-review-comments-e2ee",
                ...e2eeAccountFields(20),
            },
            select: { id: true },
        });

        const create = getRouteHandler(registerDefaultRoutes(), "POST", "/v1/reviews/comments");
        const reply = createReplyStub();
        const denied = await create({
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
        }, reply);
        expect(reply.statusCode).toBe(400);
        expect(denied).toMatchObject({ error: "review_comment_encryption_mode_mismatch" });

        const rows = await db.$queryRaw<Array<{
            body_envelope_json: string;
            snapshot_envelope_json: string;
        }>>`SELECT body_envelope_json, snapshot_envelope_json FROM review_comments WHERE account_id = ${account.id}`;
        expect(rows).toHaveLength(0);

        const events = await db.$queryRaw<Array<{
            event_envelope_json: string;
        }>>`SELECT event_envelope_json FROM review_comment_events WHERE account_id = ${account.id}`;
        expect(events).toHaveLength(0);
    });

    it("reseals encrypted redaction rather than retaining the unredacted body ciphertext", async () => {
        const account = await db.account.create({
            data: {
                id: "account-review-comments-e2ee-redact",
                ...e2eeAccountFields(22),
            },
            select: { id: true },
        });

        const app = registerDefaultRoutes();
        await initEncrypt();
        const actor = { kind: "user", userId: account.id } as const;
        const context = { accountId: account.id, mode: "e2ee", material: { type: "dataKey", machineKey: new Uint8Array(32).fill(23) } } as const;
        const run = (actionId: ReviewCommentMutationActionIdV1, input: Record<string, unknown>) => executeReviewCommentTransportV1({ actionId, input, actor, context, randomBytes,
            request: async (request) => getRouteHandler(app, "POST", request.path)({ userId: account.id, authAuthority: "present_user", method: "POST", url: request.path, body: request.body }, createReplyStub()),
        });
        const created = ReviewCommentCreateResponseV1Schema.parse(await run("reviews.comments.create", {
                projectId: "project-1",
                anchor: { kind: "line", filePath: "src/example.ts", line: 2 },
                snapshot: textSnapshot(),
                body: "private unredacted body",
                clientMutationId: "mutation-create",
        }));
        const prior = await createSqlReviewCommentStore().getSource({ accountId: account.id, commentId: created.comment.id });

        const redacted = await run("reviews.comments.redact", {
                commentId: created.comment.id,
                projectId: "project-1",
                expectedServerRevision: 1,
                redactBody: true,
                clientMutationId: "mutation-redact",
        });

        expect(redacted).toMatchObject({
            comment: {
                id: created.comment.id,
                body: "",
                flags: { redacted: true },
            },
        });

        const rows = await db.$queryRaw<Array<{ body_envelope_json: string }>>`
            SELECT body_envelope_json FROM review_comments WHERE account_id = ${account.id}
        `;
        expect(rows).toHaveLength(1);
        const source = await createSqlReviewCommentStore().getSource({ accountId: account.id, commentId: created.comment.id });
        expect(source?.source).not.toEqual(prior?.source);
        expect(JSON.parse(rows[0]!.body_envelope_json)).toMatchObject({ t: "encrypted" });
    });

    it("rejects mixed envelope modes at durable review-comment write choke points", async () => {
        const account = await db.account.create({
            data: {
                id: "account-review-comments-e2ee-mixed",
                ...e2eeAccountFields(24),
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
