import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
    buildTrustedHostSessionInputAdmissionV1,
    SESSION_MESSAGE_PROVENANCE_META_KEY,
    settleSessionInputRequestV1,
    settleSessionInputRequestV2,
    settleSessionMessageProvenanceV1,
    settleSessionMessageProvenanceV2,
    withSessionInputAuthorityV1,
    withSessionInputAuthority,
    type SessionInputAdmissionReceiptV1,
    type SessionMessageDeliveryResolutionV1,
    type SessionMessageProvenanceV1,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import {
    blockPendingDelivery,
    deletePendingMessage as deletePendingMessageWithAuthentication,
    dismissPendingDelivery as dismissPendingDeliveryWithAuthentication,
    discardPendingMessage as discardPendingMessageWithAuthentication,
    enqueuePendingMessageByAuthenticatedMachine,
    enqueuePendingMessage as enqueuePendingMessageWithAction,
    listQueuedExecutionRunPendingTargetsForSessions,
    listPendingMessages as listPendingMessagesWithAuthentication,
    markPendingDeliveryHandled as markPendingDeliveryHandledWithAuthentication,
    materializeNextPendingMessage as materializeNextPendingMessageWithAuthority,
    reorderPendingMessages as reorderPendingMessagesWithAuthentication,
    resolveAcceptedPendingDelivery as resolveAcceptedPendingDeliveryWithAuthority,
    sendPendingDeliveryAsNew as sendPendingDeliveryAsNewWithAuthentication,
    settlePendingInputAdmission,
    restorePendingMessage as restorePendingMessageWithAuthentication,
    updatePendingMessage as updatePendingMessageWithAuthentication,
    updatePendingRequestedAction as updatePendingRequestedActionWithAuthentication,
} from "./pendingMessageService";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createFakeSocket, getSocketHandler } from "@/app/api/testkit/socketHarness";
import { sessionUpdateHandler } from "@/app/api/socket/sessionUpdateHandler";
import { activityCache } from "@/app/presence/sessionCache";
import { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import { reconcileSessionPendingQueueStateInTx } from "./reconcileSessionPendingQueueState";
import { inTx } from "@/storage/inTx";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { sessionPendingRoutes } from "@/app/api/routes/session/pendingRoutes";
import { changesRoutes } from "@/app/api/routes/changes/changesRoutes";
import { registerSessionListingRoutes } from "@/app/api/routes/session/registerSessionListingRoutes";

type EnqueuePendingMessageParams = Parameters<typeof enqueuePendingMessageWithAction>[0];
const authentication = createPresentUserSessionAccessAuthentication();
const enqueuePendingMessage = (
    params: Omit<EnqueuePendingMessageParams, "authentication" | "requestedAction"> & Partial<Pick<EnqueuePendingMessageParams, "requestedAction">>,
) => enqueuePendingMessageWithAction({
    ...params,
    authentication,
    requestedAction: params.requestedAction ?? { v: 1, kind: "enqueue" },
} as EnqueuePendingMessageParams);

type WithoutAuthentication<T> = T extends unknown ? Omit<T, "authentication"> : never;

const withPresentUserAuthentication = <TParams extends object>(
    params: TParams,
): TParams & Readonly<{ authentication: SessionAccessAuthentication }> => ({ ...params, authentication });

const deletePendingMessage = (params: WithoutAuthentication<Parameters<typeof deletePendingMessageWithAuthentication>[0]>) =>
    deletePendingMessageWithAuthentication(withPresentUserAuthentication(params));
const dismissPendingDelivery = (params: WithoutAuthentication<Parameters<typeof dismissPendingDeliveryWithAuthentication>[0]>) =>
    dismissPendingDeliveryWithAuthentication(withPresentUserAuthentication(params));
const discardPendingMessage = (params: WithoutAuthentication<Parameters<typeof discardPendingMessageWithAuthentication>[0]>) =>
    discardPendingMessageWithAuthentication(withPresentUserAuthentication(params));
const listPendingMessages = (params: WithoutAuthentication<Parameters<typeof listPendingMessagesWithAuthentication>[0]>) =>
    listPendingMessagesWithAuthentication(withPresentUserAuthentication(params));
const markPendingDeliveryHandled = (params: WithoutAuthentication<Parameters<typeof markPendingDeliveryHandledWithAuthentication>[0]>) =>
    markPendingDeliveryHandledWithAuthentication(withPresentUserAuthentication(params));
const reorderPendingMessages = (params: WithoutAuthentication<Parameters<typeof reorderPendingMessagesWithAuthentication>[0]>) =>
    reorderPendingMessagesWithAuthentication(withPresentUserAuthentication(params));
const sendPendingDeliveryAsNew = (params: WithoutAuthentication<Parameters<typeof sendPendingDeliveryAsNewWithAuthentication>[0]>) =>
    sendPendingDeliveryAsNewWithAuthentication(withPresentUserAuthentication(params));
const restorePendingMessage = (params: WithoutAuthentication<Parameters<typeof restorePendingMessageWithAuthentication>[0]>) =>
    restorePendingMessageWithAuthentication(withPresentUserAuthentication(params));
const updatePendingMessage = (params: WithoutAuthentication<Parameters<typeof updatePendingMessageWithAuthentication>[0]>) =>
    updatePendingMessageWithAuthentication(withPresentUserAuthentication(params));
const updatePendingRequestedAction = (params: WithoutAuthentication<Parameters<typeof updatePendingRequestedActionWithAuthentication>[0]>) =>
    updatePendingRequestedActionWithAuthentication(withPresentUserAuthentication(params));

describe("pendingMessageService (shared sessions)", () => {
    let harness: LightSqliteHarness;
    const providerAuthorityBySessionId = new Map<
        string,
        Promise<Awaited<ReturnType<typeof createCurrentPendingPublisher>>>
    >();

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-pending-shared-",
            initAuth: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        harness.resetEnv();
        providerAuthorityBySessionId.clear();
    });

    const createAccount = async (kind: string) => {
        return db.account.create({
            data: { publicKey: `pk-${kind}-${randomUUID()}` },
            select: { id: true },
        });
    };

    const createSession = async <TSelect extends Prisma.SessionSelect>(
        ownerId: string,
        select: TSelect = { id: true } as TSelect,
    ): Promise<Prisma.SessionGetPayload<{ select: TSelect }>> => {
        return db.session.create({
            data: {
                tag: `tag-${randomUUID()}`,
                accountId: ownerId,
                metadata: "meta",
                metadataVersion: 0,
                agentState: null,
                agentStateVersion: 0,
            },
            select,
        });
    };

    const markPendingProviderDeliveryClaimed = async (params: {
        sessionId: string;
        localId: string;
    }) => {
        await db.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId: params.sessionId, localId: params.localId } },
            data: { deliveryState: "delivering", deliveryBlockedReason: null },
        });
    };

    const createCommittedTranscriptMessage = async (params: {
        sessionId: string;
        localId: string;
        seq: number;
        messageRole: "user" | "agent" | null;
        ciphertext: string;
        deliveryResolution?: SessionMessageDeliveryResolutionV1;
    }) => {
        await db.session.updateMany({ where: { id: params.sessionId }, data: { seq: params.seq } });
        await db.sessionMessage.create({
            data: {
                sessionId: params.sessionId,
                seq: params.seq,
                localId: params.localId,
                messageRole: params.messageRole,
                content: { t: "encrypted", c: params.ciphertext },
                deliveryResolution: params.deliveryResolution,
            },
        });
    };

    const shareSession = async (params: {
        sessionId: string;
        ownerId: string;
        participantId: string;
        accessLevel: "edit" | "view";
    }) => {
        return db.sessionShare.create({
            data: {
                sessionId: params.sessionId,
                sharedByUserId: params.ownerId,
                sharedWithUserId: params.participantId,
                accessLevel: params.accessLevel,
                canApprovePermissions: false,
            },
            select: { id: true },
        });
    };

    const createCurrentPendingPublisher = async (params: { accountId: string; sessionId: string }) => {
        const runtimeActivity = await db.session.findUniqueOrThrow({
            where: { id: params.sessionId },
            select: {
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
                runtimeActivityObservedAt: true,
            },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId: params.accountId, metadata: "{}" } });
        await db.accessKey.create({
            data: { accountId: params.accountId, machineId, sessionId: params.sessionId, data: "encrypted" },
        });
        const binding = { accountId: params.accountId, machineId, sessionId: params.sessionId };
        const presence = createSessionPublisherPresence();
        const socket = {};
        const registered = await presence.registerPublisher({
            socket,
            binding,
            completeActivitySnapshot: runtimeActivity.runtimeActivityObservedAt !== null
                && runtimeActivity.runtimeActivityState === "active"
                && runtimeActivity.runtimeActivityActiveCount > 0
                ? { state: "active", activeCount: runtimeActivity.runtimeActivityActiveCount }
                : runtimeActivity.runtimeActivityObservedAt !== null
                    && runtimeActivity.runtimeActivityState === "idle"
                    && runtimeActivity.runtimeActivityActiveCount === 0
                    ? { state: "idle", activeCount: 0 }
                    : { state: "unknown", activeCount: 0 },
        });
        if (registered.status !== "registered") throw new Error(`publisher registration failed: ${registered.status}`);
        return {
            ...binding,
            committedFence: registered.committedFence,
            runtimeActivityRevision: registered.activity.projection.runtimeActivityRevision,
            presence,
            socket,
        };
    };

    type MaterializeNextPendingMessageParams = Parameters<typeof materializeNextPendingMessageWithAuthority>[0];
    const materializeNextPendingMessage = async (
        params: Omit<MaterializeNextPendingMessageParams, "deliveryState" | "deliveryTiming" | "foregroundState" | "publisherAuthority">
            & Partial<Pick<MaterializeNextPendingMessageParams, "deliveryState" | "deliveryTiming" | "foregroundState" | "publisherAuthority">>,
    ): ReturnType<typeof materializeNextPendingMessageWithAuthority> => {
        if (params.publisherAuthority) {
            return materializeNextPendingMessageWithAuthority({
                ...params,
                deliveryState: "provider",
                deliveryTiming: params.deliveryTiming ?? "after_foreground_ready",
                foregroundState: params.foregroundState ?? "ready",
                publisherAuthority: params.publisherAuthority,
            });
        }
        let publisherAuthority = providerAuthorityBySessionId.get(params.sessionId);
        if (!publisherAuthority) {
            publisherAuthority = createCurrentPendingPublisher({
                accountId: params.actorUserId,
                sessionId: params.sessionId,
            });
            providerAuthorityBySessionId.set(params.sessionId, publisherAuthority);
        }
        const currentPublisher = await publisherAuthority;
        return materializeNextPendingMessageWithAuthority({
            ...params,
            deliveryState: "provider",
            deliveryTiming: params.deliveryTiming ?? "after_foreground_ready",
            foregroundState: params.foregroundState ?? "ready",
            expectedRuntimeActivityRevision: params.expectedRuntimeActivityRevision
                ?? currentPublisher.runtimeActivityRevision,
            publisherAuthority: currentPublisher,
        });
    };

    type ResolveAcceptedPendingDeliveryParams = Parameters<typeof resolveAcceptedPendingDeliveryWithAuthority>[0];
    const resolveAcceptedPendingDelivery = async (
        params: Omit<ResolveAcceptedPendingDeliveryParams, "publisherAuthority"> & Partial<Pick<ResolveAcceptedPendingDeliveryParams, "publisherAuthority">>,
    ): ReturnType<typeof resolveAcceptedPendingDeliveryWithAuthority> => {
        if (params.publisherAuthority) return resolveAcceptedPendingDeliveryWithAuthority(params as ResolveAcceptedPendingDeliveryParams);
        let publisherAuthority = providerAuthorityBySessionId.get(params.sessionId);
        if (!publisherAuthority) {
            publisherAuthority = createCurrentPendingPublisher({
                accountId: params.actorUserId,
                sessionId: params.sessionId,
            });
            providerAuthorityBySessionId.set(params.sessionId, publisherAuthority);
        }
        return resolveAcceptedPendingDeliveryWithAuthority({
            ...params,
            publisherAuthority: await publisherAuthority,
        });
    };

    it("projects Pending authors from immutable receipts after access loss and Account deletion", async () => {
        const owner = await createAccount("actor-owner");
        const editor = await createAccount("actor-editor");
        const session = await createSession(owner.id);
        const share = await shareSession({ sessionId: session.id, ownerId: owner.id, participantId: editor.id, accessLevel: "edit" });
        await db.account.update({ where: { id: editor.id }, data: { firstName: "Alice" } });
        expect(await enqueuePendingMessage({ actorUserId: editor.id, sessionId: session.id, localId: "actor-input", ciphertext: "cipher", messageRole: "user" })).toMatchObject({
            ok: true, pending: { accountActor: { accountId: editor.id, profile: { firstName: "Alice" } } },
        });
        await db.sessionShare.delete({ where: { id: share.id } });
        expect(await listPendingMessages({ actorUserId: owner.id, sessionId: session.id })).toMatchObject({
            ok: true, pending: [{ accountActor: { accountId: editor.id, profile: { firstName: "Alice" } } }],
        });
        expect(await listPendingMessages({ actorUserId: editor.id, sessionId: session.id })).toMatchObject({ ok: false });
        await db.account.delete({ where: { id: editor.id } });
        expect(await listPendingMessages({ actorUserId: owner.id, sessionId: session.id })).toMatchObject({
            ok: true, pending: [{ authorAccountId: null, accountActor: { accountId: editor.id, profile: null } }],
        });
        await withAuthenticatedTestApp(sessionPendingRoutes, async (app) => {
            const response = await app.inject({ method: "GET", url: `/v2/sessions/${session.id}/pending`, headers: { "x-test-user-id": owner.id } });
            expect(response.statusCode).toBe(200);
            expect(response.json().pending[0]).toMatchObject({ accountActor: { accountId: editor.id, profile: null } });
            expect(response.json().pending[0]).not.toHaveProperty("inputAdmissionReceipt");
        });
    });

    it("keeps main readers isolated from mixed main and execution-run pending rows", async () => {
        const owner = await createAccount("target-isolation-owner");
        const session = await createSession(owner.id);
        for (const [localId, target] of [["run-a-first", "run-a"], ["main", null], ["run-b", "run-b"]] as const) {
            await enqueuePendingMessage({
                actorUserId: owner.id,
                sessionId: session.id,
                localId,
                ciphertext: `cipher-${localId}`,
                messageRole: "user",
            });
            await db.$executeRaw`UPDATE "SessionPendingMessage" SET "targetExecutionRunId" = ${target} WHERE "sessionId" = ${session.id} AND "localId" = ${localId}`;
        }

        const listed = await listPendingMessages({ actorUserId: owner.id, sessionId: session.id });
        expect.soft(listed).toMatchObject({ ok: true, pending: [{ localId: "main" }] });
        const materialized = await materializeNextPendingMessage({ actorUserId: owner.id, sessionId: session.id });
        expect(materialized).toMatchObject({ ok: true, didMaterialize: true, message: { localId: "main" } });
        expect(materialized).toMatchObject({ pendingCount: 1, pendingBlockedCount: 0 });
    });

    it("lists every distinct current queued Execution Run target only for the owning Account and requested Sessions", async () => {
        const owner = await createAccount("pending-target-replay-owner");
        const otherOwner = await createAccount("pending-target-replay-other-owner");
        const session = await createSession(owner.id);
        const otherSession = await createSession(otherOwner.id);
        for (const [localId, targetExecutionRunId] of [
            ["run-b-first", "run-b"],
            ["main", null],
            ["run-a", "run-a"],
            ["run-b-second", "run-b"],
            ["discarded-run", "run-discarded"],
        ] as const) {
            await enqueuePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId, ciphertext: localId });
            await db.sessionPendingMessage.update({
                where: { sessionId_localId: { sessionId: session.id, localId } },
                data: { targetExecutionRunId },
            });
        }
        await db.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId: session.id, localId: "discarded-run" } },
            data: { status: "discarded" },
        });
        await enqueuePendingMessage({ actorUserId: otherOwner.id, sessionId: otherSession.id, localId: "other-run", ciphertext: "other" });
        await db.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId: otherSession.id, localId: "other-run" } },
            data: { targetExecutionRunId: "run-other-account" },
        });

        await expect(listQueuedExecutionRunPendingTargetsForSessions({
            accountId: owner.id,
            sessionIds: [session.id, otherSession.id],
        })).resolves.toEqual([
            { sessionId: session.id, runId: "run-b" },
            { sessionId: session.id, runId: "run-a" },
        ]);

        await db.accountChange.update({
            where: {
                accountId_kind_entityId: {
                    accountId: owner.id,
                    kind: "session",
                    entityId: session.id,
                },
            },
            data: { hint: { lastMessageSeq: 42 } },
        });

        await withAuthenticatedTestApp(changesRoutes, async (app) => {
            const response = await app.inject({
                method: "GET",
                url: "/v2/changes?after=0",
                headers: { "x-test-user-id": owner.id },
            });
            expect(response.statusCode).toBe(200);
            const sessionChange = response.json().changes.find((change: { kind: string; entityId: string }) =>
                change.kind === "session" && change.entityId === session.id,
            );
            expect(sessionChange).toMatchObject({
                hint: {
                    lastMessageSeq: 42,
                    pendingExecutionRunIds: ["run-b", "run-a"],
                },
            });
            expect(response.json().changes).not.toContainEqual(expect.objectContaining({ entityId: otherSession.id }));
        });

        await withAuthenticatedTestApp(registerSessionListingRoutes, async (app) => {
            const response = await app.inject({
                method: "GET",
                url: `/v2/sessions/${session.id}?accessProjectionVersion=1`,
                headers: { "x-test-user-id": owner.id },
            });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({
                session: { pendingExecutionRunIds: ["run-b", "run-a"] },
            });
        });
    });

    it("refuses main materialization rejoin against an existing run-sidechain user anchor", async () => {
        const owner = await createAccount("main-sidechain-rejoin-owner");
        const session = await createSession(owner.id);
        const localId = "main-sidechain-rejoin";
        await enqueuePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId, ciphertext: "same-cipher", messageRole: "user" });
        await createCommittedTranscriptMessage({ sessionId: session.id, localId, seq: 1, ciphertext: "same-cipher", messageRole: "user" });
        await db.sessionMessage.update({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            data: { sidechainId: "run-sidechain" },
        });

        expect(await materializeNextPendingMessage({ actorUserId: owner.id, sessionId: session.id })).toMatchObject({
            ok: false,
            error: "transcript-conflict",
        });
        expect(await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId } } })).toMatchObject({ sidechainId: "run-sidechain" });
    });

    it("keeps main mutation and settlement requests out of run rows while publisher loss covers every target", async () => {
        const owner = await createAccount("target-mutations-owner");
        const session = await createSession(owner.id);
        const publisherAuthority = await createCurrentPendingPublisher({ accountId: owner.id, sessionId: session.id });
        for (const [localId, target] of [["main-a", null], ["run-a", "run-a"], ["main-b", null], ["run-b", "run-b"]] as const) {
            await enqueuePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId, ciphertext: `cipher-${localId}`, messageRole: "user" });
            await db.$executeRaw`UPDATE "SessionPendingMessage" SET "targetExecutionRunId" = ${target} WHERE "sessionId" = ${session.id} AND "localId" = ${localId}`;
        }
        expect.soft(await reorderPendingMessages({ actorUserId: owner.id, sessionId: session.id, orderedLocalIds: ["main-b", "main-a"] })).toMatchObject({ ok: true });
        const mainOrder = await db.sessionPendingMessage.findMany({ where: { sessionId: session.id }, orderBy: { position: "asc" }, select: { localId: true, position: true } });
        expect.soft(mainOrder).toEqual([{ localId: "main-b", position: 1 }, { localId: "run-a", position: 2 }, { localId: "main-a", position: 3 }, { localId: "run-b", position: 4 }]);
        const targetRequest = { actorUserId: owner.id, sessionId: session.id, localId: "run-a" };
        const original = await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId: "run-a" } } });
        await updatePendingMessage({ ...targetRequest, ciphertext: "wrong-main-edit" });
        await updatePendingRequestedAction({ ...targetRequest, requestedAction: { v: 1, kind: "send_now" } });
        await discardPendingMessage(targetRequest);
        await restorePendingMessage(targetRequest);
        await deletePendingMessage(targetRequest);
        expect.soft(await db.sessionPendingMessage.findUnique({ where: { sessionId_localId: { sessionId: session.id, localId: "run-a" } } })).toEqual(original);

        await markPendingProviderDeliveryClaimed({ sessionId: session.id, localId: "run-b" });
        expect.soft(await resolveAcceptedPendingDelivery({ ...targetRequest, localId: "run-b", publisherAuthority })).toMatchObject({ ok: false });
        expect.soft(await db.sessionMessage.count({ where: { sessionId: session.id } })).toBe(0);
        await createCurrentPendingPublisher({ accountId: owner.id, sessionId: session.id });
        expect.soft(await db.sessionPendingMessage.findUnique({ where: { sessionId_localId: { sessionId: session.id, localId: "run-b" } } })).toMatchObject({ deliveryState: "blocked", deliveryBlockedReason: "delivery_outcome_uncertain" });
        expect(await inTx((tx) => reconcileSessionPendingQueueStateInTx(tx, session.id))).toMatchObject({ pendingCount: 2, pendingBlockedCount: 0 });
    });

    it("refuses accepted main settlement against an existing sidechain anchor", async () => {
        const owner = await createAccount("main-settlement-sidechain");
        const session = await createSession(owner.id);
        const localId = "main-settlement-sidechain";
        await enqueuePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId, ciphertext: "same-cipher", messageRole: "user" });
        await markPendingProviderDeliveryClaimed({ sessionId: session.id, localId });
        await createCommittedTranscriptMessage({ sessionId: session.id, localId, seq: 1, ciphertext: "same-cipher", messageRole: "user" });
        await db.sessionMessage.update({ where: { sessionId_localId: { sessionId: session.id, localId } }, data: { sidechainId: "run-sidechain" } });
        expect(await resolveAcceptedPendingDelivery({ actorUserId: owner.id, sessionId: session.id, localId })).toMatchObject({ ok: false, error: "transcript-conflict" });
        expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).toBe(1);
    });

    it("admits exact run input from a collaborator through the custodian Machine without main activation", async () => {
        const owner = await createAccount("target-admission-owner");
        const collaborator = await createAccount("target-admission-collaborator");
        const session = await createSession(owner.id);
        await shareSession({ sessionId: session.id, ownerId: owner.id, participantId: collaborator.id, accessLevel: "edit" });
        const machineId = `target-machine-${randomUUID()}`;
        await db.machine.create({ data: {
            id: machineId, accountId: owner.id, metadata: "{}",
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } },
            operationProtocolCapabilitiesRevision: 1,
        } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId, sessionId: session.id, data: "encrypted" } });
        const request = {
            actorUserId: collaborator.id, sessionId: session.id, localId: "target-admission",
            ciphertext: "cipher-run-a", messageRole: "user", requestedAction: { v: 1, kind: "send_now" } as const,
            targetExecutionRunId: "run-a", targetMachineId: machineId,
        };
        expect.soft(await enqueuePendingMessage(request)).toMatchObject({
            ok: true, didWrite: true, pendingCount: 0, pendingBlockedCount: 0,
            pending: { recipient: { kind: "execution_run", runId: "run-a" }, authorAccountId: collaborator.id },
        });
        expect.soft(await listPendingMessages(request)).toMatchObject({
            ok: true,
            pending: [{ localId: request.localId, recipient: { kind: "execution_run", runId: "run-a" } }],
        });
        expect.soft(await listPendingMessages({ actorUserId: collaborator.id, sessionId: session.id })).toMatchObject({
            ok: true, pending: [],
        });
        expect.soft(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ pendingCount: 0, pendingActivationRequestId: null });
        expect.soft(await enqueuePendingMessage(request)).toMatchObject({ ok: true, didWrite: false });
        expect.soft(await enqueuePendingMessage({ ...request, targetExecutionRunId: "run-b" })).toMatchObject({ ok: false, admissionRejectionCode: "session_input_idempotency_conflict" });
        expect.soft(await enqueuePendingMessage({ ...request, targetExecutionRunId: undefined })).toMatchObject({ ok: false, admissionRejectionCode: "session_input_idempotency_conflict" });
        await db.machine.update({ where: { accountId_id: { accountId: owner.id, id: machineId } }, data: { operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] } } } });
        expect.soft(await enqueuePendingMessage({ ...request, localId: "unsupported-target" })).toMatchObject({ ok: false, admissionRejectionCode: "session_input_target_update_required" });
        expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id } })).toBe(1);
    });

    it("keeps exact target mutations and materialization isolated while settling into the target sidechain", async () => {
        const owner = await createAccount("target-drain-owner");
        const session = await createSession(owner.id);
        const publisherAuthority = await createCurrentPendingPublisher({ accountId: owner.id, sessionId: session.id });
        await db.machine.update({ where: { id: publisherAuthority.machineId }, data: {
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } }, operationProtocolCapabilitiesRevision: 1,
        } });
        for (const [localId, target] of [["main", null], ["run-a-first", "run-a"], ["run-b", "run-b"], ["run-a-next", "run-a"]] as const) {
            expect(await enqueuePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId, ciphertext: `cipher-${localId}`, messageRole: "user", targetExecutionRunId: target, targetMachineId: publisherAuthority.machineId })).toMatchObject({ ok: true });
        }
        const runA = { actorUserId: owner.id, sessionId: session.id, targetExecutionRunId: "run-a" };
        expect.soft(await reorderPendingMessages({ ...runA, orderedLocalIds: ["run-a-next", "run-a-first"] })).toMatchObject({ ok: true });
        expect.soft(await reorderPendingMessages({ ...runA, orderedLocalIds: ["run-b", "run-a-next"] })).toMatchObject({ ok: false });
        expect.soft(await updatePendingMessage({ ...runA, localId: "run-a-next", ciphertext: "updated-a" })).toMatchObject({ ok: true });
        expect.soft(await updatePendingRequestedAction({ ...runA, localId: "run-a-next", requestedAction: { v: 1, kind: "send_now" } })).toMatchObject({ ok: true });
        expect.soft(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ pendingActivationRequestId: null });
        const targetMaterialization = { ...runA, publisherAuthority, expectedSidechainId: "sidechain-a" };
        const claimed = await materializeNextPendingMessage(targetMaterialization);
        expect.soft(claimed).toMatchObject({ ok: true, didMaterialize: true, message: { localId: "run-a-next", content: { t: "encrypted", c: "updated-a" } } });
        expect.soft(await materializeNextPendingMessage({ actorUserId: owner.id, sessionId: session.id, publisherAuthority })).toMatchObject({ ok: true, didMaterialize: true, message: { localId: "main" } });
        expect.soft(await materializeNextPendingMessage({ ...targetMaterialization, targetExecutionRunId: "run-b", expectedSidechainId: "sidechain-b" })).toMatchObject({ ok: true, didMaterialize: true, message: { localId: "run-b" } });
        // Ciphertext and its tag are opaque network-boundary fixtures; only the authenticated publisher supplies this evidence.
        expect.soft(await settlePendingInputAdmission({ ...targetMaterialization, localId: "run-a-next", decision: {
            kind: "admit", finalContent: { t: "encrypted", c: "admitted-a" }, requestEqualityEvidenceV1: { kind: "e2eeTag", tag: "A".repeat(43) },
        } })).toMatchObject({ ok: true, result: { status: "accepted" } });
        expect.soft(await resolveAcceptedPendingDelivery({ ...targetMaterialization, localId: "run-a-next" })).toMatchObject({ ok: true, didResolve: true });
        expect.soft(await db.sessionMessage.findUnique({ where: { sessionId_localId: { sessionId: session.id, localId: "run-a-next" } } })).toMatchObject({ sidechainId: "sidechain-a" });
        expect(await listPendingMessages(runA)).toMatchObject({
            ok: true,
            pending: [{ localId: "run-a-first", recipient: { kind: "execution_run", runId: "run-a" } }],
            targetPendingState: { pendingCount: 1, pendingBlockedCount: 0, pendingVersion: expect.any(Number) },
        });
    });

    it("blocks a fresh target claim whose localId is already anchored to another sidechain without touching other queues", async () => {
        const owner = await createAccount("target-sidechain-collision-owner");
        const session = await createSession(owner.id);
        const publisherAuthority = await createCurrentPendingPublisher({ accountId: owner.id, sessionId: session.id });
        await db.machine.update({ where: { id: publisherAuthority.machineId }, data: {
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } }, operationProtocolCapabilitiesRevision: 1,
        } });
        for (const [localId, targetExecutionRunId] of [["main", null], ["run-a-collision", "run-a"], ["run-b", "run-b"]] as const) {
            expect(await enqueuePendingMessage({
                actorUserId: owner.id,
                sessionId: session.id,
                localId,
                ciphertext: `cipher-${localId}`,
                messageRole: "user",
                targetExecutionRunId,
                targetMachineId: publisherAuthority.machineId,
            })).toMatchObject({ ok: true });
        }
        await createCommittedTranscriptMessage({
            sessionId: session.id,
            localId: "run-a-collision",
            seq: 1,
            ciphertext: "cipher-run-a-collision",
            messageRole: "user",
        });
        await db.sessionMessage.update({
            where: { sessionId_localId: { sessionId: session.id, localId: "run-a-collision" } },
            data: { sidechainId: "sidechain-b" },
        });
        const sessionBefore = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingVersion: true, pendingCount: true, pendingBlockedCount: true },
        });
        const unrelatedBefore = await db.sessionPendingMessage.findMany({
            where: { sessionId: session.id, localId: { in: ["main", "run-b"] } },
            orderBy: { localId: "asc" },
        });

        const result = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            targetExecutionRunId: "run-a",
            expectedSidechainId: "sidechain-a",
            publisherAuthority,
        });

        expect(result).toMatchObject({
            ok: true,
            didMaterialize: false,
            localId: "run-a-collision",
            pendingStateChanged: true,
            pendingCount: 1,
            pendingBlockedCount: 1,
            pendingVersion: sessionBefore.pendingVersion + 1,
            sessionPendingStateForPublication: {
                pendingCount: sessionBefore.pendingCount,
                pendingBlockedCount: sessionBefore.pendingBlockedCount,
                pendingVersion: sessionBefore.pendingVersion + 1,
            },
            recipientCursorsPending: [expect.objectContaining({ accountId: owner.id, cursor: expect.any(Number) })],
        });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId: "run-a-collision" } },
            select: { status: true, deliveryState: true, deliveryBlockedReason: true, providerAction: true },
        })).resolves.toEqual({
            status: "queued",
            deliveryState: "blocked",
            deliveryBlockedReason: "session_input_target_unavailable",
            providerAction: null,
        });
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingVersion: true, pendingCount: true, pendingBlockedCount: true },
        })).resolves.toEqual({
            pendingVersion: sessionBefore.pendingVersion + 1,
            pendingCount: sessionBefore.pendingCount,
            pendingBlockedCount: sessionBefore.pendingBlockedCount,
        });
        await expect(db.sessionMessage.findMany({
            where: { sessionId: session.id },
            select: { localId: true, sidechainId: true, content: true },
        })).resolves.toEqual([{
            localId: "run-a-collision",
            sidechainId: "sidechain-b",
            content: { t: "encrypted", c: "cipher-run-a-collision" },
        }]);
        await expect(db.sessionPendingMessage.findMany({
            where: { sessionId: session.id, localId: { in: ["main", "run-b"] } },
            orderBy: { localId: "asc" },
        })).resolves.toEqual(unrelatedBefore);
    });

    it("blocks a delivering target rejoin whose frozen localId is anchored to another sidechain", async () => {
        const owner = await createAccount("target-sidechain-rejoin-owner");
        const session = await createSession(owner.id);
        const publisherAuthority = await createCurrentPendingPublisher({ accountId: owner.id, sessionId: session.id });
        await db.machine.update({ where: { id: publisherAuthority.machineId }, data: {
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } }, operationProtocolCapabilitiesRevision: 1,
        } });
        const localId = "run-a-rejoin-collision";
        expect(await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-run-a-rejoin",
            messageRole: "user",
            requestedAction: { v: 1, kind: "send_now" },
            targetExecutionRunId: "run-a",
            targetMachineId: publisherAuthority.machineId,
        })).toMatchObject({ ok: true });
        const targetClaim = {
            actorUserId: owner.id,
            sessionId: session.id,
            targetExecutionRunId: "run-a",
            expectedSidechainId: "sidechain-a",
            publisherAuthority,
        } as const;
        const claimed = await materializeNextPendingMessage({
            ...targetClaim,
            foregroundState: "active_unsteerable",
        });
        expect(claimed).toMatchObject({
            ok: true,
            didMaterialize: true,
            message: { localId, providerAction: "interrupt_and_send" },
        });
        if (!claimed.ok || !claimed.didMaterialize) throw new Error("expected target provider claim");
        await createCommittedTranscriptMessage({
            sessionId: session.id,
            localId,
            seq: 1,
            ciphertext: "cipher-run-a-rejoin",
            messageRole: "user",
        });
        await db.sessionMessage.update({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            data: { sidechainId: "sidechain-b" },
        });

        const result = await materializeNextPendingMessage(targetClaim);

        expect(result).toMatchObject({
            ok: true,
            didMaterialize: false,
            localId,
            pendingStateChanged: true,
            pendingCount: 1,
            pendingBlockedCount: 1,
            pendingVersion: claimed.pendingVersion + 1,
            recipientCursorsPending: [expect.objectContaining({ accountId: owner.id, cursor: expect.any(Number) })],
        });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true, deliveryBlockedReason: true, providerAction: true },
        })).resolves.toEqual({
            status: "queued",
            deliveryState: "blocked",
            deliveryBlockedReason: "session_input_target_unavailable",
            providerAction: "interrupt_and_send",
        });
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingVersion: true },
        })).resolves.toEqual({ pendingVersion: claimed.pendingVersion + 1 });
        await expect(db.sessionMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { sidechainId: true, content: true },
        })).resolves.toEqual({
            sidechainId: "sidechain-b",
            content: { t: "encrypted", c: "cipher-run-a-rejoin" },
        });
    });

    it("keeps a same-sidechain target with divergent transcript content queued as a transcript conflict", async () => {
        const owner = await createAccount("target-content-conflict-owner");
        const session = await createSession(owner.id);
        const publisherAuthority = await createCurrentPendingPublisher({ accountId: owner.id, sessionId: session.id });
        await db.machine.update({ where: { id: publisherAuthority.machineId }, data: {
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } }, operationProtocolCapabilitiesRevision: 1,
        } });
        const localId = "run-a-content-conflict";
        expect(await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-pending-authoritative",
            messageRole: "user",
            targetExecutionRunId: "run-a",
            targetMachineId: publisherAuthority.machineId,
        })).toMatchObject({ ok: true });
        await createCommittedTranscriptMessage({
            sessionId: session.id,
            localId,
            seq: 1,
            ciphertext: "cipher-stale-transcript",
            messageRole: "user",
        });
        await db.sessionMessage.update({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            data: { sidechainId: "sidechain-a" },
        });
        const before = await db.session.findUniqueOrThrow({ where: { id: session.id }, select: { pendingVersion: true } });

        const result = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            targetExecutionRunId: "run-a",
            expectedSidechainId: "sidechain-a",
            publisherAuthority,
        });

        expect(result).toMatchObject({ ok: false, error: "transcript-conflict" });
        await expect(db.session.findUniqueOrThrow({ where: { id: session.id }, select: { pendingVersion: true } }))
            .resolves.toEqual(before);
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true, deliveryBlockedReason: true, providerAction: true, content: true },
        })).resolves.toEqual({
            status: "queued",
            deliveryState: null,
            deliveryBlockedReason: null,
            providerAction: null,
            content: { t: "encrypted", c: "cipher-pending-authoritative" },
        });
    });

    it("preserves exact targets through discard restore send-as-new and deletion without changing main counts", async () => {
        const owner = await createAccount("target-mutation-owner");
        const session = await createSession(owner.id);
        for (const [localId, target] of [["main", null], ["run-a", "run-a"], ["run-b", "run-b"]] as const) {
            await enqueuePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId, ciphertext: localId });
            await db.sessionPendingMessage.update({ where: { sessionId_localId: { sessionId: session.id, localId } }, data: { targetExecutionRunId: target } });
        }
        await inTx((tx) => reconcileSessionPendingQueueStateInTx(tx, session.id));
        const runA = { actorUserId: owner.id, sessionId: session.id, localId: "run-a", targetExecutionRunId: "run-a" };
        expect.soft(await discardPendingMessage({ ...runA, targetExecutionRunId: "run-b" })).toMatchObject({ ok: false });
        expect.soft(await discardPendingMessage(runA)).toMatchObject({ ok: true, pendingCount: 1 });
        expect.soft(await restorePendingMessage(runA)).toMatchObject({ ok: true, pendingCount: 1 });
        await db.sessionPendingMessage.update({ where: { sessionId_localId: { sessionId: session.id, localId: "run-a" } }, data: { deliveryState: "blocked", deliveryBlockedReason: "delivery_outcome_uncertain" } });
        const replacement = await sendPendingDeliveryAsNew(runA);
        expect.soft(replacement).toMatchObject({ ok: true, didWrite: true, pendingCount: 1, pendingBlockedCount: 0 });
        if (replacement.ok) {
            expect.soft(await db.sessionPendingMessage.findUnique({ where: { sessionId_localId: { sessionId: session.id, localId: replacement.newLocalId } } })).toMatchObject({ targetExecutionRunId: "run-a", status: "queued" });
            expect.soft(await deletePendingMessage({ ...runA, localId: replacement.newLocalId })).toMatchObject({ ok: true, pendingCount: 1 });
            expect.soft(await db.sessionPendingMessage.findUnique({ where: { sessionId_localId: { sessionId: session.id, localId: replacement.newLocalId } } })).toBeNull();
        }
        expect(await db.sessionPendingMessage.findMany({ where: { sessionId: session.id, localId: { in: ["main", "run-b"] } }, orderBy: { position: "asc" }, select: { localId: true, status: true, deliveryState: true } })).toEqual([
            { localId: "main", status: "queued", deliveryState: null },
            { localId: "run-b", status: "queued", deliveryState: null },
        ]);
    });

    it.each(["enqueue", "edit", "action", "reorder", "discard", "restore", "delete", "handled", "dismiss", "sendAsNew"] as const)(
        "rechecks a collaborator revoked before the %s transaction without mutating pending",
        async (operation) => {
            const owner = await createAccount("revocation-owner");
            const collaborator = await createAccount("revocation-editor");
            const session = await createSession(owner.id);
            const share = await shareSession({ sessionId: session.id, ownerId: owner.id, participantId: collaborator.id, accessLevel: "edit" });
            const request = { actorUserId: collaborator.id, sessionId: session.id, localId: "existing" };
            await enqueuePendingMessage({ ...request, ciphertext: "cipher-existing", messageRole: "user" });
            const before = await db.sessionPendingMessage.findMany({ where: { sessionId: session.id } });
            const originalTransaction = db.$transaction;
            // Interpose only at real database acquisition; the callback still runs in a real transaction.
            db.$transaction = (async (...args: Parameters<typeof db.$transaction>) => {
                await db.sessionShare.delete({ where: { id: share.id } });
                return originalTransaction.apply(db, args);
            }) as typeof db.$transaction;
            try {
                const operations = {
                    enqueue: () => enqueuePendingMessage({ ...request, localId: "new", ciphertext: "new-cipher" }),
                    edit: () => updatePendingMessage({ ...request, ciphertext: "changed" }),
                    action: () => updatePendingRequestedAction({ ...request, requestedAction: { v: 1, kind: "send_now" } }),
                    reorder: () => reorderPendingMessages({ ...request, orderedLocalIds: [request.localId] }),
                    discard: () => discardPendingMessage(request),
                    restore: () => restorePendingMessage(request),
                    delete: () => deletePendingMessage(request),
                    handled: () => markPendingDeliveryHandled(request),
                    dismiss: () => dismissPendingDelivery(request),
                    sendAsNew: () => sendPendingDeliveryAsNew(request),
                };
                expect(await operations[operation]()).toMatchObject({ ok: false, error: "session-not-found" });
            } finally {
                db.$transaction = originalTransaction;
            }
            expect(await db.sessionPendingMessage.findMany({ where: { sessionId: session.id } })).toEqual(before);
        },
    );

    it("never settles, repairs, or activates a run row through a main operation", async () => {
        const owner = await createAccount("main-operation-isolation");
        const session = await createSession(owner.id);
        const publisherAuthority = await createCurrentPendingPublisher({ accountId: owner.id, sessionId: session.id });
        const request = { actorUserId: owner.id, sessionId: session.id, localId: "run-only" };
        await enqueuePendingMessage({ ...request, ciphertext: "cipher-run-only", messageRole: "user" });
        await db.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId: session.id, localId: request.localId } },
            data: { targetExecutionRunId: "run-a", deliveryState: "delivering" },
        });
        const original = await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId: request.localId } } });
        expect.soft(await resolveAcceptedPendingDelivery({ ...request, publisherAuthority })).toMatchObject({ ok: false });
        await blockPendingDelivery({ ...request, reason: "delivery_outcome_uncertain" });
        await markPendingDeliveryHandled(request);
        await dismissPendingDelivery(request);
        await sendPendingDeliveryAsNew(request);
        expect.soft(await db.sessionPendingMessage.findMany({ where: { sessionId: session.id } })).toEqual([original]);
        expect(await db.sessionMessage.count({ where: { sessionId: session.id } })).toBe(0);
    });

    it("commits resume authorization for an ordinary queued row without changing its delivery priority", async () => {
        const owner = await createAccount("inactive-ui-death-owner");
        const collaborator = await createAccount("inactive-ui-death-collaborator");
        const session = await createSession(owner.id);
        await shareSession({
            sessionId: session.id,
            ownerId: owner.id,
            participantId: collaborator.id,
            accessLevel: "edit",
        });
        const localId = `inactive-ui-death-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-inactive-ui-death",
            messageRole: "user",
            requestedAction: { v: 1, kind: "enqueue" },
            resumeWhenAvailable: true,
        })).resolves.toMatchObject({
            ok: true,
            didWrite: true,
            activationTarget: {
                accountId: owner.id,
                requestId: localId,
            },
        });

        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { requestedAction: true },
        })).resolves.toEqual({ requestedAction: { v: 1, kind: "enqueue" } });

        await expect(db.accountChange.findUniqueOrThrow({
            where: {
                accountId_kind_entityId: {
                    accountId: owner.id,
                    kind: "session",
                    entityId: session.id,
                },
            },
            select: { hint: true },
        })).resolves.toEqual({
            hint: expect.objectContaining({
                pendingCount: 1,
                pendingVersion: 1,
                pendingActivationRequestId: localId,
            }),
        });
        await expect(db.accountChange.findUniqueOrThrow({
            where: {
                accountId_kind_entityId: {
                    accountId: collaborator.id,
                    kind: "session",
                    entityId: session.id,
                },
            },
            select: { hint: true },
        })).resolves.toEqual({
            hint: expect.not.objectContaining({
                pendingActivationRequestId: expect.anything(),
            }),
        });

        await expect(updatePendingRequestedAction({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            requestedAction: { v: 1, kind: "enqueue" },
            resumeWhenAvailable: false,
        })).resolves.toMatchObject({ ok: true, didUpdate: true });
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingActivationRequestId: true },
        })).resolves.toEqual({ pendingActivationRequestId: null });

        await expect(updatePendingRequestedAction({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            requestedAction: { v: 1, kind: "enqueue" },
            resumeWhenAvailable: true,
        })).resolves.toMatchObject({
            ok: true,
            didUpdate: true,
            activationTarget: { accountId: owner.id, requestId: localId },
        });
    });

    it("admits machine input only for the exact capable target and persists no Machine identity", async () => {
        const owner = await createAccount("machine-admission-owner");
        const session = await createSession(owner.id);
        const sourceMachineId = `machine-source-${randomUUID()}`;
        const retryMachineId = `machine-retry-${randomUUID()}`;
        const targetMachineId = `machine-target-${randomUUID()}`;
        await db.machine.createMany({
            data: [sourceMachineId, retryMachineId].map((id) => ({
                id,
                accountId: owner.id,
                metadata: "{}",
            })),
        });
        await db.machine.create({
            data: {
                id: targetMachineId,
                accountId: owner.id,
                metadata: "{}",
                operationProtocolCapabilities: {
                    sessionInputAdmission: { protocolVersions: [1] },
                },
                operationProtocolCapabilitiesRevision: 1,
            },
        });
        await db.accessKey.create({
            data: {
                accountId: owner.id,
                machineId: targetMachineId,
                sessionId: session.id,
                data: "encrypted",
            },
        });
        const localId = `plugin-input-v1:${randomUUID()}`;
        const request = {
            accountId: owner.id,
            sourceMachineId,
            targetMachineId,
            sessionId: session.id,
            localId,
            content: { t: "encrypted" as const, c: "randomized-ciphertext" },
            requestedAction: { v: 1 as const, kind: "enqueue" as const },
            requestEqualityEvidenceV1: { kind: "e2eeTag" as const, tag: "A".repeat(43) },
        };

        await expect(enqueuePendingMessageByAuthenticatedMachine(request)).resolves.toEqual({
            status: "accepted",
            localId,
        });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { authorAccountId: true, inputAdmissionReceipt: true },
        })).resolves.toEqual({
            authorAccountId: null,
            inputAdmissionReceipt: { v: 1, issuer: "authenticatedMachine" },
        });

        await expect(enqueuePendingMessageByAuthenticatedMachine({
            ...request,
            sourceMachineId: retryMachineId,
        })).resolves.toEqual({ status: "alreadyAccepted", localId });
    });

    it("rejects a known incapable exact target before writing Pending custody", async () => {
        const owner = await createAccount("machine-admission-old-target");
        const session = await createSession(owner.id);
        const sourceMachineId = `machine-source-${randomUUID()}`;
        const targetMachineId = `machine-target-${randomUUID()}`;
        await db.machine.createMany({
            data: [sourceMachineId, targetMachineId].map((id) => ({
                id,
                accountId: owner.id,
                metadata: "{}",
            })),
        });
        await db.accessKey.create({
            data: {
                accountId: owner.id,
                machineId: targetMachineId,
                sessionId: session.id,
                data: "encrypted",
            },
        });
        const localId = `plugin-input-v1:${randomUUID()}`;

        await expect(enqueuePendingMessageByAuthenticatedMachine({
            accountId: owner.id,
            sourceMachineId,
            targetMachineId,
            sessionId: session.id,
            localId,
            content: { t: "encrypted", c: "randomized-ciphertext" },
            requestedAction: { v: 1, kind: "enqueue" },
            requestEqualityEvidenceV1: { kind: "e2eeTag", tag: "B".repeat(43) },
        })).resolves.toEqual({
            status: "rejected",
            code: "session_input_target_update_required",
        });
        await expect(db.sessionPendingMessage.count({
            where: { sessionId: session.id, localId },
        })).resolves.toBe(0);
    });

    it("distinguishes unavailable exact targets from unsupported capabilities before enqueue", async () => {
        const owner = await createAccount("target-capability-preflight-owner");
        const session = await createSession(owner.id);
        const targetMachineId = `target-capability-${randomUUID()}`;
        await db.machine.create({ data: {
            id: targetMachineId,
            accountId: owner.id,
            metadata: "{}",
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } },
            operationProtocolCapabilitiesRevision: 1,
        } });
        await db.accessKey.create({
            data: { accountId: owner.id, machineId: targetMachineId, sessionId: session.id, data: "encrypted" },
        });
        const enqueue = async (localId: string) => await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            targetExecutionRunId: "run-a",
            targetMachineId,
            localId,
            content: { t: "encrypted" as const, c: "ciphertext" },
            requestedAction: { v: 1 as const, kind: "enqueue" as const },
        });
        const expectRejection = async (localId: string, code: "session_input_target_unavailable" | "session_input_target_update_required") => {
            await expect(enqueue(localId)).resolves.toMatchObject({
                ok: false,
                admissionRejectionCode: code,
            });
            await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id } })).resolves.toBe(0);
        };

        await db.machine.update({ where: { id: targetMachineId }, data: { replacedByMachineId: "replacement-machine" } });
        await expectRejection("replaced-target", "session_input_target_unavailable");
        await db.machine.update({ where: { id: targetMachineId }, data: { replacedByMachineId: null, revokedAt: new Date() } });
        await expectRejection("revoked-target", "session_input_target_unavailable");
        await db.machine.update({
            where: { id: targetMachineId },
            data: { revokedAt: null, operationProtocolCapabilities: "malformed", operationProtocolCapabilitiesRevision: 2 },
        });
        await expectRejection("malformed-target", "session_input_target_update_required");
        await db.machine.update({
            where: { id: targetMachineId },
            data: {
                operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] } },
                operationProtocolCapabilitiesRevision: 3,
            },
        });
        await expectRejection("withdrawn-target", "session_input_target_update_required");
        await db.accessKey.delete({
            where: { accountId_machineId_sessionId: { accountId: owner.id, machineId: targetMachineId, sessionId: session.id } },
        });
        await expectRejection("missing-access-target", "session_input_target_unavailable");
    });

    it("returns target-unavailable without mutation when the strict target Machine is unavailable", async () => {
        const owner = await createAccount("target-route-rejection-owner");
        const session = await createSession(owner.id);
        const localId = `target-route-rejection-${randomUUID()}`;

        await withAuthenticatedTestApp(sessionPendingRoutes, async (app) => {
            const response = await app.inject({
                method: "POST",
                url: `/v2/sessions/${session.id}/execution-runs/run-a/pending`,
                headers: { "x-test-user-id": owner.id },
                payload: {
                    v: 1,
                    targetMachineId: `missing-machine-${randomUUID()}`,
                    localId,
                    content: { t: "encrypted", c: "ciphertext" },
                    requestedAction: { v: 1, kind: "enqueue" },
                },
            });
            expect(response.statusCode).toBe(404);
            expect(response.json()).toEqual({
                error: "session-not-found",
                code: "session_input_target_unavailable",
            });
        });

        await expect(db.sessionPendingMessage.count({
            where: { sessionId: session.id, localId },
        })).resolves.toBe(0);
    });

    it("blocks only the exact target from authoritative current-publisher evidence before claim", async () => {
        const owner = await createAccount("target-block-owner");
        const session = await createSession(owner.id);
        const publisherAuthority = await createCurrentPendingPublisher({ accountId: owner.id, sessionId: session.id });
        await db.machine.update({ where: { id: publisherAuthority.machineId }, data: {
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } }, operationProtocolCapabilitiesRevision: 1,
        } });
        for (const [localId, target] of [["main", null], ["run-a", "run-a"], ["run-b", "run-b"]] as const) {
            await enqueuePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId, ciphertext: localId });
            await db.sessionPendingMessage.update({ where: { sessionId_localId: { sessionId: session.id, localId } }, data: { targetExecutionRunId: target } });
        }
        const request = { actorUserId: owner.id, sessionId: session.id, localId: "run-a", targetExecutionRunId: "run-a", reason: "session_input_target_unavailable" as const };
        expect.soft(await blockPendingDelivery(request)).toMatchObject({ ok: false });
        expect.soft(await blockPendingDelivery({ ...request, publisherAuthority, targetExecutionRunId: "run-b" })).toMatchObject({ ok: false });
        expect.soft(await blockPendingDelivery({ ...request, publisherAuthority })).toMatchObject({ ok: true, didUpdate: true, pendingBlockedCount: 0, targetPendingState: { pendingCount: 1, pendingBlockedCount: 1 } });
        expect.soft(await db.sessionPendingMessage.findUnique({ where: { sessionId_localId: { sessionId: session.id, localId: "run-a" } } })).toMatchObject({ deliveryState: "blocked", deliveryBlockedReason: "session_input_target_unavailable", providerAction: null });
        expect.soft(await db.sessionPendingMessage.count({ where: { sessionId: session.id, deliveryState: null } })).toBe(2);
        expect(await db.sessionMessage.count({ where: { sessionId: session.id } })).toBe(0);
    });

    it("settles target input authority without publishing its user anchor before runtime acceptance", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional" });
        const owner = await createAccount("target-authority-owner");
        const session = await createSession(owner.id);
        await db.session.update({ where: { id: session.id }, data: { encryptionMode: "plain" } });
        const publisherAuthority = await createCurrentPendingPublisher({ accountId: owner.id, sessionId: session.id });
        await db.machine.update({ where: { id: publisherAuthority.machineId }, data: {
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } }, operationProtocolCapabilitiesRevision: 1,
        } });
        const localId = "target-authority";
        const recipientMeta = { happier: { kind: "participant_message.v1", payload: { recipient: { kind: "execution_run", runId: "run-a" } } } };
        const content = { t: "plain", v: { role: "user", content: { type: "text", text: "continue" }, meta: {
            ...recipientMeta, sentFrom: "cli",
            happierInputRequestV1: { v: 1, producer: "cli", caller: { kind: "host" }, permission: {} },
        } } } as const;
        expect(await enqueuePendingMessageByAuthenticatedMachine({
            accountId: owner.id, sourceMachineId: publisherAuthority.machineId, targetMachineId: publisherAuthority.machineId,
            sessionId: session.id, targetExecutionRunId: "run-a", localId, content, requestedAction: { v: 1, kind: "enqueue" },
        })).toMatchObject({ status: "accepted" });
        await db.sessionPendingMessage.update({ where: { sessionId_localId: { sessionId: session.id, localId } }, data: { deliveryState: "delivering" } });
        const finalContent = { t: "plain", v: { role: "user", content: { type: "text", text: "continue" }, meta: {
            ...recipientMeta, sentFrom: "cli",
            [SESSION_MESSAGE_PROVENANCE_META_KEY]: { v: 1, kind: "host", producer: "cli" },
            happierInputAuthorityV1: { v: 1, producer: "cli", caller: { kind: "host" }, permission: { admittedPermissionCeiling: "default" } },
        } } } as const;
        const settlement = { actorUserId: owner.id, sessionId: session.id, localId, publisherAuthority, decision: { kind: "admit", finalContent } } as const;
        expect.soft(await settlePendingInputAdmission(settlement)).toMatchObject({ ok: true, result: { status: "accepted", localId } });
        expect.soft(await db.sessionMessage.count({ where: { sessionId: session.id } })).toBe(0);
        expect.soft(await db.sessionPendingMessage.findUnique({ where: { sessionId_localId: { sessionId: session.id, localId } } })).toMatchObject({
            targetExecutionRunId: "run-a", deliveryState: "delivering", content: finalContent,
            requestEqualityEvidenceV1: { kind: "plainDigest" },
        });
        expect.soft(await settlePendingInputAdmission(settlement)).toMatchObject({ ok: true, result: { status: "alreadyAccepted", localId } });
        expect(await enqueuePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId: "main-waits", content: {
            t: "plain", v: { role: "user", content: { type: "text", text: "main input" } },
        } })).toMatchObject({ ok: true });
        expect.soft(await resolveAcceptedPendingDelivery({ ...settlement, targetExecutionRunId: "run-a", expectedSidechainId: "sidechain-a" })).toMatchObject({ ok: true, didResolve: true, pendingCount: 1, targetPendingState: { pendingCount: 0, pendingBlockedCount: 0 } });
        expect(await db.sessionMessage.findUnique({ where: { sessionId_localId: { sessionId: session.id, localId } } })).toMatchObject({ sidechainId: "sidechain-a" });
        expect.soft(await resolveAcceptedPendingDelivery({ ...settlement, targetExecutionRunId: "run-a", expectedSidechainId: "sidechain-a" })).toMatchObject({ ok: true, didResolve: false });
        expect.soft(await resolveAcceptedPendingDelivery({ ...settlement, targetExecutionRunId: "run-b", expectedSidechainId: "sidechain-a" })).toMatchObject({ ok: false });
        expect.soft(await resolveAcceptedPendingDelivery({ ...settlement, targetExecutionRunId: "run-a", expectedSidechainId: "sidechain-b" })).toMatchObject({ ok: false });
        const replay = {
            accountId: owner.id, sourceMachineId: publisherAuthority.machineId, targetMachineId: publisherAuthority.machineId,
            sessionId: session.id, localId, requestedAction: { v: 1, kind: "enqueue" },
        } as const;
        expect.soft(await enqueuePendingMessageByAuthenticatedMachine({ ...replay, targetExecutionRunId: "run-a", content })).toMatchObject({ status: "alreadyAccepted" });
        expect.soft(await enqueuePendingMessageByAuthenticatedMachine({ ...replay, targetExecutionRunId: "run-b", content: {
            ...content, v: { ...content.v, meta: { ...content.v.meta, happier: { kind: "participant_message.v1", payload: { recipient: { kind: "execution_run", runId: "run-b" } } } } },
        } })).toMatchObject({ status: "rejected", code: "session_input_idempotency_conflict" });
        const { happier: _recipient, ...mainMeta } = content.v.meta;
        expect(await enqueuePendingMessageByAuthenticatedMachine({ ...replay, content: { ...content, v: { ...content.v, meta: mainMeta } } })).toMatchObject({ status: "rejected", code: "session_input_idempotency_conflict" });
    });

    it("settles and rejoins plain Workflow V2 target input through the shared pending owner", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional" });
        const owner = await createAccount("workflow-v2-authority-owner");
        const session = await createSession(owner.id);
        await db.session.update({ where: { id: session.id }, data: { encryptionMode: "plain" } });
        const publisherAuthority = await createCurrentPendingPublisher({ accountId: owner.id, sessionId: session.id });
        await db.machine.update({ where: { id: publisherAuthority.machineId }, data: {
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } }, operationProtocolCapabilitiesRevision: 1,
        } });
        const localId = `workflow-v2-authority-${randomUUID()}`;
        const targetExecutionRunId = "execution-run-a";
        const workflow = { purpose: "invocation", runId: "workflow-run-a", invocationRecordId: "invocation-a" } as const;
        const request = { v: 2, producer: "workflow", caller: { kind: "host" }, workflow, permission: {} } as const;
        const requestedProvenance = { v: 2, kind: "workflow_invocation", runId: workflow.runId, invocationRecordId: workflow.invocationRecordId } as const;
        const recipientMeta = { happier: { kind: "participant_message.v1", payload: { recipient: { kind: "execution_run", runId: targetExecutionRunId } } } };
        const requestContent = { t: "plain", v: { role: "user", content: { type: "text", text: "continue workflow" }, meta: {
            ...recipientMeta,
            [SESSION_MESSAGE_PROVENANCE_META_KEY]: requestedProvenance,
            happierInputRequestV1: request,
        } } } as const;
        expect(await enqueuePendingMessageByAuthenticatedMachine({
            accountId: owner.id,
            sourceMachineId: publisherAuthority.machineId,
            targetMachineId: publisherAuthority.machineId,
            sessionId: session.id,
            targetExecutionRunId,
            localId,
            content: requestContent,
            requestedAction: { v: 1, kind: "enqueue" },
        })).toMatchObject({ status: "accepted" });
        await db.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            data: { deliveryState: "delivering" },
        });
        const inputAdmissionReceipt = { v: 1, issuer: "authenticatedMachine" } as const;
        const authority = settleSessionInputRequestV2({
            request,
            currentSessionPermissionCeiling: "default",
            inputAdmissionReceipt,
        });
        const provenance = settleSessionMessageProvenanceV2({
            request,
            requestedProvenance,
            inputAdmissionReceipt,
        });
        const finalContent = { ...requestContent, v: { ...requestContent.v, meta: {
            ...withSessionInputAuthority(requestContent.v.meta, authority),
            [SESSION_MESSAGE_PROVENANCE_META_KEY]: provenance,
        } } } as const;
        const settlement = {
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            publisherAuthority,
            decision: { kind: "admit", finalContent },
        } as const;

        expect.soft(await settlePendingInputAdmission(settlement)).toMatchObject({
            ok: true,
            result: { status: "accepted", localId },
        });
        expect.soft(await settlePendingInputAdmission(settlement)).toMatchObject({
            ok: true,
            result: { status: "alreadyAccepted", localId },
        });
        expect.soft(await resolveAcceptedPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            targetExecutionRunId,
            expectedSidechainId: "workflow-sidechain-a",
            localId,
            publisherAuthority,
        })).toMatchObject({ ok: true, didResolve: true });
        expect(await db.sessionMessage.findUnique({
            where: { sessionId_localId: { sessionId: session.id, localId } },
        })).toMatchObject({ content: finalContent, requestEqualityEvidenceV1: { kind: "plainDigest" } });
    });

    it("refuses to resolve an unsettled plain Workflow V2 protected request", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional" });
        const owner = await createAccount("workflow-v2-unsettled-owner");
        const session = await createSession(owner.id);
        await db.session.update({ where: { id: session.id }, data: { encryptionMode: "plain" } });
        const publisherAuthority = await createCurrentPendingPublisher({ accountId: owner.id, sessionId: session.id });
        await db.machine.update({ where: { id: publisherAuthority.machineId }, data: {
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } }, operationProtocolCapabilitiesRevision: 1,
        } });
        const localId = `workflow-v2-unsettled-${randomUUID()}`;
        const targetExecutionRunId = "execution-run-unsettled";
        const content = { t: "plain", v: { role: "user", content: { type: "text", text: "do not resolve yet" }, meta: {
            happier: { kind: "participant_message.v1", payload: { recipient: { kind: "execution_run", runId: targetExecutionRunId } } },
            [SESSION_MESSAGE_PROVENANCE_META_KEY]: { v: 2, kind: "workflow_invocation", runId: "workflow-run-unsettled", invocationRecordId: "invocation-unsettled" },
            happierInputRequestV1: {
                v: 2,
                producer: "workflow",
                caller: { kind: "host" },
                workflow: { purpose: "invocation", runId: "workflow-run-unsettled", invocationRecordId: "invocation-unsettled" },
                permission: {},
            },
        } } } as const;
        expect(await enqueuePendingMessageByAuthenticatedMachine({
            accountId: owner.id,
            sourceMachineId: publisherAuthority.machineId,
            targetMachineId: publisherAuthority.machineId,
            sessionId: session.id,
            targetExecutionRunId,
            localId,
            content,
            requestedAction: { v: 1, kind: "enqueue" },
        })).toMatchObject({ status: "accepted" });
        await db.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            data: { deliveryState: "delivering" },
        });

        await expect(resolveAcceptedPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            targetExecutionRunId,
            expectedSidechainId: "workflow-sidechain-unsettled",
            localId,
            publisherAuthority,
        })).resolves.toMatchObject({ ok: false, error: "transcript-conflict" });
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
    });

    it("accepts plain Account target input without a protected request while retaining its exact author", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional" });
        const owner = await createAccount("target-plain-owner");
        const collaborator = await createAccount("target-plain-author");
        const session = await createSession(owner.id);
        await db.session.update({ where: { id: session.id }, data: { encryptionMode: "plain" } });
        await shareSession({ sessionId: session.id, ownerId: owner.id, participantId: collaborator.id, accessLevel: "edit" });
        const publisherAuthority = await createCurrentPendingPublisher({ accountId: owner.id, sessionId: session.id });
        await db.machine.update({ where: { id: publisherAuthority.machineId }, data: {
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } }, operationProtocolCapabilitiesRevision: 1,
        } });
        const localId = "target-plain-no-request";
        const content = { t: "plain", v: { role: "user", content: { type: "text", text: "continue" }, meta: {
            happier: { kind: "participant_message.v1", payload: { recipient: { kind: "execution_run", runId: "run-a" } } },
        } } } as const;
        expect(await enqueuePendingMessage({ actorUserId: collaborator.id, sessionId: session.id, localId, targetExecutionRunId: "run-a", targetMachineId: publisherAuthority.machineId, content })).toMatchObject({ ok: true });
        const target = { actorUserId: owner.id, sessionId: session.id, targetExecutionRunId: "run-a", expectedSidechainId: "sidechain-a", publisherAuthority };
        expect(await materializeNextPendingMessage(target)).toMatchObject({ ok: true, didMaterialize: true, authorAccountId: collaborator.id });
        expect(await resolveAcceptedPendingDelivery({ ...target, localId })).toMatchObject({ ok: true, didResolve: true, message: { sidechainId: "sidechain-a" } });
        expect(await db.sessionMessage.findUnique({ where: { sessionId_localId: { sessionId: session.id, localId } } })).toMatchObject({
            sidechainId: "sidechain-a", authorAccountId: collaborator.id,
            inputAdmissionReceipt: { issuer: "authenticatedAccount", actorAccountId: collaborator.id },
            requestEqualityEvidenceV1: { kind: "plainDigest" }, content,
        });
    });

    it("binds Account E2EE terminal replay to its exact execution-run target", async () => {
        const owner = await createAccount("target-e2ee-terminal-owner");
        const collaborator = await createAccount("target-e2ee-terminal-collaborator");
        const session = await createSession(owner.id);
        await shareSession({
            sessionId: session.id,
            ownerId: owner.id,
            participantId: collaborator.id,
            accessLevel: "edit",
        });
        const publisherAuthority = await createCurrentPendingPublisher({ accountId: owner.id, sessionId: session.id });
        await db.machine.update({
            where: { id: publisherAuthority.machineId },
            data: {
                operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } },
                operationProtocolCapabilitiesRevision: 1,
            },
        });
        const localId = `target-e2ee-terminal-${randomUUID()}`;
        const content = { t: "encrypted", c: "opaque-targeted-input" } as const;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            targetExecutionRunId: "run-a",
            targetMachineId: publisherAuthority.machineId,
            content,
        })).resolves.toMatchObject({ ok: true, didWrite: true });
        const immediateRetry = await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            targetExecutionRunId: "run-a",
            targetMachineId: publisherAuthority.machineId,
            content,
        });
        expect(immediateRetry, JSON.stringify(immediateRetry)).toMatchObject({ ok: true, didWrite: false });
        await expect(materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            targetExecutionRunId: "run-a",
            expectedSidechainId: "sidechain-a",
            publisherAuthority,
        })).resolves.toMatchObject({ ok: true, didMaterialize: true });
        await expect(settlePendingInputAdmission({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            publisherAuthority,
            decision: {
                kind: "admit",
                finalContent: content,
                requestEqualityEvidenceV1: { kind: "e2eeTag", tag: "A".repeat(43) },
            },
        })).resolves.toMatchObject({ ok: true, result: { status: "accepted", localId } });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: {
                authorAccountId: true,
                inputAdmissionReceipt: true,
                requestEqualityEvidenceV1: true,
                content: true,
            },
        })).resolves.toMatchObject({
            // Opaque E2EE content has no server-visible role, so authorship is
            // carried by the immutable authenticated-Account receipt.
            authorAccountId: null,
            inputAdmissionReceipt: { issuer: "authenticatedAccount", actorAccountId: owner.id },
            requestEqualityEvidenceV1: { kind: "e2eeTag" },
            content,
        });
        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            targetExecutionRunId: "run-a",
            targetMachineId: publisherAuthority.machineId,
            content,
        })).resolves.toMatchObject({ ok: true, didWrite: false });
        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            targetExecutionRunId: "run-a",
            targetMachineId: publisherAuthority.machineId,
            content: { t: "encrypted", c: "changed-targeted-input" },
        })).resolves.toMatchObject({
            ok: false,
            admissionRejectionCode: "session_input_idempotency_conflict",
        });
        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            targetExecutionRunId: "run-a",
            targetMachineId: publisherAuthority.machineId,
            content,
            requestedAction: { v: 1, kind: "send_now" },
        })).resolves.toMatchObject({
            ok: false,
            admissionRejectionCode: "session_input_idempotency_conflict",
        });
        await expect(enqueuePendingMessage({
            actorUserId: collaborator.id,
            sessionId: session.id,
            localId,
            targetExecutionRunId: "run-a",
            targetMachineId: publisherAuthority.machineId,
            content,
        })).resolves.toMatchObject({
            ok: false,
            admissionRejectionCode: "session_input_idempotency_conflict",
        });
        await expect(resolveAcceptedPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            targetExecutionRunId: "run-a",
            expectedSidechainId: "sidechain-a",
            localId,
            publisherAuthority,
        })).resolves.toMatchObject({ ok: true, didResolve: true });
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.sessionMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { targetExecutionRunId: true },
        })).resolves.toEqual({ targetExecutionRunId: "run-a" });

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            targetExecutionRunId: "run-a",
            targetMachineId: publisherAuthority.machineId,
            content,
        })).resolves.toMatchObject({ ok: true, terminal: true, didWrite: false });
        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            targetExecutionRunId: "run-a",
            targetMachineId: publisherAuthority.machineId,
            content: { t: "encrypted", c: "changed-after-terminal" },
        })).resolves.toMatchObject({
            ok: false,
            admissionRejectionCode: "session_input_idempotency_conflict",
        });

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            targetExecutionRunId: "run-b",
            targetMachineId: publisherAuthority.machineId,
            content,
        })).resolves.toEqual({
            ok: false,
            error: "invalid-params",
            admissionRejectionCode: "session_input_idempotency_conflict",
        });

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            content,
        })).resolves.toEqual({
            ok: false,
            error: "invalid-params",
            admissionRejectionCode: "session_input_idempotency_conflict",
        });

        const mainLocalId = `main-e2ee-terminal-${randomUUID()}`;
        await createCommittedTranscriptMessage({
            sessionId: session.id,
            localId: mainLocalId,
            seq: 2,
            messageRole: "user",
            ciphertext: content.c,
        });
        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: mainLocalId,
            targetExecutionRunId: "run-a",
            targetMachineId: publisherAuthority.machineId,
            content,
        })).resolves.toEqual({
            ok: false,
            error: "invalid-params",
            admissionRejectionCode: "session_input_idempotency_conflict",
        });
    });

    it("preserves Machine input provenance when a target delivery is sent as new", async () => {
        const owner = await createAccount("target-resent-machine-owner");
        const session = await createSession(owner.id);
        const publisherAuthority = await createCurrentPendingPublisher({ accountId: owner.id, sessionId: session.id });
        await db.machine.update({ where: { id: publisherAuthority.machineId }, data: {
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } }, operationProtocolCapabilitiesRevision: 1,
        } });
        const localId = "target-resent-machine";
        expect(await enqueuePendingMessageByAuthenticatedMachine({
            accountId: owner.id, sourceMachineId: publisherAuthority.machineId, targetMachineId: publisherAuthority.machineId,
            sessionId: session.id, targetExecutionRunId: "run-a", localId, content: { t: "encrypted", c: "cipher" }, requestedAction: { v: 1, kind: "enqueue" },
            requestEqualityEvidenceV1: { kind: "e2eeTag", tag: "A".repeat(43) },
        })).toMatchObject({ status: "accepted" });
        await db.sessionPendingMessage.update({ where: { sessionId_localId: { sessionId: session.id, localId } }, data: { deliveryState: "blocked", deliveryBlockedReason: "delivery_outcome_uncertain" } });
        const resent = await sendPendingDeliveryAsNew({ actorUserId: owner.id, sessionId: session.id, localId, targetExecutionRunId: "run-a" });
        expect(resent).toMatchObject({ ok: true, didWrite: true });
        if (!resent.ok) throw new Error("Target send-as-new failed");
        expect(await db.sessionPendingMessage.findUnique({ where: { sessionId_localId: { sessionId: session.id, localId: resent.newLocalId } } })).toMatchObject({
            authorAccountId: null, inputAdmissionReceipt: { issuer: "authenticatedMachine" }, targetExecutionRunId: "run-a",
        });
    });

    it("rejects an edit that changes the authored recipient of an exact target row", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional" });
        const owner = await createAccount("target-edit-recipient-owner");
        const session = await createSession(owner.id);
        await db.session.update({ where: { id: session.id }, data: { encryptionMode: "plain" } });
        const publisherAuthority = await createCurrentPendingPublisher({ accountId: owner.id, sessionId: session.id });
        await db.machine.update({ where: { id: publisherAuthority.machineId }, data: {
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } }, operationProtocolCapabilitiesRevision: 1,
        } });
        const contentForRun = (runId: string) => ({ t: "plain", v: {
            role: "user", content: { type: "text", text: "continue" },
            meta: { happier: { kind: "participant_message.v1", payload: { recipient: { kind: "execution_run", runId } } } },
        } } as const);
        const mutation = { actorUserId: owner.id, sessionId: session.id, targetExecutionRunId: "run-a", localId: "target-edit-recipient" };
        expect(await enqueuePendingMessage({ ...mutation, targetMachineId: publisherAuthority.machineId, content: contentForRun("run-a") })).toMatchObject({ ok: true });
        expect.soft(await updatePendingMessage({ ...mutation, content: contentForRun("run-b") })).toMatchObject({ ok: false });
        expect(await db.sessionPendingMessage.findUnique({ where: { sessionId_localId: { sessionId: session.id, localId: mutation.localId } } })).toMatchObject({ content: contentForRun("run-a"), targetExecutionRunId: "run-a" });
    });

    it.each(["action", "content"] as const)("rebuilds target equality after an admitted machine draft %s is edited", async (operation) => {
        const owner = await createAccount("target-edit-equality-owner");
        const session = await createSession(owner.id);
        const publisherAuthority = await createCurrentPendingPublisher({ accountId: owner.id, sessionId: session.id });
        await db.machine.update({ where: { id: publisherAuthority.machineId }, data: {
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } }, operationProtocolCapabilitiesRevision: 1,
        } });
        const localId = "target-edit-equality";
        expect.soft(await enqueuePendingMessageByAuthenticatedMachine({
            accountId: owner.id, sourceMachineId: publisherAuthority.machineId, targetMachineId: publisherAuthority.machineId,
            sessionId: session.id, targetExecutionRunId: "run-a", localId, content: { t: "encrypted", c: "original" },
            requestedAction: { v: 1, kind: "enqueue" }, requestEqualityEvidenceV1: { kind: "e2eeTag", tag: "A".repeat(43) },
        })).toMatchObject({ status: "accepted" });
        const mutation = { actorUserId: owner.id, sessionId: session.id, targetExecutionRunId: "run-a", localId };
        const edited = operation === "action"
            ? await updatePendingRequestedAction({ ...mutation, requestedAction: { v: 1, kind: "send_now" } })
            : await updatePendingMessage({ ...mutation, ciphertext: "edited" });
        expect.soft(edited).toMatchObject({ ok: true });
        expect.soft(await db.sessionPendingMessage.findUnique({ where: { sessionId_localId: { sessionId: session.id, localId } } })).toMatchObject({ requestEqualityEvidenceV1: null, targetExecutionRunId: "run-a" });
        await db.sessionPendingMessage.update({ where: { sessionId_localId: { sessionId: session.id, localId } }, data: { deliveryState: "delivering", providerAction: "send" } });
        expect(await settlePendingInputAdmission({ ...mutation, publisherAuthority, decision: {
            kind: "admit", finalContent: { t: "encrypted", c: "admitted-edited" }, requestEqualityEvidenceV1: { kind: "e2eeTag", tag: "B".repeat(43) },
        } })).toMatchObject({ ok: true, result: { status: "accepted" } });
    });

    it("settles protected machine input exactly once before transcript visibility", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional" });
        const owner = await createAccount("machine-settlement-owner");
        const session = await createSession(owner.id);
        await db.session.update({
            where: { id: session.id },
            data: { encryptionMode: "plain" },
        });
        const publisher = await createCurrentPendingPublisher({
            accountId: owner.id,
            sessionId: session.id,
        });
        await db.machine.update({
            where: { id: publisher.machineId },
            data: {
                operationProtocolCapabilities: {
                    sessionInputAdmission: { protocolVersions: [1] },
                },
                operationProtocolCapabilitiesRevision: 1,
            },
        });
        const sourceMachineId = `machine-source-${randomUUID()}`;
        await db.machine.create({
            data: { id: sourceMachineId, accountId: owner.id, metadata: "{}" },
        });
        const requestMeta = {
            sentFrom: "cli",
            happierInputRequestV1: {
                v: 1,
                producer: "pluginSession",
                caller: {
                    kind: "plugin",
                    pluginId: "example.channels",
                    contributionLocalId: "inbound",
                },
                permission: { requestedPermissionCeiling: "safe-yolo" },
            },
        } as const;
        const finalMeta = {
            sentFrom: "cli",
            [SESSION_MESSAGE_PROVENANCE_META_KEY]: {
                v: 1,
                kind: "host",
                producer: "pluginSession",
            },
            happierInputAuthorityV1: {
                v: 1,
                producer: "pluginSession",
                caller: {
                    kind: "plugin",
                    pluginId: "example.channels",
                    contributionLocalId: "inbound",
                },
                permission: {
                    requestedPermissionCeiling: "safe-yolo",
                    admittedPermissionCeiling: "read-only",
                },
            },
        } as const;
        const authority = {
            accountId: publisher.accountId,
            machineId: publisher.machineId,
            sessionId: publisher.sessionId,
            committedFence: publisher.committedFence,
        };

        const acceptedLocalId = `plugin-input-v1:${randomUUID()}`;
        await expect(enqueuePendingMessageByAuthenticatedMachine({
            accountId: owner.id,
            sourceMachineId,
            targetMachineId: publisher.machineId,
            sessionId: session.id,
            localId: acceptedLocalId,
            content: {
                t: "plain",
                v: { role: "user", content: { type: "text", text: "admit" }, meta: requestMeta },
            },
            requestedAction: { v: 1, kind: "enqueue" },
        })).resolves.toEqual({ status: "accepted", localId: acceptedLocalId });
        await markPendingProviderDeliveryClaimed({ sessionId: session.id, localId: acceptedLocalId });

        await expect(settlePendingInputAdmission({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: acceptedLocalId,
            publisherAuthority: authority,
            decision: {
                kind: "admit",
                finalContent: {
                    t: "plain",
                    v: { role: "user", content: { type: "text", text: "admit" }, meta: finalMeta },
                },
            },
        })).resolves.toMatchObject({
            ok: true,
            result: { status: "accepted", localId: acceptedLocalId },
            message: {
                localId: acceptedLocalId,
                content: {
                    t: "plain",
                    v: { meta: finalMeta },
                },
            },
        });
        await expect(db.sessionMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId: acceptedLocalId } },
            select: { inputAdmissionReceipt: true, requestEqualityEvidenceV1: true },
        })).resolves.toEqual({
            inputAdmissionReceipt: { v: 1, issuer: "authenticatedMachine" },
            requestEqualityEvidenceV1: {
                kind: "plainDigest",
                digest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
            },
        });

        const rejectedLocalId = `plugin-input-v1:${randomUUID()}`;
        await expect(enqueuePendingMessageByAuthenticatedMachine({
            accountId: owner.id,
            sourceMachineId,
            targetMachineId: publisher.machineId,
            sessionId: session.id,
            localId: rejectedLocalId,
            content: {
                t: "plain",
                v: { role: "user", content: { type: "text", text: "reject" }, meta: requestMeta },
            },
            requestedAction: { v: 1, kind: "enqueue" },
        })).resolves.toEqual({ status: "accepted", localId: rejectedLocalId });
        await markPendingProviderDeliveryClaimed({ sessionId: session.id, localId: rejectedLocalId });
        const rejection = {
            actorUserId: owner.id,
            sessionId: session.id,
            localId: rejectedLocalId,
            publisherAuthority: authority,
            decision: { kind: "reject" as const, code: "session_input_invalid" as const },
        };
        await expect(settlePendingInputAdmission(rejection)).resolves.toMatchObject({
            ok: true,
            result: { status: "rejected", code: "session_input_invalid" },
        });
        await expect(settlePendingInputAdmission(rejection)).resolves.toMatchObject({
            ok: true,
            result: { status: "rejected", code: "session_input_invalid" },
        });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId: rejectedLocalId } },
            select: { status: true, discardedReason: true, discardedAt: true, requestEqualityEvidenceV1: true },
        })).resolves.toEqual({
            status: "discarded",
            discardedReason: "session_input_invalid",
            discardedAt: expect.any(Date),
            requestEqualityEvidenceV1: {
                kind: "plainDigest",
                digest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
            },
        });

        const automation = await db.automation.create({
            data: {
                accountId: owner.id,
                name: "cancelled Session input settlement",
                enabled: true,
                targetType: "existing_session",
                templateCiphertext: "opaque-template",
                templateVersion: 1,
            },
            select: { id: true },
        });
        const cancelledRun = await db.automationRun.create({
            data: {
                automationId: automation.id,
                accountId: owner.id,
                state: "cancelled",
                triggerId: null,
                causeKind: "manual",
                causeOccurredAt: new Date(),
                scheduledAt: new Date(),
                dueAt: new Date(),
                finishedAt: new Date(),
            },
            select: { id: true },
        });
        const cancelledLocalId = `automation:run:${cancelledRun.id}`;
        const automationRequestMeta = {
            sentFrom: "cli",
            happierInputRequestV1: {
                v: 1,
                producer: "automation",
                caller: { kind: "host" },
                automation: { automationId: automation.id, runId: cancelledRun.id },
                permission: {},
            },
        } as const;
        const automationFinalMeta = {
            sentFrom: "cli",
            [SESSION_MESSAGE_PROVENANCE_META_KEY]: {
                v: 1,
                kind: "host",
                producer: "automation",
            },
            happierInputAuthorityV1: {
                v: 1,
                producer: "automation",
                caller: { kind: "host" },
                automation: { automationId: automation.id, runId: cancelledRun.id },
                permission: { admittedPermissionCeiling: "default" },
            },
        } as const;
        await expect(enqueuePendingMessageByAuthenticatedMachine({
            accountId: owner.id,
            sourceMachineId,
            targetMachineId: publisher.machineId,
            sessionId: session.id,
            localId: cancelledLocalId,
            content: {
                t: "plain",
                v: { role: "user", content: { type: "text", text: "cancelled" }, meta: automationRequestMeta },
            },
            requestedAction: { v: 1, kind: "enqueue" },
        })).resolves.toEqual({ status: "accepted", localId: cancelledLocalId });
        await markPendingProviderDeliveryClaimed({ sessionId: session.id, localId: cancelledLocalId });

        await expect(settlePendingInputAdmission({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: cancelledLocalId,
            publisherAuthority: authority,
            decision: {
                kind: "admit",
                finalContent: {
                    t: "plain",
                    v: { role: "user", content: { type: "text", text: "cancelled" }, meta: automationFinalMeta },
                },
                validation: {
                    automation: { automationId: automation.id, runId: cancelledRun.id },
                },
            },
        })).resolves.toMatchObject({
            ok: true,
            result: { status: "rejected", code: "session_input_cancelled" },
        });
        await expect(db.sessionMessage.findUnique({
            where: { sessionId_localId: { sessionId: session.id, localId: cancelledLocalId } },
        })).resolves.toBeNull();
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId: cancelledLocalId } },
            select: { status: true, discardedReason: true },
        })).resolves.toEqual({
            status: "discarded",
            discardedReason: "session_input_cancelled",
        });

        // Cancellation is the only durable terminal input rejection: a Run
        // that settled outcome_uncertain may already have started its target
        // effect, so the exact Run-scoped input still settles normally instead
        // of being rejected with every cancellation-adjacent state.
        const uncertainRun = await db.automationRun.create({
            data: {
                automationId: automation.id,
                accountId: owner.id,
                state: "outcome_uncertain",
                triggerId: null,
                causeKind: "manual",
                causeOccurredAt: new Date(),
                scheduledAt: new Date(),
                dueAt: new Date(),
                finishedAt: new Date(),
            },
            select: { id: true },
        });
        const uncertainLocalId = `automation:run:${uncertainRun.id}`;
        const uncertainRequestMeta = {
            sentFrom: "cli",
            happierInputRequestV1: {
                v: 1,
                producer: "automation",
                caller: { kind: "host" },
                automation: { automationId: automation.id, runId: uncertainRun.id },
                permission: {},
            },
        } as const;
        const uncertainFinalMeta = {
            sentFrom: "cli",
            [SESSION_MESSAGE_PROVENANCE_META_KEY]: {
                v: 1,
                kind: "host",
                producer: "automation",
            },
            happierInputAuthorityV1: {
                v: 1,
                producer: "automation",
                caller: { kind: "host" },
                automation: { automationId: automation.id, runId: uncertainRun.id },
                permission: { admittedPermissionCeiling: "default" },
            },
        } as const;
        await expect(enqueuePendingMessageByAuthenticatedMachine({
            accountId: owner.id,
            sourceMachineId,
            targetMachineId: publisher.machineId,
            sessionId: session.id,
            localId: uncertainLocalId,
            content: {
                t: "plain",
                v: { role: "user", content: { type: "text", text: "uncertain" }, meta: uncertainRequestMeta },
            },
            requestedAction: { v: 1, kind: "enqueue" },
        })).resolves.toEqual({ status: "accepted", localId: uncertainLocalId });
        await markPendingProviderDeliveryClaimed({ sessionId: session.id, localId: uncertainLocalId });

        await expect(settlePendingInputAdmission({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: uncertainLocalId,
            publisherAuthority: authority,
            decision: {
                kind: "admit",
                finalContent: {
                    t: "plain",
                    v: { role: "user", content: { type: "text", text: "uncertain" }, meta: uncertainFinalMeta },
                },
                validation: {
                    automation: { automationId: automation.id, runId: uncertainRun.id },
                },
            },
        })).resolves.toMatchObject({
            ok: true,
            result: { status: "accepted", localId: uncertainLocalId },
        });
        await expect(db.sessionMessage.findUnique({
            where: { sessionId_localId: { sessionId: session.id, localId: uncertainLocalId } },
        })).resolves.toEqual(expect.objectContaining({ localId: uncertainLocalId }));
        await expect(db.sessionPendingMessage.findUnique({
            where: { sessionId_localId: { sessionId: session.id, localId: uncertainLocalId } },
        })).resolves.toBeNull();
    });

    it.each([
        {
            label: "owner",
            authorKind: "ui-owner",
            sessionRelationship: "owner",
            expectedActorKind: "owner",
        },
        {
            label: "shared collaborator",
            authorKind: "ui-collaborator",
            sessionRelationship: "sharedEditor",
            expectedActorKind: "sharedCollaborator",
        },
    ] as const)("accepts exact CLI settlement of $label UI provenance and rejects forged provenance", async ({
        authorKind,
        sessionRelationship,
        expectedActorKind,
    }) => {
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional" });
        const owner = await createAccount(`${authorKind}-session-owner`);
        const author = sessionRelationship === "owner" ? owner : await createAccount(authorKind);
        const session = await createSession(owner.id);
        await db.session.update({
            where: { id: session.id },
            data: { encryptionMode: "plain" },
        });
        if (sessionRelationship !== "owner") {
            await shareSession({
                sessionId: session.id,
                ownerId: owner.id,
                participantId: author.id,
                accessLevel: "edit",
            });
        }
        const publisher = await createCurrentPendingPublisher({
            accountId: owner.id,
            sessionId: session.id,
        });
        await db.machine.update({
            where: { id: publisher.machineId },
            data: {
                operationProtocolCapabilities: {
                    sessionInputAdmission: { protocolVersions: [1] },
                },
                operationProtocolCapabilitiesRevision: 1,
            },
        });
        const publisherAuthority = {
            accountId: publisher.accountId,
            machineId: publisher.machineId,
            sessionId: publisher.sessionId,
            committedFence: publisher.committedFence,
        };
        const admission = buildTrustedHostSessionInputAdmissionV1("ui");
        const receipt: Extract<SessionInputAdmissionReceiptV1, { issuer: "authenticatedAccount" }> = {
            v: 1,
            issuer: "authenticatedAccount",
            actorAccountId: author.id,
            sessionRelationship,
        };
        const authority = settleSessionInputRequestV1({
            request: admission.request,
            currentSessionPermissionCeiling: "default",
            inputAdmissionReceipt: receipt,
        });
        const expectedProvenance = settleSessionMessageProvenanceV1({
            request: admission.request,
            requestedProvenance: admission.provenance,
            inputAdmissionReceipt: receipt,
        });

        const settle = async (provenance: SessionMessageProvenanceV1) => {
            const localId = `ui-provenance-settlement-${randomUUID()}`;
            const requestMeta = {
                sentFrom: "ui",
                [SESSION_MESSAGE_PROVENANCE_META_KEY]: admission.provenance,
                happierInputRequestV1: admission.request,
            };
            await expect(enqueuePendingMessage({
                actorUserId: author.id,
                sessionId: session.id,
                localId,
                content: {
                    t: "plain",
                    v: { role: "user", content: { type: "text", text: "settle provenance" }, meta: requestMeta },
                },
            })).resolves.toMatchObject({ ok: true, didWrite: true });
            await markPendingProviderDeliveryClaimed({ sessionId: session.id, localId });
            return settlePendingInputAdmission({
                actorUserId: owner.id,
                sessionId: session.id,
                localId,
                publisherAuthority,
                decision: {
                    kind: "admit",
                    finalContent: {
                        t: "plain",
                        v: {
                            role: "user",
                            content: { type: "text", text: "settle provenance" },
                            meta: {
                                ...withSessionInputAuthorityV1(requestMeta, authority),
                                [SESSION_MESSAGE_PROVENANCE_META_KEY]: provenance,
                            },
                        },
                    },
                },
            });
        };

        await expect(settle(expectedProvenance)).resolves.toMatchObject({
            ok: true,
            result: { status: "accepted" },
            message: {
                content: {
                    t: "plain",
                    v: {
                        meta: {
                            [SESSION_MESSAGE_PROVENANCE_META_KEY]: {
                                v: 1,
                                kind: "happierApp",
                                actor: { kind: expectedActorKind },
                            },
                        },
                    },
                },
            },
        });

        const forgedProvenance: SessionMessageProvenanceV1 = {
            v: 1,
            kind: "happierApp",
            actor: { kind: expectedActorKind === "owner" ? "sharedCollaborator" : "owner" },
        };
        await expect(settle(forgedProvenance)).resolves.toEqual({ ok: false, error: "conflict" });
        await expect(settle({ v: 1, kind: "cli" })).resolves.toEqual({ ok: false, error: "conflict" });
    });

    it("rejects a whitespace-only localId at every Pending service boundary without mutation", async () => {
        const owner = await createAccount("pending-local-id-owner");
        const session = await createSession(owner.id, { id: true, pendingCount: true, pendingBlockedCount: true, pendingVersion: true });
        const localId = " \t ";

        const results = await Promise.all([
            enqueuePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId, ciphertext: "cipher" }),
            updatePendingRequestedAction({
                actorUserId: owner.id,
                sessionId: session.id,
                localId,
                requestedAction: { v: 1, kind: "send_now" },
            }),
            updatePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId, ciphertext: "cipher" }),
            deletePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId }),
            resolveAcceptedPendingDelivery({ actorUserId: owner.id, sessionId: session.id, localId }),
            blockPendingDelivery({ actorUserId: owner.id, sessionId: session.id, localId, reason: "unsupported_action" }),
            sendPendingDeliveryAsNew({ actorUserId: owner.id, sessionId: session.id, localId }),
            markPendingDeliveryHandled({ actorUserId: owner.id, sessionId: session.id, localId }),
            discardPendingMessage({ actorUserId: owner.id, sessionId: session.id, localId }),
            restorePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId }),
            reorderPendingMessages({ actorUserId: owner.id, sessionId: session.id, orderedLocalIds: [localId] }),
        ]);

        expect(results).toEqual(results.map(() => ({ ok: false, error: "invalid-params" })));
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id } })).resolves.toBe(0);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
        })).resolves.toEqual({
            pendingCount: session.pendingCount,
            pendingBlockedCount: session.pendingBlockedCount,
            pendingVersion: session.pendingVersion,
        });
    });

    it("updates only mutable queued action intent and releases steering-unavailable through send-now", async () => {
        const owner = await createAccount("pending-action-owner");
        const session = await createSession(owner.id);
        const localId = `pending-action-${randomUUID()}`;
        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-pending-action",
        });

        const changed = await updatePendingRequestedAction({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            requestedAction: { v: 1, kind: "steer_now" },
        });
        expect(changed).toMatchObject({ ok: true, didUpdate: true, requestedAction: { v: 1, kind: "steer_now" } });
        if (!changed.ok) throw new Error("expected action update");

        const idempotent = await updatePendingRequestedAction({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            requestedAction: { v: 1, kind: "steer_now" },
        });
        expect(idempotent).toMatchObject({ ok: true, didUpdate: false, pendingVersion: changed.pendingVersion });

        await db.session.update({
            where: { id: session.id },
            data: { pendingBlockedCount: 1 },
        });
        const reconciledIdempotent = await updatePendingRequestedAction({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            requestedAction: { v: 1, kind: "steer_now" },
        });
        expect(reconciledIdempotent).toMatchObject({
            ok: true,
            didUpdate: false,
            pendingCount: 1,
            pendingBlockedCount: 0,
        });
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true },
        })).resolves.toEqual({ pendingCount: 1, pendingBlockedCount: 0 });

        await db.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            data: { deliveryState: "blocked", deliveryBlockedReason: "steering_unavailable" },
        });
        await expect(updatePendingRequestedAction({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            requestedAction: { v: 1, kind: "send_now" },
        })).resolves.toMatchObject({ ok: true, requestedAction: { v: 1, kind: "send_now" } });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { requestedAction: true, deliveryState: true, deliveryBlockedReason: true },
        })).resolves.toEqual({
            requestedAction: { v: 1, kind: "send_now" },
            deliveryState: null,
            deliveryBlockedReason: null,
        });

        await db.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            data: { deliveryState: "delivering" },
        });
        await expect(updatePendingRequestedAction({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            requestedAction: { v: 1, kind: "enqueue" },
        })).resolves.toEqual({ ok: false, error: "action-conflict" });
    });

    it.each([
        "provider_rejected_before_acceptance",
        "provider_unavailable_before_acceptance",
    ] as const)("retries the same pending row after a reversible pre-acceptance block (%s)", async (blockedReason) => {
        const owner = await createAccount("pending-action-provider-rejected");
        const session = await createSession(owner.id);
        const localId = `pending-action-provider-rejected-${randomUUID()}`;
        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-pending-action-provider-rejected",
            requestedAction: { v: 1, kind: "send_now" },
        });
        await blockPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            reason: blockedReason,
        });
        await db.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            data: { providerAction: "interrupt_and_send" },
        });

        await expect(updatePendingRequestedAction({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            requestedAction: { v: 1, kind: "send_now" },
        })).resolves.toMatchObject({
            ok: true,
            didUpdate: true,
            pendingBlockedCount: 0,
        });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { requestedAction: true, providerAction: true, deliveryState: true, deliveryBlockedReason: true },
        })).resolves.toEqual({
            requestedAction: { v: 1, kind: "send_now" },
            providerAction: null,
            deliveryState: null,
            deliveryBlockedReason: null,
        });
    });

    it("repairs an orphaned provider claim when the user explicitly retries the row", async () => {
        const owner = await createAccount("pending-action-orphaned-claim");
        const session = await createSession(owner.id);
        const localId = `pending-action-orphaned-claim-${randomUUID()}`;
        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-pending-action-orphaned-claim",
            requestedAction: { v: 1, kind: "send_now" },
        });
        await db.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            data: { providerAction: "interrupt_and_send" },
        });

        await expect(updatePendingRequestedAction({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            requestedAction: { v: 1, kind: "send_now" },
        })).resolves.toMatchObject({ ok: true, didUpdate: true });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { requestedAction: true, providerAction: true, deliveryState: true },
        })).resolves.toEqual({
            requestedAction: { v: 1, kind: "send_now" },
            providerAction: null,
            deliveryState: null,
        });
    });

    it("reopens a runtime-disposed-before-delivery row through an explicit action retry", async () => {
        const owner = await createAccount("pending-action-runtime-disposed");
        const session = await createSession(owner.id);
        const localId = `pending-action-runtime-disposed-${randomUUID()}`;
        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-pending-action-runtime-disposed",
            requestedAction: { v: 1, kind: "send_now" },
        });
        await blockPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            reason: "runtime_disposed_before_delivery",
        });

        await expect(updatePendingRequestedAction({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            requestedAction: { v: 1, kind: "send_now" },
        })).resolves.toMatchObject({
            ok: true,
            didUpdate: true,
            pendingBlockedCount: 0,
        });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { requestedAction: true, deliveryState: true, deliveryBlockedReason: true },
        })).resolves.toEqual({
            requestedAction: { v: 1, kind: "send_now" },
            deliveryState: null,
            deliveryBlockedReason: null,
        });
    });

    it("atomically requeues a conditional steer rejected before provider effect", async () => {
        const owner = await createAccount("conditional-steer-fallback-owner");
        const session = await createSession(owner.id);
        const localId = `conditional-steer-fallback-${randomUUID()}`;

        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-conditional-steer-fallback",
            requestedAction: { v: 1, kind: "steer_if_active" },
        });
        const claim = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
            foregroundState: "active_steerable",
        });
        expect(claim).toMatchObject({
            ok: true,
            didMaterialize: true,
            message: {
                localId,
                requestedAction: { v: 1, kind: "steer_if_active" },
                providerAction: "steer",
            },
        });

        await expect(blockPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            reason: "conditional_steer_unavailable",
        })).resolves.toMatchObject({
            ok: true,
            didUpdate: true,
            pendingCount: 1,
            pendingBlockedCount: 0,
        });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: {
                requestedAction: true,
                providerAction: true,
                deliveryState: true,
                deliveryBlockedReason: true,
            },
        })).resolves.toEqual({
            requestedAction: { v: 1, kind: "enqueue" },
            providerAction: null,
            deliveryState: null,
            deliveryBlockedReason: null,
        });

        await expect(blockPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            reason: "conditional_steer_unavailable",
        })).resolves.toMatchObject({
            ok: true,
            didUpdate: false,
            pendingCount: 1,
            pendingBlockedCount: 0,
        });
    });

    it("keeps an explicit steer strict when steering is unavailable before provider effect", async () => {
        const owner = await createAccount("explicit-steer-unavailable-owner");
        const session = await createSession(owner.id);
        const localId = `explicit-steer-unavailable-${randomUUID()}`;

        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-explicit-steer-unavailable",
            requestedAction: { v: 1, kind: "steer_now" },
        });
        await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
            foregroundState: "active_steerable",
        });

        await expect(blockPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            reason: "conditional_steer_unavailable",
        })).resolves.toEqual({
            ok: false,
            error: "delivery-settlement-conflict",
        });
        await expect(blockPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            reason: "steering_unavailable",
        })).resolves.toMatchObject({
            ok: true,
            didUpdate: true,
            pendingBlockedCount: 1,
        });
    });

    it("rejects a physical SQL-null requested action after the persistence contraction", async () => {
        const owner = await createAccount("pending-action-physical-null");
        const session = await createSession(owner.id);
        const localId = `pending-action-physical-null-${randomUUID()}`;
        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-pending-action-physical-null",
        });
        await expect(db.$executeRawUnsafe(
            'UPDATE "SessionPendingMessage" SET "requestedAction" = NULL WHERE "sessionId" = ? AND "localId" = ?',
            session.id,
            localId,
        )).rejects.toThrow();
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { requestedAction: true },
        })).resolves.toEqual({ requestedAction: { v: 1, kind: "enqueue" } });
    });

    it("keeps the originally observed action revision stale when a transaction callback is retried", async () => {
        const owner = await createAccount("pending-action-retry-race");
        const session = await createSession(owner.id);
        const localId = `pending-action-retry-race-${randomUUID()}`;
        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-pending-action-retry-race",
        });

        const pendingMessageDelegate = db.sessionPendingMessage;
        const originalUpdateMany = pendingMessageDelegate.updateMany;
        const realUpdateMany = originalUpdateMany.bind(pendingMessageDelegate);
        const realTransaction = db.$transaction.bind(db);
        let injectedWinner = false;
        db.$transaction = (async (callback: unknown) => {
            if (typeof callback !== "function") throw new Error("expected interactive transaction callback");
            return await callback(db);
        }) as typeof db.$transaction;
        pendingMessageDelegate.updateMany = (async (
            args: Parameters<typeof realUpdateMany>[0],
        ) => {
            if (!injectedWinner) {
                injectedWinner = true;
                const observed = await db.sessionPendingMessage.findUniqueOrThrow({
                    where: { sessionId_localId: { sessionId: session.id, localId } },
                    select: { updatedAt: true },
                });
                await db.sessionPendingMessage.update({
                    where: { sessionId_localId: { sessionId: session.id, localId } },
                    data: {
                        requestedAction: { v: 1, kind: "steer_now" },
                        updatedAt: new Date(observed.updatedAt.getTime() + 1),
                    },
                });
                throw Object.assign(new Error("retry after concurrent winner"), { code: "P2034" });
            }
            return await realUpdateMany(args);
        // Prisma's delegate advertises PrismaPromise, while this retry fixture intentionally
        // interposes an ordinary async rejection at the genuine database boundary.
        }) as any;

        try {
            await expect(updatePendingRequestedAction({
                actorUserId: owner.id,
                sessionId: session.id,
                localId,
                requestedAction: { v: 1, kind: "steer_now" },
            })).resolves.toEqual({ ok: false, error: "action-conflict" });
        } finally {
            pendingMessageDelegate.updateMany = originalUpdateMany;
            db.$transaction = realTransaction;
        }

        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { requestedAction: true },
        })).resolves.toEqual({ requestedAction: { v: 1, kind: "steer_now" } });
    });

    it.each(["enqueue", "send_now"] as const)(
        "releases a proven pre-effect steering block regardless of stale %s origin intent",
        async (originKind) => {
            const owner = await createAccount(`pending-action-origin-${originKind}`);
            const session = await createSession(owner.id);
            const localId = `pending-action-origin-${originKind}-${randomUUID()}`;
            await enqueuePendingMessage({
                actorUserId: owner.id,
                sessionId: session.id,
                localId,
                ciphertext: `cipher-pending-action-origin-${originKind}`,
                requestedAction: { v: 1, kind: originKind },
            });
            await db.sessionPendingMessage.update({
                where: { sessionId_localId: { sessionId: session.id, localId } },
                data: { deliveryState: "blocked", deliveryBlockedReason: "steering_unavailable" },
            });

            await expect(updatePendingRequestedAction({
                actorUserId: owner.id,
                sessionId: session.id,
                localId,
                requestedAction: { v: 1, kind: "send_now" },
            })).resolves.toMatchObject({ ok: true, didUpdate: true });
            await expect(db.sessionPendingMessage.findUniqueOrThrow({
                where: { sessionId_localId: { sessionId: session.id, localId } },
                select: { requestedAction: true, deliveryState: true, deliveryBlockedReason: true },
            })).resolves.toEqual({
                requestedAction: { v: 1, kind: "send_now" },
                deliveryState: null,
                deliveryBlockedReason: null,
            });
        },
    );

    it("keeps concurrent claim and action mutation ordered by the database compare-and-set", async () => {
        for (let iteration = 0; iteration < 8; iteration += 1) {
            const owner = await createAccount(`pending-action-claim-race-${iteration}`);
            const session = await createSession(owner.id);
            const localId = `pending-action-claim-race-${iteration}-${randomUUID()}`;
            await enqueuePendingMessage({
                actorUserId: owner.id,
                sessionId: session.id,
                localId,
                ciphertext: `cipher-pending-action-claim-race-${iteration}`,
                requestedAction: { v: 1, kind: "steer_if_active" },
            });

            const [claimed, changed] = await Promise.all([
                materializeNextPendingMessage({
                    actorUserId: owner.id,
                    sessionId: session.id,
                    deliveryState: "provider",
                    foregroundState: "active_steerable",
                } as Parameters<typeof materializeNextPendingMessage>[0] & { deliveryState: "provider" }),
                updatePendingRequestedAction({
                    actorUserId: owner.id,
                    sessionId: session.id,
                    localId,
                    requestedAction: { v: 1, kind: "send_now" },
                }),
            ]);

            expect(claimed).toMatchObject({ ok: true, didMaterialize: true, message: { localId } });
            if (!claimed.ok || !claimed.didMaterialize) throw new Error("expected provider claim");
            if (changed.ok) {
                expect(changed.didUpdate).toBe(true);
                expect(claimed.message).toMatchObject({
                    requestedAction: { v: 1, kind: "send_now" },
                    providerAction: "interrupt_and_send",
                });
            } else {
                expect(changed).toEqual({ ok: false, error: "action-conflict" });
                expect(claimed.message).toMatchObject({
                    requestedAction: { v: 1, kind: "steer_if_active" },
                    providerAction: "steer",
                });
            }
        }
    });

    it.each([
        ["delivering", { deliveryState: "delivering", deliveryBlockedReason: null }],
        ["external handoff", { deliveryState: "external_handoff", deliveryBlockedReason: null }],
        ["ambiguous terminal delivery", { deliveryState: "blocked", deliveryBlockedReason: "ambiguous_terminal_delivery" }],
        ["uncertain delivery", { deliveryState: "blocked", deliveryBlockedReason: "delivery_outcome_uncertain" }],
        ["unknown delivery", { deliveryState: "blocked", deliveryBlockedReason: "unknown" }],
    ] as const)("keeps a provider-effect-possible %s row unchanged when an ordinary edit is attempted", async (_label, delivery) => {
        const owner = await createAccount(`pending-edit-fence-${_label}`);
        const session = await createSession(owner.id);
        const localId = `pending-edit-fence-${randomUUID()}`;
        const originalContent = { t: "encrypted" as const, c: `cipher-original-${localId}` };
        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            content: originalContent,
        });
        await db.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            data: delivery,
        });
        const before = await db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { content: true, status: true, deliveryState: true, deliveryBlockedReason: true },
        });

        await expect(updatePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: `cipher-mutated-${localId}`,
        })).resolves.toEqual({ ok: false, error: "delivery-settlement-conflict" });

        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { content: true, status: true, deliveryState: true, deliveryBlockedReason: true },
        })).resolves.toEqual(before);
    });

    it("atomically fences external handoff rows from the ordinary materializer and retains them", async () => {
        const owner = await createAccount("external-handoff-owner");
        const session = await createSession(owner.id);
        const localId = `external-handoff-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-external-handoff",
            deliveryMode: "external_handoff",
        })).resolves.toMatchObject({
            ok: true,
            didWrite: true,
            pending: { localId, deliveryStatus: { status: "external_handoff" } },
        });
        await expect(materializeNextPendingMessage({ actorUserId: owner.id, sessionId: session.id }))
            .resolves.toMatchObject({ ok: true });
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true },
        })).resolves.toEqual({ status: "queued", deliveryState: "external_handoff" });
        await expect(deletePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId }))
            .resolves.toEqual({ ok: false, error: "delivery-settlement-conflict" });
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(1);
        await expect(updatePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "mutated-external-handoff",
        })).resolves.toEqual({ ok: false, error: "delivery-settlement-conflict" });
        await expect(markPendingDeliveryHandled({ actorUserId: owner.id, sessionId: session.id, localId }))
            .resolves.toMatchObject({ ok: true, didResolve: true, pendingCount: 0 });
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(1);
    });

    it("atomically suppresses an automatic continuation when queued user input already exists", async () => {
        const owner = await createAccount("conditional-continuation-owner");
        const session = await createSession(owner.id);
        const explicitLocalId = `explicit-input-${randomUUID()}`;
        const continuationLocalId = `connected-service-continuation:${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: explicitLocalId,
            ciphertext: "cipher-explicit-input",
            messageRole: "user",
            requestedAction: { v: 1, kind: "send_now" },
        })).resolves.toMatchObject({ ok: true, didWrite: true });

        const enqueueConditionalContinuation = enqueuePendingMessageWithAction as unknown as (
            params: EnqueuePendingMessageParams & Readonly<{
                admissionMode: "continuation_if_no_queued_user_input";
            }>,
        ) => ReturnType<typeof enqueuePendingMessageWithAction>;
        await expect(enqueueConditionalContinuation(withPresentUserAuthentication({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: continuationLocalId,
            ciphertext: "cipher-continuation",
            messageRole: "user",
            requestedAction: { v: 1, kind: "send_now" },
            admissionMode: "continuation_if_no_queued_user_input",
        }))).resolves.toMatchObject({
            ok: true,
            didWrite: false,
            suppressed: true,
        });

        await expect(db.sessionPendingMessage.findMany({
            where: { sessionId: session.id, status: "queued" },
            orderBy: { position: "asc" },
            select: { localId: true, requestedAction: true },
        })).resolves.toEqual([
            { localId: explicitLocalId, requestedAction: { v: 1, kind: "send_now" } },
        ]);
    });

    it("rejoins an already-committed continuation even after newer explicit input arrives", async () => {
        const owner = await createAccount("committed-continuation-rejoin-owner");
        const session = await createSession(owner.id);
        const continuationLocalId = `connected-service-continuation:${randomUUID()}`;
        const explicitLocalId = `explicit-input-${randomUUID()}`;
        const enqueueConditionalContinuation = enqueuePendingMessageWithAction as unknown as (
            params: EnqueuePendingMessageParams & Readonly<{
                admissionMode: "continuation_if_no_queued_user_input";
            }>,
        ) => ReturnType<typeof enqueuePendingMessageWithAction>;
        const continuation = {
            actorUserId: owner.id,
            sessionId: session.id,
            localId: continuationLocalId,
            ciphertext: "cipher-continuation",
            messageRole: "user" as const,
            requestedAction: { v: 1 as const, kind: "send_now" as const },
            admissionMode: "continuation_if_no_queued_user_input" as const,
        };

        await expect(enqueueConditionalContinuation(withPresentUserAuthentication(continuation))).resolves.toMatchObject({
            ok: true,
            didWrite: true,
        });
        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: explicitLocalId,
            ciphertext: "cipher-explicit-input",
            messageRole: "user",
            requestedAction: { v: 1, kind: "send_now" },
        })).resolves.toMatchObject({ ok: true, didWrite: true });
        await expect(enqueueConditionalContinuation(withPresentUserAuthentication(continuation))).resolves.toMatchObject({
            ok: true,
            didWrite: false,
            pending: { localId: continuationLocalId },
        });

        await expect(db.sessionPendingMessage.findMany({
            where: { sessionId: session.id, status: "queued" },
            orderBy: { position: "asc" },
            select: { localId: true },
        })).resolves.toEqual([
            { localId: continuationLocalId },
            { localId: explicitLocalId },
        ]);
    });

    it("rejects reordering across an active external-handoff reservation", async () => {
        const owner = await createAccount("external-handoff-reorder-owner");
        const session = await createSession(owner.id);
        const reservedLocalId = `external-handoff-reorder-${randomUUID()}`;
        const queuedLocalId = `queued-after-external-handoff-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: reservedLocalId,
            ciphertext: "cipher-external-handoff-reorder",
            deliveryMode: "external_handoff",
        })).resolves.toMatchObject({
            ok: true,
            pending: { deliveryStatus: { status: "external_handoff" } },
        });
        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: queuedLocalId,
            ciphertext: "cipher-queued-after-external-handoff",
        })).resolves.toMatchObject({ ok: true });

        await expect(reorderPendingMessages({
            actorUserId: owner.id,
            sessionId: session.id,
            orderedLocalIds: [queuedLocalId, reservedLocalId],
        })).resolves.toEqual({ ok: false, error: "invalid-params" });

        await expect(db.sessionPendingMessage.findMany({
            where: { sessionId: session.id, status: "queued" },
            orderBy: [{ position: "asc" }, { localId: "asc" }],
            select: { localId: true, deliveryState: true },
        })).resolves.toEqual([
            { localId: reservedLocalId, deliveryState: "external_handoff" },
            { localId: queuedLocalId, deliveryState: null },
        ]);
    });

    it("allows explicit discard and restore to release an external-handoff reservation", async () => {
        const owner = await createAccount("external-handoff-discard-restore-owner");
        const session = await createSession(owner.id);
        const localId = `external-handoff-discard-restore-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-external-handoff-discard-restore",
            deliveryMode: "external_handoff",
        })).resolves.toMatchObject({
            ok: true,
            pending: { deliveryStatus: { status: "external_handoff" } },
        });

        await expect(discardPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            reason: "user_discarded",
        })).resolves.toMatchObject({ ok: true, pendingCount: 0 });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true, discardedReason: true },
        })).resolves.toEqual({
            status: "discarded",
            deliveryState: null,
            discardedReason: "user_discarded",
        });

        await expect(restorePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
        })).resolves.toMatchObject({ ok: true, pendingCount: 1 });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true, discardedReason: true },
        })).resolves.toEqual({
            status: "queued",
            deliveryState: null,
            discardedReason: null,
        });
    });

    it("treats a compatible terminal transcript localId as idempotent and rejects conflicting replay", async () => {
        const owner = await createAccount("terminal-enqueue-owner");
        const session = await createSession(owner.id);
        const localId = `terminal-enqueue-${randomUUID()}`;
        await createCommittedTranscriptMessage({
            sessionId: session.id,
            localId,
            seq: 1,
            messageRole: "user",
            ciphertext: "cipher-terminal",
            deliveryResolution: { v: 1, kind: "manual_handled" },
        });

        const compatibleReplays = await Promise.all([
            enqueuePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId, ciphertext: "cipher-terminal", messageRole: "user" }),
            enqueuePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId, ciphertext: "cipher-terminal", messageRole: "user" }),
        ]);
        expect(compatibleReplays).toEqual([
            expect.objectContaining({
                ok: true,
                didWrite: false,
                terminal: true,
                message: expect.objectContaining({ deliveryResolution: { v: 1, kind: "manual_handled" } }),
            }),
            expect.objectContaining({
                ok: true,
                didWrite: false,
                terminal: true,
                message: expect.objectContaining({ deliveryResolution: { v: 1, kind: "manual_handled" } }),
            }),
        ]);
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(enqueuePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId, ciphertext: "cipher-conflict", messageRole: "user" }))
            .resolves.toEqual({ ok: false, error: "invalid-params" });
        await expect(enqueuePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId, ciphertext: "cipher-terminal", messageRole: "agent" }))
            .resolves.toEqual({ ok: false, error: "invalid-params" });
    });

    it("stores the client PATCH structured-input envelope when a pending attachment edit removes one selection", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional" });
        const owner = await createAccount("pending-structured-edit-owner");
        const session = await createSession(owner.id);
        const localId = `pending-structured-edit-${randomUUID()}`;
        const removedAttachment = {
            v: 1,
            instanceId: "issue-42",
            attachment: { pluginId: "acme.issues", localId: "issue" },
            key: "42",
            value: { issueId: 42 },
            presentation: { label: "Issue #42", typeLabel: "Issue" },
        };
        const retainedAttachment = {
            v: 1,
            instanceId: "issue-43",
            attachment: { pluginId: "acme.issues", localId: "issue" },
            key: "43",
            value: { issueId: 43 },
            presentation: { label: "Issue #43", typeLabel: "Issue" },
        };
        const originalContent = {
            t: "plain",
            v: {
                role: "user",
                content: { type: "text", text: "old text" },
                meta: {
                    otherMetadata: "preserved",
                    happierStructuredInputV1: {
                        v: 1,
                        composerAttachments: [removedAttachment, retainedAttachment],
                    },
                },
            },
        } satisfies PrismaJson.SessionPendingMessageContent;
        const editedContent = {
            t: "plain",
            v: {
                role: "user",
                content: { type: "text", text: "edited text" },
                meta: {
                    otherMetadata: "preserved",
                    happierStructuredInputV1: {
                        v: 1,
                        composerAttachments: [retainedAttachment],
                    },
                },
            },
        } satisfies PrismaJson.SessionPendingMessageContent;

        await db.session.update({ where: { id: session.id }, data: { encryptionMode: "plain" } });
        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            content: originalContent,
            messageRole: "user",
        })).resolves.toMatchObject({ ok: true });

        await expect(updatePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            content: editedContent,
            messageRole: "user",
        })).resolves.toMatchObject({ ok: true });

        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { content: true, messageRole: true },
        })).resolves.toEqual({
            content: editedContent,
            messageRole: "user",
        });
    });

    it("atomically rotates a queued pending localId while preserving its row and queue position", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional" });
        const owner = await createAccount("pending-local-id-rotation-owner");
        const session = await createSession(owner.id);
        const localId = `pending-local-id-rotation-${randomUUID()}`;
        const replacementLocalId = `pending-local-id-replacement-${randomUUID()}`;
        const replacementMutationFingerprint = "A".repeat(43);
        const originalContent = {
            t: "plain",
            v: {
                role: "user",
                content: { type: "text", text: "old text" },
            },
        } satisfies PrismaJson.SessionPendingMessageContent;
        const editedContent = {
            t: "plain",
            v: {
                role: "user",
                content: { type: "text", text: "prepared text" },
            },
        } satisfies PrismaJson.SessionPendingMessageContent;

        await db.session.update({ where: { id: session.id }, data: { encryptionMode: "plain" } });
        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            content: originalContent,
            messageRole: "user",
        })).resolves.toMatchObject({ ok: true });
        const before = await db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { id: true, position: true },
        });

        const result = await updatePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            replacementLocalId,
            replacementMutationFingerprint,
            content: editedContent,
            messageRole: "user",
        } as Parameters<typeof updatePendingMessage>[0] & {
            replacementLocalId: string;
            replacementMutationFingerprint: string;
        });

        expect(result).toMatchObject({ ok: true, localId: replacementLocalId });
        await expect(db.sessionPendingMessage.findUnique({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { id: true },
        })).resolves.toBeNull();
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId: replacementLocalId } },
            select: {
                id: true,
                position: true,
                content: true,
                messageRole: true,
                predecessorLocalId: true,
                replacementMutationFingerprint: true,
            },
        })).resolves.toEqual({
            id: before.id,
            position: before.position,
            content: editedContent,
            messageRole: "user",
            predecessorLocalId: localId,
            replacementMutationFingerprint,
        });
    });

    it("rejoins only the exact response-lost same-row localId rotation", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional" });
        const owner = await createAccount("pending-local-id-rejoin-owner");
        const session = await createSession(owner.id);
        const predecessorLocalId = `pending-local-id-predecessor-${randomUUID()}`;
        const successorLocalId = `pending-local-id-successor-${randomUUID()}`;
        const fingerprint = "A".repeat(43);
        const differentFingerprint = "B".repeat(43);
        const content = {
            t: "plain",
            v: {
                role: "user",
                content: { type: "text", text: "prepared text" },
            },
        } satisfies PrismaJson.SessionPendingMessageContent;

        await db.session.update({ where: { id: session.id }, data: { encryptionMode: "plain" } });
        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: predecessorLocalId,
            content,
            messageRole: "user",
        })).resolves.toMatchObject({ ok: true });

        const rotate = {
            actorUserId: owner.id,
            sessionId: session.id,
            localId: predecessorLocalId,
            replacementLocalId: successorLocalId,
            replacementMutationFingerprint: fingerprint,
            content,
            messageRole: "user",
        } as Parameters<typeof updatePendingMessage>[0] & {
            replacementLocalId: string;
            replacementMutationFingerprint: string;
        };
        await expect(updatePendingMessage(rotate)).resolves.toMatchObject({ ok: true, localId: successorLocalId });

        await expect(updatePendingMessage(rotate)).resolves.toMatchObject({ ok: true, localId: successorLocalId });
        await expect(updatePendingMessage({
            ...rotate,
            replacementMutationFingerprint: differentFingerprint,
        })).resolves.toEqual({ ok: false, error: "pending-mutation-conflict" });
        await expect(db.sessionPendingMessage.findMany({
            where: { sessionId: session.id },
            select: { localId: true, content: true },
        })).resolves.toEqual([{ localId: successorLocalId, content }]);
    });

    it("does not let an old response-loss proof rejoin after the successor has changed", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional" });
        const owner = await createAccount("pending-local-id-stale-rejoin-owner");
        const session = await createSession(owner.id);
        const predecessorLocalId = `pending-local-id-stale-predecessor-${randomUUID()}`;
        const successorLocalId = `pending-local-id-stale-successor-${randomUUID()}`;
        const fingerprint = "A".repeat(43);
        const preparedContent = {
            t: "plain",
            v: {
                role: "user",
                content: { type: "text", text: "prepared text" },
            },
        } satisfies PrismaJson.SessionPendingMessageContent;
        const laterContent = {
            t: "plain",
            v: {
                role: "user",
                content: { type: "text", text: "later edit" },
            },
        } satisfies PrismaJson.SessionPendingMessageContent;

        await db.session.update({ where: { id: session.id }, data: { encryptionMode: "plain" } });
        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: predecessorLocalId,
            content: preparedContent,
            messageRole: "user",
        })).resolves.toMatchObject({ ok: true });

        const rotate = {
            actorUserId: owner.id,
            sessionId: session.id,
            localId: predecessorLocalId,
            replacementLocalId: successorLocalId,
            replacementMutationFingerprint: fingerprint,
            content: preparedContent,
            messageRole: "user",
        } as Parameters<typeof updatePendingMessage>[0] & {
            replacementLocalId: string;
            replacementMutationFingerprint: string;
        };
        await expect(updatePendingMessage(rotate)).resolves.toMatchObject({ ok: true, localId: successorLocalId });

        await expect(updatePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: successorLocalId,
            content: laterContent,
            messageRole: "user",
        })).resolves.toMatchObject({ ok: true, localId: successorLocalId });

        await expect(updatePendingMessage(rotate)).resolves.toEqual({ ok: false, error: "pending-mutation-conflict" });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId: successorLocalId } },
            select: {
                content: true,
                predecessorLocalId: true,
                replacementMutationFingerprint: true,
            },
        })).resolves.toEqual({
            content: laterContent,
            predecessorLocalId: null,
            replacementMutationFingerprint: null,
        });
    });

    it("allows shared edit participants to edit/reorder/discard/restore pending (queue is session-global)", async () => {
        const owner = await createAccount("owner");
        const collaborator = await createAccount("collab");
        const session = await createSession(owner.id);

        await shareSession({
            sessionId: session.id,
            ownerId: owner.id,
            participantId: collaborator.id,
            accessLevel: "edit",
        });

        const localIdA = `a-${randomUUID()}`;
        const localIdB = `b-${randomUUID()}`;
        const localIdC = `c-${randomUUID()}`;

        const enqueueA = await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: localIdA,
            ciphertext: "cipher-a-1",
        });
        expect(enqueueA.ok).toBe(true);

        const enqueueB = await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: localIdB,
            ciphertext: "cipher-b-1",
        });
        expect(enqueueB.ok).toBe(true);

        const enqueueC = await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: localIdC,
            ciphertext: "cipher-c-1",
        });
        expect(enqueueC.ok).toBe(true);

        const editA = await updatePendingMessage({
            actorUserId: collaborator.id,
            sessionId: session.id,
            localId: localIdA,
            ciphertext: "cipher-a-2",
        });
        expect(editA.ok).toBe(true);

        const reorder1 = await reorderPendingMessages({
            actorUserId: collaborator.id,
            sessionId: session.id,
            orderedLocalIds: [localIdB, localIdC, localIdA],
        });
        expect(reorder1.ok).toBe(true);

        const discardC = await discardPendingMessage({
            actorUserId: collaborator.id,
            sessionId: session.id,
            localId: localIdC,
            reason: "test",
        });
        expect(discardC.ok).toBe(true);

        const restoreC = await restorePendingMessage({
            actorUserId: collaborator.id,
            sessionId: session.id,
            localId: localIdC,
        });
        expect(restoreC.ok).toBe(true);

        const reorder2 = await reorderPendingMessages({
            actorUserId: collaborator.id,
            sessionId: session.id,
            orderedLocalIds: [localIdB, localIdC, localIdA],
        });
        expect(reorder2.ok).toBe(true);

        const listQueued = await listPendingMessages({
            actorUserId: collaborator.id,
            sessionId: session.id,
            includeDiscarded: false,
        });
        expect(listQueued.ok).toBe(true);
        if (!listQueued.ok) throw new Error("unexpected list failure");
        expect(listQueued.pending.map((p) => p.localId)).toEqual([localIdB, localIdC, localIdA]);

    });

    it("keeps newly queued messages after pre-existing queued rows when the queue counter lags behind", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);

        const localIdA = `seed-a-${randomUUID()}`;
        const localIdB = `seed-b-${randomUUID()}`;
        const localIdC = `new-c-${randomUUID()}`;

        await db.sessionPendingMessage.create({
            data: {
                sessionId: session.id,
                localId: localIdA,
                content: { t: "encrypted", c: "cipher-seed-a" },
                requestedAction: { v: 1, kind: "enqueue" },
                status: "queued",
                position: 5,
                authorAccountId: owner.id,
            },
        });
        await db.sessionPendingMessage.create({
            data: {
                sessionId: session.id,
                localId: localIdB,
                content: { t: "encrypted", c: "cipher-seed-b" },
                requestedAction: { v: 1, kind: "enqueue" },
                status: "queued",
                position: 6,
                authorAccountId: owner.id,
            },
        });
        await db.session.updateMany({
            where: { id: session.id },
            data: { pendingQueueSeq: 0 },
        });

        const enqueue = await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: localIdC,
            ciphertext: "cipher-new-c",
        });
        expect(enqueue.ok).toBe(true);
        if (!enqueue.ok || enqueue.terminal === true || enqueue.suppressed === true) throw new Error("expected enqueue to succeed");
        expect(enqueue.pending.position).toBe(7);

        const listQueued = await listPendingMessages({
            actorUserId: owner.id,
            sessionId: session.id,
            includeDiscarded: false,
        });
        expect(listQueued.ok).toBe(true);
        if (!listQueued.ok) throw new Error("unexpected list failure");
        expect(listQueued.pending.map((p) => p.localId)).toEqual([localIdA, localIdB, localIdC]);
        expect(listQueued.pending.map((p) => p.position)).toEqual([5, 6, 7]);
    });

    it("forbids non-owner participants from materializing pending", async () => {
        const owner = await createAccount("owner");
        const collaborator = await createAccount("collab");
        const session = await createSession(owner.id);

        await shareSession({
            sessionId: session.id,
            ownerId: owner.id,
            participantId: collaborator.id,
            accessLevel: "edit",
        });

        const localId = `a-${randomUUID()}`;
        const enqueue = await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-a-1",
        });
        expect(enqueue.ok).toBe(true);

        const publisher = await createCurrentPendingPublisher({
            accountId: owner.id,
            sessionId: session.id,
        });
        const materialize = await materializeNextPendingMessage({
            actorUserId: collaborator.id,
            sessionId: session.id,
            expectedRuntimeActivityRevision: publisher.runtimeActivityRevision,
            publisherAuthority: publisher,
        });
        expect(materialize.ok).toBe(false);
        if (materialize.ok) throw new Error("expected forbidden");
        expect(materialize.error).toBe("forbidden");
    });

    it("claims provider-delivery prompt rows without writing transcript until accepted", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery",
            messageRole: "user",
        })).resolves.toMatchObject({ ok: true });

        const materialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        } as Parameters<typeof materializeNextPendingMessage>[0] & { deliveryState: "provider" });
        expect(materialize.ok).toBe(true);
        if (!materialize.ok || !materialize.didMaterialize) throw new Error("expected provider materialization");
        expect(materialize).toMatchObject({
            didWriteMessage: false,
            message: {
                id: null,
                seq: null,
                localId,
                messageRole: "user",
                content: { t: "encrypted", c: "cipher-provider-delivery" },
            },
            pendingCount: 1,
            pendingBlockedCount: 0,
            deliveryState: { mode: "provider", unresolved: true },
        });
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);

        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true, deliveryBlockedReason: true },
        })).resolves.toEqual({ status: "queued", deliveryState: "delivering", deliveryBlockedReason: null });
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true },
        })).resolves.toEqual({ pendingCount: 1 });

        const accepted = await resolveAcceptedPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
        });
        expect(accepted).toMatchObject({
            ok: true,
            didResolve: true,
            didWrite: true,
            pendingCount: 0,
            pendingBlockedCount: 0,
            message: {
                id: expect.any(String),
                seq: expect.any(Number),
                localId,
            },
        });
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(1);
    });

    it("rejects raw materialization without publisher authority before transcript or Pending mutation", async () => {
        const owner = await createAccount("raw-materializer-no-authority");
        const session = await createSession(owner.id);
        const localId = `raw-materializer-no-authority-${randomUUID()}`;
        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-raw-materializer-no-authority",
        })).resolves.toMatchObject({ ok: true });
        const pendingBefore = await db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true, providerAction: true, updatedAt: true },
        });
        const sessionBefore = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
        });

        await expect(materializeNextPendingMessageWithAuthority({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        } as unknown as MaterializeNextPendingMessageParams)).resolves.toEqual({ ok: false, error: "forbidden" });

        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true, providerAction: true, updatedAt: true },
        })).resolves.toEqual(pendingBefore);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
        })).resolves.toEqual(sessionBefore);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
    });

    it.each([
        {
            mode: "e2ee" as const,
            content: { t: "encrypted" as const, c: "opaque-pending-ciphertext" },
        },
        {
            mode: "plain" as const,
            content: {
                t: "plain" as const,
                v: { role: "user", content: { type: "text", text: "plain pending payload" } },
            },
        },
    ])("preserves the $mode envelope through provider custody and exact settlement", async ({ mode, content }) => {
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional" });
        const owner = await createAccount(`provider-envelope-${mode}`);
        const session = await createSession(owner.id);
        if (mode === "plain") {
            await db.session.update({ where: { id: session.id }, data: { encryptionMode: "plain" } });
        }
        const localId = `provider-envelope-${mode}-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            content,
            messageRole: "user",
        })).resolves.toMatchObject({ ok: true, pending: { localId, content } });

        const materialized = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        } as Parameters<typeof materializeNextPendingMessage>[0] & { deliveryState: "provider" });
        expect(materialized).toMatchObject({
            ok: true,
            didMaterialize: true,
            didWriteMessage: false,
            message: { localId, content },
        });

        await expect(resolveAcceptedPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
        })).resolves.toMatchObject({ ok: true, didResolve: true, message: { localId, content } });
        await expect(db.sessionMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { content: true },
        })).resolves.toEqual({ content });
    });

    it("defers queued materialization for after-runtime-idle timing while runtime activity projection is live", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `runtime-idle-defer-${randomUUID()}`;
        const nowMs = Date.now();

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-runtime-idle-defer",
            messageRole: "user",
        })).resolves.toMatchObject({ ok: true });
        await db.session.updateMany({
            where: { id: session.id },
            data: {
                runtimeActivityState: "active",
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: BigInt(nowMs),
                runtimeActivityRevision: BigInt(1),
            },
        });

        const materialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryTiming: "after_runtime_idle",
        } as Parameters<typeof materializeNextPendingMessage>[0] & { deliveryTiming: "after_runtime_idle" });

        if (!materialize.ok) throw new Error(`unexpected materialization failure: ${JSON.stringify(materialize)}`);
        expect(materialize.ok).toBe(true);
        expect(materialize).toMatchObject({
            didMaterialize: false,
            pendingCount: 1,
            pendingBlockedCount: 0,
            deferredReason: "waiting_for_runtime_activity",
        });
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { deliveryState: true, deliveryBlockedReason: true },
        })).resolves.toEqual({ deliveryState: null, deliveryBlockedReason: null });
    });

    it.each([
        ["ready", "send"],
        ["active_steerable", "steer"],
        ["active_unsteerable", "steer"],
    ] as const)("claims an exact later steer-now row with %s foreground while leaving its ordinary FIFO neighbor queued", async (foregroundState, providerAction) => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const earlierLocalId = `exact-earlier-${randomUUID()}`;
        const exactLocalId = `exact-target-${randomUUID()}`;
        const nowMs = Date.now();

        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: earlierLocalId,
            ciphertext: "cipher-exact-earlier",
            messageRole: "user",
        });
        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: exactLocalId,
            ciphertext: "cipher-exact-target",
            messageRole: "user",
            requestedAction: { v: 1, kind: "steer_now" },
        });
        await db.session.updateMany({
            where: { id: session.id },
            data: {
                runtimeActivityState: "active",
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: BigInt(nowMs),
                runtimeActivityRevision: BigInt(1),
            },
        });

        const materialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryTiming: "after_runtime_idle",
            foregroundState,
        });

        expect(materialize).toMatchObject({
            ok: true,
            didMaterialize: true,
            didWriteMessage: false,
            message: {
                localId: exactLocalId,
                requestedAction: { v: 1, kind: "steer_now" },
                providerAction,
            },
        });
        await expect(db.sessionPendingMessage.findMany({
            where: { sessionId: session.id, status: "queued" },
            select: { localId: true, deliveryState: true },
            orderBy: [{ position: "asc" }, { localId: "asc" }],
        })).resolves.toEqual([
            { localId: earlierLocalId, deliveryState: null },
            { localId: exactLocalId, deliveryState: "delivering" },
        ]);
    });

    it("defers canonical active runtime activity independently of owner presence or clocks", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `runtime-idle-fresh-presence-${randomUUID()}`;
        const nowMs = Date.now();

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-runtime-idle-fresh-presence",
            messageRole: "user",
        })).resolves.toMatchObject({ ok: true });
        await db.session.updateMany({
            where: { id: session.id },
            data: {
                active: true,
                lastActiveAt: new Date(nowMs - 1_000),
                runtimeActivityState: "active",
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: BigInt(nowMs - 120_000),
                runtimeActivityRevision: BigInt(3),
            },
        });

        const materialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryTiming: "after_runtime_idle",
        } as Parameters<typeof materializeNextPendingMessage>[0] & { deliveryTiming: "after_runtime_idle" });

        if (!materialize.ok) throw new Error(`unexpected materialization failure: ${JSON.stringify(materialize)}`);
        expect(materialize).toMatchObject({
            didMaterialize: false,
            pendingCount: 1,
            pendingBlockedCount: 0,
            deferredReason: "waiting_for_runtime_activity",
        });
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(1);
    });

    it("accepts a provider-materialized delivery by committing the pending row once", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-queued-accepted-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery-queued-accepted",
            messageRole: "user",
        })).resolves.toMatchObject({ ok: true });

        const materialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(materialize.ok).toBe(true);
        if (!materialize.ok || !materialize.didMaterialize) throw new Error("expected provider materialization");
        expect(materialize).toMatchObject({
            didWriteMessage: false,
            pendingCount: 1,
            pendingBlockedCount: 0,
            deliveryState: { mode: "provider", unresolved: true },
            message: {
                id: null,
                seq: null,
                localId,
                messageRole: "user",
                content: { t: "encrypted", c: "cipher-provider-delivery-queued-accepted" },
            },
        });

        const accepted = await resolveAcceptedPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
        });

        expect(accepted).toMatchObject({
            ok: true,
            didResolve: true,
            didWrite: true,
            pendingCount: 0,
            pendingBlockedCount: 0,
            message: {
                id: expect.any(String),
                seq: expect.any(Number),
                localId,
                messageRole: "user",
                content: { t: "encrypted", c: "cipher-provider-delivery-queued-accepted" },
                deliveryResolution: null,
            },
        });
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(1);
        await expect(markPendingDeliveryHandled({ actorUserId: owner.id, sessionId: session.id, localId }))
            .resolves.toMatchObject({ ok: true, didResolve: false, pendingCount: 0 });
        await expect(db.sessionMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { deliveryResolution: true },
        })).resolves.toEqual({ deliveryResolution: null });
    });

    it("blocks accepted provider delivery that collides with divergent transcript content", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-conflict-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-pending-authoritative",
        })).resolves.toMatchObject({ ok: true });

        await markPendingProviderDeliveryClaimed({ sessionId: session.id, localId });
        await createCommittedTranscriptMessage({
            sessionId: session.id,
            localId,
            seq: 1,
            messageRole: "user",
            ciphertext: "cipher-stale-transcript",
        });

        const accepted = await resolveAcceptedPendingDelivery({ actorUserId: owner.id, sessionId: session.id, localId });
        expect(accepted.ok).toBe(false);
        if (accepted.ok || accepted.error !== "transcript-conflict") {
            throw new Error("expected accept conflict");
        }
        expect(accepted.error).toBe("transcript-conflict");
        expect(accepted.pendingStateChanged).toBe(true);
        expect(accepted.pendingCount).toBe(1);
        expect(accepted.pendingBlockedCount).toBe(1);
        expect(accepted.pendingVersion).toBeGreaterThan(0);
        expect(accepted.recipientCursors).toEqual([
            expect.objectContaining({ accountId: owner.id, cursor: expect.any(Number) }),
        ]);
        expect(accepted).toHaveProperty("badgeAttentionChanged", false);

        await expect(db.sessionMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { content: true, messageRole: true },
        })).resolves.toEqual({ content: { t: "encrypted", c: "cipher-stale-transcript" }, messageRole: "user" });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true, deliveryBlockedReason: true, content: true },
        })).resolves.toEqual({
            status: "queued",
            deliveryState: "blocked",
            deliveryBlockedReason: "unknown",
            content: { t: "encrypted", c: "cipher-pending-authoritative" },
        });
    });

    it("accepts a blocked provider delivery and never accepts an unclaimed queued row", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const blockedLocalId = `provider-delivery-accept-blocked-${randomUUID()}`;
        const queuedLocalId = `provider-delivery-accept-queued-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: blockedLocalId,
            ciphertext: "cipher-provider-delivery-accept-blocked",
        })).resolves.toMatchObject({ ok: true });
        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: queuedLocalId,
            ciphertext: "cipher-provider-delivery-accept-queued",
        })).resolves.toMatchObject({ ok: true });

        const materialized = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        } as Parameters<typeof materializeNextPendingMessage>[0] & { deliveryState: "provider" });
        expect(materialized.ok).toBe(true);
        if (!materialized.ok || !materialized.didMaterialize) throw new Error("expected provider claim");
        expect(materialized.message.localId).toBe(blockedLocalId);

        await expect(blockPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: blockedLocalId,
            reason: "delivery_outcome_uncertain",
        })).resolves.toMatchObject({ ok: true, didUpdate: true });

        const blockedAccepted = await resolveAcceptedPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: blockedLocalId,
        });
        expect(blockedAccepted.ok).toBe(true);
        if (!blockedAccepted.ok) throw new Error("expected blocked provider delivery acceptance");
        expect(blockedAccepted.didResolve).toBe(true);
        expect(blockedAccepted.didWrite).toBe(true);
        expect(blockedAccepted.pendingCount).toBe(1);
        expect(blockedAccepted.pendingBlockedCount).toBe(0);

        const queuedAccepted = await resolveAcceptedPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: queuedLocalId,
        });
        expect(queuedAccepted.ok).toBe(true);
        if (!queuedAccepted.ok) throw new Error("expected queued provider delivery acceptance no-op");
        expect(queuedAccepted.didResolve).toBe(false);
        expect(queuedAccepted.pendingCount).toBe(1);

        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId: queuedLocalId } },
            select: { status: true, deliveryState: true },
        })).resolves.toEqual({ status: "queued", deliveryState: null });
        await expect(db.sessionMessage.findMany({
            where: { sessionId: session.id },
            orderBy: { seq: "asc" },
            select: { localId: true, content: true },
        })).resolves.toEqual([
            { localId: blockedLocalId, content: { t: "encrypted", c: "cipher-provider-delivery-accept-blocked" } },
        ]);
    });

    it("leaves provider materialization pending when it collides with divergent transcript content", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-materialize-conflict-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-pending-authoritative",
        })).resolves.toMatchObject({ ok: true });

        await createCommittedTranscriptMessage({
            sessionId: session.id,
            localId,
            seq: 1,
            messageRole: "user",
            ciphertext: "cipher-provider-stale-transcript",
        });

        const materialized = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        } as Parameters<typeof materializeNextPendingMessage>[0] & { deliveryState: "provider" });
        expect(materialized.ok).toBe(false);
        if (materialized.ok) throw new Error("expected materialization conflict");
        expect(materialized.error).toBe("transcript-conflict");

        await expect(db.sessionMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { content: true, messageRole: true },
        })).resolves.toEqual({ content: { t: "encrypted", c: "cipher-provider-stale-transcript" }, messageRole: "user" });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true, deliveryBlockedReason: true, content: true },
        })).resolves.toEqual({
            status: "queued",
            deliveryState: null,
            deliveryBlockedReason: null,
            content: { t: "encrypted", c: "cipher-provider-pending-authoritative" },
        });
    });

    it("returns the exact compatible transcript anchor across provider claim replay and the successor claim", async () => {
        const owner = await createAccount("provider-materialize-current-anchor");
        const session = await createSession(owner.id);
        const firstLocalId = `provider-materialize-current-anchor-first-${randomUUID()}`;
        const successorLocalId = `provider-materialize-current-anchor-successor-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: firstLocalId,
            ciphertext: "cipher-current-anchor-first",
            messageRole: "user",
        })).resolves.toMatchObject({ ok: true });
        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: successorLocalId,
            ciphertext: "cipher-current-anchor-successor",
            messageRole: "user",
        })).resolves.toMatchObject({ ok: true });

        await createCommittedTranscriptMessage({
            sessionId: session.id,
            localId: firstLocalId,
            seq: 7,
            messageRole: "user",
            ciphertext: "cipher-current-anchor-first",
        });
        await createCommittedTranscriptMessage({
            sessionId: session.id,
            localId: successorLocalId,
            seq: 9,
            messageRole: "user",
            ciphertext: "cipher-current-anchor-successor",
        });
        const committed = await db.sessionMessage.findMany({
            where: { sessionId: session.id, localId: { in: [firstLocalId, successorLocalId] } },
            select: { id: true, localId: true, seq: true },
            orderBy: { seq: "asc" },
        });
        expect(committed).toHaveLength(2);

        const first = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(first).toMatchObject({
            ok: true,
            didMaterialize: true,
            didWriteMessage: false,
            message: {
                id: committed[0]!.id,
                seq: 7,
                localId: firstLocalId,
            },
        });

        await expect(materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        })).resolves.toMatchObject({
            ok: true,
            didMaterialize: true,
            didWriteMessage: false,
            message: {
                id: committed[0]!.id,
                seq: 7,
                localId: firstLocalId,
            },
        });

        await expect(resolveAcceptedPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: firstLocalId,
        })).resolves.toMatchObject({ ok: true, didResolve: true });

        await expect(materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        })).resolves.toMatchObject({
            ok: true,
            didMaterialize: true,
            didWriteMessage: false,
            message: {
                id: committed[1]!.id,
                seq: 9,
                localId: successorLocalId,
            },
        });
    });

    it("joins accepted provider delivery with a compatible transcript row without rewriting content", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-compatible-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-compatible",
            messageRole: "user",
        })).resolves.toMatchObject({ ok: true });

        await markPendingProviderDeliveryClaimed({ sessionId: session.id, localId });
        await createCommittedTranscriptMessage({
            sessionId: session.id,
            localId,
            seq: 1,
            messageRole: null,
            ciphertext: "cipher-compatible",
        });

        const accepted = await resolveAcceptedPendingDelivery({ actorUserId: owner.id, sessionId: session.id, localId });
        expect(accepted.ok).toBe(true);
        if (!accepted.ok || !accepted.didResolve || !accepted.message) throw new Error("expected accepted join");
        expect(accepted.message.content).toEqual({ t: "encrypted", c: "cipher-compatible" });
        expect(accepted.message.messageRole).toBe("user");

        await expect(db.sessionMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { content: true, messageRole: true },
        })).resolves.toEqual({ content: { t: "encrypted", c: "cipher-compatible" }, messageRole: "user" });
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
    });

    it("handles duplicate accepted delivery resolution races idempotently", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-accepted-race-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery-accepted-race",
        })).resolves.toMatchObject({ ok: true });

        const materialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(materialize.ok).toBe(true);
        if (!materialize.ok || !materialize.didMaterialize) throw new Error("expected provider materialization");
        expect(materialize).toMatchObject({
            didWriteMessage: false,
            pendingCount: 1,
            pendingBlockedCount: 0,
            deliveryState: { mode: "provider", unresolved: true },
        });

        const results = await Promise.all([
            resolveAcceptedPendingDelivery({ actorUserId: owner.id, sessionId: session.id, localId }),
            resolveAcceptedPendingDelivery({ actorUserId: owner.id, sessionId: session.id, localId }),
        ]);

        expect(results.every((result) => result.ok)).toBe(true);
        expect(results.filter((result) => result.ok && result.didResolve).length).toBe(1);
        expect(results.filter((result) => result.ok && !result.didResolve).length).toBe(1);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(1);
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true },
        })).resolves.toEqual({ pendingCount: 0, pendingBlockedCount: 0 });
    });

    it("settles an accepted exact send-now row while leaving its earlier queued neighbor untouched", async () => {
        const owner = await createAccount("provider-delivery-exact-send-now");
        const session = await createSession(owner.id);
        const earlierLocalId = `provider-delivery-exact-earlier-${randomUUID()}`;
        const selectedLocalId = `provider-delivery-exact-selected-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: earlierLocalId,
            ciphertext: "cipher-provider-delivery-exact-earlier",
        })).resolves.toMatchObject({ ok: true });
        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: selectedLocalId,
            ciphertext: "cipher-provider-delivery-exact-selected",
            requestedAction: { v: 1, kind: "send_now" },
        })).resolves.toMatchObject({ ok: true });

        await expect(materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            foregroundState: "active_unsteerable",
        })).resolves.toMatchObject({
            ok: true,
            didMaterialize: true,
            message: {
                localId: selectedLocalId,
                requestedAction: { v: 1, kind: "send_now" },
                providerAction: "interrupt_and_send",
            },
        });

        await expect(resolveAcceptedPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: selectedLocalId,
        })).resolves.toMatchObject({ ok: true, didResolve: true });

        await expect(db.sessionPendingMessage.findMany({
            where: { sessionId: session.id },
            orderBy: { position: "asc" },
            select: { localId: true, status: true, deliveryState: true },
        })).resolves.toEqual([{
            localId: earlierLocalId,
            status: "queued",
            deliveryState: null,
        }]);
        await expect(db.sessionMessage.findMany({
            where: { sessionId: session.id },
            select: { localId: true },
        })).resolves.toEqual([{ localId: selectedLocalId }]);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true },
        })).resolves.toEqual({ pendingCount: 1, pendingBlockedCount: 0 });
    });

    it("rejects accepted provider delivery when neither a pending row nor a committed legacy message exists", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-missing-${randomUUID()}`;

        const accepted = await resolveAcceptedPendingDelivery({ actorUserId: owner.id, sessionId: session.id, localId });
        expect(accepted.ok).toBe(false);
        if (accepted.ok) throw new Error("expected accepted resolution rejection");
        expect(accepted.error).toBe("not-found");
    });

    it("treats accepted provider delivery as idempotent when the pending row is gone but a committed legacy message exists", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-legacy-${randomUUID()}`;

        const committed = await db.sessionMessage.create({
            data: {
                sessionId: session.id,
                localId,
                seq: 1,
                messageRole: "user",
                content: { t: "encrypted", c: "cipher-provider-delivery-legacy" },
            },
        });

        const accepted = await resolveAcceptedPendingDelivery({ actorUserId: owner.id, sessionId: session.id, localId });
        expect(accepted.ok).toBe(true);
        if (!accepted.ok) throw new Error("expected accepted resolution to be idempotent");
        expect(accepted.didResolve).toBe(false);
        expect(accepted.pendingCount).toBe(0);
        expect(accepted.message).toMatchObject({
            id: committed.id,
            seq: 1,
            localId,
            messageRole: "user",
            content: { t: "encrypted", c: "cipher-provider-delivery-legacy" },
        });
    });

    it("blocks accepted provider delivery that collides with an incompatible transcript role", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-role-conflict-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-role-conflict",
            messageRole: "user",
        })).resolves.toMatchObject({ ok: true });

        await markPendingProviderDeliveryClaimed({ sessionId: session.id, localId });
        await createCommittedTranscriptMessage({
            sessionId: session.id,
            localId,
            seq: 1,
            messageRole: "agent",
            ciphertext: "cipher-role-conflict",
        });

        const accepted = await resolveAcceptedPendingDelivery({ actorUserId: owner.id, sessionId: session.id, localId });
        expect(accepted.ok).toBe(false);
        if (accepted.ok) throw new Error("expected role conflict");
        expect(accepted.error).toBe("transcript-conflict");

        await expect(db.sessionMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { content: true, messageRole: true },
        })).resolves.toEqual({ content: { t: "encrypted", c: "cipher-role-conflict" }, messageRole: "agent" });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true, deliveryBlockedReason: true },
        })).resolves.toEqual({
            status: "queued",
            deliveryState: "blocked",
            deliveryBlockedReason: "unknown",
        });
    });

    it("keeps a later ordinary enqueue row behind an unresolved FIFO claim", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const firstLocalId = `provider-delivery-first-${randomUUID()}`;
        const secondLocalId = `provider-delivery-second-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: firstLocalId,
            ciphertext: "cipher-provider-delivery-first",
        })).resolves.toMatchObject({ ok: true });
        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: secondLocalId,
            ciphertext: "cipher-provider-delivery-second",
        })).resolves.toMatchObject({ ok: true });

        const firstMaterialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        } as Parameters<typeof materializeNextPendingMessage>[0] & { deliveryState: "provider" });
        expect(firstMaterialize).toMatchObject({
            ok: true,
            didMaterialize: true,
            didWriteMessage: false,
            message: {
                id: null,
                seq: null,
                localId: firstLocalId,
                requestedAction: { v: 1, kind: "enqueue" },
            },
        });

        const secondMaterialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        } as Parameters<typeof materializeNextPendingMessage>[0] & { deliveryState: "provider" });
        expect(secondMaterialize).toMatchObject({
            ok: true,
            didMaterialize: true,
            didWriteMessage: false,
            message: {
                id: null,
                seq: null,
                localId: firstLocalId,
                requestedAction: { v: 1, kind: "enqueue" },
            },
        });

        const secondAcceptedFirst = await resolveAcceptedPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: secondLocalId,
        });
        expect(secondAcceptedFirst).toMatchObject({ ok: true, didResolve: false });
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId: secondLocalId } })).resolves.toBe(0);

        const firstAccepted = await resolveAcceptedPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: firstLocalId,
        });
        expect(firstAccepted).toMatchObject({ ok: true, didResolve: true });

        await expect(materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        } as Parameters<typeof materializeNextPendingMessage>[0] & { deliveryState: "provider" })).resolves.toMatchObject({
            ok: true,
            didMaterialize: true,
            didWriteMessage: false,
            message: { id: null, seq: null, localId: secondLocalId },
        });

        const secondAccepted = await resolveAcceptedPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: secondLocalId,
        });
        expect(secondAccepted).toMatchObject({ ok: true, didResolve: true });

        const committed = await db.sessionMessage.findMany({
            where: { sessionId: session.id, localId: { in: [firstLocalId, secondLocalId] } },
            select: { localId: true, seq: true },
            orderBy: { seq: "asc" },
        });
        expect(committed.map((message) => message.localId)).toEqual([firstLocalId, secondLocalId]);
    });

    it("keeps claimed provider-delivery rows immutable to normal pending edits", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-immutable-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery-original",
        })).resolves.toMatchObject({ ok: true });

        const materialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        } as Parameters<typeof materializeNextPendingMessage>[0] & { deliveryState: "provider" });
        expect(materialize.ok).toBe(true);
        if (!materialize.ok || !materialize.didMaterialize) throw new Error("expected provider delivery claim");
        expect(materialize.didWriteMessage).toBe(false);

        await expect(updatePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery-edited",
        })).resolves.toMatchObject({ ok: false, error: "not-found" });

        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true, deliveryBlockedReason: true, content: true },
        })).resolves.toEqual({
            status: "queued",
            deliveryState: "delivering",
            deliveryBlockedReason: null,
            content: { t: "encrypted", c: "cipher-provider-delivery-original" },
        });
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
    });

    it("blocks and marks handled claimed provider delivery with a durable transcript row", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-blocked-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery-blocked",
        })).resolves.toMatchObject({ ok: true });

        const firstMaterialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        } as Parameters<typeof materializeNextPendingMessage>[0] & { deliveryState: "provider" });
        expect(firstMaterialize.ok).toBe(true);
        if (!firstMaterialize.ok || !firstMaterialize.didMaterialize) throw new Error("expected first materialization");
        expect(firstMaterialize.didWriteMessage).toBe(false);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);

        const blocked = await blockPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            reason: "terminal_composer_draft",
        });
        expect(blocked).toMatchObject({ ok: true, didUpdate: true, pendingCount: 1, pendingBlockedCount: 1 });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { deliveryState: true, deliveryBlockedReason: true },
        })).resolves.toEqual({ deliveryState: "blocked", deliveryBlockedReason: "terminal_composer_draft" });

        const blockedMaterialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        } as Parameters<typeof materializeNextPendingMessage>[0] & { deliveryState: "provider" });
        expect(blockedMaterialize).toMatchObject({ ok: true, didMaterialize: false, pendingCount: 1, pendingBlockedCount: 1 });

        const reblocked = await blockPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            reason: "ambiguous_terminal_delivery",
        });
        expect(reblocked).toMatchObject({ ok: true, didUpdate: true, pendingCount: 1, pendingBlockedCount: 1 });

        const uncertain = await blockPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            reason: "delivery_outcome_uncertain",
        });
        expect(uncertain).toMatchObject({ ok: true, didUpdate: true, pendingCount: 1, pendingBlockedCount: 1 });
        const handled = await markPendingDeliveryHandled({ actorUserId: owner.id, sessionId: session.id, localId });
        expect(handled).toMatchObject({
            ok: true,
            didResolve: true,
            didWrite: true,
            pendingCount: 0,
            pendingBlockedCount: 0,
            message: {
                id: expect.any(String),
                seq: expect.any(Number),
                localId,
                deliveryResolution: { v: 1, kind: "manual_handled" },
            },
        });
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(1);
        await expect(db.$queryRaw<Array<{ kind: string | null }>>`
            SELECT json_extract("deliveryResolution", '$.kind') AS "kind"
            FROM "SessionMessage"
            WHERE "sessionId" = ${session.id} AND "localId" = ${localId}
        `).resolves.toEqual([{ kind: "manual_handled" }]);

        await expect(markPendingDeliveryHandled({ actorUserId: owner.id, sessionId: session.id, localId }))
            .resolves.toMatchObject({ ok: true, didResolve: false, pendingCount: 0 });
        await expect(resolveAcceptedPendingDelivery({ actorUserId: owner.id, sessionId: session.id, localId }))
            .resolves.toMatchObject({
                ok: true,
                didResolve: false,
                message: { localId, deliveryResolution: { v: 1, kind: "manual_handled" } },
            });
        await expect(db.sessionMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { deliveryResolution: true },
        })).resolves.toEqual({ deliveryResolution: { v: 1, kind: "manual_handled" } });
    });

    it("atomically archives an uncertain delivery and enqueues the same content under a new identity", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `uncertain-original-${randomUUID()}`;

        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-uncertain-send-as-new",
        });
        await blockPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            reason: "delivery_outcome_uncertain",
        });

        const firstSendAsNew = await sendPendingDeliveryAsNew({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
        });
        expect(firstSendAsNew).toMatchObject({
            ok: true,
            didWrite: true,
            pendingCount: 1,
            pendingBlockedCount: 0,
            newLocalId: expect.any(String),
        });
        if (!firstSendAsNew.ok) throw new Error("send-as-new unexpectedly failed");
        const newLocalId = firstSendAsNew.newLocalId;

        await expect(db.sessionPendingMessage.findMany({
            where: { sessionId: session.id, localId: { in: [localId, newLocalId] } },
            orderBy: { localId: "asc" },
            select: { localId: true, status: true, deliveryState: true, discardedReason: true, content: true, requestedAction: true },
        })).resolves.toEqual(expect.arrayContaining([
            expect.objectContaining({ localId, status: "discarded", discardedReason: "resent_as_new" }),
            expect.objectContaining({
                localId: newLocalId,
                status: "queued",
                deliveryState: null,
                discardedReason: null,
                content: { t: "encrypted", c: "cipher-uncertain-send-as-new" },
                requestedAction: { v: 1, kind: "enqueue" },
            }),
        ]));
        await expect(listPendingMessages({
            actorUserId: owner.id,
            sessionId: session.id,
            includeDiscarded: true,
        })).resolves.toMatchObject({
            ok: true,
            pending: [expect.objectContaining({ localId: newLocalId, status: "queued" })],
        });
        await expect(restorePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId }))
            .resolves.toEqual({ ok: false, error: "delivery-settlement-conflict" });

        await expect(sendPendingDeliveryAsNew({ actorUserId: owner.id, sessionId: session.id, localId }))
            .resolves.toMatchObject({ ok: true, didWrite: false, pendingCount: 1, pendingBlockedCount: 0, newLocalId });
        await db.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId: session.id, localId: newLocalId } },
            data: { content: { t: "encrypted", c: "different-ciphertext" } },
        });
        await expect(sendPendingDeliveryAsNew({ actorUserId: owner.id, sessionId: session.id, localId }))
            .resolves.toEqual({ ok: false, error: "identity-conflict" });

        const accepted = await resolveAcceptedPendingDelivery({ actorUserId: owner.id, sessionId: session.id, localId });
        expect(accepted).toMatchObject({ ok: true, didResolve: true, message: { localId } });
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId: newLocalId } })).resolves.toBe(1);
    });

    it("settles late exact evidence for a dismissed uncertain delivery without restoring its executable state", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `uncertain-dismissed-${randomUUID()}`;

        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-uncertain-dismissed",
        });
        await blockPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            reason: "delivery_outcome_uncertain",
        });
        await expect(dismissPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
        })).resolves.toMatchObject({ ok: true, didDismiss: true, pendingCount: 0, pendingBlockedCount: 0 });

        await expect(restorePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId }))
            .resolves.toEqual({ ok: false, error: "delivery-settlement-conflict" });
        await expect(deletePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId }))
            .resolves.toEqual({ ok: false, error: "delivery-settlement-conflict" });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true, discardedReason: true },
        })).resolves.toEqual({
            status: "discarded",
            deliveryState: null,
            discardedReason: "dismissed_uncertain",
        });

        await expect(resolveAcceptedPendingDelivery({ actorUserId: owner.id, sessionId: session.id, localId }))
            .resolves.toMatchObject({ ok: true, didResolve: true, message: { localId } });
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(1);
    });

    it("rejects manufacturing an uncertainty tombstone from an ordinary queued row", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `queued-not-uncertain-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-queued-not-uncertain",
        })).resolves.toMatchObject({ ok: true });

        await expect(dismissPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
        })).resolves.toEqual({ ok: false, error: "delivery-settlement-conflict" });
        await expect(discardPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            reason: "dismissed_uncertain",
        })).resolves.toEqual({ ok: false, error: "delivery-settlement-conflict" });
        await expect(discardPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            reason: "resent_as_new",
        })).resolves.toEqual({ ok: false, error: "delivery-settlement-conflict" });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true, discardedReason: true },
        })).resolves.toEqual({ status: "queued", deliveryState: null, discardedReason: null });
    });

    it("marks a blocked provider delivery as handled by committing the pending row", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-manual-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery-manual",
        })).resolves.toMatchObject({ ok: true });

        const blocked = await blockPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            reason: "manual_user_handled",
        });
        expect(blocked).toMatchObject({ ok: true, didUpdate: true, pendingCount: 1, pendingBlockedCount: 1 });
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);

        const handled = await markPendingDeliveryHandled({ actorUserId: owner.id, sessionId: session.id, localId });
        expect(handled).toMatchObject({
            ok: true,
            didResolve: true,
            didWrite: true,
            pendingCount: 0,
            pendingBlockedCount: 0,
            message: {
                id: expect.any(String),
                seq: expect.any(Number),
                localId,
                content: { t: "encrypted", c: "cipher-provider-delivery-manual" },
            },
        });
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(1);
    });

    it("marks a delivering provider delivery as handled after row-first materialization", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-delivering-handled-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery-delivering-handled",
        })).resolves.toMatchObject({ ok: true });

        const materialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        } as Parameters<typeof materializeNextPendingMessage>[0] & { deliveryState: "provider" });
        expect(materialize.ok).toBe(true);
        if (!materialize.ok || !materialize.didMaterialize) throw new Error("expected materialization");
        expect(materialize.didWriteMessage).toBe(false);

        const handled = await markPendingDeliveryHandled({ actorUserId: owner.id, sessionId: session.id, localId });
        expect(handled).toMatchObject({
            ok: true,
            didResolve: true,
            didWrite: true,
            pendingCount: 0,
            pendingBlockedCount: 0,
            message: {
                id: expect.any(String),
                seq: expect.any(Number),
                localId,
            },
        });

        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true },
        })).resolves.toEqual({ pendingCount: 0, pendingBlockedCount: 0 });

        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(1);
    });

    it("does not advance ready projection when a shared editor marks provider delivery handled", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional" });
        const owner = await createAccount("owner");
        const collaborator = await createAccount("collab");
        const session = await createSession(owner.id);

        await shareSession({
            sessionId: session.id,
            ownerId: owner.id,
            participantId: collaborator.id,
            accessLevel: "edit",
        });
        await db.session.updateMany({
            where: { id: session.id },
            data: { encryptionMode: "plain" },
        });

        const localId = `provider-delivery-editor-ready-handled-${randomUUID()}`;
        const readyContent = {
            t: "plain",
            v: {
                role: "agent",
                content: {
                    type: "event",
                    id: "ready-event-editor-handled",
                    data: { type: "ready" },
                },
            },
        } satisfies PrismaJson.SessionPendingMessageContent;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            content: readyContent,
            messageRole: "event",
        })).resolves.toMatchObject({ ok: true });

        const materialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(materialize.ok).toBe(true);
        if (!materialize.ok || !materialize.didMaterialize) throw new Error("expected provider materialization");
        expect(materialize.didWriteMessage).toBe(false);

        const handled = await markPendingDeliveryHandled({ actorUserId: collaborator.id, sessionId: session.id, localId });
        expect(handled.ok).toBe(true);
        if (!handled.ok || !handled.didResolve || !handled.message) throw new Error("expected handled resolution");
        expect(handled).not.toHaveProperty("readyProjection");

        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { latestReadyEventSeq: true, latestReadyEventAt: true },
        })).resolves.toEqual({ latestReadyEventSeq: null, latestReadyEventAt: null });
    });

    it("handles duplicate handled delivery resolution races idempotently", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-handled-race-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery-handled-race",
        })).resolves.toMatchObject({ ok: true });

        await markPendingProviderDeliveryClaimed({ sessionId: session.id, localId });

        const results = await Promise.all([
            markPendingDeliveryHandled({ actorUserId: owner.id, sessionId: session.id, localId }),
            markPendingDeliveryHandled({ actorUserId: owner.id, sessionId: session.id, localId }),
        ]);

        expect(results.every((result) => result.ok)).toBe(true);
        expect(results.filter((result) => result.ok && result.didResolve).length).toBe(1);
        expect(results.filter((result) => result.ok && !result.didResolve).length).toBe(1);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(1);
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true },
        })).resolves.toEqual({ pendingCount: 0, pendingBlockedCount: 0 });
    });

    it("does not refresh an in-flight delivering row during queue reorder", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const publisherAuthority = await createCurrentPendingPublisher({ accountId: owner.id, sessionId: session.id });
        const localId = `provider-delivery-reorder-stale-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery-reorder-stale",
        })).resolves.toMatchObject({ ok: true });

        const claim = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
            publisherAuthority,
        } as Parameters<typeof materializeNextPendingMessage>[0] & { deliveryState: "provider" });
        expect(claim.ok).toBe(true);
        if (!claim.ok || !claim.didMaterialize) throw new Error("expected provider claim");
        expect(claim.didWriteMessage).toBe(false);

        const staleUpdatedAt = new Date(Date.now() - 10 * 60_000);
        await db.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            data: { updatedAt: staleUpdatedAt },
        });

        const reorder = await reorderPendingMessages({
            actorUserId: owner.id,
            sessionId: session.id,
            orderedLocalIds: [localId],
        });
        expect(reorder.ok).toBe(true);

        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { deliveryState: true, deliveryBlockedReason: true, updatedAt: true },
        })).resolves.toEqual({
            deliveryState: "delivering",
            deliveryBlockedReason: null,
            updatedAt: staleUpdatedAt,
        });
    });




    it("does not recover a provider-delivery claim merely because time advances", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const publisherAuthority = await createCurrentPendingPublisher({ accountId: owner.id, sessionId: session.id });
        const localId = `provider-delivery-fresh-stale-sweep-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery-fresh-stale-sweep",
        })).resolves.toMatchObject({ ok: true });

        const firstMaterialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
            publisherAuthority,
        } as Parameters<typeof materializeNextPendingMessage>[0] & { deliveryState: "provider" });
        expect(firstMaterialize.ok).toBe(true);
        if (!firstMaterialize.ok || !firstMaterialize.didMaterialize) throw new Error("expected first materialization");
        expect(firstMaterialize.didWriteMessage).toBe(false);

        await db.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            data: { updatedAt: new Date(Date.now() - 10 * 60_000) },
        });

        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { deliveryState: true, deliveryBlockedReason: true },
        })).resolves.toEqual({ deliveryState: "delivering", deliveryBlockedReason: null });
    });


    it("returns one frozen claim lineage under concurrent same-publisher materialization", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const publisherAuthority = await createCurrentPendingPublisher({ accountId: owner.id, sessionId: session.id });
        const localId = `provider-race-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-race",
        })).resolves.toMatchObject({ ok: true });

        const results = await Promise.all([
            materializeNextPendingMessage({
                actorUserId: owner.id,
                sessionId: session.id,
                deliveryState: "provider",
                publisherAuthority,
            } as Parameters<typeof materializeNextPendingMessage>[0] & { deliveryState: "provider" }),
            materializeNextPendingMessage({
                actorUserId: owner.id,
                sessionId: session.id,
                deliveryState: "provider",
                publisherAuthority,
            } as Parameters<typeof materializeNextPendingMessage>[0] & { deliveryState: "provider" }),
        ]);

        expect(results.every((result) => result.ok)).toBe(true);
        expect(results.every((result) => result.ok && result.didMaterialize)).toBe(true);
        expect(new Set(results.map((result) => result.ok ? result.pendingVersion : -1)).size).toBe(1);
        expect(results.map((result) => result.ok && result.didMaterialize ? result.message.localId : null))
            .toEqual([localId, localId]);
        const materialized = results.find((result) => result.ok && result.didMaterialize);
        if (!materialized?.ok || !materialized.didMaterialize) throw new Error("expected provider delivery claim");
        expect(materialized.didWriteMessage).toBe(false);
        expect(materialized.message).toEqual(expect.objectContaining({
            id: null,
            seq: null,
            localId,
            content: { t: "encrypted", c: "cipher-provider-race" },
        }));
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true, deliveryBlockedReason: true },
        })).resolves.toEqual({
            status: "queued",
            deliveryState: "delivering",
            deliveryBlockedReason: null,
        });
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true },
        })).resolves.toEqual({ pendingCount: 1, pendingBlockedCount: 0 });
    });

    it("rejoins the same heartbeat-advanced publisher's frozen claim before timing, foreground, or Activity evaluation", async () => {
        const owner = await createAccount("provider-rejoin");
        const session = await createSession(owner.id);
        const publisherAuthority = await createCurrentPendingPublisher({ accountId: owner.id, sessionId: session.id });
        const localId = `provider-rejoin-${randomUUID()}`;
        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-rejoin",
            requestedAction: { v: 1, kind: "send_now" },
        });

        const first = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
            publisherAuthority,
            foregroundState: "active_unsteerable",
            deliveryTiming: "after_foreground_ready",
        });
        expect(first).toMatchObject({
            ok: true,
            didMaterialize: true,
            message: { localId, requestedAction: { kind: "send_now" }, providerAction: "interrupt_and_send" },
        });
        if (!first.ok || !first.didMaterialize) throw new Error("expected fresh provider claim");
        const claimed = await db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { providerAction: true, updatedAt: true },
        });
        const touched = await publisherAuthority.presence.touchPublisher({ socket: publisherAuthority.socket });
        if (touched.status !== "touched") throw new Error("expected publisher heartbeat advance");
        const rejoinPublisherAuthority = {
            accountId: publisherAuthority.accountId,
            machineId: publisherAuthority.machineId,
            sessionId: publisherAuthority.sessionId,
            committedFence: touched.committedFence,
        };
        const frozenSessionUpdatedAt = new Date("2020-01-02T03:04:05.000Z");
        await db.session.update({
            where: { id: session.id },
            data: { updatedAt: frozenSessionUpdatedAt },
        });
        const sessionBeforeRejoin = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { updatedAt: true, pendingVersion: true, active: true, lastActiveAt: true },
        });

        const rejoined = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
            publisherAuthority: rejoinPublisherAuthority,
            foregroundState: "ready",
            deliveryTiming: "after_runtime_idle",
        });

        expect(rejoined).toMatchObject({
            ok: true,
            didMaterialize: true,
            didWriteMessage: false,
            pendingVersion: first.pendingVersion,
            message: { localId, requestedAction: { kind: "send_now" }, providerAction: "interrupt_and_send" },
        });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { providerAction: true, updatedAt: true },
        })).resolves.toEqual(claimed);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { updatedAt: true, pendingVersion: true, active: true, lastActiveAt: true },
        })).resolves.toEqual(sessionBeforeRejoin);
    });

    it("claims ordinary after-runtime-idle work from the exact current-publisher idle revision", async () => {
        const owner = await createAccount("provider-idle-current-revision");
        const session = await createSession(owner.id);
        const publisherAuthority = await createCurrentPendingPublisher({ accountId: owner.id, sessionId: session.id });
        const localId = `provider-idle-current-revision-${randomUUID()}`;
        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-idle-current-revision",
        });
        await db.session.update({
            where: { id: session.id },
            data: {
                runtimeActivityState: "idle",
                runtimeActivityActiveCount: 0,
                runtimeActivityObservedAt: BigInt(Date.now()),
                runtimeActivityRevision: BigInt(42),
            },
        });

        await expect(materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
            publisherAuthority,
            foregroundState: "ready",
            deliveryTiming: "after_runtime_idle",
            expectedRuntimeActivityRevision: 42,
        })).resolves.toMatchObject({
            ok: true,
            didMaterialize: true,
            didWriteMessage: false,
            message: {
                localId,
                requestedAction: { kind: "enqueue" },
                providerAction: "send",
            },
            deliveryState: { mode: "provider", unresolved: true },
        });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { deliveryState: true, deliveryBlockedReason: true, providerAction: true },
        })).resolves.toEqual({
            deliveryState: "delivering",
            deliveryBlockedReason: null,
            providerAction: "send",
        });
    });

    it("lets urgent current-publisher delivery bypass after-runtime-idle Activity evaluation and revision fencing", async () => {
        const owner = await createAccount("provider-urgent-zero-activity");
        const session = await createSession(owner.id);
        const publisherAuthority = await createCurrentPendingPublisher({ accountId: owner.id, sessionId: session.id });
        const localId = `provider-urgent-zero-activity-${randomUUID()}`;
        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-urgent-zero-activity",
            requestedAction: { v: 1, kind: "send_now" },
        });
        await db.session.update({
            where: { id: session.id },
            data: {
                runtimeActivityState: "active",
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: BigInt(Date.now()),
                runtimeActivityRevision: BigInt(41),
            },
        });
        const activityBefore = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
                runtimeActivityObservedAt: true,
                runtimeActivityRevision: true,
            },
        });

        await expect(materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
            publisherAuthority,
            foregroundState: "active_unsteerable",
            deliveryTiming: "after_runtime_idle",
        })).resolves.toMatchObject({
            ok: true,
            didMaterialize: true,
            didWriteMessage: false,
            message: {
                localId,
                requestedAction: { kind: "send_now" },
                providerAction: "interrupt_and_send",
            },
        });
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
                runtimeActivityObservedAt: true,
                runtimeActivityRevision: true,
            },
        })).resolves.toEqual(activityBefore);
    });

    it("gives a replaced publisher zero fresh-claim or rejoin authority without mutating Queue state", async () => {
        const owner = await createAccount("provider-replaced");
        const session = await createSession(owner.id);
        const predecessorAuthority = await createCurrentPendingPublisher({ accountId: owner.id, sessionId: session.id });
        const successorAuthority = await createCurrentPendingPublisher({ accountId: owner.id, sessionId: session.id });
        const localId = `provider-replaced-${randomUUID()}`;
        await enqueuePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId, ciphertext: "cipher-replaced" });

        const beforeStaleClaim = await db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { deliveryState: true, providerAction: true, requestedAction: true, updatedAt: true },
        });
        const versionBeforeStaleClaim = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingVersion: true },
        });
        await expect(materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
            publisherAuthority: predecessorAuthority,
        })).resolves.toEqual({ ok: false, error: "forbidden" });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { deliveryState: true, providerAction: true, requestedAction: true, updatedAt: true },
        })).resolves.toEqual(beforeStaleClaim);
        await expect(db.session.findUniqueOrThrow({ where: { id: session.id }, select: { pendingVersion: true } }))
            .resolves.toEqual(versionBeforeStaleClaim);

        const claimed = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
            publisherAuthority: successorAuthority,
        });
        expect(claimed).toMatchObject({ ok: true, didMaterialize: true, message: { localId } });
        const claimedRow = await db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { deliveryState: true, providerAction: true, requestedAction: true, updatedAt: true },
        });
        const claimedVersion = await db.session.findUniqueOrThrow({ where: { id: session.id }, select: { pendingVersion: true } });
        await expect(materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
            publisherAuthority: predecessorAuthority,
        })).resolves.toEqual({ ok: false, error: "forbidden" });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { deliveryState: true, providerAction: true, requestedAction: true, updatedAt: true },
        })).resolves.toEqual(claimedRow);
        await expect(db.session.findUniqueOrThrow({ where: { id: session.id }, select: { pendingVersion: true } }))
            .resolves.toEqual(claimedVersion);
    });

    it("gives a replaced publisher zero accepted-settlement authority without creating transcript state", async () => {
        const owner = await createAccount("provider-replaced-settlement");
        const session = await createSession(owner.id);
        const predecessorAuthority = await createCurrentPendingPublisher({ accountId: owner.id, sessionId: session.id });
        const localId = `provider-replaced-settlement-${randomUUID()}`;
        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-replaced-settlement",
        });

        await expect(materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
            publisherAuthority: predecessorAuthority,
        })).resolves.toMatchObject({ ok: true, didMaterialize: true, message: { localId } });

        await createCurrentPendingPublisher({ accountId: owner.id, sessionId: session.id });
        const before = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
        });
        const pendingBefore = await db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true, providerAction: true, requestedAction: true, updatedAt: true },
        });

        const staleSettlementRequest = {
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            publisherAuthority: predecessorAuthority,
        };
        await expect(resolveAcceptedPendingDelivery(staleSettlementRequest)).resolves.toEqual({
            ok: false,
            error: "forbidden",
        });

        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true, providerAction: true, requestedAction: true, updatedAt: true },
        })).resolves.toEqual(pendingBefore);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
        })).resolves.toEqual(before);
    });

    it("rolls back the exact row, counts, and version when publisher authority changes after the row claim", async () => {
        const owner = await createAccount("provider-mid-transaction-replacement");
        const session = await createSession(owner.id);
        const publisherAuthority = await createCurrentPendingPublisher({ accountId: owner.id, sessionId: session.id });
        const localId = `provider-mid-transaction-replacement-${randomUUID()}`;
        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-mid-transaction-replacement",
        });
        const rowBefore = await db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: {
                status: true,
                deliveryState: true,
                deliveryBlockedReason: true,
                providerAction: true,
                updatedAt: true,
            },
        });
        const sessionBefore = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                pendingCount: true,
                pendingBlockedCount: true,
                pendingVersion: true,
                lastActiveAt: true,
            },
        });

        await db.$executeRawUnsafe(`
            CREATE TRIGGER replace_pending_publisher_after_claim
            AFTER UPDATE OF deliveryState ON SessionPendingMessage
            WHEN NEW.deliveryState = 'delivering'
            BEGIN
                UPDATE Session
                SET lastActiveAt = lastActiveAt + 1
                WHERE id = NEW.sessionId;
            END
        `);
        try {
            await expect(materializeNextPendingMessage({
                actorUserId: owner.id,
                sessionId: session.id,
                deliveryState: "provider",
                publisherAuthority,
            })).resolves.toEqual({ ok: false, error: "forbidden" });
        } finally {
            await db.$executeRawUnsafe("DROP TRIGGER IF EXISTS replace_pending_publisher_after_claim");
        }

        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: {
                status: true,
                deliveryState: true,
                deliveryBlockedReason: true,
                providerAction: true,
                updatedAt: true,
            },
        })).resolves.toEqual(rowBefore);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                pendingCount: true,
                pendingBlockedCount: true,
                pendingVersion: true,
                lastActiveAt: true,
            },
        })).resolves.toEqual(sessionBefore);
    });

    it("clamps pendingCount at 0 when discarding a queued message from stale-low session state", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id, { id: true });

        const localId = `a-${randomUUID()}`;
        const enqueue = await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-a-1",
        });
        expect(enqueue.ok).toBe(true);

        // Simulate a race or data inconsistency where the queued row exists but the denormalized counter is already 0.
        await db.session.updateMany({ where: { id: session.id }, data: { pendingCount: 0 } });
        const before = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingVersion: true },
        });

        const discard = await discardPendingMessage({ actorUserId: owner.id, sessionId: session.id, localId, reason: "test" });
        expect(discard.ok).toBe(true);
        if (!discard.ok) throw new Error("expected discard to succeed");
        expect(discard.pendingCount).toBe(0);
        expect(discard.pendingVersion).toBe(before.pendingVersion + 1);

        const after = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingVersion: true },
        });
        expect(after.pendingCount).toBe(0);
        expect(after.pendingVersion).toBe(before.pendingVersion + 1);
    });

    it("discards a delivering provider-owned pending row", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-discard-delivering-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-discard-delivering",
        })).resolves.toMatchObject({ ok: true });

        const materialized = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        } as Parameters<typeof materializeNextPendingMessage>[0] & { deliveryState: "provider" });
        expect(materialized.ok).toBe(true);
        if (!materialized.ok || !materialized.didMaterialize) throw new Error("expected materialized provider claim");
        expect(materialized.didWriteMessage).toBe(false);
        const beforeDiscard = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
        });
        await expect(db.sessionPendingMessage.findUnique({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true },
        })).resolves.toEqual({ status: "queued", deliveryState: "delivering" });

        const discard = await discardPendingMessage({ actorUserId: owner.id, sessionId: session.id, localId, reason: "test" });
        expect(discard.ok).toBe(true);
        if (!discard.ok) throw new Error("expected discard to succeed");
        expect(discard.pendingCount).toBe(beforeDiscard.pendingCount - 1);
        expect(discard.pendingBlockedCount).toBe(beforeDiscard.pendingBlockedCount);
        expect(discard.pendingVersion).toBe(beforeDiscard.pendingVersion + 1);

        await expect(db.sessionPendingMessage.findUnique({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true, discardedReason: true },
        })).resolves.toEqual({
            status: "discarded",
            deliveryState: null,
            discardedReason: "test",
        });
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
    });

    it("rejects generic deletion of a delivering row so exact acceptance remains the retirement owner", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delete-delivering-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delete-delivering",
        })).resolves.toMatchObject({ ok: true });

        const materialized = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        } as Parameters<typeof materializeNextPendingMessage>[0] & { deliveryState: "provider" });
        expect(materialized.ok).toBe(true);
        if (!materialized.ok || !materialized.didMaterialize) throw new Error("expected materialized provider claim");
        expect(materialized.didWriteMessage).toBe(false);

        const beforeDelete = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
        });

        const deleted = await deletePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId });
        expect(deleted).toEqual({ ok: false, error: "delivery-settlement-conflict" });

        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true },
        })).resolves.toEqual({ status: "queued", deliveryState: "delivering" });
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
        })).resolves.toEqual(beforeDelete);

        const accepted = await resolveAcceptedPendingDelivery({ actorUserId: owner.id, sessionId: session.id, localId });
        expect(accepted).toMatchObject({ ok: true, didResolve: true, pendingCount: 0, pendingBlockedCount: 0 });
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(1);

        const afterAccepted = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
        });
        expect(afterAccepted).toEqual({
            pendingCount: 0,
            pendingBlockedCount: 0,
            pendingVersion: beforeDelete.pendingVersion + 1,
        });
        await expect(deletePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId })).resolves.toMatchObject({
            ok: true,
            ...afterAccepted,
        });
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
        })).resolves.toEqual(afterAccepted);
    });

    it("serializes concurrent delivering-row deletion and exact acceptance without corrupting counts or version", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delete-accept-race-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delete-accept-race",
        })).resolves.toMatchObject({ ok: true });
        await expect(materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        } as Parameters<typeof materializeNextPendingMessage>[0] & { deliveryState: "provider" })).resolves.toMatchObject({
            ok: true,
            didMaterialize: true,
            didWriteMessage: false,
        });

        const before = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
        });
        const [deleted, accepted] = await Promise.all([
            deletePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId }),
            resolveAcceptedPendingDelivery({ actorUserId: owner.id, sessionId: session.id, localId }),
        ]);

        expect(accepted).toMatchObject({ ok: true, pendingCount: 0, pendingBlockedCount: 0 });
        expect(deleted.ok === true || (deleted.ok === false && deleted.error === "delivery-settlement-conflict")).toBe(true);
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(1);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
        })).resolves.toEqual({
            pendingCount: 0,
            pendingBlockedCount: 0,
            pendingVersion: before.pendingVersion + 1,
        });
    });

    it("forbids view-only participants from mutating pending (but allows listing)", async () => {
        const owner = await createAccount("owner");
        const viewer = await createAccount("viewer");
        const session = await createSession(owner.id);

        await shareSession({
            sessionId: session.id,
            ownerId: owner.id,
            participantId: viewer.id,
            accessLevel: "view",
        });

        const localId = `a-${randomUUID()}`;
        const enqueueOwner = await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-a-1",
        });
        expect(enqueueOwner.ok).toBe(true);

        const list = await listPendingMessages({ actorUserId: viewer.id, sessionId: session.id, includeDiscarded: true });
        expect(list.ok).toBe(true);
        if (!list.ok) throw new Error("expected viewer listing");
        expect(list.pending.map(row => row.localId)).toEqual([localId]);
        const pendingBefore = await db.sessionPendingMessage.findMany({ where: { sessionId: session.id } });
        const stateBefore = await db.session.findUniqueOrThrow({ where: { id: session.id },
            select: { pendingCount: true, pendingVersion: true, pendingActivationRequestId: true } });

        const enqueueViewer = await enqueuePendingMessage({
            actorUserId: viewer.id,
            sessionId: session.id,
            localId: `v-${randomUUID()}`,
            ciphertext: "cipher-view",
        });
        // Capability-qualified absence and denial share the canonical Pending
        // privacy projection; a readable Session does not grant input mutation.
        expect(enqueueViewer).toEqual({ ok: false, error: "session-not-found" });

        const edit = await updatePendingMessage({
            actorUserId: viewer.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-a-2",
        });
        expect(edit).toEqual({ ok: false, error: "session-not-found" });

        const reorder = await reorderPendingMessages({ actorUserId: viewer.id, sessionId: session.id, orderedLocalIds: [localId] });
        expect(reorder).toEqual({ ok: false, error: "session-not-found" });

        const discard = await discardPendingMessage({ actorUserId: viewer.id, sessionId: session.id, localId, reason: "test" });
        expect(discard).toEqual({ ok: false, error: "session-not-found" });

        const restore = await restorePendingMessage({ actorUserId: viewer.id, sessionId: session.id, localId });
        expect(restore).toEqual({ ok: false, error: "session-not-found" });

        const del = await deletePendingMessage({ actorUserId: viewer.id, sessionId: session.id, localId });
        expect(del).toEqual({ ok: false, error: "session-not-found" });
        expect(await db.sessionPendingMessage.findMany({ where: { sessionId: session.id } })).toEqual(pendingBefore);
        expect(await db.session.findUniqueOrThrow({ where: { id: session.id },
            select: { pendingCount: true, pendingVersion: true, pendingActivationRequestId: true } })).toEqual(stateBefore);
    });

    it("treats deletePendingMessage as a no-op when the localId does not exist", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id, { id: true, pendingVersion: true, pendingCount: true });

        const localId = `missing-${randomUUID()}`;
        const res = await deletePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId });
        expect(res.ok).toBe(true);
        if (!res.ok) throw new Error("expected ok");
        expect(res.pendingVersion).toBe(session.pendingVersion);
        expect(res.pendingCount).toBe(session.pendingCount);
        expect(res.recipientCursors).toEqual([]);

        const after = await db.session.findUnique({
            where: { id: session.id },
            select: { pendingVersion: true, pendingCount: true },
        });
        expect(after?.pendingVersion).toBe(session.pendingVersion);
        expect(after?.pendingCount).toBe(session.pendingCount);
    });

    it("treats discardPendingMessage as a no-op when message is already discarded", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);

        const localId = `a-${randomUUID()}`;
        const enqueue = await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-a-1",
        });
        expect(enqueue.ok).toBe(true);
        if (!enqueue.ok) throw new Error("expected enqueue to succeed");

        const firstDiscard = await discardPendingMessage({ actorUserId: owner.id, sessionId: session.id, localId, reason: "test" });
        expect(firstDiscard.ok).toBe(true);
        if (!firstDiscard.ok) throw new Error("expected first discard to succeed");

        const beforeSecondDiscard = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingVersion: true, pendingCount: true },
        });

        const secondDiscard = await discardPendingMessage({ actorUserId: owner.id, sessionId: session.id, localId, reason: "test-2" });
        expect(secondDiscard.ok).toBe(true);
        if (!secondDiscard.ok) throw new Error("expected second discard to succeed");
        expect(secondDiscard.pendingVersion).toBe(beforeSecondDiscard.pendingVersion);
        expect(secondDiscard.pendingCount).toBe(beforeSecondDiscard.pendingCount);
        expect(secondDiscard.recipientCursors).toEqual([]);

        const afterSecondDiscard = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingVersion: true, pendingCount: true },
        });
        expect(afterSecondDiscard.pendingVersion).toBe(beforeSecondDiscard.pendingVersion);
        expect(afterSecondDiscard.pendingCount).toBe(beforeSecondDiscard.pendingCount);
    });

    it("admits exact target machine events through authenticated durable custody", async () => {
        const { machineUpdateHandler } = await import("@/app/api/socket/machineUpdateHandler");
        const protocol = await import("@happier-dev/protocol");
        const owner = await createAccount("target-machine-transport");
        const session = await createSession(owner.id);
        const publisher = await createCurrentPendingPublisher({ accountId: owner.id, sessionId: session.id });
        await db.machine.update({ where: { id: publisher.machineId }, data: {
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } }, operationProtocolCapabilitiesRevision: 1,
        } });
        const socket = createFakeSocket({ data: { clientType: "machine-scoped", machineId: publisher.machineId } });
        machineUpdateHandler(owner.id, socket as unknown as Parameters<typeof machineUpdateHandler>[1], {
            operationSocketBatchLimits: { ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 } },
        });
        let response: unknown;
        const request = { v: 2, sessionId: session.id, targetMachineId: publisher.machineId, recipient: { kind: "execution_run", runId: "run-a" }, localId: "target-machine", content: { t: "encrypted", c: "cipher-target" }, requestedAction: { v: 1, kind: "enqueue" } };
        await getSocketHandler(socket, protocol.SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2)({ ...request, recipient: { ...request.recipient, label: "untrusted" } }, (value: unknown) => { response = value; });
        expect(response).toMatchObject({ v: 2, result: { status: "rejected", code: "session_input_invalid" } });
        await getSocketHandler(socket, protocol.SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2)(request, (value: unknown) => { response = value; });
        expect(response).toMatchObject({ v: 2, result: { status: "accepted", localId: request.localId } });
        expect(await db.sessionPendingMessage.findUnique({ where: { sessionId_localId: { sessionId: session.id, localId: request.localId } } })).toMatchObject({ targetExecutionRunId: "run-a" });
        expect(await listPendingMessages({ actorUserId: owner.id, sessionId: session.id })).toMatchObject({ ok: true, pending: [] });
    });

    it("serves exact target HTTP custody and strict publisher socket claim without main fallback", async () => {
        const { createRouteTestBuilder } = await import("@/app/api/testkit/routeTestBuilder");
        const { sessionPendingRoutes } = await import("@/app/api/routes/session/pendingRoutes");
        const protocol = await import("@happier-dev/protocol");
        const owner = await createAccount("target-transport-owner");
        const collaborator = await createAccount("target-transport-collaborator");
        const session = await createSession(owner.id);
        await db.session.update({
            where: { id: session.id },
            data: { currentStorageState: "hosted" },
        });
        await shareSession({ sessionId: session.id, ownerId: owner.id, participantId: collaborator.id, accessLevel: "edit" });
        const publisher = await createCurrentPendingPublisher({ accountId: owner.id, sessionId: session.id });
        await db.machine.update({ where: { id: publisher.machineId }, data: {
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } }, operationProtocolCapabilitiesRevision: 1,
        } });
        const route = (method: "POST" | "GET" | "PATCH" | "DELETE", suffix = "") => createRouteTestBuilder({
            method, path: `/v2/sessions/:sessionId/execution-runs/:runId/pending${suffix}`,
            defaultRequest: { authAuthority: "present_user" },
            // The HTTP boundary fixture supplies Fastify registration and request/reply adapters.
            registerRoutes: (app) => sessionPendingRoutes(app as unknown as Parameters<typeof sessionPendingRoutes>[0]),
        });
        const params = { sessionId: session.id, runId: "run-a" };
        const body = { v: 1, localId: "target-http", targetMachineId: publisher.machineId, messageRole: "user", content: { t: "encrypted", c: "cipher-target-http" } };
        const invalid = await route("POST").invoke({ userId: collaborator.id, params, body: { ...body, requestEqualityEvidenceV1: { kind: "e2eeTag", tag: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } } });
        expect(invalid.reply.statusCode).toBe(400);
        expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id } })).toBe(0);
        expect((await route("POST").invoke({ userId: collaborator.id, params, body })).response).toMatchObject({ didWrite: true, pending: { recipient: { kind: "execution_run", runId: "run-a" }, authorAccountId: collaborator.id } });
        expect((await route("GET").invoke({ userId: collaborator.id, params })).response).toMatchObject({
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: 1,
            pending: [{ localId: "target-http", recipient: { kind: "execution_run", runId: "run-a" } }],
        });
        expect(await listPendingMessages({ actorUserId: owner.id, sessionId: session.id })).toMatchObject({ ok: true, pending: [] });
        expect((await route("PATCH", "/:localId").invoke({ userId: collaborator.id, params: { ...params, localId: body.localId }, body: { ciphertext: "edited-target-http", messageRole: "user" } })).response).toMatchObject({ ok: true, recipient: { kind: "execution_run", runId: "run-a" } });
        await route("DELETE", "/:localId").invoke({ userId: collaborator.id, params: { ...params, runId: "run-b", localId: body.localId } });
        expect(await db.sessionPendingMessage.findUniqueOrThrow({ where: { sessionId_localId: { sessionId: session.id, localId: body.localId } } })).toMatchObject({ targetExecutionRunId: "run-a", content: { t: "encrypted", c: "edited-target-http" } });

        const socket = createFakeSocket({
            data: { authAuthority: "present_user", clientType: "session-scoped", userId: owner.id },
        });
        const binding = { accountId: owner.id, machineId: publisher.machineId, sessionId: session.id };
        await publisher.presence.registerPublisher({ socket, binding, completeActivitySnapshot: { state: "active", activeCount: 1 } });
        sessionUpdateHandler(owner.id, socket as unknown as Parameters<typeof sessionUpdateHandler>[1], {
            connectionType: "session-scoped", socket, userId: owner.id, sessionId: session.id,
        } as unknown as Parameters<typeof sessionUpdateHandler>[2], { presence: publisher.presence, binding });
        const claim = { v: 2, sessionId: session.id, recipient: { kind: "execution_run", runId: "run-a" }, sidechainId: "sidechain-a", foregroundState: "ready", deliveryTiming: "after_runtime_idle" };
        let response: unknown;
        await getSocketHandler(socket, protocol.SESSION_PENDING_EXECUTION_RUN_MATERIALIZE_NEXT_EVENT_V2)({ ...claim, authorAccountId: owner.id }, (value: unknown) => { response = value; });
        expect(response).toMatchObject({ v: 2, ok: false, error: "invalid-params" });
        await getSocketHandler(socket, protocol.SESSION_PENDING_EXECUTION_RUN_MATERIALIZE_NEXT_EVENT_V2)(claim, (value: unknown) => { response = value; });
        expect(response).toMatchObject({ v: 2, ok: true, didMaterialize: true, recipient: claim.recipient, sidechainId: "sidechain-a", authorAccountId: collaborator.id, pendingCount: 1, message: { localId: "target-http" } });
        expect(protocol.SessionPendingExecutionRunMaterializeNextResponseV2Schema.safeParse(response).success).toBe(true);
        expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ pendingCount: 0 });
        await getSocketHandler(socket, protocol.SESSION_PENDING_EXECUTION_RUN_MATERIALIZE_NEXT_EVENT_V2)(claim, (value: unknown) => { response = value; });
        expect(response).toMatchObject({ ok: true, didMaterialize: true, message: { localId: "target-http" } });
        expect(await db.sessionMessage.count({ where: { sessionId: session.id } })).toBe(0);
        const { eventRouter } = await import("@/app/events/eventRouter");
        const subscriberSocket = createFakeSocket({
            data: { authAuthority: "present_user", clientType: "user-scoped", userId: collaborator.id },
        });
        const subscriber = { connectionType: "user-scoped", socket: subscriberSocket, userId: collaborator.id } as unknown as Parameters<typeof eventRouter.addConnection>[1];
        eventRouter.addConnection(collaborator.id, subscriber);
        try {
            await getSocketHandler(socket, protocol.SESSION_PENDING_EXECUTION_RUN_ACCEPTED_EVENT_V2)({ v: 2, sessionId: session.id, localId: "target-http", recipient: claim.recipient, sidechainId: "sidechain-a" }, (value: unknown) => { response = value; });
            expect.soft(subscriberSocket.emit).toHaveBeenCalledWith("update", expect.objectContaining({ body: expect.objectContaining({ t: "new-message", message: expect.objectContaining({ sidechainId: "sidechain-a", localId: "target-http" }) }) }));
        } finally {
            eventRouter.removeConnection(collaborator.id, subscriber);
        }
        expect(response).toMatchObject({ v: 2, recipient: claim.recipient, sidechainId: "sidechain-a", result: { ok: true, didResolve: true } });
        expect(await db.sessionMessage.findUnique({ where: { sessionId_localId: { sessionId: session.id, localId: "target-http" } } })).toMatchObject({ sidechainId: "sidechain-a", authorAccountId: collaborator.id });
        await route("POST").invoke({ userId: collaborator.id, params, body: { ...body, localId: "target-unavailable" } });
        await getSocketHandler(socket, protocol.SESSION_PENDING_EXECUTION_RUN_BLOCK_EVENT_V2)({ v: 2, sessionId: session.id, recipient: claim.recipient, localId: "target-unavailable", reason: "session_input_target_unavailable" }, (value: unknown) => { response = value; });
        expect(response).toMatchObject({ v: 2, recipient: claim.recipient, localId: "target-unavailable", result: { ok: true, didUpdate: true, pendingCount: 1, pendingBlockedCount: 1 } });
        expect(await db.sessionPendingMessage.findUnique({ where: { sessionId_localId: { sessionId: session.id, localId: "target-unavailable" } } })).toMatchObject({ targetExecutionRunId: "run-a", deliveryState: "blocked", providerAction: null });
        expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ pendingCount: 0, pendingBlockedCount: 0 });
    });

    it("treats non-participants as session-not-found", async () => {
        const owner = await createAccount("owner");
        const stranger = await createAccount("stranger");
        const session = await createSession(owner.id);

        const list = await listPendingMessages({ actorUserId: stranger.id, sessionId: session.id, includeDiscarded: true });
        expect(list.ok).toBe(false);
        if (list.ok) throw new Error("expected session-not-found");
        expect(list.error).toBe("session-not-found");
    });

    it("preserves restricted-Team authentication continuation across Pending list, state, and enqueue", async () => {
        const owner = await createAccount("pending-auth-owner");
        const collaborator = await createAccount("pending-auth-collaborator");
        const team = await db.team.create({ data: { name: `Pending auth ${randomUUID()}` } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: collaborator.id, role: "member" } });
        const session = await createSession(owner.id);
        await db.team.update({
            where: { id: team.id },
            data: {
                authenticationPolicy: {
                    v: 1,
                    mode: "restricted",
                    accepted: [{ kind: "home_method", methodId: "key_challenge" }],
                },
            },
        });
        await db.sessionTeamGrant.create({
            data: {
                sessionId: session.id,
                teamId: team.id,
                accessLevel: "edit",
                canApprovePermissions: false,
                effectiveAt: new Date(),
            },
        });

        const previousKeyChallengeFeature = process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED;
        const requiredAuthentication = createPresentUserSessionAccessAuthentication({
            env: { HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1" },
            authenticationEvidence: [],
        });
        expect(await listPendingMessagesWithAuthentication({
            actorUserId: collaborator.id,
            sessionId: session.id,
            authentication: requiredAuthentication,
        })).toEqual({ ok: false, error: "session_access_authentication_required" });
        expect(await enqueuePendingMessageWithAction({
            actorUserId: collaborator.id,
            sessionId: session.id,
            localId: "pending-auth-required",
            ciphertext: "cipher",
            requestedAction: { v: 1, kind: "enqueue" },
            authentication: requiredAuthentication,
        })).toEqual({ ok: false, error: "session_access_authentication_required" });

        const unavailableAuthentication = createPresentUserSessionAccessAuthentication({
            env: { HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "0" },
            authenticationEvidence: [],
        });
        const state = await (await import("./pendingMessageService")).readSessionPendingState({
            actorUserId: collaborator.id,
            sessionId: session.id,
            authentication: unavailableAuthentication,
        });
        expect(state).toEqual({ ok: false, error: "session_access_authentication_unavailable" });
        expect(await db.sessionPendingMessage.count({ where: { sessionId: session.id } })).toBe(0);

        const { createRouteTestBuilder } = await import("@/app/api/testkit/routeTestBuilder");
        const route = (method: "GET" | "POST") => createRouteTestBuilder({
            method,
            path: "/v2/sessions/:sessionId/pending",
            defaultRequest: { authAuthority: "present_user" },
            registerRoutes: (app) => sessionPendingRoutes(app as unknown as Parameters<typeof sessionPendingRoutes>[0]),
        });
        const deleteRoute = createRouteTestBuilder({
            method: "DELETE",
            path: "/v2/sessions/:sessionId/pending/:localId",
            defaultRequest: { authAuthority: "present_user" },
            registerRoutes: (app) => sessionPendingRoutes(app as unknown as Parameters<typeof sessionPendingRoutes>[0]),
        });
        try {
            process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED = "1";
            const requiredList = await route("GET").invoke({ userId: collaborator.id, params: { sessionId: session.id } });
            expect(requiredList.reply.statusCode).toBe(403);
            expect(requiredList.response).toEqual({ error: "session_access_authentication_required" });
            const requiredEnqueue = await route("POST").invoke({
                userId: collaborator.id,
                params: { sessionId: session.id },
                body: { localId: "pending-auth-route", ciphertext: "cipher" },
            });
            expect(requiredEnqueue.reply.statusCode).toBe(403);
            expect(requiredEnqueue.response).toEqual({ error: "session_access_authentication_required" });
            const requiredDelete = await deleteRoute.invoke({
                userId: collaborator.id,
                params: { sessionId: session.id, localId: "missing-but-auth-gated" },
            });
            expect(requiredDelete.reply.statusCode).toBe(403);
            expect(requiredDelete.response).toEqual({ error: "session_access_authentication_required" });

            process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED = "0";
            const unavailableList = await route("GET").invoke({ userId: collaborator.id, params: { sessionId: session.id } });
            expect(unavailableList.reply.statusCode).toBe(503);
            expect(unavailableList.response).toEqual({ error: "session_access_authentication_unavailable" });
        } finally {
            if (previousKeyChallengeFeature === undefined) {
                delete process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED;
            } else {
                process.env.HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED = previousKeyChallengeFeature;
            }
        }
    });
});
