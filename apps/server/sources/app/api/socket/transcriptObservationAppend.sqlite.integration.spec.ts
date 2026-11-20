import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { UpdateContainerSchema } from "@happier-dev/protocol/updates";

import { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import { sessionUpdateHandler } from "@/app/api/socket/sessionUpdateHandler";
import { eventRouter } from "@/app/events/eventRouter";
import { projectSessionDeliveryForSocket } from "@/app/events/sessionDeliveryProjection";
import { createAuthenticatedFakeSocket, getSocketHandler } from "@/app/api/testkit/socketHarness";
import { db } from "@/storage/db";
import { readRetentionPolicyFromEnv } from "@/app/retention/config/readRetentionPolicyFromEnv";
import { runRetentionSweep } from "@/app/retention/runtime/runRetentionSweep";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

describe("transcript observation appends on SQLite", () => {
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

    it("keeps the detached part with each admitted revision and never resurrects an expired part", async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID() }, select: { id: true } });
        const machineId = randomUUID();
        await db.machine.create({ data: { id: machineId, accountId: owner.id, metadata: "{}" } });
        const session = await db.session.create({
            data: { accountId: owner.id, tag: randomUUID(), metadata: "{}", encryptionMode: "e2ee" },
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
        await getSocketHandler(socket, "session-runtime-activity-snapshot")({
            sessionId: session.id,
            mutationId: `runtime-activity-snapshot:${session.id}`,
            snapshot: { state: "idle", activeCount: 0 },
        }, () => {});

        const localId = randomUUID();
        const sourceTime = Date.parse("2026-11-19T00:00:00.000Z");
        const observe = async (shell: string, part: string, sourceRevision: number) => {
            const acks: unknown[] = [];
            await getSocketHandler(socket, "transcript-observation-v1")({
                v: 2, sessionId: session.id, localId, messageRole: "agent", content: shell,
                toolOutputPart: { t: "encrypted", c: part }, createdAt: sourceTime, updatedAt: sourceTime + sourceRevision,
                provenance: { kind: "non_dependent", source: "external" },
            }, (value: unknown) => acks.push(value));
            expect(acks).toHaveLength(1);
            return acks[0];
        };
        const read = () => db.sessionMessage.findFirstOrThrow({
            where: { sessionId: session.id, localId },
            select: { id: true, seq: true, content: true, toolOutputBytes: true, toolOutputExpiredAfterDays: true },
        });
        expect(await observe("first-shell", "Zmlyc3Q=", 0)).toMatchObject({ ok: true, didWrite: true });
        expect(await read()).toMatchObject({ seq: 1, toolOutputBytes: new TextEncoder().encode("first") });
        expect(await observe("corrected-shell", "Y29ycmVjdGVk", 1)).toMatchObject({ ok: true, didUpdate: true });
        expect(await read()).toMatchObject({ seq: 1, toolOutputBytes: new TextEncoder().encode("corrected") });

        const policy = readRetentionPolicyFromEnv({
            HAPPIER_SERVER_RETENTION__ENABLED: "true",
            HAPPIER_SERVER_RETENTION__TOOL_OUTPUTS__MODE: "delete_older_than",
            HAPPIER_SERVER_RETENTION__TOOL_OUTPUTS__DAYS: "30",
        });
        await runRetentionSweep({ policy, now: new Date("2027-01-01T00:00:00Z") });
        const expired = await read();
        expect(expired).toMatchObject({ seq: 1, toolOutputBytes: null, toolOutputExpiredAfterDays: 30 });
        expect(await observe("corrected-shell", "Y29ycmVjdGVk", 1)).toMatchObject({ ok: true, didWrite: false });
        expect(await observe("late-shell", "bGF0ZQ==", 2)).toMatchObject({ ok: false });
        expect(await read()).toEqual(expired);
    });

    it("relays only the appended text to the app's live consumer while the message grows, and the full row otherwise", async () => {
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

        const emitted: unknown[] = [];
        vi.spyOn(eventRouter, "emitUpdate").mockImplementation((params) => { emitted.push(params.payload); });

        const localId = `segment-${randomUUID()}`;
        const createdAt = Date.parse("2026-11-07T18:00:00.000Z");
        // Encrypted envelopes are opaque to Home; a ciphertext string stands in for the encrypted record.
        const record = (text: string) => text;
        const lines = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => `${from + index}-numbered-line|`).join("");
        const observe = async (text: string, updatedAt: number, append?: Readonly<{ text: string; baseLength: number; baseUpdatedAt: number }>) => {
            const acks: unknown[] = [];
            await getSocketHandler(socket, "transcript-observation-v1")({
                v: 1, sessionId: session.id, localId, messageRole: "agent", content: record(text), createdAt, updatedAt,
                provenance: { kind: "non_dependent", source: "external" },
                ...(append ? { append: { content: record(append.text), baseLength: append.baseLength, baseUpdatedAt: append.baseUpdatedAt } } : {}),
            }, (value: unknown) => acks.push(value));
            expect(acks).toEqual([expect.objectContaining({ ok: true })]);
        };

        // A growing message: each commit names the previous acknowledged commit as its base.
        let text = "";
        let previousUpdatedAt = 0;
        const commits = [[0, 20], [20, 120], [120, 400], [400, 650]] as const;
        for (const [index, [from, to]] of commits.entries()) {
            const appended = lines(from, to);
            const updatedAt = createdAt + (index + 1) * 2_000;
            await observe(text + appended, updatedAt, index === 0 ? undefined : { text: appended, baseLength: text.length, baseUpdatedAt: previousUpdatedAt });
            text += appended;
            previousUpdatedAt = updatedAt;
        }
        // A commit whose named base is not the stored row publishes the full message.
        await observe(`${text}tail|`, createdAt + 20_000, { text: "tail|", baseLength: text.length, baseUpdatedAt: createdAt + 1 });

        // An append whose envelope mode differs from the stored row's is never relayed (full row instead).
        const crossMode = async () => {
            const acks: unknown[] = [];
            await getSocketHandler(socket, "transcript-observation-v1")({
                v: 1, sessionId: session.id, localId, messageRole: "agent", content: `${text}tail|more|`, createdAt, updatedAt: createdAt + 22_000,
                provenance: { kind: "non_dependent", source: "external" },
                append: { content: { t: "plain", v: { role: "agent", content: { type: "text", text: "more|" } } }, baseLength: text.length + 5, baseUpdatedAt: createdAt + 20_000 },
            }, (value: unknown) => acks.push(value));
            expect(acks).toEqual([expect.objectContaining({ ok: true })]);
        };
        await crossMode();

        const appSync = { userId: owner.id, clientType: "user-scoped", clientPurpose: "sync",
            sessionConsumption: { liveSessionIds: new Set([session.id]), durableSessionIds: new Set([session.id]) } };
        const follower = { userId: owner.id, clientType: "user-scoped", clientPurpose: "sdk" };
        const project = (data: object, payload: unknown) => {
            const projected = projectSessionDeliveryForSocket(data as never, session.id, "update", payload, true, 0);
            expect(UpdateContainerSchema.safeParse(projected).success).toBe(true);
            return projected as { body: { t: string; delivery: string; message: { content: { c: string } }; base?: { updatedAt: number; length: number } } };
        };
        const revisions = emitted.filter((payload) => (payload as { body: { t: string } }).body.t === "message-updated");
        expect(revisions).toHaveLength(commits.length + 1);

        const appFrames = revisions.map((payload) => project(appSync, payload));
        const appBytes = appFrames.map((frame) => JSON.stringify(frame).length);
        const followerBytes = revisions.map((payload) => JSON.stringify(project(follower, payload)).length);
        // Counts: what the app receives per revision tracks the appended text, not the message length.
        expect(appFrames.map((frame) => frame.body.delivery)).toEqual(["delta", "delta", "delta", "full", "full"]);
        expect(appBytes[2]!).toBeLessThan(appBytes[1]!); // 250 appended lines at 650 total < 280 appended at 400
        expect(appBytes[2]!).toBeLessThan(followerBytes[2]! / 2);
        expect(appBytes[3]!).toBe(followerBytes[3]!);

        // The relayed appends rebuild exactly each stored revision from the base the app holds.
        const stored = await db.sessionMessage.findFirstOrThrow({ where: { sessionId: session.id, localId }, select: { content: true } });
        let rebuilt = lines(0, 20);
        const created = emitted.find((payload) => (payload as { body: { t: string } }).body.t === "new-message");
        let heldUpdatedAt = (created as { body: { message: { updatedAt: number } } }).body.message.updatedAt;
        for (const frame of appFrames.slice(0, 3)) {
            expect(frame.body.base).toEqual({ updatedAt: heldUpdatedAt, length: rebuilt.length });
            rebuilt += frame.body.message.content.c;
            heldUpdatedAt = (frame.body.message as unknown as { updatedAt: number }).updatedAt;
        }
        expect(rebuilt).toBe(lines(0, 650));
        expect(stored.content).toEqual({ t: "encrypted", c: `${lines(0, 650)}tail|more|` });
        expect(followerBytes.every((bytes, index) => index === 0 || bytes > followerBytes[index - 1]!)).toBe(true);
    });
});
