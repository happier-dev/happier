import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { acquireAccountSessionOwnerMetadataFenceInTx } from "@/app/encryption/accountSessionOwnerMetadataFence";
import {
    PLUGIN_ACCOUNT_STORAGE_KEY_PREFIX,
    PLUGIN_DECLARATIVE_SETTINGS_KEY_PREFIX,
} from "@/app/kv/accountScopedKv";
import {
    deriveAccountEncryptionMigrationKeyFingerprints,
} from "@/app/encryption/accountEncryptionTransition";
import { registerAccountEncryptionMigrateRoutes } from "./registerAccountEncryptionMigrateRoutes";
import { registerAccountSettingsRoutes } from "./registerAccountSettingsRoutes";
import {
    createProviderAccountUsageRecordKey,
    createUsageSnapshot,
} from "../connect/providerAccountUsageTestkit";
import { mutateConnectedServiceCredential } from "../connect/credentials/mutation";
import {
    mutateQualifiedConnectedServiceCredential,
} from "../connect/qualifiedConnectedAccounts/credentialRepository";
import {
    createQualifiedConnectedAccountGroup,
    createQualifiedConnectedAccountGroupMember,
    setQualifiedConnectedAccountGroupActiveAccount,
} from "../connect/qualifiedConnectedAccounts/groupRepository";
import {
    writeQualifiedProviderAccountUsageRecordFromLegacyBoundary,
    writeQualifiedProviderAccountUsageRecord,
} from "../connect/qualifiedConnectedAccounts/usageRepository";
import {
    resolveLegacyQualifiedConnectedAccountService,
} from "../connect/qualifiedConnectedAccounts/identity";
import {
    createLegacyCredentialFixtureIdentity,
} from "../connect/testkit/qualifiedConnectedAccountFixtureIdentity";
import { registerAutomationCrudRoutes } from "../automations/registerAutomationCrudRoutes";
import tweetnacl from "tweetnacl";
import * as privacyKit from "privacy-kit";
import {
    ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATIONS_MAX_ITEMS,
    attachAccountEncryptionMigrateProofSignatureV1,
    ARTIFACT_PLAIN_DATA_KEY_MARKER,
    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    buildAccountStoredContentCompatibilityHttpHeadersV1,
    computeAccountEncryptionMigrateKeyFingerprintV1,
    createAccountEncryptionMigrateProofSigningInputV1,
    deriveAutomationOccurrenceKeyV1,
    encodePlainArtifactStoredContent,
    encodeSessionOwnerMetadataEnvelopeV1,
    bindReviewCommentEventSensitiveEnvelopeV1,
    sealReviewCommentEventSensitiveEnvelopeV1,
    sealReviewCommentSensitiveEnvelopeV1,
    sealAccountScopedBlobCiphertext,
    AutomationSourceSelectorIdV1Schema,
    sealAutomationTriggerDefinitionStoredEnvelopeV1,
    splitReviewCommentV1,
    type AccountEncryptionMigrateRequest,
    type AccountEncryptionMigrateUnsignedRequest,
    type ReviewCommentEventV1,
    type ReviewCommentV1,
} from "@happier-dev/protocol";
import { enableErrorHandlers } from "@/app/api/utils/enableErrorHandlers";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import {
    captureAccountStoredContentCompatibilityForHttpRequest,
} from "@/app/clientCompatibility/accountStoredContentCompatibility";
import {
    REVIEW_COMMENT_CANONICAL_SENSITIVE_LAYOUT_MARKER_JSON,
    createReviewCommentAccountEncryptionMigrationPersistenceInTx,
} from "@/app/reviews/comments/accountEncryptionMigrationPersistence";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";

import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

const SESSION_OWNER_MATERIAL = {
    type: "legacy",
    secret: new Uint8Array(32).fill(23),
} as const;
const AUTOMATION_TRIGGER_DEFINITION_MATERIAL = {
    type: "legacy",
    secret: new Uint8Array(32).fill(29),
} as const;
const ROUTE_PLUGIN_EVENT_SOURCE_SELECTOR_ID =
    AutomationSourceSelectorIdV1Schema.parse(
        "8a2e26d2-5b2b-4e9b-a57f-68ca5e575dc7",
    );

const FAE505_ACCOUNT_ENCRYPTION_MIGRATE_BAD_REQUEST_READER =
    z.discriminatedUnion("error", [
        z.object({
            error: z.literal("invalid-params"),
            reason: z
                .enum(["restore_required", "key_proof_required"])
                .optional(),
        }).strict(),
        z.object({
            error: z.literal("connected_services_not_empty"),
        }).strict(),
        z.object({
            error: z.literal("automations_not_empty"),
        }).strict(),
    ]);

function encodePlainStoredJson(value: unknown): string {
    return Buffer.from(
        JSON.stringify({ t: "plain", v: value }),
        "utf8",
    ).toString("base64");
}

const CONVERSATION_OWNER_REF = {
    pluginId: "happier.channels",
    localId: "provider/observation-ingest-v1",
} as const;

function encodeConversationTriggerDefinitionEnvelope(params: Readonly<{
    automationId: string;
    templateVersion: number;
    mode: "plain" | "e2ee";
}>): string {
    const binding = {
        v: 1 as const,
        automationId: params.automationId,
        templateVersion: params.templateVersion,
        triggerKind: "conversation" as const,
        eventRef: null,
        sourceSelectorId: null,
    };
    const definition = {
        v: 1,
        bindingId: "route-account-encryption-conversation",
        owner: CONVERSATION_OWNER_REF,
    };
    return JSON.stringify(params.mode === "plain"
        ? sealAutomationTriggerDefinitionStoredEnvelopeV1({
            mode: "plain",
            binding,
            definition,
        })
        : sealAutomationTriggerDefinitionStoredEnvelopeV1({
            mode: "e2ee",
            binding,
            definition,
            material: AUTOMATION_TRIGGER_DEFINITION_MATERIAL,
            randomBytes: (length) => new Uint8Array(length).fill(3),
        }));
}

function encodePluginEventTriggerDefinitionEnvelope(params: Readonly<{
    automationId: string;
    templateVersion: number;
    mode: "plain" | "e2ee";
}>): string {
    const binding = {
        v: 1 as const,
        automationId: params.automationId,
        templateVersion: params.templateVersion,
        triggerKind: "pluginEvent" as const,
        eventRef: {
            pluginId: "com.example.github",
            localId: "repository-event",
        },
        sourceSelectorId: ROUTE_PLUGIN_EVENT_SOURCE_SELECTOR_ID,
    };
    const definition = {
        v: 1,
        sourceInstanceId: "route-account-encryption-source",
        sourceConfig: { repositoryId: 42 },
        filter: null,
        maximumObservationAgeMs: null,
    };
    return JSON.stringify(params.mode === "plain"
        ? sealAutomationTriggerDefinitionStoredEnvelopeV1({
            mode: "plain",
            binding,
            definition,
        })
        : sealAutomationTriggerDefinitionStoredEnvelopeV1({
            mode: "e2ee",
            binding,
            definition,
            material: AUTOMATION_TRIGGER_DEFINITION_MATERIAL,
            randomBytes: (length) => new Uint8Array(length).fill(3),
        }));
}

function sealOwnerMetadata(marker: string): string {
    return sealAccountScopedBlobCiphertext({
        kind: "session_owner_metadata",
        material: SESSION_OWNER_MATERIAL,
        payload: { v: 1, marker },
        randomBytes: (length) =>
            new Uint8Array(length).fill(marker.charCodeAt(0)),
    });
}

function createSignedContentKeyBinding(
    signingSecretKey: Uint8Array,
): Readonly<{
    contentPublicKey: string;
    contentPublicKeySig: string;
    contentPublicKeyBytes: Uint8Array<ArrayBuffer>;
    contentPublicKeySigBytes: Uint8Array<ArrayBuffer>;
}> {
    const contentKey = tweetnacl.box.keyPair();
    const binding = Buffer.concat([
        Buffer.from("Happy content key v1\u0000", "utf8"),
        Buffer.from(contentKey.publicKey),
    ]);
    const signature = tweetnacl.sign.detached(binding, signingSecretKey);
    return {
        contentPublicKey: privacyKit.encodeBase64(
            new Uint8Array(contentKey.publicKey),
        ),
        contentPublicKeySig: privacyKit.encodeBase64(
            new Uint8Array(signature),
        ),
        contentPublicKeyBytes: new Uint8Array(contentKey.publicKey),
        contentPublicKeySigBytes: new Uint8Array(signature),
    };
}

function signPlainToE2eeMigrationRequest(params: Readonly<{
    accountId: string;
    signingSecretKey: Uint8Array;
    request: AccountEncryptionMigrateUnsignedRequest;
}>): AccountEncryptionMigrateRequest {
    const signingInput =
        createAccountEncryptionMigrateProofSigningInputV1({
            request: params.request,
            accountId: params.accountId,
            sourceMode: "plain",
        });
    return attachAccountEncryptionMigrateProofSignatureV1({
        request: params.request,
        signature: privacyKit.encodeBase64(
            new Uint8Array(
                tweetnacl.sign.detached(
                    signingInput,
                    params.signingSecretKey,
                ),
            ),
        ),
    });
}

async function createAmendment9PopulatedMigrationFixture(
    accountId: string,
    sourceMode: "plain" | "e2ee" = "e2ee",
) {
    const targetMode = sourceMode === "e2ee" ? "plain" : "e2ee";
    const commentId =
        `comment-amendment9-${randomKeyNaked(8)}`;
    const comment: ReviewCommentV1 = {
        v: 1,
        id: commentId,
        accountId,
        projectId: "project-amendment9",
        workspaceId: "workspace-amendment9",
        anchor: {
            kind: "line",
            filePath: "src/private.ts",
            line: 7,
            side: "after",
        },
        snapshot: {
            kind: "text",
            selectedLines: ["private snapshot"],
            beforeContext: ["private context before"],
            afterContext: ["private context after"],
            selectedLinesHash: "selected-hash",
            contextWindowHash: "context-hash",
            capturedAt: 1_000,
            fileLength: 3,
            source: "workingTree",
            isUncommitted: true,
            isUntracked: false,
            truncated: false,
            hasBidiControls: false,
            likelyMinified: false,
        },
        body: "private body",
        bodyVersion: 2,
        edits: [{
            editId: "edit-amendment9",
            previousBody: "old private body",
            nextBody: "private body",
            reason: "private edit reason",
            editedAt: 1_100,
            editedBy: {
                kind: "user",
                userId: "user-amendment9",
            },
        }],
        author: {
            kind: "user",
            userId: "user-amendment9",
        },
        state: "resolved",
        flags: {},
        dispositions: {},
        threadId: commentId,
        evidence: [{
            kind: "reasoning",
            message: "private evidence",
        }],
        transitions: [{
            transitionId: "transition-amendment9",
            fromState: "open",
            toState: "resolved",
            transitionedAt: 1_100,
            transitionedBy: {
                kind: "user",
                userId: "user-amendment9",
            },
            reason: "private transition reason",
            serverRevision: 2,
        }],
        fingerprint: {
            normalizedMessageHash: "public-dedupe-hash",
            ruleId: "private-source-hash",
        },
        linkedRefs: [{
            kind: "external",
            url: "https://private.example/review",
        }],
        suggestedFix: {
            kind: "replacement",
            replacementText: "private replacement",
        },
        metadata: {
            severity: "error",
            taxonomyIds: ["private-taxonomy"],
            tags: ["private-tag"],
        },
        createdAt: 1_000,
        updatedAt: 1_100,
        serverRevision: 2,
    };
    const event: ReviewCommentEventV1 = {
        eventId: `event-amendment9-${randomKeyNaked(8)}`,
        commentId: comment.id,
        accountId,
        projectId: comment.projectId,
        eventKind: "edited",
        actor: comment.author,
        bulkActionId: "bulk-amendment9",
        authorDeviceId: "device-amendment9",
        clientLamport: 4,
        serverRevision: 2,
        createdAt: 1_100,
        event: {
            clientMutationId: "mutation-amendment9",
            reason: "private event detail",
        },
    };
    await db.reviewComment.create({
        data: {
            id: comment.id,
            accountId,
            projectId: comment.projectId,
            workspaceId: comment.workspaceId,
            threadId: comment.threadId,
            state: comment.state,
            flagsJson: JSON.stringify(comment.flags),
            anchorJson: JSON.stringify(comment.anchor),
            anchorFilePath:
                "filePath" in comment.anchor
                    ? comment.anchor.filePath
                    : null,
            snapshotEnvelopeJson: JSON.stringify(
                sourceMode === "e2ee"
                    ? {
                        t: "encrypted",
                        c: "legacy-snapshot-ciphertext",
                    }
                    : { t: "plain", v: comment.snapshot },
            ),
            bodyEnvelopeJson: JSON.stringify(
                sourceMode === "e2ee"
                    ? {
                        t: "encrypted",
                        c: "legacy-body-ciphertext",
                    }
                    : { t: "plain", v: comment.body },
            ),
            bodyVersion: comment.bodyVersion,
            authorJson: JSON.stringify(comment.author),
            editsJson: JSON.stringify(
                sourceMode === "e2ee"
                    ? comment.edits.map((edit) => ({
                        ...edit,
                        previousBody: {
                            t: "encrypted",
                            c: "legacy-previous-body-ciphertext",
                        },
                        nextBody: {
                            t: "encrypted",
                            c: "legacy-next-body-ciphertext",
                        },
                    }))
                    : comment.edits,
            ),
            dispositionsJson: JSON.stringify(
                comment.dispositions,
            ),
            evidenceJson: JSON.stringify(comment.evidence),
            transitionsJson: JSON.stringify(
                comment.transitions,
            ),
            fingerprintJson: JSON.stringify(comment.fingerprint),
            linkedRefsJson: JSON.stringify(comment.linkedRefs),
            suggestedFixJson: JSON.stringify(
                comment.suggestedFix,
            ),
            metadataJson: JSON.stringify(comment.metadata),
            serverRevision: comment.serverRevision,
            createdAt: BigInt(comment.createdAt),
            updatedAt: BigInt(comment.updatedAt),
        },
    });
    await db.reviewCommentEvent.create({
        data: {
            eventId: event.eventId,
            commentId: comment.id,
            accountId,
            projectId: comment.projectId,
            eventKind: event.eventKind,
            eventEnvelopeJson: JSON.stringify(
                sourceMode === "e2ee"
                    ? {
                        t: "encrypted",
                        c: "legacy-event-ciphertext",
                    }
                    : { t: "plain", v: event.event },
            ),
            bulkActionId: event.bulkActionId,
            clientMutationId:
                event.event.clientMutationId as string,
            actorJson: JSON.stringify(event.actor),
            authorDeviceId: event.authorDeviceId,
            clientLamport: BigInt(event.clientLamport ?? 0),
            serverRevision: event.serverRevision,
            createdAt: BigInt(event.createdAt),
        },
    });
    const split = splitReviewCommentV1(comment);
    const targetSensitiveEnvelope =
        targetMode === "plain"
            ? sealReviewCommentSensitiveEnvelopeV1({
                structural: split.structural,
                sensitive: split.sensitive,
                mode: "plain",
            })
            : {
                t: "encrypted" as const,
                c: "canonical-review-target-ciphertext",
            };
    const inventory = await inTx(async (tx) =>
        await createReviewCommentAccountEncryptionMigrationPersistenceInTx(
            tx,
        ).readInventory(accountId)
    );
    expect(inventory).toHaveLength(1);
    expect(inventory[0]!.events).toHaveLength(1);
    const storedEvent = inventory[0]!.events[0]!;
    const requestBinding = storedEvent.sensitiveEnvelope.binding.requestBinding;
    const targetEventSensitiveEnvelope =
        bindReviewCommentEventSensitiveEnvelopeV1({
            event: storedEvent.event,
            requestBinding,
            sensitive:
                targetMode === "plain"
                    ? sealReviewCommentEventSensitiveEnvelopeV1({
                    mode: "plain",
                    payload: {
                        v: 1,
                        requestBinding,
                        details: event.event,
                    },
                })
                    : {
                        t: "encrypted",
                        c: "canonical-event-target-ciphertext",
                    },
        });
    const folderSourceDisplay = sourceMode === "e2ee"
        ? {
            t: "encrypted" as const,
            c: "folder-source-ciphertext",
        }
        : {
            t: "plain" as const,
            v: { name: "Private folder" },
        };
    const tagSourceDisplay = sourceMode === "e2ee"
        ? {
            t: "encrypted" as const,
            c: "tag-source-ciphertext",
        }
        : {
            t: "plain" as const,
            v: { name: "Private tag" },
        };
    const labelSourceDisplay = sourceMode === "e2ee"
        ? {
            t: "encrypted" as const,
            c: "label-source-ciphertext",
        }
        : {
            t: "plain" as const,
            v: { name: "Private label" },
        };
    const folder = await db.sessionOrganizationFolder.create({
        data: {
            id: `folder-amendment9-${randomKeyNaked(8)}`,
            accountId,
            folderKey: "folder-amendment9",
            folderHash: `folder-hash-${randomKeyNaked(8)}`,
            displayDbValue: JSON.stringify(folderSourceDisplay),
        },
    });
    const tag = await db.sessionOrganizationTag.create({
        data: {
            id: `tag-amendment9-${randomKeyNaked(8)}`,
            accountId,
            tagKey: "tag-amendment9",
            tagHash: `tag-hash-${randomKeyNaked(8)}`,
            archivedAt: new Date(1_200),
            displayDbValue: JSON.stringify(tagSourceDisplay),
        },
    });
    const label = await db.sessionOrganizationLabel.create({
        data: {
            id: `label-amendment9-${randomKeyNaked(8)}`,
            accountId,
            labelKind: "workspace",
            scopeKey: "workspace-amendment9",
            scopeHash: `label-hash-${randomKeyNaked(8)}`,
            displayDbValue: JSON.stringify(labelSourceDisplay),
        },
    });
    await db.sessionOrganizationCheckpoint.create({
        data: {
            accountId,
            version: 5,
        },
    });
    return {
        comment,
        event,
        folder,
        tag,
        label,
        reviewComments: {
            action: "migrate" as const,
            items: [{
                commentId: comment.id,
                expectedServerRevision:
                    inventory[0]!.serverRevision,
                expectedBodyVersion:
                    inventory[0]!.bodyVersion,
                expectedSensitiveSource:
                    inventory[0]!.sensitiveSource,
                targetSensitiveEnvelope,
                events: [{
                    eventId: storedEvent.event.eventId,
                    expectedSensitiveEnvelope:
                        storedEvent.sensitiveEnvelope,
                    targetSensitiveEnvelope:
                        targetEventSensitiveEnvelope,
                }],
            }],
        },
        sessionOrganization: {
            action: "migrate" as const,
            expectedVersion: 5,
            folders: [{
                folderId: folder.id,
                expectedDisplay: folderSourceDisplay,
                display: targetMode === "plain"
                    ? {
                        t: "plain" as const,
                        v: { name: "Private folder" },
                    }
                    : {
                        t: "encrypted" as const,
                        c: "folder-target-ciphertext",
                    },
            }],
            tags: [{
                tagId: tag.id,
                expectedDisplay: tagSourceDisplay,
                display: targetMode === "plain"
                    ? {
                        t: "plain" as const,
                        v: { name: "Private tag" },
                    }
                    : {
                        t: "encrypted" as const,
                        c: "tag-target-ciphertext",
                    },
            }],
            labels: [{
                labelKind: label.labelKind as "workspace",
                scopeKey: label.scopeKey,
                expectedDisplay: labelSourceDisplay,
                display: targetMode === "plain"
                    ? {
                        t: "plain" as const,
                        v: { name: "Private label" },
                    }
                    : {
                        t: "encrypted" as const,
                        c: "label-target-ciphertext",
                    },
            }],
        },
    };
}

async function createAccountMigrationSessionGuardFixture(params: Readonly<{
    archivedAt: Date | null;
    metadataLayoutVersion: number;
    ownerMetadata?: string | null;
}>) {
    const account = await db.account.create({
        data: {
            ...createSignedAccountContentBinding(),
            encryptionMode: "e2ee",
            settings: "ciphertext",
            settingsVersion: 0,
        },
        select: { id: true },
    });
    const session = await db.session.create({
        data: {
            accountId: account.id,
            tag: `layout-${params.metadataLayoutVersion}-${params.archivedAt ? "archived" : "active"}`,
            metadata: "shared-before-migration",
            metadataVersion: 1,
            metadataLayoutVersion: params.metadataLayoutVersion,
            ownerMetadata: params.ownerMetadata === undefined
                ? params.metadataLayoutVersion === 0
                    ? null
                    : sealOwnerMetadata("current-owner")
                : params.ownerMetadata,
            agentState: null,
            agentStateVersion: 2,
            archivedAt: params.archivedAt,
        },
        select: {
            id: true,
            metadata: true,
            metadataVersion: true,
            metadataLayoutVersion: true,
            ownerMetadata: true,
            agentState: true,
            agentStateVersion: true,
            archivedAt: true,
        },
    });
    await db.serviceAccountToken.create({
        data: {
            accountId: account.id,
            vendor: "anthropic",
            profileId: "default",
            ...createLegacyCredentialFixtureIdentity({
                serviceId: "anthropic",
                profileId: "default",
            }),
            token: new TextEncoder().encode("sealed-before-migration"),
        },
    });
    const automation = await db.automation.create({
        data: {
            accountId: account.id,
            name: "migration-owned automation",
            scheduleKind: "interval",
            everyMs: 60_000,
            timezone: null,
            scheduleExpr: null,
            targetType: "new_session",
            templateCiphertext: "automation-before-migration",
        },
        select: { id: true },
    });
    return { account, automation, session };
}

