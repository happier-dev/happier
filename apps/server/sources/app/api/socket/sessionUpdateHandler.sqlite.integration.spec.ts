import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
    SESSION_AGENT_TRANSITION_DIVIDER_LOCAL_ID_PREFIX,
    SESSION_DISCUSSION_AGENT_POST_EVENT_V1,
    SESSION_DISCUSSION_REQUEST_MAX_UTF8_BYTES_V1,
} from "@happier-dev/protocol";

import { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import { resolvePresenceTimeoutConfig, runPresenceTimeoutTick } from "@/app/presence/timeout";
import { sessionUpdateHandler } from "@/app/api/socket/sessionUpdateHandler";
import {
    createAuthenticatedFakeSocket,
    createFakeSocket,
    getSocketHandler,
} from "@/app/api/testkit/socketHarness";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { applySessionTurnMutation } from "@/app/session/sessionWriteService";
import { deriveSessionSystemRecordAddressKeys } from "@/app/session/systemRecords/sessionSystemRecordAddressKeys";
import { encodeSessionSystemRecordRevision } from "@/app/session/systemRecords/sessionSystemRecordRevision";
import { createSessionDiscussion } from "@/app/session/discussions/mutations";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { setHomeSettings } from '@/app/home/settings/homeSettings';
import { logger } from '@/utils/logging/log';

const authentication = createPresentUserSessionAccessAuthentication();

describe("session update handler on SQLite", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-update-handler-",
            sqliteConnectionLimit: 1,
            initAuth: true,
            initEncrypt: false,
            initFiles: false,
        });
    }, 120_000);
    beforeEach(() => harness.resetEnv());
    afterAll(async () => await harness.close());

    it('reads saved live message diagnostics on the next socket event without reconnecting', async () => {
        const owner = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'plain', homeRole: 'owner' }, select: { id: true } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: `session-${randomUUID()}`, encryptionMode: 'plain', metadata: JSON.stringify({ t: 'plain', v: {} }) }, select: { id: true } });
        const socket = createAuthenticatedFakeSocket();
        sessionUpdateHandler(owner.id, socket as never, { connectionType: 'user-scoped', socket, userId: owner.id } as never);
        const diagnostic = vi.spyOn(logger, 'debug').mockImplementation(() => {});
        try {
            const saved = await setHomeSettings({ actorAccountId: owner.id, write: { expectedRevision: 0, values: { HAPPIER_SOCKET_MESSAGE_DIAGNOSTIC_LOGS: true } } });
            expect(saved.status).toBe('applied');
            await getSocketHandler(socket, 'message')({ sid: session.id, localId: randomUUID(), messageRole: 'user', message: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Hello' } } } });
            expect(diagnostic.mock.calls.some(([, message]) => typeof message === 'string' && message.startsWith('Received message from socket'))).toBe(true);
            diagnostic.mockClear();
            expect((await setHomeSettings({ actorAccountId: owner.id, write: { expectedRevision: 1, values: { HAPPIER_SOCKET_MESSAGE_DIAGNOSTIC_LOGS: false } } })).status).toBe('applied');
            await getSocketHandler(socket, 'message')({ sid: session.id, localId: randomUUID(), messageRole: 'user', message: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Again' } } } });
            expect(diagnostic.mock.calls.some(([, message]) => typeof message === 'string' && message.startsWith('Received message from socket'))).toBe(false);
        } finally {
            diagnostic.mockRestore();
            await db.homeSettings.deleteMany({});
        }
    });

    it("ACKs the canonical Runtime Activity publisher claim only after active reachability commits", async () => {
        const owner = await db.account.create({
            // A Session-owning Account is current: terminal turn settlement
            // takes the canonical Account transition fence.
            data: { publicKey: `pk-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({
            data: { id: machineId, accountId: owner.id, metadata: "{}" },
        });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `session-${randomUUID()}`,
                metadata: "{}",
                active: false,
                lastActiveAt: new Date("2026-07-22T07:00:00.000Z"),
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 0n,
            },
            select: { id: true },
        });
        await db.accessKey.create({
            data: {
                accountId: owner.id,
                machineId,
                sessionId: session.id,
                data: "encrypted",
            },
        });
        const socket = createAuthenticatedFakeSocket();
        sessionUpdateHandler(
            owner.id,
            socket as never,
            {
                connectionType: "session-scoped",
                socket,
                userId: owner.id,
                sessionId: session.id,
            } as never,
            {
                presence: createSessionPublisherPresence(),
                binding: {
                    accountId: owner.id,
                    machineId,
                    sessionId: session.id,
                },
            },
        );

        const acknowledgements: unknown[] = [];
        await getSocketHandler(socket, "session-runtime-activity-snapshot")({
            sessionId: session.id,
            mutationId: `runtime-activity-snapshot:${session.id}`,
            snapshot: { state: "unknown", activeCount: 0 },
        }, (value: unknown) => acknowledgements.push(value));

        expect(acknowledgements).toEqual([expect.objectContaining({
            status: "unchanged",
            sessionId: session.id,
            mutationId: `runtime-activity-snapshot:${session.id}`,
            projection: expect.objectContaining({
                state: "unknown",
                activeCount: 0,
            }),
        })]);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { active: true },
        })).resolves.toEqual({ active: true });
    });

    it("posts Agent Discussion provenance only through the exact current Session publisher", async () => {
        process.env.HAPPIER_FEATURE_SESSIONS__ENABLED = "1";
        process.env.HAPPIER_FEATURE_SESSIONS_CONVERSATIONS__ENABLED = "1";
        const owner = await db.account.create({
            data: { publicKey: `pk-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId: owner.id, metadata: "{}" } });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `session-${randomUUID()}`,
                encryptionMode: "plain",
                metadata: JSON.stringify({ t: "plain", v: {} }),
                active: false,
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 0n,
            },
            select: { id: true },
        });
        await db.accessKey.create({
            data: { accountId: owner.id, machineId, sessionId: session.id, data: "encrypted" },
        });
        const created = await createSessionDiscussion({
            authentication,
            actorAccountId: owner.id,
            sessionId: session.id,
            request: {
                creationLocalId: `discussion-${randomUUID()}`,
                titleContent: { t: "plain", v: { v: 1, title: "Runtime" } },
                firstMessage: {
                    localId: `message-${randomUUID()}`,
                    content: { t: "plain", v: { v: 1, parts: [{ t: "text", text: "Start" }] } },
                    mentionedAccountIds: [],
                },
            },
        });
        expect(created.ok).toBe(true);
        if (!created.ok) return;

        const presence = createSessionPublisherPresence();
        const socket = createFakeSocket({
            id: "discussion-current-publisher",
            data: { authAuthority: "account_automation" },
        });
        sessionUpdateHandler(
            owner.id,
            socket as never,
            { connectionType: "session-scoped", socket, userId: owner.id, sessionId: session.id } as never,
            { presence, binding: { accountId: owner.id, machineId, sessionId: session.id } },
        );

        const beforeClaim: unknown[] = [];
        await getSocketHandler(socket, SESSION_DISCUSSION_AGENT_POST_EVENT_V1)({
            v: 1,
            sessionId: session.id,
            discussionId: created.value.discussion.id,
            request: {
                localId: "agent-before-claim",
                content: { t: "plain", v: { v: 1, parts: [{ t: "text", text: "No" }] } },
                mentionedAccountIds: [],
            },
        }, (value: unknown) => beforeClaim.push(value));
        expect(beforeClaim).toEqual([{ ok: false, v: 1, error: "session_discussion_post_denied" }]);

        const overBudget: unknown[] = [];
        await getSocketHandler(socket, SESSION_DISCUSSION_AGENT_POST_EVENT_V1)({
            v: 1,
            sessionId: session.id,
            discussionId: created.value.discussion.id,
            request: {
                localId: "agent-over-budget",
                content: {
                    t: "plain",
                    v: {
                        v: 1,
                        parts: [{ t: "text", text: "x".repeat(SESSION_DISCUSSION_REQUEST_MAX_UTF8_BYTES_V1) }],
                    },
                },
                mentionedAccountIds: [],
            },
        }, (value: unknown) => overBudget.push(value));
        expect(overBudget).toEqual([{ ok: false, v: 1, error: "session_discussion_invalid_content" }]);
        expect(await db.sessionDiscussionMessage.count({ where: { localId: "agent-over-budget" } })).toBe(0);

        await getSocketHandler(socket, "session-runtime-activity-snapshot")({
            sessionId: session.id,
            mutationId: `runtime-activity-snapshot:${session.id}`,
            snapshot: { state: "idle", activeCount: 0 },
        }, () => {});

        const acknowledgements: unknown[] = [];
        await getSocketHandler(socket, SESSION_DISCUSSION_AGENT_POST_EVENT_V1)({
            v: 1,
            sessionId: session.id,
            discussionId: created.value.discussion.id,
            runId: "run-1",
            toolCallId: "tool-1",
            request: {
                localId: "agent-after-claim",
                content: { t: "plain", v: { v: 1, parts: [{ t: "text", text: "Done" }] } },
                mentionedAccountIds: [],
            },
        }, (value: unknown) => acknowledgements.push(value));

        expect(acknowledgements).toEqual([expect.objectContaining({
            ok: true,
            v: 1,
            value: expect.objectContaining({
                message: expect.objectContaining({
                    authorAccountId: owner.id,
                    producerV1: {
                        v: 1,
                        kind: "agent",
                        sessionId: session.id,
                        runId: "run-1",
                        toolCallId: "tool-1",
                    },
                }),
            }),
        })]);
    });

    it("advertises transcript observation support before the Antigravity publisher claim without admitting observations", async () => {
        const owner = await db.account.create({
            // A Session-owning Account is current: terminal turn settlement
            // takes the canonical Account transition fence.
            data: { publicKey: `pk-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({
            data: { id: machineId, accountId: owner.id, metadata: "{}" },
        });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `session-${randomUUID()}`,
                metadata: "{}",
                active: false,
                lastActiveAt: new Date("2026-07-22T07:00:00.000Z"),
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 0n,
            },
            select: { id: true },
        });
        await db.accessKey.create({
            data: {
                accountId: owner.id,
                machineId,
                sessionId: session.id,
                data: "encrypted",
            },
        });

        const presence = createSessionPublisherPresence();
        const socket = createAuthenticatedFakeSocket();
        sessionUpdateHandler(
            owner.id,
            socket as never,
            {
                connectionType: "session-scoped",
                socket,
                userId: owner.id,
                sessionId: session.id,
            } as never,
            {
                presence,
                binding: {
                    accountId: owner.id,
                    machineId,
                    sessionId: session.id,
                },
            },
        );

        const observation = {
            v: 1 as const,
            sessionId: session.id,
            localId: `antigravity-${randomUUID()}`,
            messageRole: "agent" as const,
            content: "antigravity-ciphertext",
            createdAt: Date.parse("2026-07-28T18:00:02.000Z"),
            updatedAt: Date.parse("2026-07-28T18:00:02.000Z"),
            provenance: {
                kind: "non_dependent" as const,
                source: "external" as const,
            },
        };

        const capabilityAcks: unknown[] = [];
        await getSocketHandler(socket, "transcript-observation-capability-v1")(
            { v: 1, sessionId: session.id },
            (value: unknown) => capabilityAcks.push(value),
        );
        await getSocketHandler(socket, "transcript-observation-capability-v1")(
            { v: 2, sessionId: session.id },
            (value: unknown) => capabilityAcks.push(value),
        );
        await getSocketHandler(socket, "transcript-observation-capability-v1")(
            { v: 2, sessionId: session.id, invented: true },
            (value: unknown) => capabilityAcks.push(value),
        );

        const preclaimObservationAcks: unknown[] = [];
        await getSocketHandler(socket, "transcript-observation-v1")(
            observation,
            (value: unknown) => preclaimObservationAcks.push(value),
        );
        const preclaimCount = await db.sessionMessage.count({
            where: { sessionId: session.id },
        });

        const claimAcks: unknown[] = [];
        await getSocketHandler(socket, "session-runtime-activity-snapshot")(
            {
                sessionId: session.id,
                mutationId: `runtime-activity-snapshot:${session.id}`,
                snapshot: { state: "idle", activeCount: 0 },
            },
            (value: unknown) => claimAcks.push(value),
        );

        const claimedObservationAcks: unknown[] = [];
        await getSocketHandler(socket, "transcript-observation-v1")(
            observation,
            (value: unknown) => claimedObservationAcks.push(value),
        );

        expect(capabilityAcks).toEqual([{
            ok: true,
            capability: "session-transcript-observation-v1",
        }, {
            ok: true,
            capability: "session-transcript-observation-v2",
        }, { ok: false, error: "invalid_session" }]);
        expect(preclaimObservationAcks).toEqual([{
            ok: false,
            error: "forbidden",
        }]);
        expect(preclaimCount).toBe(0);
        expect(claimAcks).toEqual([expect.objectContaining({
            status: "applied",
            sessionId: session.id,
        })]);
        expect(claimedObservationAcks).toEqual([expect.objectContaining({
            ok: true,
            status: "observed",
            localId: observation.localId,
            didWrite: true,
        })]);
        await expect(db.sessionMessage.findMany({
            where: { sessionId: session.id },
            select: {
                localId: true,
                messageRole: true,
                content: true,
                sourceCreatedAt: true,
                sourceUpdatedAt: true,
                transcriptObservationProvenance: true,
            },
        })).resolves.toEqual([{
            localId: observation.localId,
            messageRole: "agent",
            content: { t: "encrypted", c: "antigravity-ciphertext" },
            sourceCreatedAt: new Date(observation.createdAt),
            sourceUpdatedAt: new Date(observation.updatedAt),
            transcriptObservationProvenance: {
                kind: "non_dependent",
                source: "external",
            },
        }]);

        const surfaceRecord = await db.sessionSystemRecord.create({ data: {
            sessionId: session.id, accountId: owner.id, ownerKind: "host", pluginId: null,
            namespace: "surface", kind: "item.v1", localId: "visual", version: 1,
            content: { t: "encrypted", c: "item-ciphertext" },
            ...deriveSessionSystemRecordAddressKeys({ ownerKind: "host", pluginId: null,
                namespace: "surface", localId: "visual" }),
        } });
        const surfaceItemReference = { v: 1 as const, itemId: "visual",
            itemRevision: encodeSessionSystemRecordRevision(surfaceRecord),
            sourceAddress: { serverId: "home-1", sessionId: session.id } };
        const visualLocalId = `visual-${randomUUID()}`;
        const visualAcks: unknown[] = [];
        await getSocketHandler(socket, "transcript-observation-v1")(
            { ...observation, v: 2, localId: visualLocalId, surfaceItemReference },
            (value: unknown) => visualAcks.push(value),
        );
        expect(visualAcks).toEqual([expect.objectContaining({ ok: true, status: "observed", localId: visualLocalId })]);
        await expect(db.sessionMessage.findFirst({ where: { sessionId: session.id, localId: visualLocalId },
            select: { content: true, surfaceItemReference: true } })).resolves.toEqual({
            content: { t: "encrypted", c: "antigravity-ciphertext" }, surfaceItemReference,
        });
    });

    it("refuses a reserved Agent-transition divider localId from the current transcript-observation publisher", async () => {
        // Being the claimed publisher grants the right to mirror provider output, not the
        // right to mint the owner-only transition divider. The identical observation with an
        // ordinary localId is admitted below, so this proves the refusal is the reserved
        // namespace rather than any authorization state.
        const owner = await db.account.create({
            // A Session-owning Account is current: terminal turn settlement
            // takes the canonical Account transition fence.
            data: { publicKey: `pk-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({
            data: { id: machineId, accountId: owner.id, metadata: "{}" },
        });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `session-${randomUUID()}`,
                metadata: "{}",
                active: false,
                lastActiveAt: new Date("2026-07-22T07:00:00.000Z"),
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 0n,
            },
            select: { id: true },
        });
        await db.accessKey.create({
            data: {
                accountId: owner.id,
                machineId,
                sessionId: session.id,
                data: "encrypted",
            },
        });

        const presence = createSessionPublisherPresence();
        const socket = createAuthenticatedFakeSocket();
        sessionUpdateHandler(
            owner.id,
            socket as never,
            {
                connectionType: "session-scoped",
                socket,
                userId: owner.id,
                sessionId: session.id,
            } as never,
            { presence, binding: { accountId: owner.id, machineId, sessionId: session.id } },
        );

        await getSocketHandler(socket, "transcript-observation-capability-v1")(
            { v: 1, sessionId: session.id },
            () => {},
        );
        await getSocketHandler(socket, "session-runtime-activity-snapshot")(
            {
                sessionId: session.id,
                mutationId: `runtime-activity-snapshot:${session.id}`,
                snapshot: { state: "idle", activeCount: 0 },
            },
            () => {},
        );

        const baseObservation = {
            v: 1 as const,
            sessionId: session.id,
            messageRole: "agent" as const,
            content: "divider-ciphertext",
            createdAt: Date.parse("2026-07-28T18:00:02.000Z"),
            updatedAt: Date.parse("2026-07-28T18:00:02.000Z"),
            provenance: { kind: "non_dependent" as const, source: "external" as const },
        };

        const reservedAcks: unknown[] = [];
        await getSocketHandler(socket, "transcript-observation-v1")(
            {
                ...baseObservation,
                localId: `${SESSION_AGENT_TRANSITION_DIVIDER_LOCAL_ID_PREFIX}${randomUUID()}`,
            },
            (value: unknown) => reservedAcks.push(value),
        );

        expect(reservedAcks).toEqual([{ ok: false, error: "invalid_observation" }]);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id } })).resolves.toBe(0);

        const ordinaryLocalId = `ordinary-${randomUUID()}`;
        const ordinaryAcks: unknown[] = [];
        await getSocketHandler(socket, "transcript-observation-v1")(
            { ...baseObservation, localId: ordinaryLocalId },
            (value: unknown) => ordinaryAcks.push(value),
        );

        expect(ordinaryAcks).toEqual([expect.objectContaining({
            ok: true,
            localId: ordinaryLocalId,
            didWrite: true,
        })]);
    });

    it("rejects active metadata publication from a publisher superseded after its runtime effect", async () => {
        const owner = await db.account.create({
            // A Session-owning Account is current: terminal turn settlement
            // takes the canonical Account transition fence.
            data: { publicKey: `pk-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({
            data: { id: machineId, accountId: owner.id, metadata: "{}" },
        });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `session-${randomUUID()}`,
                metadata: "{}",
                active: false,
                lastActiveAt: new Date("2026-07-22T07:00:00.000Z"),
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 0n,
            },
            select: { id: true },
        });
        await db.accessKey.create({
            data: {
                accountId: owner.id,
                machineId,
                sessionId: session.id,
                data: "encrypted",
            },
        });

        let now = new Date("2026-07-22T07:00:01.000Z");
        const presence = createSessionPublisherPresence({ now: () => now });
        const bindPublisher = (socketId: string) => {
            const socket = createAuthenticatedFakeSocket({ id: socketId });
            sessionUpdateHandler(
                owner.id,
                socket as never,
                {
                    connectionType: "session-scoped",
                    socket,
                    userId: owner.id,
                    sessionId: session.id,
                } as never,
                {
                    presence,
                    binding: {
                        accountId: owner.id,
                        machineId,
                        sessionId: session.id,
                    },
                },
            );
            return socket;
        };
        const predecessor = bindPublisher("predecessor");
        const successor = bindPublisher("successor");

        const predecessorClaim: unknown[] = [];
        await getSocketHandler(predecessor, "session-runtime-activity-snapshot")({
            sessionId: session.id,
            mutationId: `runtime-activity-snapshot:${session.id}`,
            snapshot: { state: "idle", activeCount: 0 },
        }, (value: unknown) => predecessorClaim.push(value));
        expect(predecessorClaim).toEqual([expect.objectContaining({
            status: "applied",
        })]);

        now = new Date(now.getTime() + 1_000);
        const successorClaim: unknown[] = [];
        await getSocketHandler(successor, "session-runtime-activity-snapshot")({
            sessionId: session.id,
            mutationId: `runtime-activity-snapshot:${session.id}`,
            snapshot: { state: "idle", activeCount: 0 },
        }, (value: unknown) => successorClaim.push(value));
        expect(successorClaim).toEqual([expect.objectContaining({
            status: "unchanged",
        })]);

        const stalePublication: unknown[] = [];
        await getSocketHandler(predecessor, "update-metadata")({
            sid: session.id,
            expectedVersion: 0,
            metadata: JSON.stringify({
                sessionModelsV1: {
                    v: 1,
                    agentId: "opencode",
                    updatedAt: 1,
                    currentModelId: "next-model",
                    availableModels: [{ id: "next-model", name: "Next model" }],
                },
            }),
        }, (value: unknown) => stalePublication.push(value));

        expect(stalePublication).toEqual([{ result: "publisher-superseded" }]);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { metadata: true, metadataVersion: true },
        })).resolves.toEqual({
            metadata: "{}",
            metadataVersion: 0,
        });
    });

    it("closes the exact current publisher through the canonical runtime-activity close event", async () => {
        const owner = await db.account.create({
            // A Session-owning Account is current: terminal turn settlement
            // takes the canonical Account transition fence.
            data: { publicKey: `pk-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId: owner.id, metadata: "{}" } });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `session-${randomUUID()}`,
                metadata: "{}",
                active: false,
                lastActiveAt: new Date("2026-07-22T07:00:00.000Z"),
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 0n,
            },
            select: { id: true },
        });
        await db.accessKey.create({
            data: { accountId: owner.id, machineId, sessionId: session.id, data: "encrypted" },
        });
        const turnId = `turn-${randomUUID()}`;
        await expect(applySessionTurnMutation({
            actorUserId: owner.id,
            authentication,
            mutation: {
                v: 1,
                sessionId: session.id,
                mutationId: `begin-${randomUUID()}`,
                action: "begin",
                turnId,
                observedAt: Date.now() - 1_000,
            },
        })).resolves.toMatchObject({ ok: true, didApply: true });

        const socket = createAuthenticatedFakeSocket();
        sessionUpdateHandler(
            owner.id,
            socket as never,
            {
                connectionType: "session-scoped",
                socket,
                userId: owner.id,
                sessionId: session.id,
            } as never,
            {
                presence: createSessionPublisherPresence(),
                binding: { accountId: owner.id, machineId, sessionId: session.id },
            },
        );

        const snapshotAcknowledgements: unknown[] = [];
        await getSocketHandler(socket, "session-runtime-activity-snapshot")({
            sessionId: session.id,
            mutationId: "activity-1",
            snapshot: { state: "idle", activeCount: 0 },
        }, (value: unknown) => snapshotAcknowledgements.push(value));
        expect(snapshotAcknowledgements).toEqual([expect.objectContaining({
            status: "applied",
            sessionId: session.id,
            mutationId: "activity-1",
            projection: expect.objectContaining({ state: "idle", activeCount: 0 }),
        })]);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: { active: true },
        })).resolves.toEqual({ active: true });

        const acknowledgements: unknown[] = [];
        await getSocketHandler(socket, "session-runtime-activity-close")(
            { sessionId: session.id },
            (value: unknown) => acknowledgements.push(value),
        );

        expect(acknowledgements).toEqual([{ status: "closed", sessionId: session.id }]);
        await expect(db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                active: true,
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
                latestTurnId: true,
                latestTurnStatus: true,
                thinking: true,
            },
        })).resolves.toEqual({
            active: false,
            runtimeActivityState: "idle",
            runtimeActivityActiveCount: 0,
            latestTurnId: turnId,
            latestTurnStatus: "cancelled",
            thinking: false,
        });
        await expect(db.sessionTurn.findUniqueOrThrow({
            where: { sessionId_turnId: { sessionId: session.id, turnId } },
            select: { status: true },
        })).resolves.toEqual({ status: "cancelled" });
    });

    async function createReleasedAliveSession(
        now: () => number,
        presence = createSessionPublisherPresence({ now: () => new Date(now()) }),
    ) {
        const owner = await db.account.create({
            data: { publicKey: `pk-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId: owner.id, metadata: "{}" } });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `session-${randomUUID()}`,
                metadata: "{}",
                active: false,
                lastActiveAt: new Date("2026-07-22T07:00:00.000Z"),
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 0n,
            },
            select: { id: true },
        });
        await db.accessKey.create({
            data: { accountId: owner.id, machineId, sessionId: session.id, data: "encrypted" },
        });
        const socket = createAuthenticatedFakeSocket();
        const binding = { accountId: owner.id, machineId, sessionId: session.id };
        sessionUpdateHandler(
            owner.id,
            socket as never,
            { connectionType: "session-scoped", socket, userId: owner.id, sessionId: session.id } as never,
            {
                presence,
                binding,
            },
        );
        const alive = getSocketHandler(socket, "session-alive");
        // cli-v0.2.12 / cli-v0.2.12-preview.1 at a357c655: createSessionAlivePayload.
        const heartbeat = async (thinking = false) => await alive({
            sid: session.id, time: now(), thinking, mode: "remote",
        });
        return { sessionId: session.id, heartbeat, socket, presence, binding };
    }

    it.each([
        { sessionTimeoutMs: 35_000, thinkingUntilMs: 0, idleSpacingMs: 15_000 },
        { sessionTimeoutMs: 60_000, thinkingUntilMs: 0, idleSpacingMs: 15_000 },
        { sessionTimeoutMs: 20_000, thinkingUntilMs: 8_000, idleSpacingMs: 16_000 },
    ])("keeps released heartbeats reachable with a $sessionTimeoutMs ms presence expiry after thinking until $thinkingUntilMs ms", async ({ sessionTimeoutMs, thinkingUntilMs, idleSpacingMs }) => {
        process.env.HAPPIER_PRESENCE_SESSION_TIMEOUT_MS = String(sessionTimeoutMs);
        process.env.HAPPIER_PRESENCE_TIMEOUT_TICK_MS = "1000";
        const timeoutConfig = resolvePresenceTimeoutConfig();
        const startedAt = Date.parse("2026-07-22T08:00:00.000Z");
        let clockMs = startedAt;
        const { sessionId, heartbeat } = await createReleasedAliveSession(() => clockMs);
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const now = vi.spyOn(Date, "now").mockImplementation(() => clockMs);
        let lastHeartbeatAtMs = startedAt;
        try {
            await heartbeat(thinkingUntilMs > 0);
            for (let elapsedMs = timeoutConfig.tickMs; elapsedMs <= sessionTimeoutMs * 2; elapsedMs += timeoutConfig.tickMs) {
                clockMs = startedAt + elapsedMs;
                // Expiry runs first so a coincident heartbeat cannot conceal an already stale fence.
                await runPresenceTimeoutTick(timeoutConfig);
                await expect(db.session.findUniqueOrThrow({
                    where: { id: sessionId }, select: { active: true },
                })).resolves.toEqual({ active: true });
                await vi.advanceTimersByTimeAsync(timeoutConfig.tickMs);
                // The released 2s loop takes 16s to meet the 15s idle cadence after thinking.
                const heartbeatDue = elapsedMs <= thinkingUntilMs
                    ? elapsedMs % 2_000 === 0
                    : (elapsedMs - thinkingUntilMs) % idleSpacingMs === 0;
                if (heartbeatDue) {
                    lastHeartbeatAtMs = clockMs;
                    await heartbeat(elapsedMs < thinkingUntilMs);
                }
            }
            clockMs += sessionTimeoutMs / 2;
            await vi.advanceTimersByTimeAsync(sessionTimeoutMs / 2);
            await vi.waitFor(async () => {
                const persisted = await db.session.findUniqueOrThrow({
                    where: { id: sessionId }, select: { lastActiveAt: true },
                });
                expect(persisted.lastActiveAt.getTime()).toBe(lastHeartbeatAtMs);
            });
            clockMs = lastHeartbeatAtMs + sessionTimeoutMs - 1;
            await runPresenceTimeoutTick(timeoutConfig);
            await expect(db.session.findUniqueOrThrow({
                where: { id: sessionId }, select: { active: true },
            })).resolves.toEqual({ active: true });
            clockMs += 1;
            await runPresenceTimeoutTick(timeoutConfig);
            await expect(db.session.findUniqueOrThrow({
                where: { id: sessionId }, select: { active: true },
            })).resolves.toEqual({ active: false });
        } finally {
            now.mockRestore();
            vi.useRealTimers();
        }
    });

    it.each(["trailing", "session-runtime-activity-close", "session-end", "disconnect", "replacement"])(
        "settles the default released heartbeat window through %s without inventing liveness",
        async (transition) => {
            const startedAt = Date.parse("2026-07-22T08:00:00.000Z");
            let clockMs = startedAt;
            const { sessionId, heartbeat, socket, presence, binding } = await createReleasedAliveSession(() => clockMs);
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            const now = vi.spyOn(Date, "now").mockImplementation(() => clockMs);
            try {
                await heartbeat();
                clockMs += 59_999;
                await heartbeat();
                await expect(db.session.findUniqueOrThrow({
                    where: { id: sessionId }, select: { lastActiveAt: true },
                })).resolves.toEqual({ lastActiveAt: new Date(startedAt) });
                clockMs += 1;
                if (transition === "replacement") {
                    await presence.registerPublisher({ socket: {}, binding, completeActivitySnapshot: { state: "unknown", activeCount: 0 } });
                } else if (transition !== "trailing") {
                    await getSocketHandler(socket, transition)(transition === "session-runtime-activity-close"
                        ? { sessionId }
                        : { sid: sessionId, time: clockMs });
                    if (transition === "disconnect") await presence.forgetDisconnectedPublisher({ socket });
                    expect(vi.getTimerCount()).toBe(0);
                }
                await vi.advanceTimersByTimeAsync(60_000);
                await presence.runAsCurrentPublisher({ socket, operation: async () => null });
                await vi.waitFor(async () => {
                    const persisted = await db.session.findUniqueOrThrow({
                        where: { id: sessionId }, select: { active: true, lastActiveAt: true },
                    });
                    expect(persisted).toEqual({
                        active: transition === "trailing" || transition === "replacement" || transition === "disconnect",
                        lastActiveAt: new Date(startedAt + (transition === "trailing" ? 59_999 : transition === "replacement" ? 60_000 : 0)),
                    });
                });
                expect(vi.getTimerCount()).toBe(0);
                if (transition === "trailing") {
                    for (let elapsedMs = 75_000; elapsedMs <= 180_000; elapsedMs += 15_000) {
                        clockMs = startedAt + elapsedMs;
                        await vi.advanceTimersByTimeAsync(15_000);
                        await presence.runAsCurrentPublisher({ socket, operation: async () => null });
                        await vi.waitFor(async () => {
                            const persisted = await db.session.findUniqueOrThrow({
                                where: { id: sessionId }, select: { lastActiveAt: true },
                            });
                            const expectedObservationMs = elapsedMs < 120_000 ? 59_999 : Math.floor(elapsedMs / 60_000) * 60_000 - 15_000;
                            expect(persisted.lastActiveAt.getTime()).toBe(startedAt + expectedObservationMs);
                        });
                        await heartbeat();
                    }
                }
            } finally {
                await socket.handlers.get("disconnect")?.();
                now.mockRestore();
                vi.useRealTimers();
            }
        },
    );

    it.each([false, true])("retains in-flight released observations without reviving a replacement (replacement: %s)", async (replacePublisher) => {
        const startedAt = Date.parse("2026-07-22T08:00:00.000Z");
        let clockMs = startedAt;
        const { sessionId, heartbeat, socket, presence, binding } = await createReleasedAliveSession(() => clockMs);
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const now = vi.spyOn(Date, "now").mockImplementation(() => clockMs);
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        let entered!: () => void;
        const started = new Promise<void>((resolve) => { entered = resolve; });
        try {
            await heartbeat();
            const holder = presence.runAsCurrentPublisher({ socket, operation: async () => {
                entered();
                await held;
            } });
            await started;
            clockMs = startedAt + 60_000;
            const inFlight = heartbeat();
            for (const offset of [1_000, 2_000]) {
                clockMs = startedAt + 60_000 + offset;
                await heartbeat();
            }
            clockMs = startedAt + 63_000;
            if (replacePublisher) {
                await presence.registerPublisher({ socket: {}, binding, completeActivitySnapshot: { state: "unknown", activeCount: 0 } });
            }
            release();
            await Promise.all([holder, inFlight]);
            clockMs = startedAt + 123_000;
            await vi.advanceTimersByTimeAsync(60_000);
            await presence.runAsCurrentPublisher({ socket, operation: async () => null });
            await vi.waitFor(async () => {
                const persisted = await db.session.findUniqueOrThrow({
                    where: { id: sessionId }, select: { active: true, lastActiveAt: true },
                });
                expect(persisted).toEqual({ active: true, lastActiveAt: new Date(startedAt + (replacePublisher ? 63_000 : 62_000)) });
            });
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            release();
            now.mockRestore();
            vi.useRealTimers();
        }
    });

    it("does not register a disconnected socket after an accepted released heartbeat backlog", async () => {
        let clockMs = Date.parse("2026-07-22T08:00:00.000Z");
        const presence = createSessionPublisherPresence({ now: () => new Date(clockMs) });
        const blocker = await createReleasedAliveSession(() => clockMs, presence);
        const target = await createReleasedAliveSession(() => clockMs, presence);
        const now = vi.spyOn(Date, "now").mockImplementation(() => clockMs);
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        let entered!: () => void;
        const started = new Promise<void>((resolve) => { entered = resolve; });
        try {
            await blocker.heartbeat();
            const holder = presence.runAsCurrentPublisher({ socket: blocker.socket, operation: async () => {
                entered();
                await held;
            } });
            await started;
            clockMs += 60_000;
            const blockerAlive = blocker.heartbeat();
            await Promise.resolve();
            const targetAlive = target.heartbeat();
            await target.socket.handlers.get("disconnect")?.();
            await presence.forgetDisconnectedPublisher({ socket: target.socket });
            release();
            await Promise.all([holder, blockerAlive, targetAlive]);
            await expect(db.session.findUniqueOrThrow({
                where: { id: target.sessionId }, select: { active: true },
            })).resolves.toEqual({ active: false });
        } finally {
            release();
            now.mockRestore();
        }
    });

    it.each([
        { sessionTimeoutMs: 600_000, retryCeilingMs: 60_000 },
        { sessionTimeoutMs: 35_000, retryCeilingMs: 17_500 },
    ])("bounds released alive retry backoff to $retryCeilingMs ms for a $sessionTimeoutMs ms presence expiry", async ({ sessionTimeoutMs, retryCeilingMs }) => {
        process.env.HAPPIER_PRESENCE_SESSION_TIMEOUT_MS = String(sessionTimeoutMs);
        process.env.HAPPIER_DB_TX_MAX_RETRIES = "0";
        process.env.HAPPIER_DB_TX_MAX_WAIT_MS = "1000";
        process.env.HAPPIER_DB_TX_TIMEOUT_MS = "30000";
        let clockMs = Date.parse("2026-07-22T08:00:00.000Z");
        const { sessionId, heartbeat } = await createReleasedAliveSession(() => clockMs);
        const initial = await db.session.findUniqueOrThrow({
            where: { id: sessionId }, select: { active: true, lastActiveAt: true },
        });
        const now = vi.spyOn(Date, "now").mockImplementation(() => clockMs);
        try {
            let releaseHolder!: () => void;
            const holderRelease = new Promise<void>((resolve) => { releaseHolder = resolve; });
            let resolveHolderEntered!: () => void;
            const holderEntered = new Promise<void>((resolve) => { resolveHolderEntered = resolve; });
            const holderReleased = new Error("release acquisition holder");
            const holder = inTx(async () => {
                resolveHolderEntered();
                await holderRelease;
                throw holderReleased;
            });
            await holderEntered;
            try {
                // Preserve the destination's 2s exponential base and force its existing ceiling.
                for (const advanceMs of [0, 0, 2_000, 4_000, 8_000, 16_000, 32_000]) {
                    clockMs += advanceMs;
                    await heartbeat();
                }
            } finally {
                releaseHolder();
                await expect(holder).rejects.toBe(holderReleased);
            }
            await expect(db.session.findUniqueOrThrow({
                where: { id: sessionId }, select: { active: true, lastActiveAt: true },
            })).resolves.toEqual(initial);
            clockMs += retryCeilingMs - 1;
            await heartbeat();
            await expect(db.session.findUniqueOrThrow({
                where: { id: sessionId }, select: { active: true, lastActiveAt: true },
            })).resolves.toEqual(initial);
            clockMs += 1;
            await heartbeat();
            await expect(db.session.findUniqueOrThrow({
                where: { id: sessionId }, select: { active: true, lastActiveAt: true },
            })).resolves.toEqual({ active: true, lastActiveAt: new Date(clockMs) });
        } finally {
            now.mockRestore();
        }
    });

    it("does not let concurrent released alive sockets exhaust the single SQLite transaction connection", async () => {
        process.env.HAPPIER_DB_TX_MAX_RETRIES = "0";
        process.env.HAPPIER_DB_TX_MAX_WAIT_MS = "1000";

        const owner = await db.account.create({
            // A Session-owning Account is current: terminal turn settlement
            // takes the canonical Account transition fence.
            data: { publicKey: `pk-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId: owner.id, metadata: "{}" } });
        const presence = createSessionPublisherPresence();
        const sockets = [] as Array<Readonly<{ sessionId: string; alive: (value: unknown) => Promise<void> }>>;

        for (let index = 0; index < 12; index += 1) {
            const session = await db.session.create({
                data: {
                    accountId: owner.id,
                    tag: `session-${randomUUID()}`,
                    metadata: "{}",
                    active: false,
                    lastActiveAt: new Date("2026-07-22T07:00:00.000Z"),
                    runtimeActivityState: "unknown",
                    runtimeActivityActiveCount: 0,
                    runtimeActivityRevision: 0n,
                },
                select: { id: true },
            });
            await db.accessKey.create({
                data: { accountId: owner.id, machineId, sessionId: session.id, data: "encrypted" },
            });
            const socket = createAuthenticatedFakeSocket();
            sessionUpdateHandler(
                owner.id,
                socket as never,
                {
                    connectionType: "session-scoped",
                    socket,
                    userId: owner.id,
                    sessionId: session.id,
                } as never,
                {
                    presence,
                    binding: { accountId: owner.id, machineId, sessionId: session.id },
                },
            );
            const handler = getSocketHandler(socket, "session-alive");
            const alive = async (value: unknown): Promise<void> => {
                await handler(value);
            };
            sockets.push({ sessionId: session.id, alive });
        }

        let releaseHolder!: () => void;
        const holderRelease = new Promise<void>((resolve) => { releaseHolder = resolve; });
        let resolveHolderEntered!: () => void;
        const holderEntered = new Promise<void>((resolve) => { resolveHolderEntered = resolve; });
        const holder = inTx(async () => {
            resolveHolderEntered();
            await holderRelease;
        });
        await holderEntered;

        const releaseTimer = setTimeout(releaseHolder, 850);
        try {
            await Promise.all(sockets.map(({ sessionId, alive }) => alive({
                sid: sessionId,
                time: Date.now(),
                thinking: false,
            })));
        } finally {
            clearTimeout(releaseTimer);
            releaseHolder();
            await holder;
        }

        await expect(db.session.count({
            where: {
                id: { in: sockets.map(({ sessionId }) => sessionId) },
                active: true,
            },
        })).resolves.toBe(sockets.length);
    });

    it("orders exact close behind an already accepted released alive backlog", async () => {
        const owner = await db.account.create({
            // A Session-owning Account is current: terminal turn settlement
            // takes the canonical Account transition fence.
            data: { publicKey: `pk-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId: owner.id, metadata: "{}" } });
        const createSession = async () => {
            const session = await db.session.create({
                data: {
                    accountId: owner.id,
                    tag: `session-${randomUUID()}`,
                    metadata: "{}",
                    active: false,
                    lastActiveAt: new Date("2026-07-22T07:00:00.000Z"),
                    runtimeActivityState: "unknown",
                    runtimeActivityActiveCount: 0,
                    runtimeActivityRevision: 0n,
                },
                select: { id: true },
            });
            await db.accessKey.create({
                data: { accountId: owner.id, machineId, sessionId: session.id, data: "encrypted" },
            });
            return session;
        };
        const blocker = await createSession();
        const target = await createSession();
        const presence = createSessionPublisherPresence();
        const blockerSocket = createAuthenticatedFakeSocket();
        const targetSocket = createAuthenticatedFakeSocket();
        sessionUpdateHandler(
            owner.id,
            blockerSocket as never,
            {
                connectionType: "session-scoped",
                socket: blockerSocket,
                userId: owner.id,
                sessionId: blocker.id,
            } as never,
            {
                presence,
                binding: { accountId: owner.id, machineId, sessionId: blocker.id },
            },
        );
        sessionUpdateHandler(
            owner.id,
            targetSocket as never,
            {
                connectionType: "session-scoped",
                socket: targetSocket,
                userId: owner.id,
                sessionId: target.id,
            } as never,
            {
                presence,
                binding: { accountId: owner.id, machineId, sessionId: target.id },
            },
        );

        await getSocketHandler(blockerSocket, "session-runtime-activity-snapshot")({
            sessionId: blocker.id,
            mutationId: `runtime-activity-snapshot:${blocker.id}`,
            snapshot: { state: "active", activeCount: 1 },
        }, () => {});
        let resolveBlockerEntered!: () => void;
        const blockerEntered = new Promise<void>((resolve) => { resolveBlockerEntered = resolve; });
        let releaseBlocker!: () => void;
        const blockerRelease = new Promise<void>((resolve) => { releaseBlocker = resolve; });
        const heldBlockerOperation = presence.runAsCurrentPublisher({
            socket: blockerSocket,
            operation: async () => {
                resolveBlockerEntered();
                await blockerRelease;
            },
        });
        await blockerEntered;

        const blockerAlive = getSocketHandler(blockerSocket, "session-alive")({
            sid: blocker.id,
            time: Date.now(),
            thinking: false,
        });
        await Promise.resolve();
        const targetAlive = getSocketHandler(targetSocket, "session-alive")({
            sid: target.id,
            time: Date.now(),
            thinking: false,
        });
        const closeAcknowledgements: unknown[] = [];
        const targetClose = getSocketHandler(targetSocket, "session-runtime-activity-close")(
            { sessionId: target.id },
            (value: unknown) => closeAcknowledgements.push(value),
        );

        releaseBlocker();
        await Promise.all([heldBlockerOperation, blockerAlive, targetAlive, targetClose]);

        expect(closeAcknowledgements).toEqual([{ status: "closed", sessionId: target.id }]);
        await expect(db.session.findUniqueOrThrow({
            where: { id: target.id },
            select: { active: true, runtimeActivityState: true },
        })).resolves.toEqual({
            active: false,
            runtimeActivityState: "unknown",
        });
    });

    it("returns a typed retry ACK when provider acceptance cannot acquire a transaction", async () => {
        const owner = await db.account.create({
            // A Session-owning Account is current: terminal turn settlement
            // takes the canonical Account transition fence.
            data: { publicKey: `pk-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId: owner.id, metadata: "{}" } });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `session-${randomUUID()}`,
                metadata: "{}",
                active: false,
                lastActiveAt: new Date("2026-08-14T12:00:00.000Z"),
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 0n,
            },
            select: { id: true },
        });
        await db.accessKey.create({
            data: { accountId: owner.id, machineId, sessionId: session.id, data: "encrypted" },
        });

        const presence = createSessionPublisherPresence();
        const socket = createAuthenticatedFakeSocket();
        sessionUpdateHandler(
            owner.id,
            socket as never,
            {
                connectionType: "session-scoped",
                socket,
                userId: owner.id,
                sessionId: session.id,
            } as never,
            {
                presence,
                binding: { accountId: owner.id, machineId, sessionId: session.id },
            },
        );
        await getSocketHandler(socket, "session-runtime-activity-snapshot")({
            sessionId: session.id,
            mutationId: `runtime-activity-snapshot:${session.id}`,
            snapshot: { state: "idle", activeCount: 0 },
        }, () => {});

        const previousMaxRetries = process.env.HAPPIER_DB_TX_MAX_RETRIES;
        process.env.HAPPIER_DB_TX_MAX_RETRIES = "0";
        const acquisitionError = Object.assign(
            new Error("Transaction API error: Unable to start a transaction in the given time."),
            { code: "P2028", meta: { error: "Unable to start a transaction in the given time." } },
        );
        const originalTransaction = db.$transaction;
        const transaction = vi.fn().mockRejectedValueOnce(acquisitionError);
        // Prisma's overloaded transaction boundary cannot be represented by one Vitest mock signature.
        db.$transaction = transaction as unknown as typeof db.$transaction;
        const unavailableAcknowledgements: unknown[] = [];
        try {
            await getSocketHandler(socket, "pending-delivery-accepted-v1")({
                v: 1,
                sessionId: session.id,
                localId: "pending-1",
            }, (value: unknown) => unavailableAcknowledgements.push(value));
        } finally {
            db.$transaction = originalTransaction;
            if (previousMaxRetries === undefined) {
                delete process.env.HAPPIER_DB_TX_MAX_RETRIES;
            } else {
                process.env.HAPPIER_DB_TX_MAX_RETRIES = previousMaxRetries;
            }
        }

        expect(unavailableAcknowledgements).toEqual([{
            ok: false,
            error: "transaction-unavailable",
            retryAfterMs: 1_000,
            correlationId: expect.stringMatching(/^[A-Za-z0-9_.:-]{1,160}$/u),
        }]);
        await expect(db.sessionMessage.count({ where: { sessionId: session.id } })).resolves.toBe(0);

        const continuedAcknowledgements: unknown[] = [];
        await getSocketHandler(socket, "pending-delivery-accepted-v1")({
            v: 1,
            sessionId: session.id,
            localId: "pending-1",
        }, (value: unknown) => continuedAcknowledgements.push(value));
        expect(continuedAcknowledgements).toEqual([{ ok: false, error: "not-found" }]);
    });
});
