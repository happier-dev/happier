import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { UpdateContainerSchema } from "@happier-dev/protocol/updates";

import { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import { sessionUpdateHandler } from "@/app/api/socket/sessionUpdateHandler";
import { eventRouter } from "@/app/events/eventRouter";
import { projectSessionDeliveryForSocket } from "@/app/events/sessionDeliveryProjection";
import { createAuthenticatedFakeSocket, getSocketHandler } from "@/app/api/testkit/socketHarness";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { SESSION_AGENT_TRANSITION_DIVIDER_LOCAL_ID_PREFIX } from "@happier-dev/protocol/sessions/agentTransitionDivider";

describe("transcript observation batches on SQLite", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-transcript-append-",
            sqliteConnectionLimit: 1,
            initAuth: true,
            initEncrypt: false,
            initFiles: false,
        });
    }, 120_000);
    beforeEach(() => harness.resetEnv());
    afterAll(async () => await harness.close());

    it("commits a frame of lines in order with one handler call and stops at the first refusal", async () => {
        const owner = await db.account.create({
            data: { publicKey: `pk-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId: owner.id, metadata: "{}" } });
        const session = await db.session.create({
            data: {
                accountId: owner.id, tag: `session-${randomUUID()}`, metadata: "{}", active: false,
                lastActiveAt: new Date("2026-11-07T07:00:00.000Z"),
                runtimeActivityState: "unknown", runtimeActivityActiveCount: 0, runtimeActivityRevision: 0n,
            },
            select: { id: true },
        });
        await db.accessKey.create({ data: { accountId: owner.id, machineId, sessionId: session.id, data: "encrypted" } });

        const socket = createAuthenticatedFakeSocket();
        sessionUpdateHandler(
            owner.id,
            socket as never,
            { connectionType: "session-scoped", socket, userId: owner.id, sessionId: session.id } as never,
            { presence: createSessionPublisherPresence(), binding: { accountId: owner.id, machineId, sessionId: session.id } },
        );
        await getSocketHandler(socket, "transcript-observation-capability-v1")({ v: 1, sessionId: session.id }, () => {});
        await getSocketHandler(socket, "session-runtime-activity-snapshot")({
            sessionId: session.id,
            mutationId: `runtime-activity-snapshot:${session.id}`,
            snapshot: { state: "idle", activeCount: 0 },
        }, () => {});

        const emitted: string[] = [];
        vi.spyOn(eventRouter, "emitUpdate").mockImplementation((params) => {
            const body = (params.payload as { body: { t: string; message?: { localId?: string } } }).body;
            if (body.t === "new-message" && body.message?.localId) emitted.push(body.message.localId);
        });
        const createdAt = Date.parse("2026-11-12T18:00:00.000Z");
        const observation = (localId: string, index: number) => ({
            v: 1, sessionId: session.id, localId, messageRole: "agent", content: `line-${index}`,
            createdAt: createdAt + index, updatedAt: createdAt + index,
            provenance: { kind: "non_dependent", source: "external" },
        });
        const send = async (observations: unknown[]) => {
            const acks: unknown[] = [];
            await getSocketHandler(socket, "transcript-observation-batch-v1")({ v: 1, sessionId: session.id, observations },
                (value: unknown) => acks.push(value));
            return acks[0] as { ok: boolean; acks: Array<{ ok: boolean; localId?: string; seq?: number }> };
        };

        const lines = Array.from({ length: 20 }, (_, index) => `line-${index}-${randomUUID()}`);
        const first = await send(lines.map(observation));
        const stored = await db.sessionMessage.findMany({ where: { sessionId: session.id }, orderBy: { seq: "asc" },
            select: { localId: true, seq: true } });
        expect({
            acked: first.acks.filter(ack => ack.ok).map(ack => ack.localId),
            storedInSeqOrder: stored.map(row => row.localId),
            published: emitted,
        }).toEqual({ acked: lines, storedInSeqOrder: lines, published: lines });

        // A refused member stops the frame: nothing after it commits ahead of it.
        const refused = `${SESSION_AGENT_TRANSITION_DIVIDER_LOCAL_ID_PREFIX}${randomUUID()}`;
        const after = `after-${randomUUID()}`;
        const second = await send([observation(`ok-${randomUUID()}`, 30), observation(refused, 31), observation(after, 32)]);
        expect(second.acks.map(ack => ack.ok)).toEqual([true, false]);
        expect(await db.sessionMessage.count({ where: { sessionId: session.id, localId: after } })).toBe(0);
    });
});