const { emitUpdate } = vi.hoisted(() => ({
    emitUpdate: vi.fn(),
}));

async function expectAccountMigrationGuardRefusalLeavesFixtureUnchanged(
    fixture: Awaited<
        ReturnType<typeof createAccountMigrationSessionGuardFixture>
    >,
): Promise<void> {
    await expect(db.account.findUnique({
        where: { id: fixture.account.id },
        select: {
            encryptionMode: true,
            settings: true,
            settingsVersion: true,
        },
    })).resolves.toEqual({
        encryptionMode: "e2ee",
        settings: "ciphertext",
        settingsVersion: 0,
    });
    await expect(db.serviceAccountToken.count({
        where: { accountId: fixture.account.id },
    })).resolves.toBe(1);
    await expect(db.automation.findUnique({
        where: { id: fixture.automation.id },
        select: { templateCiphertext: true },
    })).resolves.toEqual({
        templateCiphertext: "automation-before-migration",
    });
    await expect(db.session.findUnique({
        where: { id: fixture.session.id },
        select: {
            id: true,
            metadata: true,
            metadataVersion: true,
            metadataLayoutVersion: true,
            ownerMetadata: true,
            agentState: true,
            agentStateVersion: true,
            archivedAt: true,
        },
    })).resolves.toEqual(fixture.session);
    await expect(db.accountChange.count({
        where: { accountId: fixture.account.id },
    })).resolves.toBe(0);
    expect(emitUpdate).not.toHaveBeenCalled();
}

vi.mock("@/app/events/eventRouter", async () => {
    const actual = await vi.importActual<typeof import("@/app/events/eventRouter")>("@/app/events/eventRouter");
    return {
        ...actual,
        eventRouter: { emitUpdate },
    };
});

function createTestApp(options: Readonly<{
    accountStoredContentCaller?: "current" | "legacy";
}> = {}) {
    const app = Fastify({
        logger: false,
        bodyLimit: 1024 * 1024 * 100,
    });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;

    typed.decorate("authenticate", async (request: any, reply: any) => {
        const userId = request.headers["x-test-user-id"];
        if (typeof userId !== "string" || !userId) {
            return reply.code(401).send({ error: "Unauthorized" });
        }
        request.userId = userId;
        if (options.accountStoredContentCaller !== "legacy") {
            Object.assign(
                request.headers,
                buildAccountStoredContentCompatibilityHttpHeadersV1(
                    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
                ),
            );
        }
        captureAccountStoredContentCompatibilityForHttpRequest(request);
    });
    typed.addHook("preValidation", async (request: any) => {
        if (
            request.method === "POST"
            && request.url === "/v1/account/encryption/migrate"
            && request.body
            && typeof request.body === "object"
            && "machines" in request.body
        ) {
            // Mechanical migration of older current-request fixtures. Protocol
            // schema tests own proof that production callers must send this.
            request.body.sessions ??= { action: "assert_empty" };
            request.body.reviewComments ??= { action: "assert_empty" };
            request.body.sessionOrganization ??= {
                action: "assert_empty",
            };
            request.body.pets ??= { action: "assert_empty" };
        }
        if (
            request.method !== "POST"
            || request.url !== "/v1/account/encryption/migrate"
            || !request.body
            || typeof request.body !== "object"
            || !("machines" in request.body)
            || "expectedAccountVersion" in request.body
        ) {
            return;
        }
        const accountId = request.headers["x-test-user-id"];
        if (typeof accountId !== "string") return;
        const account = await db.account.findUniqueOrThrow({
            where: { id: accountId },
            select: {
                seq: true,
                publicKey: true,
                contentPublicKey: true,
            },
        });
        Object.assign(request.body, {
            expectedAccountVersion: account.seq,
            ...deriveAccountEncryptionMigrationKeyFingerprints(account),
        });
        request.body.expectedSigningKeyFingerprint =
            request.body.signingKeyFingerprint;
        request.body.expectedContentKeyFingerprint =
            request.body.contentKeyFingerprint;
        delete request.body.signingKeyFingerprint;
        delete request.body.contentKeyFingerprint;
    });
    enableErrorHandlers(typed);

    return typed;
}

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function installAccountModeReadBarrier(accountId: string): Readonly<{
    modeObserved: Promise<void>;
    release: () => void;
    restore: () => void;
}> {
    const modeObserved = deferred();
    const releaseRead = deferred();
    let paused = false;
    const mutableDb = db as any;
    const accountDelegate = mutableDb.account;
    const originalFindUnique = accountDelegate.findUnique;

    accountDelegate.findUnique = async (args: unknown) => {
        const result = await originalFindUnique.call(accountDelegate, args);
        const query = args as { where?: { id?: string }; select?: { encryptionMode?: boolean } } | undefined;
        if (!paused && query?.where?.id === accountId && query.select?.encryptionMode === true) {
            paused = true;
            modeObserved.resolve();
            await releaseRead.promise;
        }
        return result;
    };

    return {
        modeObserved: modeObserved.promise,
        release: releaseRead.resolve,
        restore: () => {
            releaseRead.resolve();
            accountDelegate.findUnique = originalFindUnique;
        },
    };
}

function installAccountTransitionCommitFailure(params: Readonly<{
    accountId: string;
    serviceId: string;
    profileId: string;
    automationId: string;
    reviewCommentId: string;
    organizationFolderId: string;
}>): Readonly<{
    observedBeforeAccountUpdate: Promise<Readonly<{
        credentialToken: Uint8Array;
        automationTemplate: string;
        automationTriggerDefinition: string | null;
        reviewCommentBodyEnvelopeJson: string;
        organizationFolderDisplayDbValue: string | null;
    }>>;
    restore: () => void;
}> {
    let resolveObserved!: (
        value: Readonly<{
            credentialToken: Uint8Array;
            automationTemplate: string;
            automationTriggerDefinition: string | null;
            reviewCommentBodyEnvelopeJson: string;
            organizationFolderDisplayDbValue: string | null;
        }>,
    ) => void;
    const observedBeforeAccountUpdate = new Promise<Readonly<{
        credentialToken: Uint8Array;
        automationTemplate: string;
        automationTriggerDefinition: string | null;
        reviewCommentBodyEnvelopeJson: string;
        organizationFolderDisplayDbValue: string | null;
    }>>((resolve) => {
        resolveObserved = resolve;
    });
    const mutableDb = db as any;
    const originalTransaction = mutableDb.$transaction;

    mutableDb.$transaction = async (operation: unknown, options: unknown) => {
        if (typeof operation !== "function") {
            return await originalTransaction.call(
                mutableDb,
                operation,
                options,
            );
        }
        return await originalTransaction.call(
            mutableDb,
            async (tx: any) => {
                const accountDelegate = tx.account;
                const originalAccountUpdateMany =
                    accountDelegate.updateMany.bind(accountDelegate);
                const wrappedAccountDelegate = new Proxy(accountDelegate, {
                    get(target, property, receiver) {
                        if (property !== "updateMany") {
                            return Reflect.get(
                                target,
                                property,
                                receiver,
                            );
                        }
                        return async (args: unknown) => {
                            const update = args as {
                                where?: { id?: string };
                                data?: { encryptionMode?: unknown };
                            };
                            if (
                                update.where?.id !== params.accountId
                                || update.data?.encryptionMode === undefined
                            ) {
                                return await originalAccountUpdateMany(args);
                            }
                            const [
                                credential,
                                automation,
                                reviewComment,
                                organizationFolder,
                            ] = await Promise.all([
                                tx.serviceAccountToken
                                    .findUniqueOrThrow({
                                        where: {
                                            accountId_vendor_profileId: {
                                                accountId:
                                                    params.accountId,
                                                vendor:
                                                    params.serviceId,
                                                profileId:
                                                    params.profileId,
                                            },
                                        },
                                        select: { token: true },
                                    }),
                                tx.automation.findUniqueOrThrow({
                                    where: {
                                        id: params.automationId,
                                    },
                                    select: {
                                        templateCiphertext: true,
                                        triggerDefinitionEnvelope: true,
                                    },
                                }),
                                tx.reviewComment.findUniqueOrThrow({
                                    where: {
                                        id: params.reviewCommentId,
                                    },
                                    select: {
                                        bodyEnvelopeJson: true,
                                    },
                                }),
                                tx.sessionOrganizationFolder
                                    .findUniqueOrThrow({
                                        where: {
                                            id:
                                                params
                                                    .organizationFolderId,
                                        },
                                        select: {
                                            displayDbValue: true,
                                        },
                                    }),
                            ]);
                            resolveObserved({
                                credentialToken:
                                    new Uint8Array(credential.token),
                                automationTemplate:
                                    automation.templateCiphertext,
                                automationTriggerDefinition:
                                    automation.triggerDefinitionEnvelope,
                                reviewCommentBodyEnvelopeJson:
                                    reviewComment.bodyEnvelopeJson,
                                organizationFolderDisplayDbValue:
                                    organizationFolder.displayDbValue,
                            });
                            throw new Error(
                                "injected Account transition commit failure",
                            );
                        };
                    },
                });
                const wrappedTx = new Proxy(tx, {
                    get(target, property, receiver) {
                        if (property === "account") {
                            return wrappedAccountDelegate;
                        }
                        return Reflect.get(target, property, receiver);
                    },
                });
                return await operation(wrappedTx);
            },
            options,
        );
    };

    return {
        observedBeforeAccountUpdate,
        restore: () => {
            mutableDb.$transaction = originalTransaction;
        },
    };
}

