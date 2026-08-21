import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import {
    blockPendingDelivery,
    deletePendingMessage,
    discardPendingMessage,
    dismissPendingDelivery,
    enqueuePendingMessage as enqueuePendingMessageOwner,
    listPendingMessages,
    materializeNextPendingMessage as materializeNextPendingMessageOwner,
    materializeNextPendingMessageForCurrentPublisher,
    markPendingDeliveryHandled,
    reorderPendingMessages,
    resolveAcceptedPendingDelivery as resolveAcceptedPendingDeliveryOwner,
    sendPendingDeliveryAsNew,
    restorePendingMessage,
    updatePendingMessage,
    updatePendingRequestedAction,
} from "./pendingMessageService";
import type { PendingRequestedActionV1 } from "@happier-dev/protocol";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { reconcileSessionPendingQueueState } from "./reconcileSessionPendingQueueState";
import { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";

type EnqueuePendingTestParams = Parameters<typeof enqueuePendingMessageOwner>[0] extends infer T
    ? T extends unknown
        ? Omit<T, "requestedAction"> & { requestedAction?: PendingRequestedActionV1 }
        : never
    : never;
const enqueuePendingMessage = (params: EnqueuePendingTestParams) => enqueuePendingMessageOwner({
    ...params,
    requestedAction: params.requestedAction ?? { v: 1, kind: "enqueue" },
} as Parameters<typeof enqueuePendingMessageOwner>[0]);

describe("pendingMessageService (shared sessions)", () => {
    let harness: LightSqliteHarness;
    type CurrentPublisherMaterializeParams = Omit<
        Parameters<typeof materializeNextPendingMessageForCurrentPublisher>[0],
        "deliveryTiming" | "trustedPublisherFence"
    > & {
        deliveryTiming?: Parameters<typeof materializeNextPendingMessageForCurrentPublisher>[0]["deliveryTiming"];
    };
    type TrustedPublisherFence = Parameters<
        typeof materializeNextPendingMessageForCurrentPublisher
    >[0]["trustedPublisherFence"];
    type TestMaterializeParams =
        Omit<CurrentPublisherMaterializeParams, "foregroundState">
        & Partial<Pick<CurrentPublisherMaterializeParams, "foregroundState">>
        & {
            deliveryState?: "provider";
            trustedPublisherFence?: TrustedPublisherFence;
        };
    const currentMaterializationFenceBySession = new Map<string, Promise<TrustedPublisherFence>>();

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
        currentMaterializationFenceBySession.clear();
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
        providerAction?: "send";
    }) => {
        await db.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId: params.sessionId, localId: params.localId } },
            data: {
                deliveryState: "delivering",
                deliveryBlockedReason: null,
                ...(params.providerAction ? { providerAction: params.providerAction } : {}),
            },
        });
    };

    const createCommittedTranscriptMessage = async (params: {
        sessionId: string;
        localId: string;
        seq: number;
        messageRole: "user" | "agent" | null;
        ciphertext: string;
        deliveryResolution?: { v: 1; kind: "manual_handled" };
    }) => {
        await db.session.update({ where: { id: params.sessionId }, data: { seq: params.seq } });
        return db.sessionMessage.create({
            data: {
                sessionId: params.sessionId,
                seq: params.seq,
                localId: params.localId,
                messageRole: params.messageRole,
                content: { t: "encrypted", c: params.ciphertext },
                ...(params.deliveryResolution ? { deliveryResolution: params.deliveryResolution } : {}),
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
                encryptedDataKey: Buffer.from([0, ...new Array(80).fill(1)]),
            },
            select: { id: true },
        });
    };

    const createCurrentPendingEvidencePublisher = async (params: { accountId: string; sessionId: string }) => {
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId: params.accountId, metadata: "{}" } });
        await db.accessKey.create({
            data: { accountId: params.accountId, machineId, sessionId: params.sessionId, data: "encrypted" },
        });
        const presence = createSessionPublisherPresence();
        const socket = {};
        const binding = { accountId: params.accountId, machineId, sessionId: params.sessionId };
        const registered = await presence.registerPublisher({
            socket,
            binding,
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        if (registered.status !== "registered") throw new Error(`publisher registration failed: ${registered.status}`);
        currentMaterializationFenceBySession.set(
            `${params.accountId}:${params.sessionId}`,
            Promise.resolve({ ...binding, committedFence: registered.committedFence }),
        );
        return { machineId, presence, socket, binding, committedFence: registered.committedFence };
    };

    const materializeNextPendingMessage = async (
        params: TestMaterializeParams,
    ): Promise<Awaited<ReturnType<typeof materializeNextPendingMessageOwner>>> => {
        const { deliveryState, trustedPublisherFence, ...commonParams } = params;
        const key = `${params.actorUserId}:${params.sessionId}`;
        let fence = trustedPublisherFence;
        if (!fence) {
            let pendingFence = currentMaterializationFenceBySession.get(key);
            if (!pendingFence) {
                pendingFence = createCurrentPendingEvidencePublisher({
                    accountId: params.actorUserId,
                    sessionId: params.sessionId,
                }).then((publisher) => ({
                    ...publisher.binding,
                    committedFence: publisher.committedFence,
                }));
                currentMaterializationFenceBySession.set(key, pendingFence);
            }
            fence = await pendingFence;
        }
        return await materializeNextPendingMessageForCurrentPublisher({
            ...commonParams,
            deliveryTiming: commonParams.deliveryTiming ?? "after_foreground_ready",
            foregroundState: commonParams.foregroundState ?? "ready",
            trustedPublisherFence: fence,
        });
    };

    it("commits the exact inactive send-now activation into the existing account-change cursor", async () => {
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
            requestedAction: { v: 1, kind: "send_now" },
        })).resolves.toMatchObject({
            ok: true,
            didWrite: true,
            activationTarget: {
                accountId: owner.id,
                requestId: localId,
            },
        });

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
    });

    type ResolveAcceptedPendingDeliveryParams = Parameters<typeof resolveAcceptedPendingDeliveryOwner>[0];
    const resolveAcceptedPendingDelivery = async (
        params: Omit<ResolveAcceptedPendingDeliveryParams, "trustedPublisherFence"> & {
            trustedPublisherFence?: ResolveAcceptedPendingDeliveryParams["trustedPublisherFence"];
        },
    ) => {
        let trustedPublisherFence = params.trustedPublisherFence;
        if (!trustedPublisherFence) {
            const key = `${params.actorUserId}:${params.sessionId}`;
            let pendingFence = currentMaterializationFenceBySession.get(key);
            if (!pendingFence) {
                pendingFence = createCurrentPendingEvidencePublisher({
                    accountId: params.actorUserId,
                    sessionId: params.sessionId,
                }).then((publisher) => ({
                    ...publisher.binding,
                    committedFence: publisher.committedFence,
                }));
                currentMaterializationFenceBySession.set(key, pendingFence);
            }
            trustedPublisherFence = await pendingFence;
        }
        return await resolveAcceptedPendingDeliveryOwner({ ...params, trustedPublisherFence });
    };

    it("does not let unrelated Session writes create malformed-Activity release authority", async () => {
        const owner = await createAccount("malformed-episode-session-churn-owner");
        const session = await createSession(owner.id);
        const localId = `malformed-episode-session-churn-${randomUUID()}`;
        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-malformed-episode-session-churn",
        })).resolves.toMatchObject({ ok: true });
        await createCurrentPendingEvidencePublisher({ accountId: owner.id, sessionId: session.id });
        await db.session.update({
            where: { id: session.id },
            data: {
                runtimeActivityState: "malformed",
                runtimeActivityActiveCount: 0,
                runtimeActivityObservedAt: null,
                runtimeActivityRevision: 0n,
            },
        });

        await expect(materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryTiming: "after_runtime_idle",
        })).resolves.toMatchObject({
            ok: true,
            didMaterialize: false,
            deferredReason: "runtime_activity_unknown",
        });
        const beforeUnrelatedWrite = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { updatedAt: true },
        });
        await db.session.update({
            where: { id: session.id },
            data: {
                updatedAt: new Date(beforeUnrelatedWrite.updatedAt.getTime() + 1),
            },
        });

        const continuedDeferral = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryTiming: "after_runtime_idle",
        });
        expect(continuedDeferral).toMatchObject({
            ok: true,
            didMaterialize: false,
            deferredReason: "runtime_activity_unknown",
        });
        expect(continuedDeferral).not.toHaveProperty("retryAfterMs");
        const beforeSecondUnrelatedWrite = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { updatedAt: true },
        });
        await db.session.update({
            where: { id: session.id },
            data: {
                updatedAt: new Date(beforeSecondUnrelatedWrite.updatedAt.getTime() + 1),
            },
        });

        await expect(materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryTiming: "after_runtime_idle",
        })).resolves.toMatchObject({
            ok: true,
            didMaterialize: false,
            deferredReason: "runtime_activity_unknown",
        });
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(1);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
    });

    it("keeps canonical stored unknown Activity deferred after the retired deadline", async () => {
        const owner = await createAccount("valid-unknown-owner");
        const session = await createSession(owner.id);
        const localId = `valid-unknown-${randomUUID()}`;
        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-valid-unknown",
        })).resolves.toMatchObject({ ok: true });
        await db.session.update({
            where: { id: session.id },
            data: {
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityObservedAt: null,
                runtimeActivityRevision: 12n,
            },
        });
        const initialNowMs = Date.now();
        const nowSpy = vi.spyOn(Date, "now").mockReturnValue(initialNowMs);
        try {
            const result = await materializeNextPendingMessage({
                actorUserId: owner.id,
                sessionId: session.id,
                deliveryTiming: "after_runtime_idle",
            });
            expect(result).toMatchObject({
                ok: true,
                didMaterialize: false,
                deferredReason: "runtime_activity_unknown",
            });
            expect(result).not.toHaveProperty("retryAfterMs");

            nowSpy.mockReturnValue(initialNowMs + 31_000);
            await expect(materializeNextPendingMessage({
                actorUserId: owner.id,
                sessionId: session.id,
                deliveryTiming: "after_runtime_idle",
            })).resolves.toMatchObject({
                ok: true,
                didMaterialize: false,
                deferredReason: "runtime_activity_unknown",
            });
        } finally {
            nowSpy.mockRestore();
        }
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(1);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
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

        await expect(materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
        })).resolves.toMatchObject({ ok: true });
        await expect(db.sessionMessage.count({
            where: { sessionId: session.id, localId },
        })).resolves.toBe(0);
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

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-external-handoff",
            deliveryMode: "external_handoff",
        })).resolves.toMatchObject({
            ok: true,
            didWrite: false,
            pending: { deliveryStatus: { status: "external_handoff" } },
        });

        await expect(markPendingDeliveryHandled({ actorUserId: owner.id, sessionId: session.id, localId }))
            .resolves.toMatchObject({ ok: true, didResolve: true, pendingCount: 0 });
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(1);
    });

    it("blocks only the exact external handoff row when the provider is unavailable before acceptance", async () => {
        const owner = await createAccount("external-handoff-provider-unavailable-owner");
        const session = await createSession(owner.id);
        const blockedLocalId = `external-handoff-blocked-${randomUUID()}`;
        const retainedLocalId = `external-handoff-retained-${randomUUID()}`;

        for (const localId of [blockedLocalId, retainedLocalId]) {
            await expect(enqueuePendingMessage({
                actorUserId: owner.id,
                sessionId: session.id,
                localId,
                ciphertext: `cipher-${localId}`,
                deliveryMode: "external_handoff",
            })).resolves.toMatchObject({
                ok: true,
                pending: { localId, deliveryStatus: { status: "external_handoff" } },
            });
        }

        await expect(blockPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: blockedLocalId,
            reason: "provider_unavailable_before_acceptance",
        })).resolves.toMatchObject({
            ok: true,
            didUpdate: true,
            pendingCount: 2,
            pendingBlockedCount: 1,
        });
        await expect(db.sessionPendingMessage.findMany({
            where: { sessionId: session.id },
            orderBy: { localId: "asc" },
            select: { localId: true, deliveryState: true, deliveryBlockedReason: true },
        })).resolves.toEqual([
            {
                localId: blockedLocalId,
                deliveryState: "blocked",
                deliveryBlockedReason: "provider_unavailable_before_acceptance",
            },
            {
                localId: retainedLocalId,
                deliveryState: "external_handoff",
                deliveryBlockedReason: null,
            },
        ]);
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

        const enqueueConditionalContinuation = enqueuePendingMessage as unknown as (
            params: EnqueuePendingTestParams & Readonly<{
                admissionMode: "continuation_if_no_queued_user_input";
            }>,
        ) => ReturnType<typeof enqueuePendingMessage>;
        await expect(enqueueConditionalContinuation({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: continuationLocalId,
            ciphertext: "cipher-continuation",
            messageRole: "user",
            requestedAction: { v: 1, kind: "send_now" },
            admissionMode: "continuation_if_no_queued_user_input",
        })).resolves.toMatchObject({
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
        const enqueueConditionalContinuation = enqueuePendingMessage as unknown as (
            params: EnqueuePendingTestParams & Readonly<{
                admissionMode: "continuation_if_no_queued_user_input";
            }>,
        ) => ReturnType<typeof enqueuePendingMessage>;
        const continuation = {
            actorUserId: owner.id,
            sessionId: session.id,
            localId: continuationLocalId,
            ciphertext: "cipher-continuation",
            messageRole: "user" as const,
            requestedAction: { v: 1 as const, kind: "send_now" as const },
            admissionMode: "continuation_if_no_queued_user_input" as const,
        };

        await expect(enqueueConditionalContinuation(continuation)).resolves.toMatchObject({
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
        await expect(enqueueConditionalContinuation(continuation)).resolves.toMatchObject({
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

    it("does not let inert continuation-recovery metadata veto a fresh Pending row", async () => {
        const owner = await createAccount("inert-continuation-metadata-owner");
        const session = await createSession(owner.id);
        const localId = `connected-service-continuation:${randomUUID()}`;
        await db.session.update({
            where: { id: session.id },
            data: {
                metadata: JSON.stringify({
                    sessionContinuationRecoveryV1: {
                        v: 1,
                        attemptsById: {
                            legacy: {
                                v: 1,
                                attemptId: "legacy",
                                status: "awaiting_provider_activity",
                                failureAtMs: 1,
                                updatedAtMs: 1,
                                resumePromptMode: "standard",
                            },
                        },
                    },
                }),
            },
        });
        const enqueueConditionalContinuation = enqueuePendingMessage as unknown as (
            params: EnqueuePendingTestParams & Readonly<{
                admissionMode: "continuation_if_no_queued_user_input";
            }>,
        ) => ReturnType<typeof enqueuePendingMessage>;

        await expect(enqueueConditionalContinuation({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-continuation",
            messageRole: "user",
            requestedAction: { v: 1, kind: "send_now" },
            admissionMode: "continuation_if_no_queued_user_input",
        })).resolves.toMatchObject({
            ok: true,
            didWrite: true,
            pending: { localId, requestedAction: { v: 1, kind: "send_now" } },
        });
        await expect(materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
        })).resolves.toMatchObject({ ok: true, didMaterialize: true, message: { localId } });
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
        })).resolves.toEqual({ ok: false, error: "delivery-settlement-conflict" });

        await expect(db.sessionPendingMessage.findMany({
            where: { sessionId: session.id, status: "queued" },
            orderBy: [{ position: "asc" }, { localId: "asc" }],
            select: { localId: true, deliveryState: true },
        })).resolves.toEqual([
            { localId: reservedLocalId, deliveryState: "external_handoff" },
            { localId: queuedLocalId, deliveryState: null },
        ]);
    });

    it("rejects ordinary discard of an external-handoff reservation", async () => {
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
        })).resolves.toEqual({ ok: false, error: "delivery-settlement-conflict" });
        await expect(restorePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
        })).resolves.toEqual({ ok: false, error: "delivery-settlement-conflict" });
        await expect(deletePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
        })).resolves.toEqual({ ok: false, error: "delivery-settlement-conflict" });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true, discardedReason: true },
        })).resolves.toEqual({
            status: "queued",
            deliveryState: "external_handoff",
            discardedReason: null,
        });
    });

    it("treats a compatible terminal transcript localId as idempotent and rejects conflicting replay", async () => {
        const owner = await createAccount("terminal-enqueue-owner");
        const session = await createSession(owner.id);
        const localId = ` terminal-enqueue-${randomUUID()} `;
        const committed = await createCommittedTranscriptMessage({
            sessionId: session.id,
            localId,
            seq: 1,
            messageRole: "user",
            ciphertext: "cipher-terminal",
            deliveryResolution: { v: 1, kind: "manual_handled" },
        });

        const compatibleReplays = await Promise.all([
            enqueuePendingMessage({
                actorUserId: owner.id,
                sessionId: session.id,
                localId,
                ciphertext: "cipher-terminal",
                messageRole: "user",
            }),
            enqueuePendingMessage({
                actorUserId: owner.id,
                sessionId: session.id,
                localId,
                ciphertext: "cipher-terminal",
                messageRole: "user",
            }),
        ]);
        expect(compatibleReplays).toEqual([
            expect.objectContaining({
                ok: true,
                didWrite: false,
                terminal: true,
                message: expect.objectContaining({
                    id: committed.id,
                    seq: committed.seq,
                    localId,
                    deliveryResolution: { v: 1, kind: "manual_handled" },
                }),
            }),
            expect.objectContaining({
                ok: true,
                didWrite: false,
                terminal: true,
                message: expect.objectContaining({
                    id: committed.id,
                    seq: committed.seq,
                    localId,
                    deliveryResolution: { v: 1, kind: "manual_handled" },
                }),
            }),
        ]);
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
        })).resolves.toMatchObject({ ok: true, didMaterialize: false });

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-conflict",
            messageRole: "user",
        })).resolves.toEqual({ ok: false, error: "invalid-params" });
        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-terminal",
            messageRole: "agent",
        })).resolves.toEqual({ ok: false, error: "invalid-params" });
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
    });

    it("rejects whitespace-only Pending identity before persistence", async () => {
        const owner = await createAccount("blank-pending-id-owner");
        const session = await createSession(owner.id);

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: " \t\r\n ",
            ciphertext: "cipher-blank-id",
            requestedAction: { v: 1, kind: "enqueue" },
        })).resolves.toEqual({ ok: false, error: "invalid-params" });
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id } })).resolves.toBe(0);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id } })).resolves.toBe(0);
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

        const editedA = listQueued.pending.find((pending) => pending.localId === localIdA);
        expect(editedA?.content).toEqual({ t: "encrypted", c: "cipher-a-2" });
        await expect(db.sessionMessage.count({ where: { sessionId: session.id } })).resolves.toBe(0);
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
                status: "queued",
                position: 5,
                authorAccountId: owner.id,
                requestedAction: { v: 1, kind: "enqueue" },
            },
        });
        await db.sessionPendingMessage.create({
            data: {
                sessionId: session.id,
                localId: localIdB,
                content: { t: "encrypted", c: "cipher-seed-b" },
                status: "queued",
                position: 6,
                authorAccountId: owner.id,
                requestedAction: { v: 1, kind: "enqueue" },
            },
        });
        await db.session.update({
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
        if (!enqueue.ok || enqueue.terminal === true || enqueue.suppressed === true) {
            throw new Error("expected enqueue to create pending work");
        }
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

    it("does not advance ready projection when a queued ready event is only claimed for provider delivery", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional" });
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);

        await db.session.update({
            where: { id: session.id },
            data: { encryptionMode: "plain" },
        });

        const localId = `ready-${randomUUID()}`;
        const readyContent = {
            t: "plain",
            v: {
                role: "agent",
                content: {
                    type: "event",
                    id: "ready-event-1",
                    data: { type: "ready" },
                },
            },
        } satisfies PrismaJson.SessionPendingMessageContent;

        const enqueue = await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            content: readyContent,
            messageRole: "event",
        });
        expect(enqueue.ok).toBe(true);

        const materialize = await materializeNextPendingMessage({ actorUserId: owner.id, sessionId: session.id });
        expect(materialize.ok).toBe(true);
        if (!materialize.ok) throw new Error("unexpected materialize failure");
        expect(materialize).toMatchObject({
            didMaterialize: true,
            didWriteMessage: false,
            message: { localId, id: null, seq: null },
        });
        if (!materialize.didMaterialize) throw new Error("expected materialization");
        expect(materialize).not.toHaveProperty("readyProjection");

        const persistedSession = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                latestReadyEventSeq: true,
                latestReadyEventAt: true,
            },
        });

        expect(persistedSession).toEqual({
            latestReadyEventSeq: null,
            latestReadyEventAt: null,
        });
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { deliveryState: true, providerAction: true },
        })).resolves.toEqual({ deliveryState: "delivering", providerAction: "send" });
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

        const sessionState = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { lastActiveAt: true },
        });
        const materialize = await materializeNextPendingMessageOwner({
            actorUserId: collaborator.id,
            sessionId: session.id,
            trustedPublisherFence: {
                accountId: collaborator.id,
                machineId: "missing-machine",
                sessionId: session.id,
                committedFence: sessionState.lastActiveAt,
            },
        });
        expect(materialize.ok).toBe(false);
        if (materialize.ok) throw new Error("expected forbidden");
        expect(materialize.error).toBe("forbidden");
    });

    it("does not decrement pendingCount below 0 when session state is inconsistent", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id, { id: true, pendingVersion: true });

        const localId = `a-${randomUUID()}`;
        const enqueue = await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-a-1",
        });
        expect(enqueue.ok).toBe(true);

        // Simulate a race or data inconsistency where pendingCount is already 0.
        await db.session.update({ where: { id: session.id }, data: { pendingCount: 0 } });
        const before = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingVersion: true },
        });

        const materialize = await materializeNextPendingMessage({ actorUserId: owner.id, sessionId: session.id });
        expect(materialize.ok).toBe(true);
        if (!materialize.ok) throw new Error("unexpected materialize failure");
        expect(materialize.didMaterialize).toBe(true);

        const after = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingVersion: true },
        });
        expect(after.pendingCount).toBe(1);
        expect(after.pendingVersion).toBe(before.pendingVersion + 1);
    });

    it("lets the exact current publisher settle a claimed row without writing transcript before acceptance", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const publisher = await createCurrentPendingEvidencePublisher({ accountId: owner.id, sessionId: session.id });
        const trustedPublisherFence = { ...publisher.binding, committedFence: publisher.committedFence };
        const localId = `provider-delivery-${randomUUID()}`;

        const enqueue = await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery",
            messageRole: "user",
        });
        expect(enqueue.ok).toBe(true);

        const materializeParams = {
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider" as const,
        };
        const materialize = await materializeNextPendingMessage(materializeParams);
        expect(materialize.ok).toBe(true);
        if (!materialize.ok) throw new Error("unexpected materialize failure");
        expect(materialize).toMatchObject({
            didMaterialize: true,
            didWriteMessage: false,
            pendingCount: 1,
            deliveryState: {
                mode: "provider",
                unresolved: true,
            },
        });
        if (!materialize.didMaterialize) throw new Error("expected materialization");
        expect(materialize.message).toEqual(expect.objectContaining({
            id: null,
            seq: null,
            localId,
            messageRole: "user",
        }));

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
            trustedPublisherFence,
        });
        expect(accepted.ok).toBe(true);
        if (!accepted.ok || !accepted.didResolve || !accepted.message) throw new Error("expected accepted resolution");
        expect(accepted.message).toEqual(expect.objectContaining({ seq: 1, localId, messageRole: "user" }));
        expect(accepted.pendingCount).toBe(0);
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(1);
        await expect(materializeNextPendingMessage(materializeParams)).resolves.toMatchObject({
            ok: true,
            didMaterialize: false,
        });
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(1);
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
        });
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
        if (accepted.ok) throw new Error("expected accept conflict");
        expect(accepted.error).toBe("transcript-conflict");
        if (accepted.error !== "transcript-conflict") throw new Error("expected transcript conflict");
        expect(accepted.pendingStateChanged).toBe(true);
        expect(accepted.pendingCount).toBe(1);
        expect(accepted.pendingBlockedCount).toBe(1);
        expect(accepted.pendingVersion).toBeGreaterThan(0);
        expect(accepted.participantCursors).toEqual([
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

    it("leaves legacy materialization pending when it collides with divergent transcript content", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `legacy-materialize-conflict-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-legacy-pending-authoritative",
        })).resolves.toMatchObject({ ok: true });

        await db.session.update({ where: { id: session.id }, data: { seq: 1 } });
        await db.sessionMessage.create({
            data: {
                sessionId: session.id,
                seq: 1,
                localId,
                messageRole: "user",
                content: { t: "encrypted", c: "cipher-legacy-stale-transcript" },
            },
        });

        const materialized = await materializeNextPendingMessage({ actorUserId: owner.id, sessionId: session.id });
        expect(materialized.ok).toBe(false);
        if (materialized.ok) throw new Error("expected materialization conflict");
        expect(materialized.error).toBe("transcript-conflict");

        await expect(db.sessionMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { content: true, messageRole: true },
        })).resolves.toEqual({ content: { t: "encrypted", c: "cipher-legacy-stale-transcript" }, messageRole: "user" });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true, deliveryBlockedReason: true, content: true },
        })).resolves.toEqual({
            status: "queued",
            deliveryState: null,
            deliveryBlockedReason: null,
            content: { t: "encrypted", c: "cipher-legacy-pending-authoritative" },
        });
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
        });
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
        });
        expect(materialize.ok).toBe(true);
        if (!materialize.ok || !materialize.didMaterialize) throw new Error("expected provider delivery claim");
        expect(materialize.didWriteMessage).toBe(false);

        await expect(updatePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery-edited",
        })).resolves.toEqual({ ok: false, error: "delivery-settlement-conflict" });

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

    it("rejoins the unresolved provider claim without materializing a later row", async () => {
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

        const firstMaterialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(firstMaterialize.ok).toBe(true);
        if (!firstMaterialize.ok || !firstMaterialize.didMaterialize) throw new Error("expected first materialization");
        expect(firstMaterialize.message.localId).toBe(firstLocalId);

        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId: firstLocalId } },
            select: { deliveryState: true, deliveryBlockedReason: true },
        })).resolves.toEqual({ deliveryState: "delivering", deliveryBlockedReason: null });

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: secondLocalId,
            ciphertext: "cipher-provider-delivery-second",
        })).resolves.toMatchObject({ ok: true });
        const sessionBeforeRejoin = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingVersion: true },
        });

        const secondMaterialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(secondMaterialize.ok).toBe(true);
        if (!secondMaterialize.ok || !secondMaterialize.didMaterialize) {
            throw new Error("expected current-publisher claim rejoin");
        }
        expect(secondMaterialize.message.localId).toBe(firstLocalId);
        expect(secondMaterialize.pendingVersion).toBe(sessionBeforeRejoin.pendingVersion);
        expect(secondMaterialize.deliveryState).toEqual({ mode: "provider", unresolved: true });

        await expect(db.sessionPendingMessage.findMany({
            where: { sessionId: session.id, status: "queued" },
            orderBy: [{ position: "asc" }, { localId: "asc" }],
            select: { localId: true, deliveryState: true },
        })).resolves.toEqual([
            { localId: firstLocalId, deliveryState: "delivering" },
            { localId: secondLocalId, deliveryState: null },
        ]);
    });

    it("persists the canonical requested action and rejects same-localId content or action drift", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `requested-action-${randomUUID()}`;
        const requestedAction = { v: 1 as const, kind: "steer_now" as const };

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-requested-action",
            requestedAction,
        })).resolves.toMatchObject({
            ok: true,
            didWrite: true,
            pending: { localId, requestedAction },
        });
        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-requested-action",
            requestedAction,
        })).resolves.toMatchObject({ ok: true, didWrite: false });
        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-requested-action",
            requestedAction: { v: 1, kind: "send_now" },
        })).resolves.toEqual({ ok: false, error: "requested-action-conflict" });
        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "different-ciphertext",
            requestedAction,
        })).resolves.toEqual({ ok: false, error: "requested-action-conflict" });
    });

    it("self-heals a legacy null role while preserving action and role conflict identity", async () => {
        const owner = await createAccount("legacy-action-role-owner");
        const session = await createSession(owner.id);
        const localId = `legacy-action-role-${randomUUID()}`;

        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-legacy-action-role",
        });
        await db.$executeRaw`
            UPDATE "SessionPendingMessage"
            SET "messageRole" = NULL
            WHERE "sessionId" = ${session.id} AND "localId" = ${localId}
        `;
        const legacyRevision = await db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { updatedAt: true },
        });

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-legacy-action-role",
            messageRole: "user",
        })).resolves.toMatchObject({
            ok: true,
            didWrite: false,
            pending: { messageRole: "user", requestedAction: { v: 1, kind: "enqueue" } },
        });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { messageRole: true, requestedAction: true, updatedAt: true },
        })).resolves.toEqual({
            messageRole: "user",
            requestedAction: { v: 1, kind: "enqueue" },
            updatedAt: expect.any(Date),
        });
        const repairedRevision = await db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { updatedAt: true },
        });
        expect(repairedRevision.updatedAt.getTime()).toBeGreaterThan(legacyRevision.updatedAt.getTime());

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-legacy-action-role",
            messageRole: "user",
        })).resolves.toMatchObject({ ok: true, didWrite: false });
        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-legacy-action-role",
            messageRole: "agent",
        })).resolves.toEqual({ ok: false, error: "requested-action-conflict" });
    });

    it("does not mutate an ordinary queued row when an external-handoff retry conflicts", async () => {
        const owner = await createAccount("external-handoff-retry-conflict-owner");
        const session = await createSession(owner.id);
        const localId = `external-handoff-retry-conflict-${randomUUID()}`;
        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-external-handoff-retry-conflict",
        });

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-external-handoff-retry-conflict",
            messageRole: "user",
            deliveryMode: "external_handoff",
        })).resolves.toEqual({ ok: false, error: "invalid-params" });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { messageRole: true, requestedAction: true, deliveryState: true },
        })).resolves.toEqual({
            messageRole: null,
            requestedAction: { v: 1, kind: "enqueue" },
            deliveryState: null,
        });
    });

    it("does not self-heal legacy identity metadata through a discarded terminal disposition", async () => {
        const owner = await createAccount("discarded-legacy-retry-owner");
        const session = await createSession(owner.id);
        const localId = `discarded-legacy-retry-${randomUUID()}`;
        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-discarded-legacy-retry",
        });
        await discardPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            reason: "user_discarded",
        });
        await db.$executeRaw`
            UPDATE "SessionPendingMessage"
            SET "messageRole" = NULL
            WHERE "sessionId" = ${session.id} AND "localId" = ${localId}
        `;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-discarded-legacy-retry",
            messageRole: "user",
        })).resolves.toEqual({ ok: false, error: "requested-action-conflict" });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, messageRole: true, requestedAction: true, discardedReason: true },
        })).resolves.toEqual({
            status: "discarded",
            messageRole: null,
            requestedAction: { v: 1, kind: "enqueue" },
            discardedReason: "user_discarded",
        });
    });

    it("serializes concurrent legacy role recovery so compatible retries rejoin and conflicting roles fail closed", async () => {
        const owner = await createAccount("concurrent-legacy-role-owner");
        const session = await createSession(owner.id);
        const seedLegacyRow = async (localId: string, ciphertext: string) => {
            await enqueuePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId, ciphertext });
            await db.$executeRaw`
                UPDATE "SessionPendingMessage"
                SET "messageRole" = NULL
                WHERE "sessionId" = ${session.id} AND "localId" = ${localId}
            `;
        };

        const compatibleLocalId = `concurrent-compatible-role-${randomUUID()}`;
        await seedLegacyRow(compatibleLocalId, "cipher-concurrent-compatible-role");
        const compatible = await Promise.all([
            enqueuePendingMessage({
                actorUserId: owner.id,
                sessionId: session.id,
                localId: compatibleLocalId,
                ciphertext: "cipher-concurrent-compatible-role",
                messageRole: "user",
            }),
            enqueuePendingMessage({
                actorUserId: owner.id,
                sessionId: session.id,
                localId: compatibleLocalId,
                ciphertext: "cipher-concurrent-compatible-role",
                messageRole: "user",
            }),
        ]);
        expect(compatible).toEqual([
            expect.objectContaining({ ok: true, didWrite: false }),
            expect.objectContaining({ ok: true, didWrite: false }),
        ]);

        const conflictingLocalId = `concurrent-conflicting-role-${randomUUID()}`;
        await seedLegacyRow(conflictingLocalId, "cipher-concurrent-conflicting-role");
        const roles = ["user", "agent"] as const;
        const conflicting = await Promise.all(roles.map((messageRole) => enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: conflictingLocalId,
            ciphertext: "cipher-concurrent-conflicting-role",
            messageRole,
        })));
        const successfulIndexes = conflicting
            .map((result, index) => result.ok ? index : -1)
            .filter((index) => index >= 0);
        expect(successfulIndexes).toHaveLength(1);
        expect(conflicting.filter((result) => !result.ok)).toEqual([
            { ok: false, error: "requested-action-conflict" },
        ]);
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId: conflictingLocalId } },
            select: { messageRole: true, requestedAction: true },
        })).resolves.toEqual({
            messageRole: roles[successfulIndexes[0]!],
            requestedAction: { v: 1, kind: "enqueue" },
        });
    });

    it("retains a malformed persisted action as visible unsupported work without changing queue counts", async () => {
        const owner = await createAccount("malformed-requested-action-owner");
        const session = await createSession(owner.id);
        const localId = `malformed-requested-action-${randomUUID()}`;

        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-malformed-requested-action",
        });
        await db.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            data: { requestedAction: { v: 1, kind: "future_action" } },
        });

        const listed = await listPendingMessages({
            actorUserId: owner.id,
            sessionId: session.id,
        });
        expect(listed).toMatchObject({
            ok: true,
            pending: [{
                localId,
                requestedActionMalformed: true,
                deliveryStatus: { status: "blocked", reason: "unsupported_action" },
            }],
        });
        expect(listed.ok && listed.pending[0]).not.toHaveProperty("requestedAction");
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true },
        })).resolves.toEqual({ pendingCount: 1 });
    });

    it.each([
        ["send_now", "active_unsteerable", "interrupt_and_send"],
        ["steer_now", "active_steerable", "steer"],
        ["steer_if_active", "active_steerable", "steer"],
    ] as const)("claims the exact later %s row while leaving its ordinary FIFO neighbor queued", async (
        urgentKind,
        foregroundState,
        providerAction,
    ) => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const firstLocalId = `requested-action-first-${randomUUID()}`;
        const urgentLocalId = `requested-action-urgent-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: firstLocalId,
            ciphertext: "cipher-requested-action-first",
            requestedAction: { v: 1, kind: "enqueue" },
        })).resolves.toMatchObject({ ok: true });
        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: urgentLocalId,
            ciphertext: "cipher-requested-action-urgent",
            requestedAction: { v: 1, kind: urgentKind },
        })).resolves.toMatchObject({ ok: true });

        const result = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
            foregroundState,
        });
        expect(result).toMatchObject({
            ok: true,
            didMaterialize: true,
            message: {
                localId: urgentLocalId,
                requestedAction: { v: 1, kind: urgentKind },
                providerAction,
            },
        });
        await expect(db.sessionPendingMessage.findMany({
            where: { sessionId: session.id },
            orderBy: [{ position: "asc" }, { localId: "asc" }],
            select: { localId: true, deliveryState: true },
        })).resolves.toEqual([
            { localId: firstLocalId, deliveryState: null },
            { localId: urgentLocalId, deliveryState: "delivering" },
        ]);
    });

    it("claims a valid exact later action without executing a malformed predecessor", async () => {
        const owner = await createAccount("requested-action-malformed-predecessor-owner");
        const session = await createSession(owner.id);
        const malformedLocalId = `requested-action-malformed-predecessor-${randomUUID()}`;
        const urgentLocalId = `requested-action-valid-urgent-${randomUUID()}`;

        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: malformedLocalId,
            ciphertext: "cipher-requested-action-malformed-predecessor",
        });
        await db.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId: session.id, localId: malformedLocalId } },
            data: { requestedAction: { v: 1, kind: "future_action" } },
        });
        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: urgentLocalId,
            ciphertext: "cipher-requested-action-valid-urgent",
            requestedAction: { v: 1, kind: "send_now" },
        });

        await expect(materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
            foregroundState: "active_unsteerable",
        })).resolves.toMatchObject({
            ok: true,
            didMaterialize: true,
            message: {
                localId: urgentLocalId,
                providerAction: "interrupt_and_send",
            },
        });
        await expect(db.sessionPendingMessage.findMany({
            where: { sessionId: session.id },
            orderBy: [{ position: "asc" }, { localId: "asc" }],
            select: { localId: true, deliveryState: true },
        })).resolves.toEqual([
            { localId: malformedLocalId, deliveryState: null },
            { localId: urgentLocalId, deliveryState: "delivering" },
        ]);
    });

    it("does not let a malformed later action preempt a valid FIFO predecessor", async () => {
        const owner = await createAccount("requested-action-later-malformed-owner");
        const session = await createSession(owner.id);
        const firstLocalId = `requested-action-valid-head-${randomUUID()}`;
        const laterLocalId = `requested-action-malformed-later-${randomUUID()}`;

        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: firstLocalId,
            ciphertext: "cipher-requested-action-valid-head",
        });
        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: laterLocalId,
            ciphertext: "cipher-requested-action-malformed-later",
        });
        await db.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId: session.id, localId: laterLocalId } },
            data: { requestedAction: { v: 1, kind: "future_action" } },
        });

        await expect(materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
            foregroundState: "ready",
        })).resolves.toMatchObject({
            ok: true,
            didMaterialize: true,
            message: { localId: firstLocalId, requestedAction: { v: 1, kind: "enqueue" } },
        });
    });

    it("freezes steer_if_active into one claim-time provider action", async () => {
        const owner = await createAccount("requested-action-provider-operation-owner");
        const activeSession = await createSession(owner.id);
        const readySession = await createSession(owner.id);

        for (const session of [activeSession, readySession]) {
            await enqueuePendingMessage({
                actorUserId: owner.id,
                sessionId: session.id,
                localId: `steer-if-active-${session.id}`,
                ciphertext: `cipher-steer-if-active-${session.id}`,
                requestedAction: { v: 1, kind: "steer_if_active" },
            });
        }

        await expect(materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: activeSession.id,
            deliveryState: "provider",
            foregroundState: "active_steerable",
        })).resolves.toMatchObject({
            ok: true,
            didMaterialize: true,
            message: {
                requestedAction: { v: 1, kind: "steer_if_active" },
                providerAction: "steer",
            },
        });
        await expect(materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: readySession.id,
            deliveryState: "provider",
            foregroundState: "ready",
        })).resolves.toMatchObject({
            ok: true,
            didMaterialize: true,
            message: {
                requestedAction: { v: 1, kind: "steer_if_active" },
                providerAction: "send",
            },
        });
    });

    it("updates only an unclaimed Pending row action and fences the action after provider claim", async () => {
        const owner = await createAccount("requested-action-update-owner");
        const session = await createSession(owner.id);
        const firstLocalId = `requested-action-update-first-${randomUUID()}`;
        const secondLocalId = `requested-action-update-second-${randomUUID()}`;

        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: firstLocalId,
            ciphertext: "cipher-requested-action-update-first",
        });
        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: secondLocalId,
            ciphertext: "cipher-requested-action-update-second",
        });

        await expect(updatePendingRequestedAction({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: secondLocalId,
            requestedAction: { v: 1, kind: "send_now" },
        })).resolves.toMatchObject({ ok: true, didUpdate: true });
        await expect(db.sessionPendingMessage.findMany({
            where: { sessionId: session.id },
            orderBy: [{ position: "asc" }, { localId: "asc" }],
            select: { localId: true, requestedAction: true },
        })).resolves.toEqual([
            { localId: firstLocalId, requestedAction: { v: 1, kind: "enqueue" } },
            { localId: secondLocalId, requestedAction: { v: 1, kind: "send_now" } },
        ]);

        await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        await expect(updatePendingRequestedAction({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: secondLocalId,
            requestedAction: { v: 1, kind: "steer_now" },
        })).resolves.toEqual({ ok: false, error: "action-conflict" });
    });

    it("allows only one stale writer to replace a pending action", async () => {
        const owner = await createAccount("requested-action-race-owner");
        const session = await createSession(owner.id);
        const localId = `requested-action-race-${randomUUID()}`;

        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-requested-action-race",
        });

        const results = await Promise.all([
            updatePendingRequestedAction({
                actorUserId: owner.id,
                sessionId: session.id,
                localId,
                requestedAction: { v: 1, kind: "send_now" },
            }),
            updatePendingRequestedAction({
                actorUserId: owner.id,
                sessionId: session.id,
                localId,
                requestedAction: { v: 1, kind: "steer_now" },
            }),
        ]);

        expect(results.filter((result) => result.ok && result.didUpdate)).toHaveLength(1);
        expect(results.filter((result) => !result.ok && result.error === "action-conflict")).toHaveLength(1);
        const stored = await db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { requestedAction: true },
        });
        expect(stored.requestedAction).toEqual(
            expect.objectContaining({ kind: expect.stringMatching(/^(send_now|steer_now)$/) }),
        );
    });

    it("serializes a different-action writer against provider claim custody", async () => {
        const owner = await createAccount("requested-action-claim-race-owner");
        const session = await createSession(owner.id);
        const localId = `requested-action-claim-race-${randomUUID()}`;

        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-requested-action-claim-race",
        });

        const [actionResult, claimResult] = await Promise.all([
            updatePendingRequestedAction({
                actorUserId: owner.id,
                sessionId: session.id,
                localId,
                requestedAction: { v: 1, kind: "send_now" },
            }),
            materializeNextPendingMessage({
                actorUserId: owner.id,
                sessionId: session.id,
                deliveryState: "provider",
                foregroundState: "ready",
            }),
        ]);

        expect(claimResult).toMatchObject({ ok: true, didMaterialize: true });
        if (!claimResult.ok || !claimResult.didMaterialize) throw new Error("expected one provider claim");
        if (actionResult.ok) {
            expect(actionResult.didUpdate).toBe(true);
            expect(claimResult.message.requestedAction).toEqual({ v: 1, kind: "send_now" });
        } else {
            expect(actionResult).toEqual({ ok: false, error: "action-conflict" });
            expect(claimResult.message.requestedAction).toEqual({ v: 1, kind: "enqueue" });
        }
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { deliveryState: true, requestedAction: true },
        })).resolves.toEqual({
            deliveryState: "delivering",
            requestedAction: claimResult.message.requestedAction,
        });
    });

    it("reopens proven pre-effect blocks while keeping provider-effect-possible rows fenced", async () => {
        const owner = await createAccount("requested-action-steering-unavailable-owner");
        const session = await createSession(owner.id);
        const releasableLocalId = `requested-action-releasable-${randomUUID()}`;
        const releasableConditionalLocalId = `requested-action-releasable-conditional-${randomUUID()}`;
        const otherBlockedLocalId = `requested-action-other-blocked-${randomUUID()}`;

        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: releasableConditionalLocalId,
            ciphertext: "cipher-requested-action-releasable-conditional",
            requestedAction: { v: 1, kind: "steer_if_active" },
        });
        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: releasableLocalId,
            ciphertext: "cipher-requested-action-releasable",
            requestedAction: { v: 1, kind: "steer_now" },
        });
        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: otherBlockedLocalId,
            ciphertext: "cipher-requested-action-other-blocked",
            requestedAction: { v: 1, kind: "send_now" },
        });
        await blockPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: releasableConditionalLocalId,
            reason: "steering_unavailable",
        });
        await blockPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: releasableLocalId,
            reason: "steering_unavailable",
        });
        await blockPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: otherBlockedLocalId,
            reason: "unknown",
        });

        await expect(updatePendingRequestedAction({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: releasableLocalId,
            requestedAction: { v: 1, kind: "send_now" },
        })).resolves.toMatchObject({
            ok: true,
            didUpdate: true,
            pendingBlockedCount: 2,
        });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId: releasableLocalId } },
            select: { requestedAction: true, deliveryState: true, deliveryBlockedReason: true },
        })).resolves.toEqual({
            requestedAction: { v: 1, kind: "send_now" },
            deliveryState: null,
            deliveryBlockedReason: null,
        });

        await expect(updatePendingRequestedAction({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: releasableConditionalLocalId,
            requestedAction: { v: 1, kind: "send_now" },
        })).resolves.toMatchObject({
            ok: true,
            didUpdate: true,
            pendingBlockedCount: 1,
        });

        await expect(updatePendingRequestedAction({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: otherBlockedLocalId,
            requestedAction: { v: 1, kind: "send_now" },
        })).resolves.toEqual({ ok: false, error: "action-conflict" });
    });

    it.each([
        "provider_rejected_before_acceptance",
        "provider_unavailable_before_acceptance",
    ] as const)("retries the same pending row after a reversible pre-acceptance block (%s)", async (blockedReason) => {
        const owner = await createAccount("requested-action-provider-rejected-owner");
        const session = await createSession(owner.id);
        const localId = `requested-action-provider-rejected-${randomUUID()}`;

        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-requested-action-provider-rejected",
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
        const owner = await createAccount("requested-action-orphaned-claim-owner");
        const session = await createSession(owner.id);
        const localId = `requested-action-orphaned-claim-${randomUUID()}`;

        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-requested-action-orphaned-claim",
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

    it("reopens a proven pre-effect runtime-disposed row for an explicit send_now retry", async () => {
        const owner = await createAccount("requested-action-runtime-disposed-owner");
        const session = await createSession(owner.id);
        const localId = `requested-action-runtime-disposed-${randomUUID()}`;

        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-requested-action-runtime-disposed",
            requestedAction: { v: 1, kind: "enqueue" },
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


    it("does not refresh an in-flight delivering row during queue reorder", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
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
        });
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

    it("settles a blocked predecessor through its exact accepted localId", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-blocked-accepted-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery-blocked-accepted",
        })).resolves.toMatchObject({ ok: true });

        const firstMaterialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(firstMaterialize.ok).toBe(true);
        if (!firstMaterialize.ok || !firstMaterialize.didMaterialize) throw new Error("expected provider claim");
        expect(firstMaterialize.didWriteMessage).toBe(false);

        await expect(blockPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            reason: "delivery_outcome_uncertain",
        })).resolves.toMatchObject({ ok: true, pendingBlockedCount: 1 });
        await createCommittedTranscriptMessage({
            sessionId: session.id,
            localId,
            seq: 2,
            messageRole: "user",
            ciphertext: "cipher-provider-delivery-blocked-accepted",
        });

        const accepted = await resolveAcceptedPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
        });
        expect(accepted.ok).toBe(true);
        if (!accepted.ok) throw new Error("expected exact accepted-localId recovery");
        expect(accepted.didResolve).toBe(true);
        expect(accepted.pendingCount).toBe(0);
        expect(accepted.pendingBlockedCount).toBe(0);

        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
    });


    it("does not recover a provider-delivery claim merely because time advances", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const publisher = await createCurrentPendingEvidencePublisher({ accountId: owner.id, sessionId: session.id });
        const trustedPublisherFence = { ...publisher.binding, committedFence: publisher.committedFence };
        const localId = `provider-delivery-live-fresh-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery-live-fresh",
        })).resolves.toMatchObject({ ok: true });

        const firstMaterialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
            trustedPublisherFence,
        });
        expect(firstMaterialize.ok).toBe(true);
        if (!firstMaterialize.ok || !firstMaterialize.didMaterialize) throw new Error("expected first materialization");
        expect(firstMaterialize.didWriteMessage).toBe(false);

        await db.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            data: { updatedAt: new Date(Date.now() - 10 * 60_000) },
        });

        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { deliveryState: true, deliveryBlockedReason: true },
        })).resolves.toEqual({ deliveryState: "delivering", deliveryBlockedReason: null });
    });


    it("marks a blocked provider delivery as handled by committing the pending row", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-handled-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery-handled",
        })).resolves.toMatchObject({ ok: true });

        const materialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(materialize.ok).toBe(true);
        if (!materialize.ok || !materialize.didMaterialize) throw new Error("expected materialization");
        expect(materialize.didWriteMessage).toBe(false);

        await expect(blockPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            reason: "ambiguous_terminal_delivery",
        })).resolves.toMatchObject({ ok: true, pendingCount: 1 });

        const handled = await markPendingDeliveryHandled({ actorUserId: owner.id, sessionId: session.id, localId });
        expect(handled.ok).toBe(true);
        if (!handled.ok || !handled.didResolve || !handled.message) throw new Error("expected handled resolution");
        expect(handled.pendingCount).toBe(0);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true },
        })).resolves.toEqual({ pendingCount: 0, pendingBlockedCount: 0 });

        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(1);
        expect(handled.message).toEqual(expect.objectContaining({ seq: 1, localId }));

        await expect(markPendingDeliveryHandled({ actorUserId: owner.id, sessionId: session.id, localId }))
            .resolves.toMatchObject({ ok: true, didResolve: false, pendingCount: 0 });
    });

    it("dismisses uncertain delivery into a non-restorable tombstone without a transcript row", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const publisher = await createCurrentPendingEvidencePublisher({ accountId: owner.id, sessionId: session.id });
        const localId = `provider-delivery-dismissed-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery-dismissed",
        })).resolves.toMatchObject({ ok: true });
        await expect(materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        })).resolves.toMatchObject({ ok: true, didMaterialize: true });
        await expect(blockPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            reason: "delivery_outcome_uncertain",
        })).resolves.toMatchObject({ ok: true });

        await expect(dismissPendingDelivery({ actorUserId: owner.id, sessionId: session.id, localId }))
            .resolves.toMatchObject({ ok: true, didDismiss: true, pendingCount: 0, pendingBlockedCount: 0 });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, discardedReason: true },
        })).resolves.toEqual({ status: "discarded", discardedReason: "dismissed_uncertain" });
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(restorePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId }))
            .resolves.toEqual({ ok: false, error: "delivery-settlement-conflict" });
        await expect(resolveAcceptedPendingDeliveryOwner({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            trustedPublisherFence: { ...publisher.binding, committedFence: publisher.committedFence },
        })).resolves.toMatchObject({ ok: true, didResolve: true, pendingCount: 0 });
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(1);
    });

    it("atomically tombstones uncertain delivery and creates one deterministic replacement", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const publisher = await createCurrentPendingEvidencePublisher({ accountId: owner.id, sessionId: session.id });
        const localId = `provider-delivery-resent-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery-resent",
            requestedAction: { v: 1, kind: "steer_now" },
        })).resolves.toMatchObject({ ok: true });
        await expect(materializeNextPendingMessage({ actorUserId: owner.id, sessionId: session.id, deliveryState: "provider" }))
            .resolves.toMatchObject({ ok: true, didMaterialize: true });
        await expect(blockPendingDelivery({ actorUserId: owner.id, sessionId: session.id, localId, reason: "delivery_outcome_uncertain" }))
            .resolves.toMatchObject({ ok: true });

        await expect(sendPendingDeliveryAsNew({ actorUserId: owner.id, sessionId: session.id, localId }))
            .resolves.toMatchObject({ ok: true, didWrite: true, pendingCount: 1, pendingBlockedCount: 0 });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, discardedReason: true },
        })).resolves.toEqual({ status: "discarded", discardedReason: "resent_as_new" });
        const replacement = await db.sessionPendingMessage.findFirstOrThrow({
            where: { sessionId: session.id, status: "queued" },
            select: { localId: true, status: true, deliveryState: true, content: true, requestedAction: true },
        });
        expect(replacement).toEqual({
            localId: expect.any(String),
            status: "queued",
            deliveryState: null,
            content: { t: "encrypted", c: "cipher-provider-delivery-resent" },
            requestedAction: { v: 1, kind: "enqueue" },
        });
        await expect(listPendingMessages({
            actorUserId: owner.id,
            sessionId: session.id,
            includeDiscarded: true,
        })).resolves.toMatchObject({
            ok: true,
            pending: [expect.objectContaining({ localId: replacement.localId, status: "queued" })],
        });
        await expect(sendPendingDeliveryAsNew({ actorUserId: owner.id, sessionId: session.id, localId }))
            .resolves.toMatchObject({ ok: true, didWrite: false, pendingCount: 1 });
        await db.sessionPendingMessage.update({
            where: { sessionId_localId: { sessionId: session.id, localId: replacement.localId } },
            data: { content: { t: "encrypted", c: "different-ciphertext" } },
        });
        await expect(sendPendingDeliveryAsNew({ actorUserId: owner.id, sessionId: session.id, localId }))
            .resolves.toEqual({ ok: false, error: "identity-conflict" });
        await expect(restorePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId }))
            .resolves.toEqual({ ok: false, error: "delivery-settlement-conflict" });

        await expect(resolveAcceptedPendingDeliveryOwner({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            trustedPublisherFence: { ...publisher.binding, committedFence: publisher.committedFence },
        })).resolves.toMatchObject({ ok: true, didResolve: true, pendingCount: 1, pendingBlockedCount: 0 });
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(1);
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId: replacement.localId } },
            select: { status: true, deliveryState: true, deliveryBlockedReason: true },
        })).resolves.toEqual({ status: "queued", deliveryState: null, deliveryBlockedReason: null });
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
    });

    it("atomically anchors the minimal manual resolution on the surviving transcript row", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-manual-lineage-${randomUUID()}`;
        const requestedAction = { v: 1 as const, kind: "steer_now" as const };

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery-manual-lineage",
            requestedAction,
        })).resolves.toMatchObject({ ok: true });

        const materialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            foregroundState: "active_steerable",
            deliveryState: "provider",
        });
        expect(materialize).toMatchObject({ ok: true, didMaterialize: true });

        await expect(markPendingDeliveryHandled({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
        })).resolves.toMatchObject({ ok: true, didResolve: true });

        await expect(db.sessionMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { deliveryResolution: true, rowRevision: true },
        })).resolves.toEqual({
            deliveryResolution: {
                v: 1,
                kind: "manual_handled",
            },
            rowRevision: 1n,
        });
        await expect(resolveAcceptedPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
        })).resolves.toMatchObject({
            ok: true,
            didResolve: false,
            message: {
                localId,
                deliveryResolution: { v: 1, kind: "manual_handled" },
            },
        });
    });

    it("marks an already-transcripted blocked provider delivery handled idempotently", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-handled-already-transcripted-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery-handled-already-transcripted",
        })).resolves.toMatchObject({ ok: true });

        const materialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(materialize.ok).toBe(true);
        if (!materialize.ok || !materialize.didMaterialize) throw new Error("expected provider claim");
        expect(materialize.didWriteMessage).toBe(false);

        await expect(blockPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            reason: "delivery_outcome_uncertain",
        })).resolves.toMatchObject({ ok: true, pendingBlockedCount: 1 });
        await createCommittedTranscriptMessage({
            sessionId: session.id,
            localId,
            seq: 3,
            messageRole: "user",
            ciphertext: "cipher-provider-delivery-handled-already-transcripted",
        });

        const handled = await markPendingDeliveryHandled({ actorUserId: owner.id, sessionId: session.id, localId });
        expect(handled.ok).toBe(true);
        if (!handled.ok) throw new Error("expected handled success");
        expect(handled.didResolve).toBe(true);
        expect(handled.didWrite).toBe(false);
        expect(handled.pendingCount).toBe(0);
        expect(handled.pendingBlockedCount).toBe(0);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(1);
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
    });

    it("marks a delivering provider delivery as handled by committing the pending row", async () => {
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
        });
        expect(materialize.ok).toBe(true);
        if (!materialize.ok || !materialize.didMaterialize) throw new Error("expected materialization");
        expect(materialize.didWriteMessage).toBe(false);

        const handled = await markPendingDeliveryHandled({ actorUserId: owner.id, sessionId: session.id, localId });
        expect(handled.ok).toBe(true);
        if (!handled.ok || !handled.message) throw new Error("expected handled resolution");
        expect(handled.didResolve).toBe(true);
        expect(handled.pendingCount).toBe(0);

        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true },
        })).resolves.toEqual({ pendingCount: 0, pendingBlockedCount: 0 });

        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(1);
        expect(handled.message).toEqual(expect.objectContaining({ seq: 1, localId }));
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
        await db.session.update({
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

    it("serializes exact acceptance against manual disposition to one terminal transcript row", async () => {
        const owner = await createAccount("provider-delivery-terminal-race");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-terminal-race-${randomUUID()}`;

        await enqueuePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId, ciphertext: "cipher" });
        await markPendingProviderDeliveryClaimed({ sessionId: session.id, localId });

        const [accepted, handled] = await Promise.all([
            resolveAcceptedPendingDelivery({
                actorUserId: owner.id,
                sessionId: session.id,
                localId,
            }),
            markPendingDeliveryHandled({
                actorUserId: owner.id,
                sessionId: session.id,
                localId,
            }),
        ]);

        expect(accepted.ok).toBe(true);
        expect(handled.ok).toBe(true);
        expect([
            accepted.ok && accepted.didResolve,
            handled.ok && handled.didResolve,
        ].filter(Boolean)).toHaveLength(1);
        await expect(db.sessionMessage.count({
            where: { sessionId: session.id, localId },
        })).resolves.toBe(1);
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
    });

    it("does not mark an unmaterialized queued row handled", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-unmaterialized-handled-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery-unmaterialized-handled",
        })).resolves.toMatchObject({ ok: true });

        const handled = await markPendingDeliveryHandled({ actorUserId: owner.id, sessionId: session.id, localId });
        expect(handled.ok).toBe(true);
        if (!handled.ok) throw new Error("expected handled no-op");
        expect(handled.didResolve).toBe(false);
        expect(handled.pendingCount).toBe(1);

        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId, status: "queued" } })).resolves.toBe(1);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
    });

    it("settles a materialized provider-delivery row by its exact accepted localId", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const firstLocalId = `provider-delivery-reconcile-first-${randomUUID()}`;
        const secondLocalId = `provider-delivery-reconcile-second-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: firstLocalId,
            ciphertext: "cipher-provider-delivery-reconcile-first",
        })).resolves.toMatchObject({ ok: true });
        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: secondLocalId,
            ciphertext: "cipher-provider-delivery-reconcile-second",
        })).resolves.toMatchObject({ ok: true });

        const firstMaterialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(firstMaterialize.ok).toBe(true);
        if (!firstMaterialize.ok || !firstMaterialize.didMaterialize) throw new Error("expected first materialization");
        expect(firstMaterialize.didWriteMessage).toBe(false);

        const secondMaterialize = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(secondMaterialize.ok).toBe(true);
        if (!secondMaterialize.ok || !secondMaterialize.didMaterialize) {
            throw new Error("expected current-publisher claim rejoin");
        }
        expect(secondMaterialize.message.localId).toBe(firstLocalId);
        expect(secondMaterialize.pendingVersion).toBe(firstMaterialize.pendingVersion);

        await createCommittedTranscriptMessage({
            sessionId: session.id,
            localId: firstLocalId,
            seq: 1,
            messageRole: "user",
            ciphertext: "cipher-provider-delivery-reconcile-first",
        });

        const accepted = await resolveAcceptedPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: firstLocalId,
        });
        expect(accepted.ok).toBe(true);
        if (!accepted.ok || !accepted.didResolve) throw new Error("expected accepted resolution");
        expect(accepted.message).toEqual(expect.objectContaining({ localId: firstLocalId, seq: 1 }));
        expect(accepted.pendingCount).toBe(1);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true },
        })).resolves.toEqual({ pendingCount: 1, pendingBlockedCount: 0 });

        const secondMaterializeAfterReconcile = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(secondMaterializeAfterReconcile.ok).toBe(true);
        if (!secondMaterializeAfterReconcile.ok || !secondMaterializeAfterReconcile.didMaterialize) {
            throw new Error("expected second materialization after resolving the queue head");
        }
        expect(secondMaterializeAfterReconcile.message.localId).toBe(secondLocalId);

        await expect(db.sessionPendingMessage.findMany({
            where: { sessionId: session.id },
            orderBy: [{ position: "asc" }, { localId: "asc" }],
            select: { localId: true, deliveryState: true },
        })).resolves.toEqual([
            { localId: secondLocalId, deliveryState: "delivering" },
        ]);
    });

    it("does not reconcile blocked claimed rows or later queued rows from transcript sequence alone", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const blockedLocalId = `provider-delivery-reconcile-blocked-${randomUUID()}`;
        const queuedLocalId = `provider-delivery-reconcile-queued-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: blockedLocalId,
            ciphertext: "cipher-provider-delivery-reconcile-blocked",
        })).resolves.toMatchObject({ ok: true });
        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: queuedLocalId,
            ciphertext: "cipher-provider-delivery-reconcile-queued",
        })).resolves.toMatchObject({ ok: true });

        const materialized = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(materialized.ok).toBe(true);
        if (!materialized.ok || !materialized.didMaterialize) throw new Error("expected provider claim");

        const blocked = await blockPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: blockedLocalId,
            reason: "terminal_composer_draft",
        });
        expect(blocked.ok).toBe(true);
        if (!blocked.ok) throw new Error("expected block to succeed");
        expect(blocked.pendingBlockedCount).toBe(1);

        await createCommittedTranscriptMessage({
            sessionId: session.id,
            localId: blockedLocalId,
            seq: 60,
            messageRole: "user",
            ciphertext: "cipher-provider-delivery-reconcile-blocked",
        });
        await createCommittedTranscriptMessage({
            sessionId: session.id,
            localId: queuedLocalId,
            seq: 61,
            messageRole: "user",
            ciphertext: "cipher-provider-delivery-reconcile-queued",
        });

        await expect(db.sessionPendingMessage.findMany({
            where: { sessionId: session.id },
            orderBy: [{ position: "asc" }, { localId: "asc" }],
            select: { localId: true, deliveryState: true, deliveryBlockedReason: true },
        })).resolves.toEqual([
            { localId: blockedLocalId, deliveryState: "blocked", deliveryBlockedReason: "terminal_composer_draft" },
            { localId: queuedLocalId, deliveryState: null, deliveryBlockedReason: null },
        ]);
    });

    it("resolves late exact provider acceptance from a blocked row", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-direct-blocked-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery-direct-blocked",
        })).resolves.toMatchObject({ ok: true });

        const materialized = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(materialized.ok).toBe(true);
        if (!materialized.ok || !materialized.didMaterialize) throw new Error("expected provider claim");

        const blocked = await blockPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            reason: "terminal_composer_draft",
        });
        expect(blocked.ok).toBe(true);
        if (!blocked.ok) throw new Error("expected block to succeed");

        await createCommittedTranscriptMessage({
            sessionId: session.id,
            localId,
            seq: 62,
            messageRole: "user",
            ciphertext: "cipher-provider-delivery-direct-blocked",
        });

        const accepted = await resolveAcceptedPendingDelivery({ actorUserId: owner.id, sessionId: session.id, localId });
        expect(accepted.ok).toBe(true);
        if (!accepted.ok) throw new Error("expected late exact acceptance");
        expect(accepted.didResolve).toBe(true);
        expect(accepted.pendingCount).toBe(0);
        expect(accepted.pendingBlockedCount).toBe(0);

        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
    });

    it("does not resolve accepted provider delivery from a queued row before it is claimed", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-prewrite-${randomUUID()}`;

        const enqueue = await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery-prewrite",
        });
        expect(enqueue.ok).toBe(true);

        const accepted = await resolveAcceptedPendingDelivery({ actorUserId: owner.id, sessionId: session.id, localId });
        expect(accepted.ok).toBe(true);
        if (!accepted.ok) throw new Error("expected accepted no-op");
        expect(accepted.didResolve).toBe(false);
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true, deliveryBlockedReason: true },
        })).resolves.toEqual({ status: "queued", deliveryState: null, deliveryBlockedReason: null });
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true },
        })).resolves.toEqual({ pendingCount: 1 });
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
        if (!materialize.ok || !materialize.didMaterialize) throw new Error("expected provider delivery claim");
        expect(materialize.didWriteMessage).toBe(false);

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

    it("preserves exact settlement response-loss idempotency while terminal lineage is disabled", async () => {
        const owner = await createAccount("provider-delivery-lineage-disabled");
        const session = await createSession(owner.id);
        const localId = `provider-delivery-lineage-disabled-${randomUUID()}`;
        const requestedAction = { v: 1 as const, kind: "send_now" as const };

        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-delivery-lineage-disabled",
            requestedAction,
        });
        await expect(materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            foregroundState: "active_unsteerable",
            deliveryState: "provider",
        })).resolves.toMatchObject({ ok: true, didMaterialize: true });
        await expect(resolveAcceptedPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
        })).resolves.toMatchObject({ ok: true, didResolve: true });

        await expect(resolveAcceptedPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
        })).resolves.toMatchObject({ ok: true, didResolve: false });
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
            deliveryState: "provider",
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

    it("blocks accepted ordinary enqueue settlement behind its earlier executable neighbor", async () => {
        const owner = await createAccount("provider-delivery-fifo-settlement");
        const session = await createSession(owner.id);
        const earlierLocalId = `provider-delivery-fifo-earlier-${randomUUID()}`;
        const selectedLocalId = `provider-delivery-fifo-selected-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: earlierLocalId,
            ciphertext: "cipher-provider-delivery-fifo-earlier",
        })).resolves.toMatchObject({ ok: true });
        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: selectedLocalId,
            ciphertext: "cipher-provider-delivery-fifo-selected",
        })).resolves.toMatchObject({ ok: true });
        await createCurrentPendingEvidencePublisher({
            accountId: owner.id,
            sessionId: session.id,
        });
        await markPendingProviderDeliveryClaimed({
            sessionId: session.id,
            localId: selectedLocalId,
            providerAction: "send",
        });

        await expect(resolveAcceptedPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: selectedLocalId,
        })).resolves.toEqual({ ok: false, error: "blocked-by-earlier-pending" });

        await expect(db.sessionPendingMessage.findMany({
            where: { sessionId: session.id },
            orderBy: { position: "asc" },
            select: { localId: true, status: true, deliveryState: true },
        })).resolves.toEqual([
            { localId: earlierLocalId, status: "queued", deliveryState: null },
            { localId: selectedLocalId, status: "queued", deliveryState: "delivering" },
        ]);
        await expect(db.sessionMessage.count({
            where: { sessionId: session.id, localId: { in: [earlierLocalId, selectedLocalId] } },
        })).resolves.toBe(0);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true },
        })).resolves.toEqual({ pendingCount: 2, pendingBlockedCount: 0 });
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

        await db.sessionMessage.create({
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
    });

    it("does not claim a later provider-delivery row while an earlier claim is unresolved", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const firstLocalId = `provider-delivery-order-first-${randomUUID()}`;
        const secondLocalId = `provider-delivery-order-second-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: firstLocalId,
            ciphertext: "cipher-provider-delivery-order-first",
        })).resolves.toMatchObject({ ok: true });
        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: secondLocalId,
            ciphertext: "cipher-provider-delivery-order-second",
        })).resolves.toMatchObject({ ok: true });

        const firstClaim = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(firstClaim.ok).toBe(true);
        if (!firstClaim.ok || !firstClaim.didMaterialize) throw new Error("expected first claim");
        expect(firstClaim.message.localId).toBe(firstLocalId);

        const secondClaim = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(secondClaim.ok).toBe(true);
        if (!secondClaim.ok || !secondClaim.didMaterialize) {
            throw new Error("expected current-publisher claim rejoin");
        }
        expect(secondClaim.message.localId).toBe(firstLocalId);
        expect(secondClaim.pendingVersion).toBe(firstClaim.pendingVersion);

        const secondAcceptedFirst = await resolveAcceptedPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: secondLocalId,
        });
        expect(secondAcceptedFirst.ok).toBe(true);
        if (!secondAcceptedFirst.ok) throw new Error("expected unclaimed acceptance no-op");
        expect(secondAcceptedFirst.didResolve).toBe(false);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId: secondLocalId } })).resolves.toBe(0);

        const firstAccepted = await resolveAcceptedPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: firstLocalId,
        });
        expect(firstAccepted.ok).toBe(true);
        if (!firstAccepted.ok || !firstAccepted.didResolve) throw new Error("expected first accept");

        const secondClaimAfterFirstAccepted = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryState: "provider",
        });
        expect(secondClaimAfterFirstAccepted.ok).toBe(true);
        if (!secondClaimAfterFirstAccepted.ok || !secondClaimAfterFirstAccepted.didMaterialize) {
            throw new Error("expected second claim after resolving the queue head");
        }
        expect(secondClaimAfterFirstAccepted.message.localId).toBe(secondLocalId);

        const secondAccepted = await resolveAcceptedPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: secondLocalId,
        });
        expect(secondAccepted.ok).toBe(true);
        if (!secondAccepted.ok || !secondAccepted.didResolve) throw new Error("expected second accept");

        await expect(db.sessionMessage.findMany({
            where: { sessionId: session.id },
            orderBy: { seq: "asc" },
            select: { localId: true },
        })).resolves.toEqual([
            { localId: firstLocalId },
            { localId: secondLocalId },
        ]);
    });

    it("rejoins the same heartbeat-advanced publisher's frozen claim before version, timing, foreground, or Activity evaluation", async () => {
        const owner = await createAccount("provider-rejoin");
        const session = await createSession(owner.id);
        const publisher = await createCurrentPendingEvidencePublisher({ accountId: owner.id, sessionId: session.id });
        const localId = `provider-rejoin-${randomUUID()}`;
        await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-rejoin",
            requestedAction: { v: 1, kind: "send_now" },
        });
        const trustedPublisherFence = { ...publisher.binding, committedFence: publisher.committedFence };

        const first = await materializeNextPendingMessageForCurrentPublisher({
            actorUserId: owner.id,
            sessionId: session.id,
            trustedPublisherFence,
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
        const touched = await publisher.presence.touchPublisher({ socket: publisher.socket });
        if (touched.status !== "touched") throw new Error("expected publisher heartbeat advance");
        const rejoinPublisherFence = { ...publisher.binding, committedFence: touched.committedFence };
        const frozenSessionUpdatedAt = new Date("2020-01-02T03:04:05.000Z");
        await db.session.update({
            where: { id: session.id },
            data: { updatedAt: frozenSessionUpdatedAt },
        });
        const sessionBeforeRejoin = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { updatedAt: true, pendingVersion: true, active: true, lastActiveAt: true },
        });

        const rejoined = await materializeNextPendingMessageForCurrentPublisher({
            actorUserId: owner.id,
            sessionId: session.id,
            trustedPublisherFence: rejoinPublisherFence,
            expectedPendingVersion: first.pendingVersion + 99,
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

    it("rejects provider delivery without a trusted current-publisher fence before mutating Queue state", async () => {
        const owner = await createAccount("provider-missing-fence");
        const session = await createSession(owner.id);
        await createCurrentPendingEvidencePublisher({ accountId: owner.id, sessionId: session.id });
        const localId = `provider-missing-fence-${randomUUID()}`;
        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-missing-fence",
        })).resolves.toMatchObject({ ok: true });

        const pendingBefore = await db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: {
                status: true,
                deliveryState: true,
                deliveryBlockedReason: true,
                providerAction: true,
                requestedAction: true,
                updatedAt: true,
            },
        });
        const sessionBefore = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
        });

        // @ts-expect-error Materialization is type-invalid without the trusted publisher fence; exercise the runtime boundary too.
        await expect(materializeNextPendingMessageOwner({
            actorUserId: owner.id,
            sessionId: session.id,
        })).resolves.toEqual({ ok: false, error: "forbidden" });

        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: {
                status: true,
                deliveryState: true,
                deliveryBlockedReason: true,
                providerAction: true,
                requestedAction: true,
                updatedAt: true,
            },
        })).resolves.toEqual(pendingBefore);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
        })).resolves.toEqual(sessionBefore);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
    });

    it("converts an actionless delivering row to uncertainty once instead of inferring a rejoin action", async () => {
        const owner = await createAccount("provider-actionless-rejoin");
        const session = await createSession(owner.id);
        const publisher = await createCurrentPendingEvidencePublisher({ accountId: owner.id, sessionId: session.id });
        const trustedPublisherFence = { ...publisher.binding, committedFence: publisher.committedFence };
        const localId = `provider-actionless-rejoin-${randomUUID()}`;
        await db.sessionPendingMessage.create({
            data: {
                sessionId: session.id,
                authorAccountId: owner.id,
                localId,
                content: { t: "encrypted", c: "cipher-actionless-rejoin" },
                requestedAction: { v: 1, kind: "enqueue" },
                providerAction: null,
                status: "queued",
                deliveryState: "delivering",
                position: 1,
            },
        });
        await db.session.update({
            where: { id: session.id },
            data: { pendingCount: 1 },
        });

        const first = await materializeNextPendingMessageForCurrentPublisher({
            actorUserId: owner.id,
            sessionId: session.id,
            trustedPublisherFence,
            expectedPendingVersion: 999,
            deliveryTiming: "after_runtime_idle",
            foregroundState: "ready",
        });
        expect(first).toMatchObject({
            ok: true,
            didMaterialize: false,
            pendingCount: 1,
            pendingBlockedCount: 1,
            pendingVersion: 1,
            deliveryState: { mode: "provider", unresolved: false },
        });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { deliveryState: true, deliveryBlockedReason: true, providerAction: true },
        })).resolves.toEqual({
            deliveryState: "blocked",
            deliveryBlockedReason: "delivery_outcome_uncertain",
            providerAction: null,
        });

        await expect(materializeNextPendingMessageForCurrentPublisher({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryTiming: "after_foreground_ready",
            foregroundState: "ready",
            trustedPublisherFence,
        })).resolves.toMatchObject({
            ok: true,
            didMaterialize: false,
            pendingCount: 1,
            pendingBlockedCount: 1,
            pendingVersion: 1,
        });
    });

    it("claims ordinary after-runtime-idle work from the exact current-publisher idle revision", async () => {
        const owner = await createAccount("provider-idle-current-revision");
        const session = await createSession(owner.id);
        const publisher = await createCurrentPendingEvidencePublisher({ accountId: owner.id, sessionId: session.id });
        const trustedPublisherFence = { ...publisher.binding, committedFence: publisher.committedFence };
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

        await expect(materializeNextPendingMessageForCurrentPublisher({
            actorUserId: owner.id,
            sessionId: session.id,
            trustedPublisherFence,
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
        const publisher = await createCurrentPendingEvidencePublisher({ accountId: owner.id, sessionId: session.id });
        const trustedPublisherFence = { ...publisher.binding, committedFence: publisher.committedFence };
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

        await expect(materializeNextPendingMessageForCurrentPublisher({
            actorUserId: owner.id,
            sessionId: session.id,
            trustedPublisherFence,
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
        const predecessor = await createCurrentPendingEvidencePublisher({ accountId: owner.id, sessionId: session.id });
        const successor = await createCurrentPendingEvidencePublisher({ accountId: owner.id, sessionId: session.id });
        const predecessorFence = { ...predecessor.binding, committedFence: predecessor.committedFence };
        const successorFence = { ...successor.binding, committedFence: successor.committedFence };
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
        await expect(materializeNextPendingMessageForCurrentPublisher({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryTiming: "after_foreground_ready",
            foregroundState: "ready",
            trustedPublisherFence: predecessorFence,
        })).resolves.toEqual({ ok: false, error: "forbidden" });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { deliveryState: true, providerAction: true, requestedAction: true, updatedAt: true },
        })).resolves.toEqual(beforeStaleClaim);
        await expect(db.session.findUniqueOrThrow({ where: { id: session.id }, select: { pendingVersion: true } }))
            .resolves.toEqual(versionBeforeStaleClaim);

        const claimed = await materializeNextPendingMessageForCurrentPublisher({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryTiming: "after_foreground_ready",
            foregroundState: "ready",
            trustedPublisherFence: successorFence,
        });
        expect(claimed).toMatchObject({ ok: true, didMaterialize: true, message: { localId } });
        const claimedRow = await db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { deliveryState: true, providerAction: true, requestedAction: true, updatedAt: true },
        });
        const claimedVersion = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingVersion: true },
        });
        await expect(materializeNextPendingMessageForCurrentPublisher({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryTiming: "after_foreground_ready",
            foregroundState: "ready",
            trustedPublisherFence: predecessorFence,
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
        const predecessor = await createCurrentPendingEvidencePublisher({ accountId: owner.id, sessionId: session.id });
        const predecessorFence = { ...predecessor.binding, committedFence: predecessor.committedFence };
        const localId = `provider-replaced-settlement-${randomUUID()}`;
        await enqueuePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId, ciphertext: "cipher-replaced-settlement" });

        await expect(materializeNextPendingMessageForCurrentPublisher({
            actorUserId: owner.id,
            sessionId: session.id,
            deliveryTiming: "after_foreground_ready",
            foregroundState: "ready",
            trustedPublisherFence: predecessorFence,
        })).resolves.toMatchObject({ ok: true, didMaterialize: true, message: { localId } });

        const beforeWrongMachine = await db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true, providerAction: true, requestedAction: true, updatedAt: true },
        });
        await expect(resolveAcceptedPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            trustedPublisherFence: { ...predecessorFence, machineId: `wrong-${randomUUID()}` },
        })).resolves.toEqual({ ok: false, error: "forbidden" });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true, providerAction: true, requestedAction: true, updatedAt: true },
        })).resolves.toEqual(beforeWrongMachine);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);

        await createCurrentPendingEvidencePublisher({ accountId: owner.id, sessionId: session.id });
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
            trustedPublisherFence: predecessorFence,
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

    it("returns one durable provider claim to concurrent materializers without committing transcript state", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const localId = `race-${randomUUID()}`;

        const enqueue = await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-race",
        });
        expect(enqueue.ok).toBe(true);

        const results = await Promise.all([
            materializeNextPendingMessage({ actorUserId: owner.id, sessionId: session.id }),
            materializeNextPendingMessage({ actorUserId: owner.id, sessionId: session.id }),
        ]);

        expect(results.every((result) => result.ok)).toBe(true);
        const materialized = results.filter((result) => result.ok && result.didMaterialize);
        expect(materialized.length).toBeGreaterThanOrEqual(1);
        for (const result of materialized) {
            expect(result).toMatchObject({
                didWriteMessage: false,
                pendingVersion: enqueue.ok ? enqueue.pendingVersion + 1 : expect.any(Number),
                message: {
                    id: null,
                    seq: null,
                    localId,
                    content: { t: "encrypted", c: "cipher-race" },
                },
            });
        }
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { deliveryState: true, providerAction: true },
        })).resolves.toEqual({ deliveryState: "delivering", providerAction: "send" });

        const after = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true },
        });
        expect(after.pendingCount).toBe(1);
    });

    it("keeps concurrent same-publisher materialization on one frozen provider-delivery claim", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const publisher = await createCurrentPendingEvidencePublisher({ accountId: owner.id, sessionId: session.id });
        const trustedPublisherFence = { ...publisher.binding, committedFence: publisher.committedFence };
        const localId = `provider-race-${randomUUID()}`;

        const enqueue = await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-provider-race",
        });
        expect(enqueue).toMatchObject({ ok: true });
        if (!enqueue.ok) throw new Error("expected enqueue success");

        const results = await Promise.all([
            materializeNextPendingMessage({ actorUserId: owner.id, sessionId: session.id, deliveryState: "provider", trustedPublisherFence }),
            materializeNextPendingMessage({ actorUserId: owner.id, sessionId: session.id, deliveryState: "provider", trustedPublisherFence }),
        ]);

        expect(results.every((result) => result.ok)).toBe(true);
        // A caller that enters after the first commit is intentionally indistinguishable from a
        // response-loss retry and rejoins the frozen claim. The durable invariant is one claim
        // transition; the exact socket/CLI owners serialize and suppress duplicate local handoff.
        const materialized = results.filter((result) => result.ok && result.didMaterialize);
        expect(materialized.length).toBeGreaterThanOrEqual(1);
        for (const result of materialized) {
            expect(result).toMatchObject({
                didWriteMessage: false,
                pendingVersion: enqueue.pendingVersion + 1,
                message: {
                    id: null,
                    seq: null,
                    localId,
                    content: { t: "encrypted", c: "cipher-provider-race" },
                    requestedAction: { v: 1, kind: "enqueue" },
                    providerAction: "send",
                },
            });
        }
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: {
                status: true,
                deliveryState: true,
                deliveryBlockedReason: true,
                requestedAction: true,
                providerAction: true,
            },
        })).resolves.toEqual({
            status: "queued",
            deliveryState: "delivering",
            deliveryBlockedReason: null,
            requestedAction: { v: 1, kind: "enqueue" },
            providerAction: "send",
        });
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
        })).resolves.toEqual({
            pendingCount: 1,
            pendingBlockedCount: 0,
            pendingVersion: enqueue.pendingVersion + 1,
        });
    });


    it("clamps pendingCount when discarding a queued message after the counter is already 0", async () => {
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

        await db.session.update({ where: { id: session.id }, data: { pendingCount: 0 } });
        const before = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingVersion: true },
        });
        expect(before.pendingCount).toBe(0);

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

    it("rejects ordinary discard of a delivering provider-owned pending row", async () => {
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
        });
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
        expect(discard).toEqual({ ok: false, error: "delivery-settlement-conflict" });

        await expect(db.sessionPendingMessage.findUnique({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { status: true, deliveryState: true, discardedReason: true },
        })).resolves.toEqual({
            status: "queued",
            deliveryState: "delivering",
            discardedReason: null,
        });
        await expect(db.sessionMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(0);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
        })).resolves.toEqual(beforeDiscard);
    });

    it("deletes queued, blocked, and discarded pending rows", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id);
        const queuedLocalId = `delete-queued-${randomUUID()}`;
        const blockedLocalId = `delete-blocked-${randomUUID()}`;
        const discardedLocalId = `delete-discarded-${randomUUID()}`;

        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: queuedLocalId,
            ciphertext: "cipher-delete-queued",
        })).resolves.toMatchObject({ ok: true });
        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: blockedLocalId,
            ciphertext: "cipher-delete-blocked",
        })).resolves.toMatchObject({ ok: true });
        await expect(enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: discardedLocalId,
            ciphertext: "cipher-delete-discarded",
        })).resolves.toMatchObject({ ok: true });

        const blocked = await blockPendingDelivery({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: blockedLocalId,
            reason: "terminal_composer_draft",
        });
        expect(blocked.ok).toBe(true);
        const discarded = await discardPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: discardedLocalId,
            reason: "runtime_switch",
        });
        expect(discarded.ok).toBe(true);

        const beforeDelete = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
        });

        await expect(deletePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId: queuedLocalId })).resolves.toMatchObject({
            ok: true,
            pendingCount: beforeDelete.pendingCount - 1,
            pendingBlockedCount: beforeDelete.pendingBlockedCount,
        });
        await expect(deletePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId: blockedLocalId })).resolves.toMatchObject({
            ok: true,
            pendingCount: beforeDelete.pendingCount - 2,
            pendingBlockedCount: beforeDelete.pendingBlockedCount - 1,
        });
        await expect(deletePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId: discardedLocalId })).resolves.toMatchObject({
            ok: true,
            pendingCount: beforeDelete.pendingCount - 2,
            pendingBlockedCount: beforeDelete.pendingBlockedCount - 1,
        });

        await expect(db.sessionPendingMessage.findMany({
            where: { sessionId: session.id, localId: { in: [queuedLocalId, blockedLocalId, discardedLocalId] } },
        })).resolves.toEqual([]);
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
        });
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
        })).resolves.toMatchObject({ ok: true, didMaterialize: true, didWriteMessage: false });

        const before = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingCount: true, pendingBlockedCount: true, pendingVersion: true },
        });
        const [deleted, accepted] = await Promise.all([
            deletePendingMessage({ actorUserId: owner.id, sessionId: session.id, localId }),
            resolveAcceptedPendingDelivery({ actorUserId: owner.id, sessionId: session.id, localId }),
        ]);

        expect(accepted).toMatchObject({ ok: true, pendingCount: 0, pendingBlockedCount: 0 });
        expect(
            deleted.ok === true || (deleted.ok === false && deleted.error === "delivery-settlement-conflict"),
        ).toBe(true);
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

        const enqueueViewer = await enqueuePendingMessage({
            actorUserId: viewer.id,
            sessionId: session.id,
            localId: `v-${randomUUID()}`,
            ciphertext: "cipher-view",
        });
        expect(enqueueViewer.ok).toBe(false);
        if (enqueueViewer.ok) throw new Error("expected forbidden");
        expect(enqueueViewer.error).toBe("forbidden");

        const edit = await updatePendingMessage({
            actorUserId: viewer.id,
            sessionId: session.id,
            localId,
            ciphertext: "cipher-a-2",
        });
        expect(edit.ok).toBe(false);
        if (edit.ok) throw new Error("expected forbidden");
        expect(edit.error).toBe("forbidden");

        const reorder = await reorderPendingMessages({ actorUserId: viewer.id, sessionId: session.id, orderedLocalIds: [localId] });
        expect(reorder.ok).toBe(false);
        if (reorder.ok) throw new Error("expected forbidden");
        expect(reorder.error).toBe("forbidden");

        const discard = await discardPendingMessage({ actorUserId: viewer.id, sessionId: session.id, localId, reason: "test" });
        expect(discard.ok).toBe(false);
        if (discard.ok) throw new Error("expected forbidden");
        expect(discard.error).toBe("forbidden");

        const block = await blockPendingDelivery({
            actorUserId: viewer.id,
            sessionId: session.id,
            localId,
            reason: "terminal_composer_draft",
        });
        expect(block.ok).toBe(false);
        if (block.ok) throw new Error("expected forbidden");
        expect(block.error).toBe("forbidden");

        const handled = await markPendingDeliveryHandled({ actorUserId: viewer.id, sessionId: session.id, localId });
        expect(handled.ok).toBe(false);
        if (handled.ok) throw new Error("expected forbidden");
        expect(handled.error).toBe("forbidden");

        const restore = await restorePendingMessage({ actorUserId: viewer.id, sessionId: session.id, localId });
        expect(restore.ok).toBe(false);
        if (restore.ok) throw new Error("expected forbidden");
        expect(restore.error).toBe("forbidden");

        const del = await deletePendingMessage({ actorUserId: viewer.id, sessionId: session.id, localId });
        expect(del.ok).toBe(false);
        if (del.ok) throw new Error("expected forbidden");
        expect(del.error).toBe("forbidden");
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
        expect(res.participantCursors).toEqual([]);

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
        expect(secondDiscard.participantCursors).toEqual([]);

        const afterSecondDiscard = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { pendingVersion: true, pendingCount: true },
        });
        expect(afterSecondDiscard.pendingVersion).toBe(beforeSecondDiscard.pendingVersion);
        expect(afterSecondDiscard.pendingCount).toBe(beforeSecondDiscard.pendingCount);
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

    it("returns authoritative pending state without mutation when expected pending version is stale", async () => {
        const owner = await createAccount("owner");
        const session = await createSession(owner.id, { id: true, pendingVersion: true });
        const localIdA = `fenced-a-${randomUUID()}`;
        const localIdB = `fenced-b-${randomUUID()}`;

        const enqueueA = await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: localIdA,
            ciphertext: "cipher-fenced-a",
        });
        expect(enqueueA.ok).toBe(true);
        const enqueueB = await enqueuePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId: localIdB,
            ciphertext: "cipher-fenced-b",
        });
        expect(enqueueB.ok).toBe(true);
        if (!enqueueA.ok || !enqueueB.ok) throw new Error("expected enqueue success");

        const stale = await materializeNextPendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            expectedPendingVersion: enqueueA.pendingVersion,
        });

        expect(stale).toEqual({
            ok: true,
            didMaterialize: false,
            pendingCount: 2,
            pendingBlockedCount: 0,
            pendingVersion: enqueueB.pendingVersion,
            deferredReason: "pending_version_mismatch",
            deliveryState: { mode: "provider", unresolved: false },
        });
        await expect(db.sessionMessage.count({ where: { sessionId: session.id } })).resolves.toBe(0);
        await expect(db.sessionPendingMessage.findMany({
            where: { sessionId: session.id },
            orderBy: [{ position: "asc" }, { createdAt: "asc" }, { localId: "asc" }],
            select: { localId: true },
        })).resolves.toEqual([{ localId: localIdA }, { localId: localIdB }]);
    });
});
