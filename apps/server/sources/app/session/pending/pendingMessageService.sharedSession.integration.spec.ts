import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { SessionMessageDeliveryResolutionV1 } from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import {
    blockPendingDelivery,
    deletePendingMessage,
    dismissPendingDelivery,
    discardPendingMessage,
    enqueuePendingMessage as enqueuePendingMessageWithAction,
    listPendingMessages,
    markPendingDeliveryHandled,
    materializeNextPendingMessage as materializeNextPendingMessageWithAuthority,
    reorderPendingMessages,
    resolveAcceptedPendingDelivery as resolveAcceptedPendingDeliveryWithAuthority,
    sendPendingDeliveryAsNew,
    restorePendingMessage,
    updatePendingMessage,
    updatePendingRequestedAction,
} from "./pendingMessageService";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createFakeSocket, getSocketHandler } from "@/app/api/testkit/socketHarness";
import { sessionUpdateHandler } from "@/app/api/socket/sessionUpdateHandler";
import { activityCache } from "@/app/presence/sessionCache";
import { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";

type EnqueuePendingMessageParams = Parameters<typeof enqueuePendingMessageWithAction>[0];
const enqueuePendingMessage = (
    params: Omit<EnqueuePendingMessageParams, "requestedAction"> & Partial<Pick<EnqueuePendingMessageParams, "requestedAction">>,
) => enqueuePendingMessageWithAction({
    ...params,
    requestedAction: params.requestedAction ?? { v: 1, kind: "enqueue" },
} as EnqueuePendingMessageParams);

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
                encryptedDataKey: Buffer.from([0, ...new Array(80).fill(1)]),
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

    it("does not reopen a runtime-disposed-before-delivery row through an action update", async () => {
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
        })).resolves.toEqual({ ok: false, error: "action-conflict" });
        await expect(db.sessionPendingMessage.findUniqueOrThrow({
            where: { sessionId_localId: { sessionId: session.id, localId } },
            select: { requestedAction: true, deliveryState: true, deliveryBlockedReason: true },
        })).resolves.toEqual({
            requestedAction: { v: 1, kind: "send_now" },
            deliveryState: "blocked",
            deliveryBlockedReason: "runtime_disposed_before_delivery",
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
        "does not release steering-unavailable from an inconsistent %s origin",
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
            })).resolves.toEqual({ ok: false, error: "action-conflict" });
            await expect(db.sessionPendingMessage.findUniqueOrThrow({
                where: { sessionId_localId: { sessionId: session.id, localId } },
                select: { requestedAction: true, deliveryState: true, deliveryBlockedReason: true },
            })).resolves.toEqual({
                requestedAction: { v: 1, kind: originKind },
                deliveryState: "blocked",
                deliveryBlockedReason: "steering_unavailable",
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
            .resolves.toMatchObject({ ok: true });
        await expect(db.sessionPendingMessage.count({ where: { sessionId: session.id, localId } })).resolves.toBe(1);
        await expect(updatePendingMessage({
            actorUserId: owner.id,
            sessionId: session.id,
            localId,
            ciphertext: "mutated-external-handoff",
        })).resolves.toEqual({ ok: false, error: "not-found" });
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
            params: EnqueuePendingMessageParams & Readonly<{
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

    it("claims an exact later steer-now row while leaving its ordinary FIFO neighbor queued", async () => {
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
            foregroundState: "active_steerable",
        });

        expect(materialize).toMatchObject({
            ok: true,
            didMaterialize: true,
            didWriteMessage: false,
            message: {
                localId: exactLocalId,
                requestedAction: { v: 1, kind: "steer_now" },
                providerAction: "steer",
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
});