describe("registerAccountEncryptionMigrateRoutes (integration)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-account-encryption-migrate-",
            initEncrypt: true,
            env: { HAPPIER_SQLITE_CONNECTION_LIMIT: "2" },
        });
    }, 120_000);

    afterEach(async () => {
        emitUpdate.mockClear();
        harness.resetEnv();
        await db.connectedServiceUsageSource.deleteMany().catch(() => {});
        await db.providerAccountUsageRecord.deleteMany().catch(() => {});
        await db.pluginWebhookDelivery.deleteMany().catch(() => {});
        await db.pluginWebhookEndpointOperation.deleteMany().catch(() => {});
        await db.pluginWebhookEndpoint.deleteMany().catch(() => {});
        await db.pluginWebhookCredential.deleteMany().catch(() => {});
        await db.pluginWebhookRoute.deleteMany().catch(() => {});
        await db.serviceAccountToken.deleteMany().catch(() => {});
        await db.automation.deleteMany().catch(() => {});
        await db.artifact.deleteMany().catch(() => {});
        await db.userKVStore.deleteMany().catch(() => {});
        await db.session.deleteMany().catch(() => {});
        await db.machine.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    afterAll(async () => {
        await harness.close();
    });

    it("migrates e2ee -> plain atomically and stores v2 settings in plaintext", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST: "none",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });

        const account = await db.account.create({
            data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee", settings: "ciphertext", settingsVersion: 0 },
            select: { id: true },
        });
        const legacySession = await db.session.create({
            data: {
                accountId: account.id,
                tag: "predecessor-layout-zero",
                metadata: "legacy-session-metadata",
                metadataVersion: 3,
                metadataLayoutVersion: 0,
                ownerMetadata: null,
                agentState: null,
                agentStateVersion: 0,
            },
            select: {
                id: true,
                metadata: true,
                metadataVersion: true,
                metadataLayoutVersion: true,
                ownerMetadata: true,
                agentState: true,
                agentStateVersion: true,
            },
        });
        const previousRevision = "csr_AAAAAAAAAAAAAAAAAAAAAA";
        await db.serviceAccountToken.create({
            data: {
                accountId: account.id,
                vendor: "anthropic",
                profileId: "work",
                ...createLegacyCredentialFixtureIdentity({
                    serviceId: "anthropic",
                    profileId: "work",
                }),
                token: new TextEncoder().encode("sealed-before-migration"),
                metadata: {
                    v: 2,
                    format: "account_scoped_v1",
                    kind: "token",
                    credentialRevision: previousRevision,
                },
                refreshLeaseOwnerMachineId: "stale-daemon:plain-migration",
                refreshLeaseExpiresAt: new Date(Date.now() + 60_000),
            },
        });

        const app = createTestApp();
        registerAccountSettingsRoutes(app as any);
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                toMode: "plain",
                expectedSettingsVersion: 0,
                settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                connectedServices: {
                    action: "migrate",
                    credentials: [{
                        serviceId: "anthropic",
                        profileId: "work",
                        expectedCredentialRevision:
                            previousRevision,
                        kind: "plain",
                        record: {
                            v: 1,
                            serviceId: "anthropic",
                            profileId: "work",
                            createdAt: 1,
                            updatedAt: 2,
                            expiresAt: null,
                            kind: "token",
                            oauth: null,
                            token: {
                                token: "plain-after-migration",
                                providerAccountId: "acct-migrate-plain",
                                providerEmail: "plain@example.com",
                                raw: null,
                            },
                        },
                    }],
                },
                automations: { action: "assert_empty" },
                machines: { action: "assert_empty" },
                todos: { action: "assert_empty" },
                artifacts: { action: "assert_empty" },
            },
        });

        expect(res.statusCode, res.body).toBe(200);
        expect(res.json()).toMatchObject({ success: true, mode: "plain" });

        const storedAccount = await db.account.findUnique({
            where: { id: account.id },
            select: { encryptionMode: true, settingsVersion: true, settings: true },
        });
        expect(storedAccount?.encryptionMode).toBe("plain");
        expect(storedAccount?.settingsVersion).toBe(1);
        expect(typeof storedAccount?.settings).toBe("string");
        expect((storedAccount?.settings ?? "").includes("ciphertext")).toBe(false);
        const migratedCredential = await db.serviceAccountToken.findUnique({
            where: {
                accountId_vendor_profileId: {
                    accountId: account.id,
                    vendor: "anthropic",
                    profileId: "work",
                },
            },
            select: {
                metadata: true,
                refreshLeaseOwnerMachineId: true,
                refreshLeaseExpiresAt: true,
            },
        });
        expect(migratedCredential?.metadata).toEqual(expect.objectContaining({
            v: 4,
            storage: "stored_envelope_v1",
            credentialRevision: expect.stringMatching(/^csr_/),
        }));
        expect((migratedCredential?.metadata as { credentialRevision?: string })?.credentialRevision).not.toBe(previousRevision);
        expect(migratedCredential?.refreshLeaseOwnerMachineId).toBeNull();
        expect(migratedCredential?.refreshLeaseExpiresAt).toBeNull();
        await expect(db.session.findUnique({
            where: { id: legacySession.id },
            select: {
                id: true,
                metadata: true,
                metadataVersion: true,
                metadataLayoutVersion: true,
                ownerMetadata: true,
                agentState: true,
                agentStateVersion: true,
            },
        })).resolves.toEqual(legacySession);
        const settingsChange = await db.accountChange.findFirst({
            where: { accountId: account.id, kind: "account", entityId: "self" },
            orderBy: { cursor: "desc" },
        });
        expect(settingsChange?.hint).toEqual({
            settingsVersion: 1,
            sourceAccountVersion: 0,
            accountEncryptionMigrationReplayBinding:
                expect.stringMatching(/^aemrsb1_/u),
        });
        await expect(db.accountSettingsSnapshot.findMany({
            where: { accountId: account.id },
            orderBy: { version: "asc" },
            select: {
                version: true,
                settingsDbValue: true,
                encryptionMode: true,
                contentKind: true,
            },
        })).resolves.toEqual([
            {
                version: 0,
                settingsDbValue: "ciphertext",
                encryptionMode: "e2ee",
                contentKind: "encrypted",
            },
            {
                version: 1,
                settingsDbValue: storedAccount!.settings,
                encryptionMode: "plain",
                contentKind: "plain",
            },
        ]);
        expect(emitUpdate).toHaveBeenCalledTimes(3);
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({
            userId: account.id,
            payload: expect.objectContaining({
                body: {
                    t: "account-settings-changed",
                    settingsVersion: 1,
                },
            }),
            recipientFilter: { type: "user-machine-scoped-only" },
        }));
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({
            userId: account.id,
            payload: expect.objectContaining({
                body: expect.objectContaining({
                    t: "update-account",
                    connectedServicesV2: expect.any(Array),
                }),
            }),
            recipientFilter: { type: "user-machine-scoped-only" },
        }));
        expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({
            userId: account.id,
            payload: expect.objectContaining({
                body: expect.objectContaining({ t: "update-account", connectedServicesV2: expect.any(Array) }),
            }),
            recipientFilter: { type: "user-scoped-only" },
        }));

        const getV2 = await app.inject({
            method: "GET",
            url: "/v2/account/settings",
            headers: { "x-test-user-id": account.id },
        });
        expect(getV2.statusCode).toBe(200);
        expect(getV2.json()).toMatchObject({ version: 1, content: { t: "plain" } });

        await app.close();
    });

    it("fails closed for an indistinguishable same-mode request without rewriting Settings", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST:
                "none",
        });
        const storedSettings = JSON.stringify({
            t: "plain",
            v: { persisted: true },
        });
        const account = await db.account.create({
            data: {
                publicKey: null,
                encryptionMode: "plain",
                settings: storedSettings,
                settingsVersion: 4,
            },
            select: {
                id: true,
                seq: true,
                updatedAt: true,
                encryptionModeUpdatedAt: true,
            },
        });
        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                },
                payload: {
                    toMode: "plain",
                    expectedAccountVersion: account.seq,
                    expectedSigningKeyFingerprint: null,
                    expectedContentKeyFingerprint: null,
                    expectedSettingsVersion: 0,
                    settingsContent: {
                        t: "plain",
                        v: { mustNotReplacePersistedSettings: true },
                    },
                    connectedServices: { action: "assert_empty" },
                    automations: { action: "assert_empty" },
                    machines: { action: "assert_empty" },
                    todos: { action: "assert_empty" },
                    artifacts: { action: "assert_empty" },
                },
            });

            expect(response.statusCode, response.body).toBe(400);
            expect(response.json()).toEqual({
                error: "invalid-params",
                reason: "migration_inventory_changed",
            });
            await expect(db.account.findUniqueOrThrow({
                where: { id: account.id },
                select: {
                    seq: true,
                    settings: true,
                    settingsVersion: true,
                    updatedAt: true,
                    encryptionModeUpdatedAt: true,
                },
            })).resolves.toEqual({
                seq: account.seq,
                settings: storedSettings,
                settingsVersion: 4,
                updatedAt: account.updatedAt,
                encryptionModeUpdatedAt:
                    account.encryptionModeUpdatedAt,
            });
            await expect(db.accountChange.count({
                where: { accountId: account.id },
            })).resolves.toBe(0);
            await expect(db.accountSettingsSnapshot.count({
                where: { accountId: account.id },
            })).resolves.toBe(0);
            expect(emitUpdate).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it("refuses settingsContent null when the source Settings value is non-null", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: "settings-ciphertext",
                settingsVersion: 3,
            },
            select: { id: true, updatedAt: true },
        });
        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                },
                payload: {
                    toMode: "plain",
                    expectedSettingsVersion: 3,
                    settingsContent: null,
                    connectedServices: { action: "assert_empty" },
                    automations: { action: "assert_empty" },
                    machines: { action: "assert_empty" },
                    todos: { action: "assert_empty" },
                    artifacts: { action: "assert_empty" },
                },
            });

            expect(response.statusCode, response.body).toBe(400);
            expect(response.json()).toEqual({
                error: "invalid-params",
                reason: "migration_inventory_changed",
            });
            await expect(db.account.findUniqueOrThrow({
                where: { id: account.id },
                select: {
                    encryptionMode: true,
                    settings: true,
                    settingsVersion: true,
                    updatedAt: true,
                },
            })).resolves.toEqual({
                encryptionMode: "e2ee",
                settings: "settings-ciphertext",
                settingsVersion: 3,
                updatedAt: account.updatedAt,
            });
            await expect(db.accountSettingsSnapshot.count({
                where: { accountId: account.id },
            })).resolves.toBe(0);
        } finally {
            await app.close();
        }
    });

    it("rejects a stale Connected Services credential revision without overwriting a refresh", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST:
                "none",
        });
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: "settings-ciphertext",
                settingsVersion: 0,
            },
            select: { id: true, seq: true },
        });
        const current = await mutateConnectedServiceCredential({
            accountId: account.id,
            serviceId: "anthropic",
            profileId: "work",
            token: new TextEncoder().encode("current-refresh-token"),
            metadata: {
                v: 2,
                format: "account_scoped_v1",
                kind: "token",
                providerAccountId: "account-after-refresh",
            },
            expiresAt: null,
            storageMode: "sealed",
            incomingIdentity: {
                providerAccountId: "account-after-refresh",
            },
            allowProviderIdentityChange: false,
            expectedCredentialRevision: null,
        });
        expect(current.status).toBe("written");
        const currentRevision =
            current.status === "written"
                ? current.credentialRevision
                : "unreachable";
        const storedBefore =
            await db.serviceAccountToken.findFirstOrThrow({
                where: { accountId: account.id },
                select: { token: true, metadata: true },
            });
        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                },
                payload: {
                    toMode: "plain",
                    expectedAccountVersion: account.seq,
                    expectedSigningKeyFingerprint: null,
                    expectedContentKeyFingerprint: null,
                    expectedSettingsVersion: 0,
                    settingsContent: {
                        t: "plain",
                        v: { schemaVersion: 2 },
                    },
                    connectedServices: {
                        action: "migrate",
                        credentials: [{
                            serviceId: "anthropic",
                            profileId: "work",
                            expectedCredentialRevision:
                                "csr_0123456789ABCDEFGHJKMNPQRS",
                            kind: "plain",
                            record: {
                                v: 1,
                                serviceId: "anthropic",
                                profileId: "work",
                                createdAt: 1,
                                updatedAt: 2,
                                expiresAt: null,
                                kind: "token",
                                oauth: null,
                                token: {
                                    token: "stale-snapshot-token",
                                    providerAccountId:
                                        "account-after-refresh",
                                    providerEmail: null,
                                    raw: null,
                                },
                            },
                        }],
                    },
                    automations: { action: "assert_empty" },
                    machines: { action: "assert_empty" },
                    todos: { action: "assert_empty" },
                    artifacts: { action: "assert_empty" },
                },
            });

            expect(response.statusCode, response.body).toBe(400);
            expect(response.json()).toEqual({
                error: "invalid-params",
                reason: "migration_inventory_changed",
            });
            const stored =
                await db.serviceAccountToken.findFirstOrThrow({
                    where: { accountId: account.id },
                    select: { token: true, metadata: true },
                });
            expect(stored).toEqual(storedBefore);
            expect(stored.metadata).toMatchObject({
                credentialRevision: currentRevision,
            });
            await expect(db.account.findUniqueOrThrow({
                where: { id: account.id },
                select: {
                    encryptionMode: true,
                    settings: true,
                    settingsVersion: true,
                },
            })).resolves.toEqual({
                encryptionMode: "e2ee",
                settings: "settings-ciphertext",
                settingsVersion: 0,
            });
        } finally {
            await app.close();
        }
    });

    it("rejects a stale Automation template version without overwriting the current template", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: "settings-ciphertext",
                settingsVersion: 0,
            },
            select: { id: true, seq: true },
        });
        const currentTemplate = JSON.stringify({
            kind: "happier_automation_template_encrypted_v1",
            payloadCiphertext: "current-after-edit",
        });
        const automation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "Current automation",
                scheduleKind: "interval",
                everyMs: 60_000,
                targetType: "new_session",
                templateCiphertext: currentTemplate,
                templateVersion: 8,
            },
            select: { id: true, updatedAt: true },
        });
        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                },
                payload: {
                    toMode: "plain",
                    expectedAccountVersion: account.seq,
                    expectedSigningKeyFingerprint: null,
                    expectedContentKeyFingerprint: null,
                    expectedSettingsVersion: 0,
                    settingsContent: {
                        t: "plain",
                        v: { schemaVersion: 2 },
                    },
                    connectedServices: { action: "assert_empty" },
                    automations: {
                        action: "migrate",
                        templates: [{
                            automationId: automation.id,
                            expectedTemplateVersion: 7,
                            templateCiphertext: JSON.stringify({
                                kind:
                                    "happier_automation_template_plain_v1",
                                payload: {
                                    prompt: "stale snapshot",
                                },
                            }),
                        }],
                    },
                    machines: { action: "assert_empty" },
                    todos: { action: "assert_empty" },
                    artifacts: { action: "assert_empty" },
                },
            });

            expect(response.statusCode, response.body).toBe(400);
            expect(response.json()).toEqual({
                error: "invalid-params",
                reason: "migration_inventory_changed",
            });
            await expect(db.automation.findUniqueOrThrow({
                where: { id: automation.id },
                select: {
                    templateCiphertext: true,
                    templateVersion: true,
                    updatedAt: true,
                },
            })).resolves.toEqual({
                templateCiphertext: currentTemplate,
                templateVersion: 8,
                updatedAt: automation.updatedAt,
            });
            await expect(db.account.findUniqueOrThrow({
                where: { id: account.id },
                select: {
                    encryptionMode: true,
                    settingsVersion: true,
                },
            })).resolves.toEqual({
                encryptionMode: "e2ee",
                settingsVersion: 0,
            });
            expect(emitUpdate).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it("rejects a retained Conversation reply receipt with the target Account mode before mode activation", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });

        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: "settings-ciphertext",
                settingsVersion: 0,
            },
            select: {
                id: true,
                seq: true,
                publicKey: true,
                contentPublicKey: true,
            },
        });
        const sourceTemplate = JSON.stringify({
            kind: "happier_automation_template_encrypted_v1",
            payloadCiphertext: "source-conversation-template",
        });
        const targetTemplate = JSON.stringify({
            kind: "happier_automation_template_plain_v1",
            payload: { prompt: "target conversation template" },
        });
        const automationId = "automation-account-encryption-route-conversation";
        const automation = await db.automation.create({
            data: {
                id: automationId,
                accountId: account.id,
                name: "Conversation Run receipt migration",
                enabled: false,
                triggerKind: "conversation",
                triggerDefinitionEnvelope: encodeConversationTriggerDefinitionEnvelope({
                    automationId,
                    templateVersion: 3,
                    mode: "e2ee",
                }),
                targetType: "new_session",
                templateCiphertext: sourceTemplate,
                templateVersion: 3,
            },
            select: {
                id: true,
                templateCiphertext: true,
                templateVersion: true,
            },
        });
        const runId = "run-account-encryption-route-conversation";
        const handoffId = "handoff-account-encryption-route-conversation";
        const sourceEvidence = {
            v: 1 as const,
            kind: "conversation" as const,
            bindingId: "binding-account-encryption-route",
            occurrenceId: "occurrence-account-encryption-route",
            occurredAt: 1_724_000_000_000,
            caller: {
                pluginId: "happier.channels",
                contributionLocalId: "provider/observation-ingest-v1",
                machineId: "machine-account-encryption-route",
            },
            input: { text: "route migration" },
            replyContextIdentity: "reply-context-account-encryption-route",
        };
        const correspondence = {
            accountId: account.id,
            automationId: automation.id,
            runId,
            handoffId,
        };
        const sourceRun = await db.automationRun.create({
            data: {
                id: runId,
                accountId: account.id,
                automationId: automation.id,
                state: "succeeded",
                originKind: "conversation",
                originOccurredAt: new Date(sourceEvidence.occurredAt),
                occurrenceKey: deriveAutomationOccurrenceKeyV1(sourceEvidence),
                occurrenceEvidenceEqualityTag:
                    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                triggerEvidenceEnvelope: JSON.stringify({
                    t: "encrypted",
                    c: "source-trigger-evidence",
                }),
                executionInputEnvelope: JSON.stringify({
                    kind: "happier_automation_run_execution_input_v1",
                    targetType: "new_session",
                    templateVersion: 1,
                    templateCiphertext: sourceTemplate,
                    origin: { kind: "manual", invokedAt: 1_723_247_201_000 },
                }),
                resultEnvelope: JSON.stringify({
                    t: "encrypted",
                    c: "source-result",
                }),
                replyContextEnvelope: JSON.stringify({
                    t: "encrypted",
                    c: "source-reply-context",
                }),
                replyHandoffActionPluginId: "happier.channels",
                replyHandoffActionLocalId: "automation/result-deliver-v1",
                replyHandoffTargetMachineId:
                    "route-account-encryption-target-machine",
                replyHandoffTargetMachineInstallationId:
                    "route-account-encryption-target-installation",
                replyHandoffTargetMaterializationId:
                    "route-account-encryption-target-materialization",
                replyHandoffId: handoffId,
                replyHandoffState: "accepted",
                replyHandoffReceiptEnvelope: JSON.stringify({
                    t: "encrypted",
                    c: "source-receipt",
                }),
                scheduledAt: new Date("2026-08-10T10:00:00.000Z"),
                dueAt: new Date("2026-08-10T10:00:00.000Z"),
                finishedAt: new Date("2026-08-10T10:01:00.000Z"),
            },
            select: {
                revision: true,
                triggerEvidenceEnvelope: true,
                occurrenceEvidenceEqualityTag: true,
                executionInputEnvelope: true,
                resultEnvelope: true,
                replyContextEnvelope: true,
                replyHandoffReceiptEnvelope: true,
            },
        });
        const targetRun = {
            triggerEvidenceEnvelope: JSON.stringify({
                t: "plain",
                v: sourceEvidence,
            }),
            occurrenceEvidenceEqualityTag: null,
            executionInputEnvelope: JSON.stringify({
                kind: "happier_automation_run_execution_input_v1",
                targetType: "new_session",
                templateVersion: 1,
                templateCiphertext: targetTemplate,
                origin: { kind: "manual", invokedAt: 1_723_247_201_000 },
            }),
            resultEnvelope: JSON.stringify({
                t: "plain",
                v: {
                    v: 1,
                    correspondence,
                    result: {
                        v: 1,
                        kind: "text",
                        text: "target automation result",
                    },
                },
            }),
            replyContextEnvelope: JSON.stringify({
                t: "plain",
                v: {
                    v: 1,
                    correspondence,
                    source: {
                        kind: "automationResult",
                        automationRunId: runId,
                        resultId: handoffId,
                        automationId: automation.id,
                        templateVersion: 3,
                        resultDelivery: "finalResult",
                    },
                    opaqueContext: {
                        conversationId:
                            "conversation-account-encryption-route",
                    },
                },
            }),
            // The transport schema intentionally accepts opaque JSON here;
            // the Automation migration owner must reject this target mode.
            replyHandoffReceiptEnvelope: JSON.stringify({
                t: "encrypted",
                c: "wrong-target-account-mode",
            }),
        };
        const fingerprints = deriveAccountEncryptionMigrationKeyFingerprints(
            account,
        );
        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                },
                payload: {
                    toMode: "plain",
                    expectedAccountVersion: account.seq,
                    expectedSigningKeyFingerprint:
                        fingerprints.signingKeyFingerprint,
                    expectedContentKeyFingerprint:
                        fingerprints.contentKeyFingerprint,
                    expectedSettingsVersion: 0,
                    settingsContent: {
                        t: "plain",
                        v: { schemaVersion: 2 },
                    },
                    connectedServices: { action: "assert_empty" },
                    automations: {
                        action: "migrate",
                        templates: [{
                            automationId: automation.id,
                            expectedTemplateVersion: automation.templateVersion,
                            templateCiphertext: targetTemplate,
                            triggerDefinitionEnvelope:
                                encodeConversationTriggerDefinitionEnvelope({
                                    automationId: automation.id,
                                    templateVersion: automation.templateVersion + 1,
                                    mode: "plain",
                                }),
                        }],
                        runs: [{
                            runId,
                            expectedRunRevision: sourceRun.revision,
                            ...targetRun,
                        }],
                    },
                    machines: { action: "assert_empty" },
                    todos: { action: "assert_empty" },
                    artifacts: { action: "assert_empty" },
                },
            });

            expect(response.statusCode, response.body).toBe(400);
            expect(response.json()).toEqual({ error: "invalid-params" });
            await expect(db.account.findUniqueOrThrow({
                where: { id: account.id },
                select: {
                    encryptionMode: true,
                    settings: true,
                    settingsVersion: true,
                },
            })).resolves.toEqual({
                encryptionMode: "e2ee",
                settings: "settings-ciphertext",
                settingsVersion: 0,
            });
            await expect(db.automation.findUniqueOrThrow({
                where: { id: automation.id },
                select: {
                    templateCiphertext: true,
                    templateVersion: true,
                },
            })).resolves.toEqual({
                templateCiphertext: automation.templateCiphertext,
                templateVersion: automation.templateVersion,
            });
            await expect(db.automationRun.findUniqueOrThrow({
                where: { id: runId },
                select: {
                    revision: true,
                    triggerEvidenceEnvelope: true,
                    occurrenceEvidenceEqualityTag: true,
                    executionInputEnvelope: true,
                    resultEnvelope: true,
                    replyContextEnvelope: true,
                    replyHandoffReceiptEnvelope: true,
                },
            })).resolves.toEqual(sourceRun);
        } finally {
            await app.close();
        }
    });

    it("clears qualified credentials, groups, and usage atomically without changing another account", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST: "none",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });

        const account = await db.account.create({
            data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee", settings: "ciphertext", settingsVersion: 0 },
            select: { id: true },
        });
        const service = {
            pluginId: "example.account-clear",
            localId: "qualified/service",
        } as const;
        const ref = {
            service,
            accountId: "qualified/account",
        } as const;
        const credential = await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref,
            expectedCredentialRevision: null,
            authenticationModeId: "oauth",
            content: {
                t: "encrypted",
                c: "sealed-qualified-credential",
            },
            metadata: {
                displayName: "Qualified account",
                scopes: [],
                providerIdentity: {
                    accountId: "acct_clear_connected_services",
                },
            },
        });
        if (credential.status !== "written") {
            throw new Error("Expected qualified credential");
        }
        const groupRef = {
            service,
            groupId: "qualified-group",
        } as const;
        const createdGroup = await createQualifiedConnectedAccountGroup({
            accountId: account.id,
            service,
            group: { groupId: groupRef.groupId },
        });
        if (createdGroup.status !== "written") {
            throw new Error("Expected qualified group");
        }
        const createdMember =
            await createQualifiedConnectedAccountGroupMember({
                accountId: account.id,
                mutation: {
                    group: groupRef,
                    connectedAccountId: ref.accountId,
                    priority: 1,
                    enabled: true,
                },
            });
        if (createdMember.status !== "written") {
            throw new Error("Expected qualified group member");
        }
        const activatedGroup =
            await setQualifiedConnectedAccountGroupActiveAccount({
                accountId: account.id,
                mutation: {
                    group: groupRef,
                    connectedAccountId: ref.accountId,
                    expectedGeneration:
                        createdMember.group.generation,
                },
            });
        if (activatedGroup.status !== "written") {
            throw new Error("Expected active qualified group member");
        }
        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey: createProviderAccountUsageRecordKey({ accountSubjectId: "acct_clear_connected_services" }),
        });
        await writeQualifiedProviderAccountUsageRecord({
            accountId: account.id,
            source: {
                ref,
                bindingKind: "group_member",
                groupId: groupRef.groupId,
                groupGeneration:
                    activatedGroup.group.generation,
            },
            expectedCredentialRevision:
                credential.credentialRevision,
            expectedConfigurationRevision: null,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "sealed_account_scoped_v1",
            sealedPayload: {
                format: "account_scoped_v1",
                ciphertext: "sealed-usage-before-mode-change",
            },
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
            materialFingerprint: "usage:account-clear-source",
        });
        const groupBeforeClear =
            await db.connectedServiceAuthGroup.findFirstOrThrow({
                where: {
                    accountId: account.id,
                    groupId: groupRef.groupId,
                },
                select: {
                    id: true,
                    generation: true,
                    runtimeStateRevision: true,
                },
            });
        const unrelatedAccount = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: "unrelated-ciphertext",
                settingsVersion: 0,
            },
            select: { id: true },
        });
        const unrelatedRef = {
            service,
            accountId: "unrelated/account",
        } as const;
        const unrelatedCredential =
            await mutateQualifiedConnectedServiceCredential({
                accountId: unrelatedAccount.id,
                ref: unrelatedRef,
                expectedCredentialRevision: null,
                authenticationModeId: "oauth",
                content: {
                    t: "encrypted",
                    c: "sealed-unrelated-credential",
                },
                metadata: {
                    displayName: "Unrelated account",
                    scopes: [],
                    providerIdentity: {
                        accountId: "acct_unrelated_connected_services",
                    },
                },
            });
        if (unrelatedCredential.status !== "written") {
            throw new Error("Expected unrelated qualified credential");
        }
        const unrelatedGroupRef = {
            service,
            groupId: "unrelated-group",
        } as const;
        const unrelatedGroup =
            await createQualifiedConnectedAccountGroup({
                accountId: unrelatedAccount.id,
                service,
                group: { groupId: unrelatedGroupRef.groupId },
            });
        if (unrelatedGroup.status !== "written") {
            throw new Error("Expected unrelated qualified group");
        }
        const unrelatedMember =
            await createQualifiedConnectedAccountGroupMember({
                accountId: unrelatedAccount.id,
                mutation: {
                    group: unrelatedGroupRef,
                    connectedAccountId: unrelatedRef.accountId,
                    priority: 1,
                    enabled: true,
                },
            });
        if (unrelatedMember.status !== "written") {
            throw new Error("Expected unrelated qualified group member");
        }
        const unrelatedActive =
            await setQualifiedConnectedAccountGroupActiveAccount({
                accountId: unrelatedAccount.id,
                mutation: {
                    group: unrelatedGroupRef,
                    connectedAccountId: unrelatedRef.accountId,
                    expectedGeneration:
                        unrelatedMember.group.generation,
                },
            });
        if (unrelatedActive.status !== "written") {
            throw new Error("Expected unrelated active group member");
        }
        const unrelatedSnapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey: createProviderAccountUsageRecordKey({
                accountSubjectId:
                    "acct_unrelated_connected_services",
            }),
        });
        await writeQualifiedProviderAccountUsageRecord({
            accountId: unrelatedAccount.id,
            source: {
                ref: unrelatedRef,
                bindingKind: "group_member",
                groupId: unrelatedGroupRef.groupId,
                groupGeneration:
                    unrelatedActive.group.generation,
            },
            expectedCredentialRevision:
                unrelatedCredential.credentialRevision,
            expectedConfigurationRevision: null,
            recordId: unrelatedSnapshot.recordId,
            recordKey: unrelatedSnapshot.recordKey,
            payloadMode: "sealed_account_scoped_v1",
            sealedPayload: {
                format: "account_scoped_v1",
                ciphertext: "sealed-unrelated-usage",
            },
            status: "ok",
            fetchedAt: unrelatedSnapshot.fetchedAtMs,
            staleAfterMs: unrelatedSnapshot.staleAfterMs,
            materialFingerprint: "usage:unrelated-account",
        });
        const unrelatedGroupBeforeClear =
            await db.connectedServiceAuthGroup.findFirstOrThrow({
                where: {
                    accountId: unrelatedAccount.id,
                    groupId: unrelatedGroupRef.groupId,
                },
                select: {
                    id: true,
                    activeConnectedAccountId: true,
                    activeProfileId: true,
                    generation: true,
                    runtimeStateRevision: true,
                },
            });

        const app = createTestApp();
        registerAccountSettingsRoutes(app as any);
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                toMode: "plain",
                expectedSettingsVersion: 0,
                settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                connectedServices: { action: "clear" },
                automations: { action: "assert_empty" },
                machines: { action: "assert_empty" },
                todos: { action: "assert_empty" },
                artifacts: { action: "assert_empty" },
            },
        });

        expect(res.statusCode).toBe(200);
        expect(await db.serviceAccountToken.count({
            where: { accountId: account.id },
        })).toBe(0);
        expect(await db.connectedServiceAuthGroupMember.count({
            where: { accountId: account.id },
        })).toBe(0);
        await expect(db.connectedServiceAuthGroup.findUniqueOrThrow({
            where: { id: groupBeforeClear.id },
            select: {
                activeConnectedAccountId: true,
                activeProfileId: true,
                generation: true,
                runtimeStateRevision: true,
            },
        })).resolves.toEqual({
            activeConnectedAccountId: null,
            activeProfileId: null,
            generation: groupBeforeClear.generation + 1,
            runtimeStateRevision:
                groupBeforeClear.runtimeStateRevision,
        });
        const repeatedClear = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": account.id,
            },
            payload: {
                toMode: "plain",
                expectedSettingsVersion: 1,
                settingsContent: {
                    t: "plain",
                    v: { schemaVersion: 2 },
                },
                connectedServices: { action: "clear" },
                automations: { action: "assert_empty" },
                machines: { action: "assert_empty" },
                todos: { action: "assert_empty" },
                artifacts: { action: "assert_empty" },
            },
        });
        expect(repeatedClear.statusCode).toBe(400);
        expect(repeatedClear.json()).toEqual({
            error: "invalid-params",
            reason: "migration_inventory_changed",
        });
        await expect(db.connectedServiceAuthGroup.findUniqueOrThrow({
            where: { id: groupBeforeClear.id },
            select: {
                activeConnectedAccountId: true,
                activeProfileId: true,
                generation: true,
                runtimeStateRevision: true,
            },
        })).resolves.toEqual({
            activeConnectedAccountId: null,
            activeProfileId: null,
            generation: groupBeforeClear.generation + 1,
            runtimeStateRevision:
                groupBeforeClear.runtimeStateRevision,
        });
        expect(await db.connectedServiceUsageSource.count({
            where: { accountId: account.id },
        })).toBe(0);
        expect(await db.providerAccountUsageRecord.count({ where: { accountId: account.id } })).toBe(0);
        expect(await db.serviceAccountToken.count({
            where: { accountId: unrelatedAccount.id },
        })).toBe(1);
        expect(await db.connectedServiceAuthGroupMember.count({
            where: { accountId: unrelatedAccount.id },
        })).toBe(1);
        expect(await db.connectedServiceUsageSource.count({
            where: { accountId: unrelatedAccount.id },
        })).toBe(1);
        expect(await db.providerAccountUsageRecord.count({
            where: { accountId: unrelatedAccount.id },
        })).toBe(1);
        await expect(db.connectedServiceAuthGroup.findUniqueOrThrow({
            where: { id: unrelatedGroupBeforeClear.id },
            select: {
                activeConnectedAccountId: true,
                activeProfileId: true,
                generation: true,
                runtimeStateRevision: true,
            },
        })).resolves.toEqual({
            activeConnectedAccountId:
                unrelatedGroupBeforeClear.activeConnectedAccountId,
            activeProfileId:
                unrelatedGroupBeforeClear.activeProfileId,
            generation: unrelatedGroupBeforeClear.generation,
            runtimeStateRevision:
                unrelatedGroupBeforeClear.runtimeStateRevision,
        });
    });

    it("returns an old-reader-safe refusal for a predecessor same-mode credential rewrite", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain", settings: null, settingsVersion: 0 },
            select: { id: true },
        });
        await db.serviceAccountToken.create({
            data: {
                accountId: account.id,
                vendor: "openai-codex",
                profileId: "work",
                ...createLegacyCredentialFixtureIdentity({
                    serviceId: "openai-codex",
                    profileId: "work",
                }),
                token: new TextEncoder().encode(JSON.stringify({
                    v: 1,
                    serviceId: "openai-codex",
                    profileId: "work",
                    kind: "oauth",
                    createdAt: 1,
                    updatedAt: 1,
                    expiresAt: null,
                    oauth: {
                        accessToken: "before",
                        refreshToken: "refresh-before",
                        idToken: null,
                        scope: null,
                        tokenType: null,
                        providerAccountId: "acct-retained",
                        providerEmail: null,
                        raw: null,
                    },
                    token: null,
                })),
                // The arrange step seeds usage through the legacy boundary, and
                // `resolveQualifiedCredential` refuses an unfenced credential there.
                // The subject of this test is the route's stored-content refusal, so
                // the credential carries a revision like every other fixture here.
                metadata: { v: 3, storage: "plain_json_v1", kind: "oauth", providerAccountId: "acct-retained", providerEmail: null, credentialRevision: "csr_AAAAAAAAAAAAAAAAAAAAAA" },
            },
        });
        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey: createProviderAccountUsageRecordKey({ accountSubjectId: "acct-retained" }),
            profileId: "work",
        });
        await writeQualifiedProviderAccountUsageRecordFromLegacyBoundary({
            accountId: account.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1",
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
            snapshot,
            source: {
                ref: {
                    service:
                        resolveLegacyQualifiedConnectedAccountService(
                            "openai-codex",
                        ),
                    accountId: "work",
                },
                bindingKind: "account",
            },
        });
        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();
        const res = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                toMode: "plain",
                expectedSettingsVersion: 0,
                settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                connectedServices: {
                    action: "migrate",
                    credentials: [{
                        serviceId: "openai-codex",
                        profileId: "work",
                        kind: "plain",
                        record: {
                            v: 1,
                            serviceId: "openai-codex",
                            profileId: "work",
                            createdAt: 1,
                            updatedAt: 2,
                            expiresAt: null,
                            kind: "oauth",
                            oauth: {
                                accessToken: "after",
                                refreshToken: "refresh-after",
                                idToken: null,
                                scope: null,
                                tokenType: null,
                                providerAccountId: "acct-retained",
                                providerEmail: null,
                                raw: null,
                            },
                            token: null,
                        },
                    }],
                },
                automations: { action: "assert_empty" },
            },
        });
        expect(res.statusCode, res.body).toBe(426);
        expect(res.json()).toEqual({
            error: "client-upgrade-required",
            requirement: {
                v: 1,
                kind: "account-stored-content",
                minimumProtocolVersion: 2,
            },
        });
        const retainedCredential =
            await db.serviceAccountToken.findFirstOrThrow({
                where: { accountId: account.id },
                select: { token: true },
            });
        expect(
            new TextDecoder().decode(
                retainedCredential.token,
            ),
        ).toContain('"accessToken":"before"');
        expect(await db.providerAccountUsageRecord.count({ where: { accountId: account.id } })).toBe(1);
        expect(await db.connectedServiceUsageSource.count({ where: { accountId: account.id } })).toBe(1);
        await app.close();
    });

    it("rejects a plaintext migration item whose embedded credential binding differs from its outer key", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const account = await db.account.create({
            data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee", settings: "ciphertext", settingsVersion: 0 },
            select: { id: true },
        });
        await db.serviceAccountToken.create({
            data: {
                accountId: account.id,
                vendor: "anthropic",
                profileId: "work",
                ...createLegacyCredentialFixtureIdentity({
                    serviceId: "anthropic",
                    profileId: "work",
                }),
                token: new TextEncoder().encode("sealed-before"),
                metadata: { v: 2, format: "account_scoped_v1", kind: "token", providerAccountId: "acct-1", credentialRevision: "csr_AAAAAAAAAAAAAAAAAAAAAA" },
            },
        });
        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();
        const res = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                toMode: "plain",
                expectedSettingsVersion: 0,
                settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                connectedServices: {
                    action: "migrate",
                    credentials: [{
                        serviceId: "anthropic",
                        profileId: "work",
                        kind: "plain",
                        record: {
                            v: 1,
                            serviceId: "anthropic",
                            profileId: "other",
                            createdAt: 1,
                            updatedAt: 2,
                            expiresAt: null,
                            kind: "token",
                            oauth: null,
                            token: { token: "foreign", providerAccountId: "acct-1", providerEmail: null, raw: null },
                        },
                    }],
                },
                automations: { action: "assert_empty" },
                machines: { action: "assert_empty" },
                todos: { action: "assert_empty" },
                artifacts: { action: "assert_empty" },
            },
        });
        expect(res.statusCode).toBe(400);
        await expect(db.account.findUnique({ where: { id: account.id }, select: { encryptionMode: true, settingsVersion: true } }))
            .resolves.toEqual({ encryptionMode: "e2ee", settingsVersion: 0 });
        expect(new TextDecoder().decode((await db.serviceAccountToken.findFirst({ where: { accountId: account.id }, select: { token: true } }))?.token))
            .toBe("sealed-before");
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("rejects provider identity changes during credential migration and rolls back account/settings writes", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const account = await db.account.create({
            data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee", settings: "ciphertext", settingsVersion: 0 },
            select: { id: true },
        });
        await expect(mutateConnectedServiceCredential({
            accountId: account.id,
            serviceId: "anthropic",
            profileId: "work",
            token: new TextEncoder().encode("sealed-before"),
            metadata: { v: 2, format: "account_scoped_v1", kind: "token", providerAccountId: "acct-old" },
            expiresAt: null,
            storageMode: "sealed",
            incomingIdentity: { providerAccountId: "acct-old" },
            allowProviderIdentityChange: false,
            expectedCredentialRevision: null,
        })).resolves.toMatchObject({ status: "written" });
        const beforeCredential = await db.serviceAccountToken.findFirstOrThrow({
            where: { accountId: account.id },
            select: { token: true, metadata: true },
        });
        emitUpdate.mockClear();
        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();
        const res = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                toMode: "plain",
                expectedSettingsVersion: 0,
                settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                connectedServices: {
                    action: "migrate",
                    credentials: [{
                        serviceId: "anthropic",
                        profileId: "work",
                        kind: "plain",
                        record: {
                            v: 1,
                            serviceId: "anthropic",
                            profileId: "work",
                            createdAt: 1,
                            updatedAt: 2,
                            expiresAt: null,
                            kind: "token",
                            oauth: null,
                            token: { token: "changed", providerAccountId: "acct-new", providerEmail: null, raw: null },
                        },
                    }],
                },
                automations: { action: "assert_empty" },
                machines: { action: "assert_empty" },
                todos: { action: "assert_empty" },
                artifacts: { action: "assert_empty" },
            },
        });
        expect(res.statusCode).toBe(400);
        await expect(db.account.findUnique({ where: { id: account.id }, select: { encryptionMode: true, settingsVersion: true, settings: true } }))
            .resolves.toEqual({ encryptionMode: "e2ee", settingsVersion: 0, settings: "ciphertext" });
        const afterCredential = await db.serviceAccountToken.findFirstOrThrow({
            where: { accountId: account.id },
            select: { token: true, metadata: true },
        });
        expect(Array.from(afterCredential.token)).toEqual(
            Array.from(beforeCredential.token),
        );
        expect(afterCredential.metadata).toEqual(beforeCredential.metadata);
        expect(emitUpdate).not.toHaveBeenCalled();
    });

    it("does not emit a settings version hint when migration preconditions fail", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });

        const account = await db.account.create({
            data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee", settings: "ciphertext", settingsVersion: 3 },
            select: { id: true },
        });

        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                toMode: "plain",
                expectedSettingsVersion: 2,
                settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                connectedServices: { action: "assert_empty" },
                automations: { action: "assert_empty" },
                machines: { action: "assert_empty" },
                todos: { action: "assert_empty" },
                artifacts: { action: "assert_empty" },
            },
        });

        expect(res.statusCode).toBe(409);
        expect(emitUpdate).not.toHaveBeenCalled();

        await app.close();
    });

    it("stores v2 settings sealed at rest for plain accounts when configured", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST: "server_sealed",
        });

        const kp = tweetnacl.sign.keyPair();
        const publicKeyHex = privacyKit.encodeHex(new Uint8Array(kp.publicKey));
        const contentBinding =
            createSignedContentKeyBinding(kp.secretKey);

        const account = await db.account.create({
            data: {
                publicKey: publicKeyHex,
                contentPublicKey:
                    contentBinding.contentPublicKeyBytes,
                contentPublicKeySig:
                    contentBinding.contentPublicKeySigBytes,
                encryptionMode: "e2ee",
                settings: "ciphertext",
                settingsVersion: 0,
            },
            select: { id: true },
        });

        const app = createTestApp();
        registerAccountSettingsRoutes(app as any);
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();

        const migrate = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                toMode: "plain",
                expectedSettingsVersion: 0,
                settingsContent: { t: "plain", v: { schemaVersion: 2, pushEnabled: true } },
                connectedServices: { action: "assert_empty" },
                automations: { action: "assert_empty" },
                machines: { action: "assert_empty" },
                todos: { action: "assert_empty" },
                artifacts: { action: "assert_empty" },
            },
        });

        expect(migrate.statusCode).toBe(200);
        expect(migrate.json()).toMatchObject({ success: true, mode: "plain", settingsVersion: 1 });

        const storedAccount = await db.account.findUnique({
            where: { id: account.id },
            select: { encryptionMode: true, settingsVersion: true, settings: true, publicKey: true },
        });
        expect(storedAccount?.encryptionMode).toBe("plain");
        expect(storedAccount?.settingsVersion).toBe(1);
        expect(storedAccount?.publicKey).toBe(publicKeyHex);
        expect(typeof storedAccount?.settings).toBe("string");
        const wrapper = JSON.parse(storedAccount?.settings ?? "{}") as any;
        expect(wrapper?.t).toBe("sealed_v1");

        const getV2 = await app.inject({
            method: "GET",
            url: "/v2/account/settings",
            headers: { "x-test-user-id": account.id },
        });
        expect(getV2.statusCode).toBe(200);
        expect(getV2.json()).toMatchObject({
            version: 1,
            content: { t: "plain", v: expect.objectContaining({ schemaVersion: 2, pushEnabled: true }) },
        });

        await app.close();
    });

    it("does not allow rotating the account signing key across encryption-mode toggles", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });

        const kp1 = tweetnacl.sign.keyPair();
        const kp2 = tweetnacl.sign.keyPair();
        const publicKeyHex1 = privacyKit.encodeHex(new Uint8Array(kp1.publicKey));
        const originalContentBinding =
            createSignedContentKeyBinding(new Uint8Array(kp1.secretKey));

        const account = await db.account.create({
            data: {
                publicKey: publicKeyHex1,
                contentPublicKey:
                    originalContentBinding.contentPublicKeyBytes,
                contentPublicKeySig:
                    originalContentBinding.contentPublicKeySigBytes,
                encryptionMode: "e2ee",
                settings: "ciphertext",
                settingsVersion: 0,
            },
            select: { id: true },
        });

        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();

        const toPlain = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                toMode: "plain",
                expectedSettingsVersion: 0,
                settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                connectedServices: { action: "assert_empty" },
                automations: { action: "assert_empty" },
                machines: { action: "assert_empty" },
                todos: { action: "assert_empty" },
                artifacts: { action: "assert_empty" },
            },
        });
        expect(toPlain.statusCode).toBe(200);

        const storedAfterPlain = await db.account.findUnique({
            where: { id: account.id },
            select: { encryptionMode: true, publicKey: true, settingsVersion: true },
        });
        expect(storedAfterPlain?.encryptionMode).toBe("plain");
        expect(storedAfterPlain?.publicKey).toBe(publicKeyHex1);
        expect(storedAfterPlain?.settingsVersion).toBe(1);

        const challenge2 = Uint8Array.from(crypto.getRandomValues(new Uint8Array(32)));
        const signature2 = Uint8Array.from(tweetnacl.sign.detached(challenge2, Uint8Array.from(kp2.secretKey)));
        const mismatchedContentBinding =
            createSignedContentKeyBinding(new Uint8Array(kp2.secretKey));
        const mismatchedKey = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                toMode: "e2ee",
                expectedSettingsVersion: 1,
                settingsContent: { t: "encrypted", c: "settings-ciphertext" },
                connectedServices: { action: "assert_empty" },
                automations: { action: "assert_empty" },
                machines: { action: "assert_empty" },
                todos: { action: "assert_empty" },
                artifacts: { action: "assert_empty" },
                keyProof: {
                    publicKey: privacyKit.encodeBase64(new Uint8Array(kp2.publicKey)),
                    challenge: privacyKit.encodeBase64(challenge2),
                    signature: privacyKit.encodeBase64(signature2),
                    contentPublicKey: mismatchedContentBinding.contentPublicKey,
                    contentPublicKeySig:
                        mismatchedContentBinding.contentPublicKeySig,
                },
            },
        });
        expect(mismatchedKey.statusCode).toBe(400);
        expect(mismatchedKey.json()).toEqual({
            error: "invalid-params",
        });

        const challenge1 = Uint8Array.from(crypto.getRandomValues(new Uint8Array(32)));
        const signature1 = Uint8Array.from(tweetnacl.sign.detached(challenge1, Uint8Array.from(kp1.secretKey)));
        const correctContentBinding =
            createSignedContentKeyBinding(new Uint8Array(kp1.secretKey));
        const correctKey = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                toMode: "e2ee",
                expectedSettingsVersion: 1,
                settingsContent: { t: "encrypted", c: "settings-ciphertext" },
                connectedServices: { action: "assert_empty" },
                automations: { action: "assert_empty" },
                machines: { action: "assert_empty" },
                todos: { action: "assert_empty" },
                artifacts: { action: "assert_empty" },
                keyProof: {
                    publicKey: privacyKit.encodeBase64(new Uint8Array(kp1.publicKey)),
                    challenge: privacyKit.encodeBase64(challenge1),
                    signature: privacyKit.encodeBase64(signature1),
                    contentPublicKey: correctContentBinding.contentPublicKey,
                    contentPublicKeySig:
                        correctContentBinding.contentPublicKeySig,
                },
            },
        });
        expect(correctKey.statusCode).toBe(400);
        expect(correctKey.json()).toEqual({
            error: "invalid-params",
        });

        const storedAfterE2ee = await db.account.findUnique({
            where: { id: account.id },
            select: {
                encryptionMode: true,
                publicKey: true,
                contentPublicKey: true,
                contentPublicKeySig: true,
                settings: true,
                settingsVersion: true,
            },
        });
        expect(storedAfterE2ee?.encryptionMode).toBe("plain");
        expect(storedAfterE2ee?.publicKey).toBe(publicKeyHex1);
        expect(storedAfterE2ee?.settingsVersion).toBe(1);
        expect(storedAfterE2ee?.contentPublicKey).toEqual(
            originalContentBinding.contentPublicKeyBytes,
        );
        expect(storedAfterE2ee?.contentPublicKeySig).toEqual(
            originalContentBinding.contentPublicKeySigBytes,
        );

        await app.close();
    });

    it("does not replace the Account content key while plain-to-e2ee proof admission is fail-closed", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const signing = tweetnacl.sign.keyPair();
        const originalContentBinding =
            createSignedContentKeyBinding(new Uint8Array(signing.secretKey));
        const replacementContentBinding =
            createSignedContentKeyBinding(new Uint8Array(signing.secretKey));
        const account = await db.account.create({
            data: {
                publicKey: privacyKit.encodeHex(
                    new Uint8Array(signing.publicKey),
                ),
                contentPublicKey:
                    originalContentBinding.contentPublicKeyBytes,
                contentPublicKeySig:
                    originalContentBinding.contentPublicKeySigBytes,
                encryptionMode: "plain",
                settings: "original-settings",
                settingsVersion: 0,
            },
            select: { id: true, updatedAt: true },
        });
        await db.automation.create({
            data: {
                accountId: account.id,
                name: "blocks key replacement",
                scheduleKind: "interval",
                everyMs: 60_000,
                timezone: null,
                scheduleExpr: null,
                targetType: "new_session",
                templateCiphertext: JSON.stringify({
                    kind: "happier_automation_template_encrypted_v1",
                    payloadCiphertext: "original-template",
                }),
            },
        });
        const challenge = crypto.getRandomValues(new Uint8Array(32));
        const signature = tweetnacl.sign.detached(
            challenge,
            signing.secretKey,
        );

        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();
        const response = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": account.id,
            },
            payload: {
                toMode: "e2ee",
                expectedSettingsVersion: 0,
                settingsContent: {
                    t: "encrypted",
                    c: "replacement-settings",
                },
                connectedServices: { action: "assert_empty" },
                automations: { action: "assert_empty" },
                machines: { action: "assert_empty" },
                todos: { action: "assert_empty" },
                artifacts: { action: "assert_empty" },
                keyProof: {
                    publicKey: privacyKit.encodeBase64(
                        new Uint8Array(signing.publicKey),
                    ),
                    challenge: privacyKit.encodeBase64(challenge),
                    signature: privacyKit.encodeBase64(
                        new Uint8Array(signature),
                    ),
                    contentPublicKey:
                        replacementContentBinding.contentPublicKey,
                    contentPublicKeySig:
                        replacementContentBinding.contentPublicKeySig,
                },
            },
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({
            error: "invalid-params",
        });
        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: {
                contentPublicKey: true,
                contentPublicKeySig: true,
                encryptionMode: true,
                settings: true,
                settingsVersion: true,
                updatedAt: true,
            },
        })).resolves.toEqual({
            contentPublicKey:
                originalContentBinding.contentPublicKeyBytes,
            contentPublicKeySig:
                originalContentBinding.contentPublicKeySigBytes,
            encryptionMode: "plain",
            settings: "original-settings",
            settingsVersion: 0,
            updatedAt: account.updatedAt,
        });
        await app.close();
    });

    it("admits keyed plain -> e2ee only with the exact request-bound proof", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });

        const kp = tweetnacl.sign.keyPair();
        const publicKey = Uint8Array.from(kp.publicKey);
        const secretKey = Uint8Array.from(kp.secretKey);
        const account = await db.account.create({
            data: {
                publicKey: privacyKit.encodeHex(publicKey),
                encryptionMode: "plain",
                settings: null,
                settingsVersion: 0,
            },
            select: {
                id: true,
                seq: true,
                updatedAt: true,
                encryptionModeUpdatedAt: true,
            },
        });

        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();

        const contentBinding = createSignedContentKeyBinding(secretKey);
        const unsignedRequest: AccountEncryptionMigrateUnsignedRequest = {
            toMode: "e2ee",
            expectedAccountVersion: account.seq,
            expectedSigningKeyFingerprint:
                computeAccountEncryptionMigrateKeyFingerprintV1(
                    publicKey,
                ),
            expectedContentKeyFingerprint: null,
            expectedSettingsVersion: 0,
            settingsContent: null,
            connectedServices: { action: "assert_empty" },
            automations: { action: "assert_empty" },
            machines: { action: "assert_empty" },
            todos: { action: "assert_empty" },
            artifacts: { action: "assert_empty" },
            sessions: { action: "assert_empty" },
            reviewComments: { action: "assert_empty" },
            sessionOrganization: { action: "assert_empty" },
            pets: { action: "assert_empty" },
            keyProof: {
                v: 1,
                publicKey: privacyKit.encodeBase64(publicKey),
                contentPublicKey: contentBinding.contentPublicKey,
                contentPublicKeySig: contentBinding.contentPublicKeySig,
            },
        };
        const {
            keyProof: _missingProof,
            ...requestWithoutProof
        } = unsignedRequest;
        const missingProof = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": account.id,
            },
            payload: requestWithoutProof,
        });
        expect(missingProof.statusCode, missingProof.body).toBe(400);
        expect(missingProof.json()).toEqual({
            error: "invalid-params",
            reason: "key_proof_required",
        });

        const signedRequest = signPlainToE2eeMigrationRequest({
            accountId: account.id,
            signingSecretKey: secretKey,
            request: unsignedRequest,
        });
        const substituted = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                ...signedRequest,
                connectedServices: { action: "clear" },
            },
        });
        expect(substituted.statusCode, substituted.body).toBe(400);
        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: {
                encryptionMode: true,
                publicKey: true,
                contentPublicKey: true,
                contentPublicKeySig: true,
                settings: true,
                settingsVersion: true,
                seq: true,
                updatedAt: true,
                encryptionModeUpdatedAt: true,
            },
        })).resolves.toEqual({
            encryptionMode: "plain",
            publicKey: privacyKit.encodeHex(publicKey),
            contentPublicKey: null,
            contentPublicKeySig: null,
            settings: null,
            settingsVersion: 0,
            seq: account.seq,
            updatedAt: account.updatedAt,
            encryptionModeUpdatedAt:
                account.encryptionModeUpdatedAt,
        });

        const response = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": account.id,
            },
            payload: signedRequest,
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toEqual({
            success: true,
            mode: "e2ee",
            accountVersion: account.seq + 1,
            settingsVersion: 1,
        });
        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: {
                encryptionMode: true,
                publicKey: true,
                contentPublicKey: true,
                contentPublicKeySig: true,
                settings: true,
                settingsVersion: true,
                seq: true,
            },
        })).resolves.toEqual({
            encryptionMode: "e2ee",
            publicKey: privacyKit.encodeHex(publicKey),
            contentPublicKey: contentBinding.contentPublicKeyBytes,
            contentPublicKeySig:
                contentBinding.contentPublicKeySigBytes,
            settings: null,
            settingsVersion: 1,
            seq: account.seq + 1,
        });
        await app.close();
    });

    it("refuses a mode-bound plugin Account-KV row on plain -> e2ee before changing Account mode", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const signingKey = tweetnacl.sign.keyPair();
        const publicKey = new Uint8Array(signingKey.publicKey);
        const secretKey = new Uint8Array(signingKey.secretKey);
        const account = await db.account.create({
            data: {
                publicKey: privacyKit.encodeHex(publicKey),
                encryptionMode: "plain",
                settings: null,
                settingsVersion: 0,
            },
            select: { id: true, seq: true },
        });
        const pluginStorageKey =
            `${PLUGIN_ACCOUNT_STORAGE_KEY_PREFIX}acme.plain-transition-blocker`;
        await db.userKVStore.create({
            data: {
                accountId: account.id,
                key: pluginStorageKey,
                value: Buffer.from(JSON.stringify({
                    t: "plain",
                    v: { v: 1, values: {} },
                }), "utf8"),
            },
        });

        const contentBinding = createSignedContentKeyBinding(secretKey);
        const request = signPlainToE2eeMigrationRequest({
            accountId: account.id,
            signingSecretKey: secretKey,
            request: {
                toMode: "e2ee",
                expectedAccountVersion: account.seq,
                expectedSigningKeyFingerprint:
                    computeAccountEncryptionMigrateKeyFingerprintV1(publicKey),
                expectedContentKeyFingerprint: null,
                expectedSettingsVersion: 0,
                settingsContent: null,
                connectedServices: { action: "assert_empty" },
                automations: { action: "assert_empty" },
                machines: { action: "assert_empty" },
                todos: { action: "assert_empty" },
                artifacts: { action: "assert_empty" },
                sessions: { action: "assert_empty" },
                reviewComments: { action: "assert_empty" },
                sessionOrganization: { action: "assert_empty" },
                pets: { action: "assert_empty" },
                keyProof: {
                    v: 1,
                    publicKey: privacyKit.encodeBase64(publicKey),
                    contentPublicKey: contentBinding.contentPublicKey,
                    contentPublicKeySig: contentBinding.contentPublicKeySig,
                },
            },
        });
        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                },
                payload: request,
            });

            expect(response.statusCode, response.body).toBe(400);
            expect(response.json()).toEqual({ error: "migration_too_large" });
            await expect(db.account.findUniqueOrThrow({
                where: { id: account.id },
                select: {
                    encryptionMode: true,
                    contentPublicKey: true,
                    contentPublicKeySig: true,
                    settingsVersion: true,
                    seq: true,
                },
            })).resolves.toEqual({
                encryptionMode: "plain",
                contentPublicKey: null,
                contentPublicKeySig: null,
                settingsVersion: 0,
                seq: account.seq,
            });
            const retainedPluginStorage = await db.userKVStore.findUniqueOrThrow({
                where: {
                    accountId_key: {
                        accountId: account.id,
                        key: pluginStorageKey,
                    },
                },
                select: { value: true },
            });
            expect(Buffer.from(retainedPluginStorage.value ?? []).toString("utf8")).toBe(
                JSON.stringify({
                    t: "plain",
                    v: { v: 1, values: {} },
                }),
            );
            await expect(db.accountChange.count({
                where: { accountId: account.id },
            })).resolves.toBe(0);
        } finally {
            await app.close();
        }
    });

    it("rejects proposed-key self-signing for a genuinely keyless plain Account", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const account = await db.account.create({
            data: {
                publicKey: null,
                encryptionMode: "plain",
                settings: null,
                settingsVersion: 0,
            },
            select: { id: true, seq: true },
        });
        const kp = tweetnacl.sign.keyPair();
        const secretKey = new Uint8Array(kp.secretKey);
        const contentBinding =
            createSignedContentKeyBinding(secretKey);
        const request = signPlainToE2eeMigrationRequest({
            accountId: account.id,
            signingSecretKey: secretKey,
            request: {
                toMode: "e2ee",
                expectedAccountVersion: account.seq,
                expectedSigningKeyFingerprint: null,
                expectedContentKeyFingerprint: null,
                expectedSettingsVersion: 0,
                settingsContent: null,
                connectedServices: { action: "assert_empty" },
                automations: { action: "assert_empty" },
                machines: { action: "assert_empty" },
                todos: { action: "assert_empty" },
                artifacts: { action: "assert_empty" },
                sessions: { action: "assert_empty" },
                reviewComments: { action: "assert_empty" },
                sessionOrganization: { action: "assert_empty" },
                pets: { action: "assert_empty" },
                keyProof: {
                    v: 1,
                    publicKey: privacyKit.encodeBase64(
                        new Uint8Array(kp.publicKey),
                    ),
                    contentPublicKey:
                        contentBinding.contentPublicKey,
                    contentPublicKeySig:
                        contentBinding.contentPublicKeySig,
                },
            },
        });
        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                },
                payload: request,
            });
            expect(response.statusCode, response.body).toBe(400);
            expect(response.json()).toEqual({
                error: "invalid-params",
                reason: "key_proof_required",
            });
            await expect(db.account.findUniqueOrThrow({
                where: { id: account.id },
                select: {
                    encryptionMode: true,
                    publicKey: true,
                    contentPublicKey: true,
                    settingsVersion: true,
                    seq: true,
                },
            })).resolves.toEqual({
                encryptionMode: "plain",
                publicKey: null,
                contentPublicKey: null,
                settingsVersion: 0,
                seq: account.seq,
            });
        } finally {
            await app.close();
        }
    });

    it("rejects automation migration templates outside the authenticated account", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });

        const account = await db.account.create({
            data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee", settings: "owned-settings", settingsVersion: 0 },
            select: { id: true },
        });
        const otherAccount = await db.account.create({
            data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee", settings: "foreign-settings", settingsVersion: 0 },
            select: { id: true },
        });
        const ownedTemplateCiphertext = JSON.stringify({
            kind: "happier_automation_template_encrypted_v1",
            payloadCiphertext: "owned-original",
        });
        const foreignTemplateCiphertext = JSON.stringify({
            kind: "happier_automation_template_encrypted_v1",
            payloadCiphertext: "foreign-original",
        });
        const ownedAutomation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "owned automation migration",
                scheduleKind: "interval",
                everyMs: 60_000,
                timezone: null,
                scheduleExpr: null,
                targetType: "new_session",
                templateCiphertext: ownedTemplateCiphertext,
            },
            select: { id: true, templateVersion: true },
        });
        const foreignAutomation = await db.automation.create({
            data: {
                accountId: otherAccount.id,
                name: "foreign automation migration",
                scheduleKind: "interval",
                everyMs: 60_000,
                timezone: null,
                scheduleExpr: null,
                targetType: "new_session",
                templateCiphertext: foreignTemplateCiphertext,
            },
            select: { id: true, templateVersion: true },
        });

        const plainTemplate = JSON.stringify({
            kind: "happier_automation_template_plain_v1",
            payload: { v: 1, name: "foreign overwrite attempt" },
        });

        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                toMode: "plain",
                expectedSettingsVersion: 0,
                settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                connectedServices: { action: "assert_empty" },
                automations: {
                    action: "migrate",
                    templates: [{
                        automationId: foreignAutomation.id,
                        expectedTemplateVersion:
                            foreignAutomation.templateVersion,
                        templateCiphertext: plainTemplate,
                    }],
                },
                machines: { action: "assert_empty" },
                todos: { action: "assert_empty" },
                artifacts: { action: "assert_empty" },
            },
        });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "automations_not_empty" });
        await expect(db.automation.findUnique({
            where: { id: ownedAutomation.id },
            select: { accountId: true, templateCiphertext: true },
        })).resolves.toEqual({ accountId: account.id, templateCiphertext: ownedTemplateCiphertext });
        await expect(db.automation.findUnique({
            where: { id: foreignAutomation.id },
            select: { accountId: true, templateCiphertext: true },
        })).resolves.toEqual({ accountId: otherAccount.id, templateCiphertext: foreignTemplateCiphertext });
        await expect(db.account.findUnique({
            where: { id: account.id },
            select: { encryptionMode: true, settingsVersion: true, settings: true },
        })).resolves.toEqual({ encryptionMode: "e2ee", settingsVersion: 0, settings: "owned-settings" });

        await app.close();
    });

    it("returns migration_too_large for an oversized retained Automation Run inventory without mutation", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });

        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: "ciphertext",
                settingsVersion: 0,
            },
            select: { id: true },
        });
        const originalTemplateCiphertext = JSON.stringify({
            kind: "happier_automation_template_encrypted_v1",
            payloadCiphertext: "oversized-original",
        });
        const automation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "oversized Automation Run migration",
                enabled: false,
                scheduleKind: "interval",
                everyMs: 60_000,
                targetType: "new_session",
                templateCiphertext: originalTemplateCiphertext,
            },
            select: { id: true, templateVersion: true },
        });
        await db.automationRun.createMany({
            data: Array.from({
                length: ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATIONS_MAX_ITEMS + 1,
            }, (_, index) => ({
                id: `route-account-encryption-too-large-${index}`,
                automationId: automation.id,
                accountId: account.id,
                state: "queued" as const,
                originKind: "scheduled" as const,
                executionInputEnvelope: JSON.stringify({ index }),
                scheduledAt: new Date(index),
                dueAt: new Date(index),
            })),
        });

        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: {
                "content-type": "application/json",
                "x-test-user-id": account.id,
            },
            payload: {
                toMode: "plain",
                expectedSettingsVersion: 0,
                settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                connectedServices: { action: "assert_empty" },
                automations: {
                    action: "migrate",
                    templates: [{
                        automationId: automation.id,
                        expectedTemplateVersion: automation.templateVersion,
                        templateCiphertext: JSON.stringify({
                            kind: "happier_automation_template_plain_v1",
                            payload: { prompt: "oversized replacement" },
                        }),
                    }],
                    runs: [],
                },
                machines: { action: "assert_empty" },
                todos: { action: "assert_empty" },
                artifacts: { action: "assert_empty" },
            },
        });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "migration_too_large" });
        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: {
                encryptionMode: true,
                settings: true,
                settingsVersion: true,
            },
        })).resolves.toEqual({
            encryptionMode: "e2ee",
            settings: "ciphertext",
            settingsVersion: 0,
        });
        await expect(db.automation.findUniqueOrThrow({
            where: { id: automation.id },
            select: { templateCiphertext: true, templateVersion: true },
        })).resolves.toEqual({
            templateCiphertext: originalTemplateCiphertext,
            templateVersion: automation.templateVersion,
        });
        await expect(db.automationRun.count({
            where: { accountId: account.id },
        })).resolves.toBe(
            ACCOUNT_ENCRYPTION_MIGRATE_AUTOMATIONS_MAX_ITEMS + 1,
        );

        await app.close();
    });

    it("rejects duplicate automation migration ids without rewriting templates", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });

        const account = await db.account.create({
            data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee", settings: "ciphertext", settingsVersion: 0 },
            select: { id: true },
        });
        const originalTemplateCiphertext = JSON.stringify({
            kind: "happier_automation_template_encrypted_v1",
            payloadCiphertext: "original",
        });
        const automation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "duplicate automation migration",
                scheduleKind: "interval",
                everyMs: 60_000,
                timezone: null,
                scheduleExpr: null,
                targetType: "new_session",
                templateCiphertext: originalTemplateCiphertext,
            },
            select: { id: true, templateVersion: true },
        });

        const plainTemplateOne = JSON.stringify({
            kind: "happier_automation_template_plain_v1",
            payload: { v: 1, name: "first" },
        });
        const plainTemplateTwo = JSON.stringify({
            kind: "happier_automation_template_plain_v1",
            payload: { v: 1, name: "second" },
        });

        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();

        const res = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                toMode: "plain",
                expectedSettingsVersion: 0,
                settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                connectedServices: { action: "assert_empty" },
                automations: {
                    action: "migrate",
                    templates: [
                        {
                            automationId: automation.id,
                            expectedTemplateVersion:
                                automation.templateVersion,
                            templateCiphertext:
                                plainTemplateOne,
                        },
                        {
                            automationId: automation.id,
                            expectedTemplateVersion:
                                automation.templateVersion,
                            templateCiphertext:
                                plainTemplateTwo,
                        },
                    ],
                },
                machines: { action: "assert_empty" },
                todos: { action: "assert_empty" },
                artifacts: { action: "assert_empty" },
            },
        });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: "automations_not_empty" });
        await expect(db.automation.findUnique({
            where: { id: automation.id },
            select: { templateCiphertext: true },
        })).resolves.toEqual({ templateCiphertext: originalTemplateCiphertext });

        await app.close();
    });

    it("leaves a concurrent plain automation update untouched when enablement is fail-closed", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const kp = tweetnacl.sign.keyPair();
        const publicKey = Uint8Array.from(kp.publicKey);
        const challenge = Uint8Array.from(crypto.getRandomValues(new Uint8Array(32)));
        const signature = Uint8Array.from(tweetnacl.sign.detached(challenge, Uint8Array.from(kp.secretKey)));
        const contentBinding =
            createSignedContentKeyBinding(new Uint8Array(kp.secretKey));
        const account = await db.account.create({
            data: {
                publicKey: privacyKit.encodeHex(publicKey),
                encryptionMode: "plain",
                settings: null,
                settingsVersion: 0,
            },
            select: { id: true },
        });
        const initialPlainTemplate = JSON.stringify({
            kind: "happier_automation_template_plain_v1",
            payload: { prompt: "initial" },
        });
        const stalePlainTemplate = JSON.stringify({
            kind: "happier_automation_template_plain_v1",
            payload: { prompt: "stale update" },
        });
        const migratedEncryptedTemplate = JSON.stringify({
            kind: "happier_automation_template_encrypted_v1",
            payloadCiphertext: "migrated-ciphertext",
        });
        const automation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "Migration race",
                enabled: false,
                scheduleKind: "interval",
                everyMs: 60_000,
                timezone: null,
                scheduleExpr: null,
                targetType: "new_session",
                templateCiphertext: initialPlainTemplate,
            },
            select: { id: true, templateVersion: true },
        });

        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        registerAutomationCrudRoutes(app as any);
        await app.ready();
        const barrier = installAccountModeReadBarrier(account.id);
        try {
            const automationPatch = app.inject({
                method: "PATCH",
                url: `/v2/automations/${automation.id}`,
                headers: { "content-type": "application/json", "x-test-user-id": account.id },
                payload: { templateCiphertext: stalePlainTemplate },
            });
            await barrier.modeObserved;

            const migration = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: { "content-type": "application/json", "x-test-user-id": account.id },
                payload: {
                    toMode: "e2ee",
                    expectedSettingsVersion: 0,
                    settingsContent: { t: "encrypted", c: "settings-ciphertext" },
                    connectedServices: { action: "assert_empty" },
                    automations: {
                        action: "migrate",
                        templates: [{
                            automationId: automation.id,
                            expectedTemplateVersion:
                                automation.templateVersion,
                            templateCiphertext:
                                migratedEncryptedTemplate,
                        }],
                    },
                    machines: { action: "assert_empty" },
                    todos: { action: "assert_empty" },
                    artifacts: { action: "assert_empty" },
                    keyProof: {
                        publicKey: privacyKit.encodeBase64(publicKey),
                        challenge: privacyKit.encodeBase64(challenge),
                        signature: privacyKit.encodeBase64(signature),
                        contentPublicKey: contentBinding.contentPublicKey,
                        contentPublicKeySig: contentBinding.contentPublicKeySig,
                    },
                },
            });
            expect(migration.statusCode).toBe(400);
            expect(migration.json()).toEqual({
                error: "invalid-params",
            });

            barrier.release();
            const patchResult = await automationPatch;
            expect(patchResult.statusCode).toBe(200);
        } finally {
            barrier.restore();
            await app.close();
        }

        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: { encryptionMode: true },
        })).resolves.toEqual({ encryptionMode: "plain" });
        await expect(db.automation.findUniqueOrThrow({
            where: { id: automation.id },
            select: { templateCiphertext: true },
        })).resolves.toEqual({
            templateCiphertext: stalePlainTemplate,
        });
    });

    it("rolls back credential rewrites when a later automation migration fails", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const account = await db.account.create({
            data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee", settings: "ciphertext", settingsVersion: 0 },
            select: { id: true },
        });
        const previousRevision = "csr_AAAAAAAAAAAAAAAAAAAAAA";
        await db.serviceAccountToken.create({
            data: {
                accountId: account.id, vendor: "anthropic", profileId: "default",
                ...createLegacyCredentialFixtureIdentity({
                    serviceId: "anthropic",
                    profileId: "default",
                }),
                token: new TextEncoder().encode("sealed-before-rollback"),
                metadata: { v: 2, format: "account_scoped_v1", kind: "token", credentialRevision: previousRevision },
                refreshLeaseOwnerMachineId: "stale-daemon:rollback",
                refreshLeaseExpiresAt: new Date(Date.now() + 60_000),
            },
        });
        const automation = await db.automation.create({
            data: {
                accountId: account.id, name: "rollback automation", scheduleKind: "interval", everyMs: 60_000,
                timezone: null, scheduleExpr: null, targetType: "new_session",
                templateCiphertext: JSON.stringify({ kind: "happier_automation_template_encrypted_v1", payloadCiphertext: "before" }),
            },
            select: { id: true },
        });
        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();
        const res = await app.inject({
            method: "POST", url: "/v1/account/encryption/migrate",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                toMode: "plain", expectedSettingsVersion: 0,
                settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                connectedServices: { action: "migrate", credentials: [{
                    serviceId: "anthropic", profileId: "default", kind: "plain",
                    record: {
                        v: 1, serviceId: "anthropic", profileId: "default", createdAt: 1, updatedAt: 2,
                        expiresAt: null, kind: "token", oauth: null,
                        token: { token: "plain-should-rollback", providerAccountId: null, providerEmail: null, raw: null },
                    },
                }] },
                automations: { action: "migrate", templates: [{ automationId: automation.id, templateCiphertext: "invalid-template" }] },
                machines: { action: "assert_empty" },
                todos: { action: "assert_empty" },
                artifacts: { action: "assert_empty" },
            },
        });
        expect(res.statusCode).toBe(400);
        await expect(db.account.findUnique({ where: { id: account.id }, select: { encryptionMode: true, settingsVersion: true, settings: true } }))
            .resolves.toEqual({ encryptionMode: "e2ee", settingsVersion: 0, settings: "ciphertext" });
        const credential = await db.serviceAccountToken.findUnique({
            where: { accountId_vendor_profileId: { accountId: account.id, vendor: "anthropic", profileId: "default" } },
            select: { token: true, metadata: true, refreshLeaseOwnerMachineId: true, refreshLeaseExpiresAt: true },
        });
        expect(new TextDecoder().decode(credential?.token)).toBe("sealed-before-rollback");
        expect(credential?.metadata).toEqual(expect.objectContaining({ credentialRevision: previousRevision }));
        expect(credential?.refreshLeaseOwnerMachineId).toBe("stale-daemon:rollback");
        expect(credential?.refreshLeaseExpiresAt).not.toBeNull();
        await app.close();
    });

    it("does not rewrite an earlier credential when a later credential has the wrong target mode", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: "none",
        });
        const account = await db.account.create({
            data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee", settings: "ciphertext", settingsVersion: 0 },
            select: { id: true },
        });
        const previousRevision = "csr_AAAAAAAAAAAAAAAAAAAAAA";
        for (const profileId of ["default", "work"] as const) {
            await db.serviceAccountToken.create({
                data: {
                    accountId: account.id,
                    vendor: "anthropic",
                    profileId,
                    ...createLegacyCredentialFixtureIdentity({
                        serviceId: "anthropic",
                        profileId,
                    }),
                    token: new TextEncoder().encode(`sealed-${profileId}-before-rollback`),
                    metadata: { v: 2, format: "account_scoped_v1", kind: "token", credentialRevision: previousRevision },
                    refreshLeaseOwnerMachineId: `stale-daemon:${profileId}`,
                    refreshLeaseExpiresAt: new Date(Date.now() + 60_000),
                },
            });
        }

        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();
        const res = await app.inject({
            method: "POST",
            url: "/v1/account/encryption/migrate",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                toMode: "plain",
                expectedSettingsVersion: 0,
                settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                connectedServices: {
                    action: "migrate",
                    credentials: [
                        {
                            serviceId: "anthropic",
                            profileId: "default",
                            kind: "plain",
                            record: {
                                v: 1,
                                serviceId: "anthropic",
                                profileId: "default",
                                createdAt: 1,
                                updatedAt: 2,
                                expiresAt: null,
                                kind: "token",
                                oauth: null,
                                token: { token: "plain-should-rollback", providerAccountId: null, providerEmail: null, raw: null },
                            },
                        },
                        {
                            serviceId: "anthropic",
                            profileId: "work",
                            kind: "sealed",
                            sealed: { format: "account_scoped_v1", ciphertext: "wrong-mode-late" },
                        },
                    ],
                },
                automations: { action: "assert_empty" },
                machines: { action: "assert_empty" },
                todos: { action: "assert_empty" },
                artifacts: { action: "assert_empty" },
            },
        });

        expect(res.statusCode).toBe(400);
        await expect(db.account.findUnique({
            where: { id: account.id },
            select: { encryptionMode: true, settingsVersion: true, settings: true },
        })).resolves.toEqual({ encryptionMode: "e2ee", settingsVersion: 0, settings: "ciphertext" });
        for (const profileId of ["default", "work"] as const) {
            const credential = await db.serviceAccountToken.findUnique({
                where: { accountId_vendor_profileId: { accountId: account.id, vendor: "anthropic", profileId } },
                select: { token: true, metadata: true, refreshLeaseOwnerMachineId: true, refreshLeaseExpiresAt: true },
            });
            expect(new TextDecoder().decode(credential?.token)).toBe(`sealed-${profileId}-before-rollback`);
            expect(credential?.metadata).toEqual(expect.objectContaining({ credentialRevision: previousRevision }));
            expect(credential?.refreshLeaseOwnerMachineId).toBe(`stale-daemon:${profileId}`);
            expect(credential?.refreshLeaseExpiresAt).not.toBeNull();
        }

        await app.close();
    });

    it("does not let another Account's split Session block or join a migration", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const accountAFixture =
            await createAccountMigrationSessionGuardFixture({
                archivedAt: null,
                metadataLayoutVersion: 0,
            });
        const accountBFixture =
            await createAccountMigrationSessionGuardFixture({
                archivedAt: null,
                metadataLayoutVersion: 1,
            });
        const accountBBefore = await db.account.findUniqueOrThrow({
            where: { id: accountBFixture.account.id },
        });
        const accountBTokenBefore =
            await db.serviceAccountToken.findFirstOrThrow({
                where: { accountId: accountBFixture.account.id },
            });
        const accountBAutomationBefore = await db.automation.findUniqueOrThrow({
            where: { id: accountBFixture.automation.id },
        });

        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();

        try {
            const successResponse = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": accountAFixture.account.id,
                },
                payload: {
                    toMode: "plain",
                    expectedSettingsVersion: 0,
                    settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                    connectedServices: { action: "clear" },
                    automations: { action: "clear" },
                    machines: { action: "assert_empty" },
                    todos: { action: "assert_empty" },
                    artifacts: { action: "assert_empty" },
                },
            });

            expect(successResponse.statusCode, successResponse.body).toBe(200);
            expect(successResponse.json()).toMatchObject({
                success: true,
                mode: "plain",
                settingsVersion: 1,
            });
            await expect(db.session.findUnique({
                where: { id: accountAFixture.session.id },
                select: {
                    id: true,
                    metadata: true,
                    metadataVersion: true,
                    metadataLayoutVersion: true,
                    ownerMetadata: true,
                    agentState: true,
                    agentStateVersion: true,
                    archivedAt: true,
                },
            })).resolves.toEqual(accountAFixture.session);

            await expect(db.account.findUniqueOrThrow({
                where: { id: accountBFixture.account.id },
            })).resolves.toEqual(accountBBefore);
            await expect(db.serviceAccountToken.findFirstOrThrow({
                where: { accountId: accountBFixture.account.id },
            })).resolves.toEqual(accountBTokenBefore);
            await expect(db.automation.findUniqueOrThrow({
                where: { id: accountBFixture.automation.id },
            })).resolves.toEqual(accountBAutomationBefore);
            await expect(db.session.findUnique({
                where: { id: accountBFixture.session.id },
                select: {
                    id: true,
                    metadata: true,
                    metadataVersion: true,
                    metadataLayoutVersion: true,
                    ownerMetadata: true,
                    agentState: true,
                    agentStateVersion: true,
                    archivedAt: true,
                },
            })).resolves.toEqual(accountBFixture.session);
            await expect(db.accountChange.count({
                where: { accountId: accountBFixture.account.id },
            })).resolves.toBe(0);
        } finally {
            await app.close();
        }
    });

    it("rewrites a layout-1 owner envelope and publishes only the owner's Session cursor", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const owner = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: null,
                settingsVersion: 0,
            },
        });
        const sharedRecipient = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
            },
        });
        const sourceCiphertext = sealOwnerMetadata("source-owner");
        const sourceEnvelope = {
            t: "encrypted" as const,
            c: sourceCiphertext,
        };
        const targetEnvelope = {
            t: "plain" as const,
            v: { v: 1 as const },
        };
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "owner-envelope-success",
                metadata: "shared-bytes-unchanged",
                metadataVersion: 4,
                metadataLayoutVersion: 1,
                ownerMetadata:
                    encodeSessionOwnerMetadataEnvelopeV1(
                        sourceEnvelope,
                    ),
                agentState: "agent-bytes-unchanged",
                agentStateVersion: 7,
            },
        });
        await db.sessionShare.create({
            data: {
                sessionId: session.id,
                sharedByUserId: owner.id,
                sharedWithUserId: sharedRecipient.id,
            },
        });

        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": owner.id,
                },
                payload: {
                    toMode: "plain",
                    expectedSettingsVersion: 0,
                    settingsContent: null,
                    connectedServices: { action: "assert_empty" },
                    automations: { action: "assert_empty" },
                    machines: { action: "assert_empty" },
                    todos: { action: "assert_empty" },
                    artifacts: { action: "assert_empty" },
                    sessions: {
                        action: "migrate",
                        items: [{
                            sessionId: session.id,
                            expectedMetadataLayoutVersion: 1,
                            expectedMetadataVersion: 4,
                            expectedAgentStateVersion: 7,
                            expectedOwnerMetadata: sourceEnvelope,
                            ownerMetadata: targetEnvelope,
                        }],
                    },
                },
            });

            expect(response.statusCode, response.body).toBe(200);
            await expect(db.session.findUniqueOrThrow({
                where: { id: session.id },
                select: {
                    metadata: true,
                    metadataVersion: true,
                    metadataLayoutVersion: true,
                    ownerMetadata: true,
                    agentState: true,
                    agentStateVersion: true,
                },
            })).resolves.toEqual({
                metadata: "shared-bytes-unchanged",
                metadataVersion: 4,
                metadataLayoutVersion: 1,
                ownerMetadata:
                    encodeSessionOwnerMetadataEnvelopeV1(
                        targetEnvelope,
                    ),
                agentState: "agent-bytes-unchanged",
                agentStateVersion: 7,
            });
            await expect(db.accountChange.count({
                where: {
                    accountId: owner.id,
                    kind: "session",
                    entityId: session.id,
                },
            })).resolves.toBe(1);
            await expect(db.accountChange.count({
                where: {
                    accountId: sharedRecipient.id,
                    kind: "session",
                    entityId: session.id,
                },
            })).resolves.toBe(0);
            expect(emitUpdate.mock.calls.some(([event]) =>
                event.userId === sharedRecipient.id
            )).toBe(false);
            expect(emitUpdate.mock.calls.some(([event]) =>
                event.userId === owner.id
                && event.payload?.body?.id === session.id
            )).toBe(true);
        } finally {
            await app.close();
        }
    });

    it("rolls back a Session owner-envelope rewrite and publication when Settings inventory rejects", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const owner = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: "source-settings-ciphertext",
                settingsVersion: 0,
            },
        });
        const sourceEnvelope = {
            t: "encrypted" as const,
            c: sealOwnerMetadata("rollback-source"),
        };
        const targetEnvelope = {
            t: "plain" as const,
            v: { v: 1 as const },
        };
        const encodedSource =
            encodeSessionOwnerMetadataEnvelopeV1(
                sourceEnvelope,
            );
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: "settings-rejection-rollback",
                metadata: "shared-rollback",
                metadataVersion: 2,
                metadataLayoutVersion: 1,
                ownerMetadata: encodedSource,
                agentState: null,
                agentStateVersion: 3,
            },
        });

        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": owner.id,
                },
                payload: {
                    toMode: "plain",
                    expectedSettingsVersion: 0,
                    // Source Settings is non-null, so this is a schema-valid
                    // inventory mismatch after the Session preconditions pass.
                    settingsContent: null,
                    connectedServices: { action: "assert_empty" },
                    automations: { action: "assert_empty" },
                    machines: { action: "assert_empty" },
                    todos: { action: "assert_empty" },
                    artifacts: { action: "assert_empty" },
                    sessions: {
                        action: "migrate",
                        items: [{
                            sessionId: session.id,
                            expectedMetadataLayoutVersion: 1,
                            expectedMetadataVersion: 2,
                            expectedAgentStateVersion: 3,
                            expectedOwnerMetadata: sourceEnvelope,
                            ownerMetadata: targetEnvelope,
                        }],
                    },
                },
            });

            expect(response.statusCode, response.body).toBe(400);
            expect(response.json()).toEqual({
                error: "invalid-params",
                reason: "migration_inventory_changed",
            });
            await expect(db.session.findUniqueOrThrow({
                where: { id: session.id },
                select: { ownerMetadata: true },
            })).resolves.toEqual({
                ownerMetadata: encodedSource,
            });
            await expect(db.account.findUniqueOrThrow({
                where: { id: owner.id },
                select: {
                    encryptionMode: true,
                    settings: true,
                    settingsVersion: true,
                },
            })).resolves.toEqual({
                encryptionMode: "e2ee",
                settings: "source-settings-ciphertext",
                settingsVersion: 0,
            });
            await expect(db.accountChange.count({
                where: { accountId: owner.id },
            })).resolves.toBe(0);
            expect(emitUpdate).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it("refuses an Account migration when an active layout-1 Session requires owner-metadata reseal", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const fixture = await createAccountMigrationSessionGuardFixture({
            archivedAt: null,
            metadataLayoutVersion: 1,
        });
        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();

        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": fixture.account.id,
                },
                payload: {
                    toMode: "plain",
                    expectedSettingsVersion: 0,
                    settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                    connectedServices: { action: "clear" },
                    automations: { action: "clear" },
                    machines: { action: "assert_empty" },
                    todos: { action: "assert_empty" },
                    artifacts: { action: "assert_empty" },
                },
            });

            expect(response.statusCode, response.body).toBe(400);
            expect(response.json()).toEqual({
                error: "metadata_privacy_upgrade_required",
            });
            await expect(db.account.findUnique({
                where: { id: fixture.account.id },
                select: {
                    encryptionMode: true,
                    settings: true,
                    settingsVersion: true,
                },
            })).resolves.toEqual({
                encryptionMode: "e2ee",
                settings: "ciphertext",
                settingsVersion: 0,
            });
            await expect(db.serviceAccountToken.count({
                where: { accountId: fixture.account.id },
            })).resolves.toBe(1);
            await expect(db.automation.findUnique({
                where: { id: fixture.automation.id },
                select: { templateCiphertext: true },
            })).resolves.toEqual({
                templateCiphertext: "automation-before-migration",
            });
            await expect(db.session.findUnique({
                where: { id: fixture.session.id },
                select: {
                    id: true,
                    metadata: true,
                    metadataVersion: true,
                    metadataLayoutVersion: true,
                    ownerMetadata: true,
                    agentState: true,
                    agentStateVersion: true,
                    archivedAt: true,
                },
            })).resolves.toEqual(fixture.session);
            await expect(db.accountChange.count({
                where: { accountId: fixture.account.id },
            })).resolves.toBe(0);
            expect(emitUpdate).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it("refuses an Account migration when an archived layout-1 Session requires owner-metadata reseal", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const fixture = await createAccountMigrationSessionGuardFixture({
            archivedAt: new Date(1_700_000_000_000),
            metadataLayoutVersion: 1,
        });
        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();

        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": fixture.account.id,
                },
                payload: {
                    toMode: "plain",
                    expectedSettingsVersion: 0,
                    settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                    connectedServices: { action: "clear" },
                    automations: { action: "clear" },
                    machines: { action: "assert_empty" },
                    todos: { action: "assert_empty" },
                    artifacts: { action: "assert_empty" },
                },
            });

            expect(response.statusCode, response.body).toBe(400);
            expect(response.json()).toEqual({
                error: "metadata_privacy_upgrade_required",
            });
            await expect(db.account.findUnique({
                where: { id: fixture.account.id },
                select: {
                    encryptionMode: true,
                    settings: true,
                    settingsVersion: true,
                },
            })).resolves.toEqual({
                encryptionMode: "e2ee",
                settings: "ciphertext",
                settingsVersion: 0,
            });
            await expect(db.serviceAccountToken.count({
                where: { accountId: fixture.account.id },
            })).resolves.toBe(1);
            await expect(db.automation.findUnique({
                where: { id: fixture.automation.id },
                select: { templateCiphertext: true },
            })).resolves.toEqual({
                templateCiphertext: "automation-before-migration",
            });
            await expect(db.session.findUnique({
                where: { id: fixture.session.id },
                select: {
                    id: true,
                    metadata: true,
                    metadataVersion: true,
                    metadataLayoutVersion: true,
                    ownerMetadata: true,
                    agentState: true,
                    agentStateVersion: true,
                    archivedAt: true,
                },
            })).resolves.toEqual(fixture.session);
            await expect(db.accountChange.count({
                where: { accountId: fixture.account.id },
            })).resolves.toBe(0);
            expect(emitUpdate).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it("fails closed when an Account owns a future-layout Session", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const fixture = await createAccountMigrationSessionGuardFixture({
            archivedAt: null,
            metadataLayoutVersion: 2,
            ownerMetadata: null,
        });
        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();

        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": fixture.account.id,
                },
                payload: {
                    toMode: "plain",
                    expectedSettingsVersion: 0,
                    settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                    connectedServices: { action: "clear" },
                    automations: { action: "clear" },
                    machines: { action: "assert_empty" },
                    todos: { action: "assert_empty" },
                    artifacts: { action: "assert_empty" },
                },
            });

            expect(response.statusCode, response.body).toBe(400);
            expect(response.json()).toEqual({
                error: "metadata_privacy_upgrade_required",
            });
            await expectAccountMigrationGuardRefusalLeavesFixtureUnchanged(
                fixture,
            );
        } finally {
            await app.close();
        }
    });

    it("fails closed when a layout-0 Session has malformed owner metadata", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const fixture = await createAccountMigrationSessionGuardFixture({
            archivedAt: null,
            metadataLayoutVersion: 0,
            ownerMetadata: sealOwnerMetadata("malformed-layout-zero"),
        });
        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();

        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": fixture.account.id,
                },
                payload: {
                    toMode: "plain",
                    expectedSettingsVersion: 0,
                    settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                    connectedServices: { action: "clear" },
                    automations: { action: "clear" },
                    machines: { action: "assert_empty" },
                    todos: { action: "assert_empty" },
                    artifacts: { action: "assert_empty" },
                },
            });

            expect(response.statusCode, response.body).toBe(400);
            expect(response.json()).toEqual({
                error: "metadata_privacy_upgrade_required",
            });
            await expectAccountMigrationGuardRefusalLeavesFixtureUnchanged(
                fixture,
            );
        } finally {
            await app.close();
        }
    });

    it("decides the layout-1 refusal after a concurrent Session writer releases the shared Account-first fence", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const fixture = await createAccountMigrationSessionGuardFixture({
            archivedAt: null,
            metadataLayoutVersion: 0,
        });
        const writerAcquired = deferred();
        const releaseWriter = deferred();
        const sessionWriter = inTx(async (tx) => {
            await acquireAccountSessionOwnerMetadataFenceInTx(
                tx,
                fixture.account.id,
            );
            await tx.session.update({
                where: { id: fixture.session.id },
                data: {
                    metadataLayoutVersion: 1,
                    ownerMetadata: sealOwnerMetadata("concurrent-owner"),
                },
            });
            writerAcquired.resolve();
            await releaseWriter.promise;
        });

        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();
        await writerAcquired.promise;
        let migrationSettled = false;
        const migration = (async () => {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": fixture.account.id,
                },
                payload: {
                    toMode: "plain",
                    expectedSettingsVersion: 0,
                    settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                    connectedServices: { action: "clear" },
                    automations: { action: "clear" },
                    machines: { action: "assert_empty" },
                    todos: { action: "assert_empty" },
                    artifacts: { action: "assert_empty" },
                },
            });
            migrationSettled = true;
            return response;
        })();

        try {
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(migrationSettled).toBe(false);
            releaseWriter.resolve();
            await sessionWriter;

            const response = await migration;
            expect(response.statusCode, response.body).toBe(400);
            expect(response.json()).toEqual({
                error: "metadata_privacy_upgrade_required",
            });
            await expect(db.account.findUnique({
                where: { id: fixture.account.id },
                select: {
                    encryptionMode: true,
                    settings: true,
                    settingsVersion: true,
                },
            })).resolves.toEqual({
                encryptionMode: "e2ee",
                settings: "ciphertext",
                settingsVersion: 0,
            });
            await expect(db.session.findUnique({
                where: { id: fixture.session.id },
                select: {
                    metadataLayoutVersion: true,
                    ownerMetadata: true,
                },
            })).resolves.toEqual({
                metadataLayoutVersion: 1,
                ownerMetadata: sealOwnerMetadata("concurrent-owner"),
            });
            await expect(db.accountChange.count({
                where: { accountId: fixture.account.id },
            })).resolves.toBe(0);
            expect(emitUpdate).not.toHaveBeenCalled();
        } finally {
            releaseWriter.resolve();
            await sessionWriter;
            await app.close();
        }
    }, 30_000);

    it("migrates an Account with layout-0-only Sessions without changing the Session", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const fixture = await createAccountMigrationSessionGuardFixture({
            archivedAt: null,
            metadataLayoutVersion: 0,
        });
        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();

        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": fixture.account.id,
                },
                payload: {
                    toMode: "plain",
                    expectedSettingsVersion: 0,
                    settingsContent: { t: "plain", v: { schemaVersion: 2 } },
                    connectedServices: { action: "clear" },
                    automations: { action: "clear" },
                    machines: { action: "assert_empty" },
                    todos: { action: "assert_empty" },
                    artifacts: { action: "assert_empty" },
                },
            });

            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({
                success: true,
                mode: "plain",
                settingsVersion: 1,
            });
            await expect(db.account.findUnique({
                where: { id: fixture.account.id },
                select: {
                    encryptionMode: true,
                    settingsVersion: true,
                },
            })).resolves.toEqual({
                encryptionMode: "plain",
                settingsVersion: 1,
            });
            await expect(db.serviceAccountToken.count({
                where: { accountId: fixture.account.id },
            })).resolves.toBe(0);
            await expect(db.automation.findUnique({
                where: { id: fixture.automation.id },
            })).resolves.toBeNull();
            await expect(db.session.findUnique({
                where: { id: fixture.session.id },
                select: {
                    id: true,
                    metadata: true,
                    metadataVersion: true,
                    metadataLayoutVersion: true,
                    ownerMetadata: true,
                    agentState: true,
                    agentStateVersion: true,
                    archivedAt: true,
                },
            })).resolves.toEqual(fixture.session);
            await expect(db.accountChange.count({
                where: { accountId: fixture.account.id },
            })).resolves.toBeGreaterThan(0);
            expect(emitUpdate).toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it("refuses a current migration payload from a legacy caller before any write", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: null,
                settingsVersion: 0,
            },
            select: {
                id: true,
                encryptionMode: true,
                settingsVersion: true,
                seq: true,
                updatedAt: true,
            },
        });
        const machine = await db.machine.create({
            data: {
                id: "machine-marker-activation-legacy",
                accountId: account.id,
                metadata: "encrypted-machine-metadata",
                metadataVersion: 2,
                daemonState: "encrypted-daemon-state",
                daemonStateVersion: 3,
                dataEncryptionKey: new Uint8Array([1, 2, 3]),
            },
        });

        const app = createTestApp({
            accountStoredContentCaller: "legacy",
        });
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                },
                payload: {
                    toMode: "plain",
                    expectedSettingsVersion: 0,
                    settingsContent: null,
                    connectedServices: { action: "assert_empty" },
                    automations: { action: "assert_empty" },
                    machines: { action: "migrate", items: [] },
                    todos: { action: "assert_empty" },
                    artifacts: { action: "assert_empty" },
                },
            });

            expect(response.statusCode, response.body).toBe(426);
            expect(response.json()).toEqual({
                error: "client-upgrade-required",
                requirement: {
                    v: 1,
                    kind: "account-stored-content",
                    minimumProtocolVersion: 2,
                },
            });
            await expect(db.account.findUniqueOrThrow({
                where: { id: account.id },
                select: {
                    encryptionMode: true,
                    settingsVersion: true,
                    seq: true,
                    updatedAt: true,
                },
            })).resolves.toEqual({
                encryptionMode: account.encryptionMode,
                settingsVersion: account.settingsVersion,
                seq: account.seq,
                updatedAt: account.updatedAt,
            });
            await expect(db.machine.findUniqueOrThrow({
                where: { id: machine.id },
            })).resolves.toEqual(machine);
            await expect(db.accountChange.count({
                where: { accountId: account.id },
            })).resolves.toBe(0);
            expect(emitUpdate).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it("admits a current all-empty request without operator activation", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const signingKey = tweetnacl.sign.keyPair();
        const contentBinding =
            createSignedContentKeyBinding(signingKey.secretKey);
        const account = await db.account.create({
            data: {
                publicKey: privacyKit.encodeHex(
                    new Uint8Array(signingKey.publicKey),
                ),
                contentPublicKey: contentBinding.contentPublicKeyBytes,
                contentPublicKeySig: contentBinding.contentPublicKeySigBytes,
                encryptionMode: "e2ee",
                settings: null,
                settingsVersion: 0,
            },
            select: {
                id: true,
                encryptionMode: true,
                settingsVersion: true,
                seq: true,
                updatedAt: true,
            },
        });
        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                },
                payload: {
                    toMode: "plain",
                    expectedAccountVersion: account.seq,
                    expectedSigningKeyFingerprint:
                        computeAccountEncryptionMigrateKeyFingerprintV1(
                            signingKey.publicKey,
                        ),
                    expectedContentKeyFingerprint:
                        computeAccountEncryptionMigrateKeyFingerprintV1(
                            contentBinding.contentPublicKeyBytes,
                        ),
                    expectedSettingsVersion: 0,
                    settingsContent: null,
                    connectedServices: { action: "assert_empty" },
                    automations: { action: "assert_empty" },
                    machines: { action: "assert_empty" },
                    todos: { action: "assert_empty" },
                    artifacts: { action: "assert_empty" },
                    sessions: { action: "assert_empty" },
                    reviewComments: { action: "assert_empty" },
                    sessionOrganization: { action: "assert_empty" },
                    pets: { action: "assert_empty" },
                },
            });

            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toEqual({
                success: true,
                mode: "plain",
                settingsVersion: 1,
                accountVersion: 1,
            });
            await expect(db.account.findUniqueOrThrow({
                where: { id: account.id },
                select: {
                    encryptionMode: true,
                    settingsVersion: true,
                },
            })).resolves.toEqual({
                encryptionMode: "plain",
                settingsVersion: 1,
            });
            await expect(db.accountChange.count({
                where: { accountId: account.id },
            })).resolves.toBeGreaterThan(0);
        } finally {
            await app.close();
        }
    });

    it("retains the exact-empty predecessor migration path", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const signingKey = tweetnacl.sign.keyPair();
        const contentBinding =
            createSignedContentKeyBinding(signingKey.secretKey);
        const account = await db.account.create({
            data: {
                publicKey: privacyKit.encodeHex(
                    new Uint8Array(signingKey.publicKey),
                ),
                contentPublicKey: contentBinding.contentPublicKeyBytes,
                contentPublicKeySig: contentBinding.contentPublicKeySigBytes,
                encryptionMode: "e2ee",
                settings: null,
                settingsVersion: 0,
            },
            select: { id: true },
        });
        const app = createTestApp({
            accountStoredContentCaller: "legacy",
        });
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                },
                payload: {
                    toMode: "plain",
                    expectedSettingsVersion: 0,
                    settingsContent: null,
                    connectedServices: { action: "assert_empty" },
                    automations: { action: "assert_empty" },
                },
            });

            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toEqual({
                success: true,
                mode: "plain",
                settingsVersion: 1,
            });
        } finally {
            await app.close();
        }
    });

    it.each([
        {
            name: "Plugin Account KV",
            expectedError: "migration_too_large",
            populate: async (accountId: string) => {
                await db.userKVStore.create({
                    data: {
                        accountId,
                        key: `${PLUGIN_ACCOUNT_STORAGE_KEY_PREFIX}acme.transition-blocker`,
                        value: new TextEncoder().encode("mode-bound-plugin-data"),
                    },
                });
            },
        },
        {
            name: "Plugin Declarative Settings",
            expectedError: "migration_too_large",
            populate: async (accountId: string) => {
                await db.userKVStore.create({
                    data: {
                        accountId,
                        key: `${PLUGIN_DECLARATIVE_SETTINGS_KEY_PREFIX}acme.transition-blocker`,
                        value: new TextEncoder().encode("mode-bound-plugin-settings"),
                    },
                });
            },
        },
        {
            name: "Account Settings History",
            expectedError: "migration_too_large",
            populate: async (accountId: string) => {
                await db.accountSettingsSnapshot.create({
                    data: {
                        accountId,
                        version: 1,
                        settingsDbValue: "retained-settings-history",
                        encryptionMode: "e2ee",
                        contentKind: "encrypted",
                    },
                });
            },
        },
        {
            name: "Review Comments",
            expectedError: "review_comments_not_empty",
            populate: async (accountId: string) => {
                await db.reviewComment.create({
                    data: {
                        id: "review-comment-transition-blocker",
                        accountId,
                        projectId: "project-transition-blocker",
                        threadId: "thread-transition-blocker",
                        state: "open",
                        flagsJson: "{}",
                        anchorJson: JSON.stringify({
                            kind: "file",
                            filePath: "src/example.ts",
                        }),
                        anchorFilePath: "src/example.ts",
                        snapshotEnvelopeJson: JSON.stringify({
                            t: "encrypted",
                            c: "snapshot-source",
                        }),
                        bodyEnvelopeJson: JSON.stringify({
                            t: "encrypted",
                            c: "body-source",
                        }),
                        bodyVersion: 1,
                        authorJson: JSON.stringify({
                            kind: "user",
                            userId: "user-transition-blocker",
                        }),
                        editsJson: "[]",
                        dispositionsJson: "{}",
                        transitionsJson: "[]",
                        serverRevision: 1,
                        createdAt: 1n,
                        updatedAt: 1n,
                    },
                });
                await inTx(async (tx) => {
                    const inventory =
                        await createReviewCommentAccountEncryptionMigrationPersistenceInTx(
                            tx,
                        ).readInventory(accountId);
                    expect(inventory).toHaveLength(1);
                });
            },
        },
        {
            name: "Session Organization",
            expectedError: "session_organization_not_empty",
            populate: async (accountId: string) => {
                await db.sessionOrganizationFolder.create({
                    data: {
                        id: "folder-transition-blocker",
                        accountId,
                        folderKey: "folder-transition-blocker",
                        folderHash: "folder-transition-blocker-hash",
                        displayDbValue: JSON.stringify({
                            t: "encrypted",
                            c: "folder-source",
                        }),
                    },
                });
            },
        },
        {
            name: "Account Pets",
            expectedError: "pets_not_empty",
            populate: async (accountId: string) => {
                await db.accountPetPackage.create({
                    data: {
                        id: "pet-transition-blocker",
                        accountId,
                        packageFormat: "codexAtlasV1",
                        contentMode: "plain",
                        manifest: { id: "pet-transition-blocker" },
                        digest: "sha256:pet-transition-blocker",
                        sizeBytes: 1,
                        origin: { kind: "manualImport" },
                    },
                });
            },
        },
        {
            name: "Plugin Webhooks",
            expectedError: "migration_too_large",
            populate: async (accountId: string) => {
                const route = await db.pluginWebhookRoute.create({
                    data: {
                        id: "route-migrate-transition-blocker",
                        opaqueRouteId: "opaque-migrate-transition-blocker",
                        verifierKind: "github_hmac_sha256_v1",
                        routingKind: "accountEndpoint",
                    },
                });
                const endpoint = await db.pluginWebhookEndpoint.create({
                    data: {
                        id: "endpoint-migrate-transition-blocker",
                        accountId,
                        routeId: route.id,
                        routingKind: "accountEndpoint",
                    },
                });
                await db.pluginWebhookDelivery.create({
                    data: {
                        id: "delivery-migrate-transition-blocker",
                        endpointId: endpoint.id,
                        accountId,
                        routeId: route.id,
                        deliveryIdentityDigest:
                            "b".repeat(64),
                        verifierKind: "github_hmac_sha256_v1",
                        targetMachineId: "machine-migrate-transition-blocker",
                        targetMachineInstallationId:
                            "installation-migrate-transition-blocker",
                        targetMaterializationId:
                            "materialization-migrate-transition-blocker",
                        targetPluginId: "acme.github",
                        targetPluginVersion: "1.0.0",
                        endpointRevision: endpoint.revision,
                        endpointWebhookContributionId: "github-events",
                        endpointHandlerActionId: "handle-webhook",
                        endpointSourceInstanceId:
                            "source-migrate-transition-blocker",
                        payloadKind: "plain",
                        payload: { t: "plain", v: { marker: "payload-bearing" } },
                        payloadBytes: 1n,
                        wireVersion: 1,
                        payloadVersion: 1,
                        state: "dead_letter",
                        nextAttemptAt: new Date("2026-08-10T00:00:00.000Z"),
                        metadataDeleteAt:
                            new Date("2026-11-10T00:00:00.000Z"),
                        receivedAt: new Date("2026-08-10T00:00:00.000Z"),
                    },
                });
            },
        },
    ])("refuses an assert-empty transition when $name is populated", async ({
        expectedError,
        populate,
    }) => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const signingKey = tweetnacl.sign.keyPair();
        const contentBinding =
            createSignedContentKeyBinding(signingKey.secretKey);
        const account = await db.account.create({
            data: {
                publicKey: privacyKit.encodeHex(
                    new Uint8Array(signingKey.publicKey),
                ),
                contentPublicKey: contentBinding.contentPublicKeyBytes,
                contentPublicKeySig: contentBinding.contentPublicKeySigBytes,
                encryptionMode: "e2ee",
                settings: null,
                settingsVersion: 0,
            },
            select: {
                id: true,
                encryptionMode: true,
                settingsVersion: true,
                seq: true,
            },
        });
        await populate(account.id);

        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                },
                payload: {
                    toMode: "plain",
                    expectedSettingsVersion: 0,
                    settingsContent: null,
                    connectedServices: { action: "assert_empty" },
                    automations: { action: "assert_empty" },
                    machines: { action: "assert_empty" },
                    todos: { action: "assert_empty" },
                    artifacts: { action: "assert_empty" },
                    sessions: { action: "assert_empty" },
                    reviewComments: { action: "assert_empty" },
                    sessionOrganization: { action: "assert_empty" },
                    pets: { action: "assert_empty" },
                },
            });

            expect(response.statusCode, response.body).toBe(400);
            expect(response.json()).toEqual({ error: expectedError });
            await expect(db.account.findUniqueOrThrow({
                where: { id: account.id },
                select: {
                    encryptionMode: true,
                    settingsVersion: true,
                    seq: true,
                },
            })).resolves.toEqual({
                encryptionMode: account.encryptionMode,
                settingsVersion: account.settingsVersion,
                seq: account.seq,
            });
            await expect(db.accountChange.count({
                where: { accountId: account.id },
            })).resolves.toBe(0);
        } finally {
            await app.close();
        }
    });

    it("migrates populated Review Comments and Session Organization and replays without writes", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: null,
                settingsVersion: 0,
            },
            select: { id: true, seq: true },
        });
        const fixture =
            await createAmendment9PopulatedMigrationFixture(
                account.id,
            );
        const accountWithBinding =
            await db.account.findUniqueOrThrow({
                where: { id: account.id },
            });
        const fingerprints =
            deriveAccountEncryptionMigrationKeyFingerprints(
                accountWithBinding,
            );
        const request: AccountEncryptionMigrateUnsignedRequest = {
            toMode: "plain",
            expectedAccountVersion: account.seq,
            expectedSigningKeyFingerprint:
                fingerprints.signingKeyFingerprint,
            expectedContentKeyFingerprint:
                fingerprints.contentKeyFingerprint,
            expectedSettingsVersion: 0,
            settingsContent: null,
            connectedServices: { action: "assert_empty" },
            automations: { action: "assert_empty" },
            machines: { action: "assert_empty" },
            todos: { action: "assert_empty" },
            artifacts: { action: "assert_empty" },
            sessions: { action: "assert_empty" },
            reviewComments: fixture.reviewComments,
            sessionOrganization: fixture.sessionOrganization,
            pets: { action: "assert_empty" },
        };
        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();
        try {
            const reviewInventoryResponse = await app.inject({
                method: "GET",
                url:
                    "/v1/account/encryption/migrate/review-comments/inventory",
                headers: {
                    "x-test-user-id": account.id,
                },
            });
            expect(
                reviewInventoryResponse.statusCode,
                reviewInventoryResponse.body,
            ).toBe(200);
            expect(reviewInventoryResponse.json()).toMatchObject({
                v: 1,
                items: [{
                    structural: {
                        id: fixture.comment.id,
                    },
                    events: [{
                        event: {
                            eventId: fixture.event.eventId,
                        },
                    }],
                }],
            });
            const organizationInventoryResponse =
                await app.inject({
                    method: "GET",
                    url:
                        "/v1/account/encryption/migrate/session-organization/inventory",
                    headers: {
                        "x-test-user-id": account.id,
                    },
                });
            expect(
                organizationInventoryResponse.statusCode,
                organizationInventoryResponse.body,
            ).toBe(200);
            expect(
                organizationInventoryResponse.json(),
            ).toEqual({
                version: 5,
                folders: [{
                    folderId: fixture.folder.id,
                    display: {
                        t: "encrypted",
                        c: "folder-source-ciphertext",
                    },
                }],
                tags: [{
                    tagId: fixture.tag.id,
                    display: {
                        t: "encrypted",
                        c: "tag-source-ciphertext",
                    },
                }],
                labels: [{
                    labelKind: fixture.label.labelKind,
                    scopeKey: fixture.label.scopeKey,
                    display: {
                        t: "encrypted",
                        c: "label-source-ciphertext",
                    },
                }],
            });
            const first = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                },
                payload: request,
            });
            expect(first.statusCode, first.body).toBe(200);

            const storedAfterFirst = {
                account: await db.account.findUniqueOrThrow({
                    where: { id: account.id },
                    select: {
                        encryptionMode: true,
                        seq: true,
                        updatedAt: true,
                    },
                }),
                comment: await db.reviewComment.findUniqueOrThrow({
                    where: { id: fixture.comment.id },
                    select: {
                        snapshotEnvelopeJson: true,
                        bodyEnvelopeJson: true,
                        evidenceJson: true,
                        linkedRefsJson: true,
                        suggestedFixJson: true,
                        metadataJson: true,
                        updatedAt: true,
                    },
                }),
                event: await db.reviewCommentEvent
                    .findUniqueOrThrow({
                        where: {
                            eventId: fixture.event.eventId,
                        },
                        select: {
                            eventEnvelopeJson: true,
                        },
                    }),
                checkpoint:
                    await db.sessionOrganizationCheckpoint
                        .findUniqueOrThrow({
                            where: { accountId: account.id },
                            select: {
                                version: true,
                                updatedAt: true,
                            },
                        }),
                accountChanges: await db.accountChange.count({
                    where: { accountId: account.id },
                }),
            };
            expect(storedAfterFirst.account.encryptionMode)
                .toBe("plain");
            expect(storedAfterFirst.comment).toMatchObject({
                snapshotEnvelopeJson:
                    REVIEW_COMMENT_CANONICAL_SENSITIVE_LAYOUT_MARKER_JSON,
                evidenceJson: null,
                linkedRefsJson: null,
                suggestedFixJson: null,
                metadataJson: null,
            });
            expect(JSON.parse(
                storedAfterFirst.comment.bodyEnvelopeJson,
            )).toEqual(
                fixture.reviewComments.items[0]!
                    .targetSensitiveEnvelope,
            );
            expect(JSON.parse(
                storedAfterFirst.event.eventEnvelopeJson,
            )).toEqual(
                fixture.reviewComments.items[0]!.events[0]!
                    .targetSensitiveEnvelope,
            );
            await expect(db.sessionOrganizationFolder
                .findUniqueOrThrow({
                    where: { id: fixture.folder.id },
                    select: { displayDbValue: true },
                })).resolves.toEqual({
                displayDbValue: JSON.stringify(
                    fixture.sessionOrganization.folders[0]!.display,
                ),
            });
            await expect(db.sessionOrganizationTag
                .findUniqueOrThrow({
                    where: { id: fixture.tag.id },
                    select: { displayDbValue: true },
                })).resolves.toEqual({
                displayDbValue: JSON.stringify(
                    fixture.sessionOrganization.tags[0]!.display,
                ),
            });
            await expect(db.sessionOrganizationLabel
                .findUniqueOrThrow({
                    where: { id: fixture.label.id },
                    select: { displayDbValue: true },
                })).resolves.toEqual({
                displayDbValue: JSON.stringify(
                    fixture.sessionOrganization.labels[0]!.display,
                ),
            });
            expect(storedAfterFirst.checkpoint.version).toBe(6);

            emitUpdate.mockClear();
            const replay = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                },
                payload: request,
            });
            expect(replay.statusCode, replay.body).toBe(200);
            expect(replay.json()).toEqual(first.json());
            await expect(db.account.findUniqueOrThrow({
                where: { id: account.id },
                select: {
                    encryptionMode: true,
                    seq: true,
                    updatedAt: true,
                },
            })).resolves.toEqual(storedAfterFirst.account);
            await expect(db.reviewComment.findUniqueOrThrow({
                where: { id: fixture.comment.id },
                select: {
                    snapshotEnvelopeJson: true,
                    bodyEnvelopeJson: true,
                    evidenceJson: true,
                    linkedRefsJson: true,
                    suggestedFixJson: true,
                    metadataJson: true,
                    updatedAt: true,
                },
            })).resolves.toEqual(storedAfterFirst.comment);
            await expect(db.sessionOrganizationCheckpoint
                .findUniqueOrThrow({
                    where: { accountId: account.id },
                    select: {
                        version: true,
                        updatedAt: true,
                    },
                })).resolves.toEqual(storedAfterFirst.checkpoint);
            await expect(db.accountChange.count({
                where: { accountId: account.id },
            })).resolves.toBe(storedAfterFirst.accountChanges);
            expect(emitUpdate).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it("migrates populated Review Comments and Session Organization to E2EE and replays without writes", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const keyPair = tweetnacl.sign.keyPair();
        const signingPublicKey =
            new Uint8Array(keyPair.publicKey);
        const signingSecretKey =
            new Uint8Array(keyPair.secretKey);
        const account = await db.account.create({
            data: {
                publicKey:
                    privacyKit.encodeHex(signingPublicKey),
                encryptionMode: "plain",
                settings: null,
                settingsVersion: 0,
            },
            select: { id: true, seq: true },
        });
        const fixture =
            await createAmendment9PopulatedMigrationFixture(
                account.id,
                "plain",
            );
        const contentBinding =
            createSignedContentKeyBinding(signingSecretKey);
        const unsignedRequest: AccountEncryptionMigrateUnsignedRequest = {
            toMode: "e2ee",
            expectedAccountVersion: account.seq,
            expectedSigningKeyFingerprint:
                computeAccountEncryptionMigrateKeyFingerprintV1(
                    signingPublicKey,
                ),
            expectedContentKeyFingerprint: null,
            expectedSettingsVersion: 0,
            settingsContent: null,
            connectedServices: { action: "assert_empty" },
            automations: { action: "assert_empty" },
            machines: { action: "assert_empty" },
            todos: { action: "assert_empty" },
            artifacts: { action: "assert_empty" },
            sessions: { action: "assert_empty" },
            reviewComments: fixture.reviewComments,
            sessionOrganization: fixture.sessionOrganization,
            pets: { action: "assert_empty" },
            keyProof: {
                v: 1,
                publicKey:
                    privacyKit.encodeBase64(signingPublicKey),
                contentPublicKey:
                    contentBinding.contentPublicKey,
                contentPublicKeySig:
                    contentBinding.contentPublicKeySig,
            },
        };
        const request = signPlainToE2eeMigrationRequest({
            accountId: account.id,
            signingSecretKey,
            request: unsignedRequest,
        });
        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();
        try {
            const first = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                },
                payload: request,
            });
            expect(first.statusCode, first.body).toBe(200);
            const storedAfterFirst = {
                account: await db.account.findUniqueOrThrow({
                    where: { id: account.id },
                    select: {
                        encryptionMode: true,
                        seq: true,
                        updatedAt: true,
                    },
                }),
                comment: await db.reviewComment.findUniqueOrThrow({
                    where: { id: fixture.comment.id },
                    select: {
                        snapshotEnvelopeJson: true,
                        bodyEnvelopeJson: true,
                        evidenceJson: true,
                        linkedRefsJson: true,
                        suggestedFixJson: true,
                        metadataJson: true,
                        updatedAt: true,
                    },
                }),
                checkpoint:
                    await db.sessionOrganizationCheckpoint
                        .findUniqueOrThrow({
                            where: { accountId: account.id },
                            select: {
                                version: true,
                                updatedAt: true,
                            },
                        }),
                accountChanges: await db.accountChange.count({
                    where: { accountId: account.id },
                }),
            };
            expect(storedAfterFirst.account.encryptionMode)
                .toBe("e2ee");
            expect(storedAfterFirst.comment).toMatchObject({
                snapshotEnvelopeJson:
                    REVIEW_COMMENT_CANONICAL_SENSITIVE_LAYOUT_MARKER_JSON,
                evidenceJson: null,
                linkedRefsJson: null,
                suggestedFixJson: null,
                metadataJson: null,
            });
            expect(JSON.parse(
                storedAfterFirst.comment.bodyEnvelopeJson,
            )).toEqual(
                fixture.reviewComments.items[0]!
                    .targetSensitiveEnvelope,
            );
            await expect(db.sessionOrganizationFolder
                .findUniqueOrThrow({
                    where: { id: fixture.folder.id },
                    select: { displayDbValue: true },
                })).resolves.toEqual({
                displayDbValue: JSON.stringify(
                    fixture.sessionOrganization.folders[0]!.display,
                ),
            });
            expect(storedAfterFirst.checkpoint.version).toBe(6);

            emitUpdate.mockClear();
            const replay = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                },
                payload: request,
            });
            expect(replay.statusCode, replay.body).toBe(200);
            expect(replay.json()).toEqual(first.json());
            await expect(db.account.findUniqueOrThrow({
                where: { id: account.id },
                select: {
                    encryptionMode: true,
                    seq: true,
                    updatedAt: true,
                },
            })).resolves.toEqual(storedAfterFirst.account);
            await expect(db.reviewComment.findUniqueOrThrow({
                where: { id: fixture.comment.id },
                select: {
                    snapshotEnvelopeJson: true,
                    bodyEnvelopeJson: true,
                    evidenceJson: true,
                    linkedRefsJson: true,
                    suggestedFixJson: true,
                    metadataJson: true,
                    updatedAt: true,
                },
            })).resolves.toEqual(storedAfterFirst.comment);
            await expect(db.sessionOrganizationCheckpoint
                .findUniqueOrThrow({
                    where: { accountId: account.id },
                    select: {
                        version: true,
                        updatedAt: true,
                    },
                })).resolves.toEqual(storedAfterFirst.checkpoint);
            await expect(db.accountChange.count({
                where: { accountId: account.id },
            })).resolves.toBe(storedAfterFirst.accountChanges);
            expect(emitUpdate).not.toHaveBeenCalled();
        } finally {
            await app.close();
        }
    });

    it("atomically migrates the complete Machine, Todo, and Artifact inventory to plaintext", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST:
                "none",
        });
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: "ciphertext",
                settingsVersion: 0,
            },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-storage-inventory",
                accountId: account.id,
                metadata: "encrypted-machine-metadata",
                metadataVersion: 2,
                daemonState: "encrypted-daemon-state",
                daemonStateVersion: 3,
                dataEncryptionKey: new Uint8Array([1, 2, 3]),
            },
        });
        await db.userKVStore.create({
            data: {
                accountId: account.id,
                key: "todo.index",
                value: new TextEncoder().encode("encrypted-todo"),
                version: 4,
            },
        });
        const artifactId =
            "00000000-0000-4000-8000-000000000001";
        await db.artifact.create({
            data: {
                id: artifactId,
                accountId: account.id,
                header: new TextEncoder().encode("encrypted-header"),
                headerVersion: 5,
                body: new TextEncoder().encode("encrypted-body"),
                bodyVersion: 6,
                dataEncryptionKey: new Uint8Array([4, 5, 6]),
            },
        });

        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();
        try {
            const machineMetadata = encodePlainStoredJson({
                host: "plain-host",
            });
            const machineDaemonState = encodePlainStoredJson({
                status: "running",
            });
            const machineDataKey = encodePlainStoredJson(null);
            const todoValue = encodePlainStoredJson({
                undoneOrder: [],
                completedOrder: [],
            });
            const artifactHeader = encodePlainArtifactStoredContent({
                title: "Plain artifact",
            });
            const artifactBody = encodePlainArtifactStoredContent({
                body: "Plain body",
            });
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                },
                payload: {
                    toMode: "plain",
                    expectedSettingsVersion: 0,
                    settingsContent: {
                        t: "plain",
                        v: { schemaVersion: 2 },
                    },
                    connectedServices: { action: "assert_empty" },
                    automations: { action: "assert_empty" },
                    machines: {
                        action: "migrate",
                        items: [{
                            machineId: "machine-storage-inventory",
                            expectedMetadataVersion: 2,
                            expectedDaemonStateVersion: 3,
                            metadata: machineMetadata,
                            daemonState: machineDaemonState,
                            dataEncryptionKey: machineDataKey,
                            contentPublicKeyFingerprint: null,
                        }],
                    },
                    todos: {
                        action: "migrate",
                        items: [{
                            key: "todo.index",
                            expectedVersion: 4,
                            value: todoValue,
                        }],
                    },
                    artifacts: {
                        action: "migrate",
                        items: [{
                            artifactId,
                            expectedHeaderVersion: 5,
                            expectedBodyVersion: 6,
                            header: artifactHeader,
                            body: artifactBody,
                            dataEncryptionKey:
                                ARTIFACT_PLAIN_DATA_KEY_MARKER,
                        }],
                    },
                },
            });

            expect(response.statusCode, response.body).toBe(200);
            await expect(db.account.findUnique({
                where: { id: account.id },
                select: {
                    encryptionMode: true,
                    settingsVersion: true,
                },
            })).resolves.toEqual({
                encryptionMode: "plain",
                settingsVersion: 1,
            });
            await expect(db.machine.findUnique({
                where: { id: "machine-storage-inventory" },
                select: {
                    metadata: true,
                    metadataVersion: true,
                    daemonState: true,
                    daemonStateVersion: true,
                    contentPublicKeyFingerprint: true,
                },
            })).resolves.toEqual({
                metadata: machineMetadata,
                metadataVersion: 3,
                daemonState: machineDaemonState,
                daemonStateVersion: 4,
                contentPublicKeyFingerprint: null,
            });
            await expect(db.userKVStore.findUnique({
                where: {
                    accountId_key: {
                        accountId: account.id,
                        key: "todo.index",
                    },
                },
                select: { value: true, version: true },
            })).resolves.toMatchObject({
                value: new Uint8Array(Buffer.from(todoValue, "base64")),
                version: 5,
            });
            const storedArtifact = await db.artifact.findUnique({
                where: { id: artifactId },
                select: {
                    header: true,
                    headerVersion: true,
                    body: true,
                    bodyVersion: true,
                },
            });
            expect(storedArtifact).toMatchObject({
                headerVersion: 6,
                bodyVersion: 7,
            });
            expect(
                Buffer.from(storedArtifact!.header).toString("base64"),
            ).toBe(artifactHeader);
            expect(
                Buffer.from(storedArtifact!.body).toString("base64"),
            ).toBe(artifactBody);
        } finally {
            await app.close();
        }
    });

    it("returns the fae505 reader-compatible proof refusal before reading an Account", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": "missing-fae505-predecessor-account",
                },
                payload: {
                    toMode: "e2ee",
                    expectedSettingsVersion: 0,
                    settingsContent: {
                        t: "encrypted",
                        c: "opaque-fae505-settings",
                    },
                    connectedServices: { action: "assert_empty" },
                    automations: { action: "assert_empty" },
                },
            });

            expect(response.statusCode, response.body).toBe(426);
            expect(response.json()).toEqual({
                error: "client-upgrade-required",
                requirement: {
                    v: 1,
                    kind: "account-stored-content",
                    minimumProtocolVersion: 2,
                },
            });
        } finally {
            await app.close();
        }
    });

    it("returns an old-reader-safe refusal for an oversized fae505 request", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const templateCiphertext = "x".repeat(220_000);
        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id":
                        "missing-oversized-fae505-predecessor-account",
                },
                payload: {
                    toMode: "plain",
                    expectedSettingsVersion: 0,
                    settingsContent: null,
                    connectedServices: { action: "assert_empty" },
                    automations: {
                        action: "migrate",
                        templates: Array.from(
                            { length: 40 },
                            (_, index) => ({
                                automationId: `oversized-${index}`,
                                templateCiphertext,
                            }),
                        ),
                    },
                },
            });

            expect(response.statusCode, response.body).toBe(400);
            expect(
                FAE505_ACCOUNT_ENCRYPTION_MIGRATE_BAD_REQUEST_READER
                    .parse(response.json()),
            ).toEqual({ error: "invalid-params" });
        } finally {
            await app.close();
        }
    });

    it("rejects the predecessor request before mutation when a newly-covered domain is populated", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: null,
                settingsVersion: 0,
            },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-predecessor-populated",
                accountId: account.id,
                metadata: "encrypted-machine-metadata",
            },
        });

        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                },
                payload: {
                    toMode: "plain",
                    expectedSettingsVersion: 0,
                    settingsContent: {
                        t: "plain",
                        v: { schemaVersion: 2 },
                    },
                    connectedServices: { action: "assert_empty" },
                    automations: { action: "assert_empty" },
                },
            });

            expect(response.statusCode, response.body).toBe(426);
            expect(response.json()).toEqual({
                error: "client-upgrade-required",
                requirement: {
                    v: 1,
                    kind: "account-stored-content",
                    minimumProtocolVersion: 2,
                },
            });
            await expect(db.account.findUnique({
                where: { id: account.id },
                select: {
                    encryptionMode: true,
                    settings: true,
                    settingsVersion: true,
                },
            })).resolves.toEqual({
                encryptionMode: "e2ee",
                settings: null,
                settingsVersion: 0,
            });
        } finally {
            await app.close();
        }
    });

    it("rolls back an earlier domain rewrite when a later inventory precondition is stale", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
        });
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: "ciphertext",
                settingsVersion: 0,
            },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-storage-rollback",
                accountId: account.id,
                metadata: "encrypted-machine-metadata",
                metadataVersion: 2,
                daemonStateVersion: 3,
                dataEncryptionKey: new Uint8Array([1, 2, 3]),
            },
        });
        await db.userKVStore.create({
            data: {
                accountId: account.id,
                key: "todo.index",
                value: new TextEncoder().encode("encrypted-todo"),
                version: 4,
            },
        });

        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                },
                payload: {
                    toMode: "plain",
                    expectedSettingsVersion: 0,
                    settingsContent: {
                        t: "plain",
                        v: { schemaVersion: 2 },
                    },
                    connectedServices: { action: "assert_empty" },
                    automations: { action: "assert_empty" },
                    machines: {
                        action: "migrate",
                        items: [{
                            machineId: "machine-storage-rollback",
                            expectedMetadataVersion: 2,
                            expectedDaemonStateVersion: 3,
                            metadata: encodePlainStoredJson({
                                host: "must-roll-back",
                            }),
                            daemonState: null,
                            dataEncryptionKey:
                                encodePlainStoredJson(null),
                            contentPublicKeyFingerprint: null,
                        }],
                    },
                    todos: { action: "migrate", items: [] },
                    artifacts: { action: "assert_empty" },
                },
            });

            expect(response.statusCode, response.body).toBe(400);
            expect(response.json()).toEqual({
                error: "invalid-params",
                reason: "migration_inventory_changed",
            });
            await expect(db.machine.findUnique({
                where: { id: "machine-storage-rollback" },
                select: {
                    metadata: true,
                    metadataVersion: true,
                    daemonStateVersion: true,
                },
            })).resolves.toEqual({
                metadata: "encrypted-machine-metadata",
                metadataVersion: 2,
                daemonStateVersion: 3,
            });
            await expect(db.account.findUnique({
                where: { id: account.id },
                select: {
                    encryptionMode: true,
                    settingsVersion: true,
                },
            })).resolves.toEqual({
                encryptionMode: "e2ee",
                settingsVersion: 0,
            });
        } finally {
            await app.close();
        }
    });

    it("applies required domain replacements before the final Account mutation and rolls everything back when that commit fails", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: "1",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST:
                "none",
        });
        const account = await db.account.create({
            data: {
                ...createSignedAccountContentBinding(),
                encryptionMode: "e2ee",
                settings: "settings-before",
                settingsVersion: 0,
            },
            select: {
                id: true,
                encryptionModeUpdatedAt: true,
            },
        });
        const amendment9Fixture =
            await createAmendment9PopulatedMigrationFixture(
                account.id,
            );
        const credentialMutation =
            await mutateConnectedServiceCredential({
            accountId: account.id,
            serviceId: "anthropic",
            profileId: "work",
            token: new TextEncoder().encode(
                "credential-before",
            ),
            metadata: {
                v: 2,
                format: "account_scoped_v1",
                kind: "token",
                providerAccountId: "acct-commit-last",
            },
            expiresAt: null,
            storageMode: "sealed",
            incomingIdentity: {
                providerAccountId: "acct-commit-last",
            },
            allowProviderIdentityChange: false,
            expectedCredentialRevision: null,
        });
        expect(credentialMutation).toMatchObject({
            status: "written",
        });
        if (credentialMutation.status !== "written") {
            throw new Error(
                "Expected credential preparation fixture write",
            );
        }
        const automationBefore = JSON.stringify({
            kind:
                "happier_automation_template_encrypted_v1",
            payloadCiphertext: "automation-before",
        });
        const automationAfter = JSON.stringify({
            kind: "happier_automation_template_plain_v1",
            payload: { prompt: "automation-after" },
        });
        const automationId = "automation-account-encryption-commit-last";
        const automationTemplateVersion = 1;
        const automationDefinitionBefore =
            encodePluginEventTriggerDefinitionEnvelope({
                automationId,
                templateVersion: automationTemplateVersion,
                mode: "e2ee",
            });
        const automationDefinitionAfter =
            encodePluginEventTriggerDefinitionEnvelope({
                automationId,
                templateVersion: automationTemplateVersion + 1,
                mode: "plain",
            });
        const automation = await db.automation.create({
            data: {
                id: automationId,
                accountId: account.id,
                name: "commit-last automation",
                enabled: false,
                triggerKind: "pluginEvent",
                triggerEventPluginId: "com.example.github",
                triggerEventLocalId: "repository-event",
                triggerSourceSelectorId:
                    ROUTE_PLUGIN_EVENT_SOURCE_SELECTOR_ID,
                triggerSourceContractVersion: 1,
                triggerObservationTransport: "checkpointedPull",
                triggerDefinitionEnvelope: automationDefinitionBefore,
                targetType: "new_session",
                templateCiphertext: automationBefore,
                templateVersion: automationTemplateVersion,
            },
            select: { id: true, templateVersion: true },
        });
        const credentialBefore =
            await db.serviceAccountToken.findFirstOrThrow({
                where: { accountId: account.id },
                select: {
                    token: true,
                    metadata: true,
                },
            });
        emitUpdate.mockClear();

        const fault = installAccountTransitionCommitFailure({
            accountId: account.id,
            serviceId: "anthropic",
            profileId: "work",
            automationId: automation.id,
            reviewCommentId: amendment9Fixture.comment.id,
            organizationFolderId:
                amendment9Fixture.folder.id,
        });
        const app = createTestApp();
        registerAccountEncryptionMigrateRoutes(app as any);
        await app.ready();
        try {
            const response = await app.inject({
                method: "POST",
                url: "/v1/account/encryption/migrate",
                headers: {
                    "content-type": "application/json",
                    "x-test-user-id": account.id,
                },
                payload: {
                    toMode: "plain",
                    expectedSettingsVersion: 0,
                    settingsContent: {
                        t: "plain",
                        v: { schemaVersion: 2 },
                    },
                    connectedServices: {
                        action: "migrate",
                        credentials: [{
                            serviceId: "anthropic",
                            profileId: "work",
                            expectedCredentialRevision:
                                credentialMutation
                                    .credentialRevision,
                            kind: "plain",
                            record: {
                                v: 1,
                                serviceId: "anthropic",
                                profileId: "work",
                                createdAt: 1,
                                updatedAt: 2,
                                expiresAt: null,
                                kind: "token",
                                oauth: null,
                                token: {
                                    token:
                                        "credential-after",
                                    providerAccountId:
                                        "acct-commit-last",
                                    providerEmail: null,
                                    raw: null,
                                },
                            },
                        }],
                    },
                    automations: {
                        action: "migrate",
                        templates: [{
                            automationId: automation.id,
                            expectedTemplateVersion:
                                automation.templateVersion,
                            templateCiphertext:
                                automationAfter,
                            triggerDefinitionEnvelope:
                                automationDefinitionAfter,
                        }],
                    },
                    machines: { action: "assert_empty" },
                    todos: { action: "assert_empty" },
                    artifacts: { action: "assert_empty" },
                    sessions: { action: "assert_empty" },
                    reviewComments:
                        amendment9Fixture.reviewComments,
                    sessionOrganization:
                        amendment9Fixture
                            .sessionOrganization,
                    pets: { action: "assert_empty" },
                },
            });

            expect(response.statusCode, response.body).toBe(500);
            const observed =
                await fault.observedBeforeAccountUpdate;
            expect(
                new TextDecoder().decode(
                    observed.credentialToken,
                ),
            ).toContain("credential-after");
            expect(observed.automationTemplate).toBe(
                automationAfter,
            );
            expect(observed.automationTriggerDefinition).toBe(
                automationDefinitionAfter,
            );
            expect(JSON.parse(
                observed.reviewCommentBodyEnvelopeJson,
            )).toEqual(
                amendment9Fixture.reviewComments.items[0]!
                    .targetSensitiveEnvelope,
            );
            expect(
                observed.organizationFolderDisplayDbValue,
            ).toBe(JSON.stringify(
                amendment9Fixture.sessionOrganization
                    .folders[0]!.display,
            ));
        } finally {
            fault.restore();
            await app.close();
        }

        await expect(db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: {
                encryptionMode: true,
                encryptionModeUpdatedAt: true,
                settings: true,
                settingsVersion: true,
            },
        })).resolves.toEqual({
            encryptionMode: "e2ee",
            encryptionModeUpdatedAt:
                account.encryptionModeUpdatedAt,
            settings: "settings-before",
            settingsVersion: 0,
        });
        await expect(db.serviceAccountToken.findFirstOrThrow({
            where: { accountId: account.id },
            select: {
                token: true,
                metadata: true,
            },
        })).resolves.toEqual(credentialBefore);
        await expect(db.automation.findUniqueOrThrow({
            where: { id: automation.id },
            select: {
                templateCiphertext: true,
                templateVersion: true,
                triggerDefinitionEnvelope: true,
            },
        })).resolves.toEqual({
            templateCiphertext: automationBefore,
            templateVersion: automationTemplateVersion,
            triggerDefinitionEnvelope: automationDefinitionBefore,
        });
        await expect(db.reviewComment.findUniqueOrThrow({
            where: {
                id: amendment9Fixture.comment.id,
            },
            select: {
                snapshotEnvelopeJson: true,
                bodyEnvelopeJson: true,
            },
        })).resolves.toEqual({
            snapshotEnvelopeJson: JSON.stringify({
                t: "encrypted",
                c: "legacy-snapshot-ciphertext",
            }),
            bodyEnvelopeJson: JSON.stringify({
                t: "encrypted",
                c: "legacy-body-ciphertext",
            }),
        });
        await expect(db.sessionOrganizationFolder
            .findUniqueOrThrow({
                where: {
                    id: amendment9Fixture.folder.id,
                },
                select: { displayDbValue: true },
            })).resolves.toEqual({
            displayDbValue: JSON.stringify({
                t: "encrypted",
                c: "folder-source-ciphertext",
            }),
        });
        await expect(db.sessionOrganizationCheckpoint
            .findUniqueOrThrow({
                where: { accountId: account.id },
                select: { version: true },
            })).resolves.toEqual({ version: 5 });
        expect(emitUpdate).not.toHaveBeenCalled();
    });

});
