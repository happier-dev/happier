import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { auth } from "@/app/auth/auth";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { sessionRoutes } from "./sessionRoutes";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    // Test-boundary bridge: route helpers use the app-local Fastify alias with auth decorations.
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    enableAuthentication(typed);
    sessionRoutes(typed);
    return trackApp(typed);
}

describe("session create/load before publisher registration (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-create-register-sqlite-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterEach(async () => {
        await closeTrackedApps();
        harness.resetEnv();
        await db.accessKey.deleteMany();
        await db.machine.deleteMany();
        await db.session.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("preserves imported source dates in storage and listing without replacing them on reuse", async () => {
        const app = createTestApp();
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        const token = await auth.createToken(account.id);
        const headers = { authorization: `Bearer ${token}` };
        const sourceCreatedAtMs = Date.parse("2025-01-02T12:00:00.000Z");
        const sourceUpdatedAtMs = Date.parse("2025-02-03T12:00:00.000Z");
        const payload = {
            tag: `history-${randomUUID()}`, metadata: "{}", encryptionMode: "e2ee",
            sourceCreatedAtMs, sourceUpdatedAtMs,
        };
        const response = await app.inject({ method: "POST", url: "/v1/sessions", headers, payload });
        expect(response.statusCode).toBe(200);
        const id = response.json().session.id as string;
        const stored = await db.session.findUniqueOrThrow({ where: { id } });
        expect(stored.createdAt.getTime()).toBe(sourceCreatedAtMs);
        expect(stored.meaningfulActivityAt?.getTime()).toBe(sourceUpdatedAtMs);
        expect(stored.active).toBe(false);
        const listed = await app.inject({ method: "GET", url: "/v1/sessions", headers });
        expect(listed.json().sessions).toContainEqual(expect.objectContaining({
            id, createdAt: sourceCreatedAtMs, meaningfulActivityAt: sourceUpdatedAtMs,
        }));

        const resumed = await app.inject({
            method: "POST", url: "/v1/sessions", headers,
            payload: { ...payload, sourceCreatedAtMs: 1, sourceUpdatedAtMs: 2 },
        });
        expect(resumed.statusCode).toBe(200);
        const afterResume = await db.session.findUniqueOrThrow({ where: { id } });
        expect(afterResume.createdAt.getTime()).toBe(sourceCreatedAtMs);
        expect(afterResume.meaningfulActivityAt!.getTime()).toBeGreaterThan(sourceUpdatedAtMs);
        expect(afterResume.lastActiveAt).toEqual(stored.lastActiveAt);
    }, 120_000);

    it.each([
        { sourceUpdatedAtMs: Date.parse("2025-02-03T12:00:00.000Z") },
        { sourceCreatedAtMs: Number.MAX_SAFE_INTEGER, sourceUpdatedAtMs: Number.MAX_SAFE_INTEGER },
    ])("uses the source activity date when creation is absent and clamps future dates: %j", async (dates) => {
        const app = createTestApp();
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        const token = await auth.createToken(account.id);
        const before = Date.now();
        const response = await app.inject({
            method: "POST", url: "/v1/sessions",
            headers: { authorization: `Bearer ${token}` },
            payload: { tag: `history-${randomUUID()}`, metadata: "{}", ...dates },
        });
        expect(response.statusCode).toBe(200);
        const session = response.json().session;
        const expected = Math.min(dates.sourceUpdatedAtMs, Date.now());
        expect(session.meaningfulActivityAt).toBeLessThanOrEqual(expected);
        expect(session.meaningfulActivityAt).toBeGreaterThanOrEqual(Math.min(dates.sourceUpdatedAtMs, before));
        expect(session.createdAt).toBe(session.meaningfulActivityAt);
        expect(session.active).toBe(false);
    });

    it("keeps a created row inactive through a rejected socket and makes exact registration the sole positive transition", async () => {
        const app = createTestApp();
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        const token = await auth.createToken(account.id);
        const tag = `create-register-${randomUUID()}`;

        const createdResponse = await app.inject({
            method: "POST",
            url: "/v1/sessions",
            headers: { authorization: `Bearer ${token}` },
            payload: { tag, metadata: "{}", encryptionMode: "e2ee" },
        });

        expect(createdResponse.statusCode).toBe(200);
        const created = createdResponse.json();
        expect(created).toMatchObject({
            resolution: "created",
            session: {
                active: false,
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 0,
            },
        });
        const sessionId = created.session.id as string;

        const beforeRegistration = await db.session.findUniqueOrThrow({
            where: { id: sessionId },
            select: {
                active: true,
                lastActiveAt: true,
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
                runtimeActivityRevision: true,
            },
        });
        expect(beforeRegistration).toMatchObject({
            active: false,
            runtimeActivityState: "unknown",
            runtimeActivityActiveCount: 0,
            runtimeActivityRevision: 0n,
        });

        const listBeforeRegistration = await app.inject({
            method: "GET",
            url: "/v1/sessions",
            headers: { authorization: `Bearer ${token}` },
        });
        expect(listBeforeRegistration.statusCode).toBe(200);
        expect(listBeforeRegistration.json()).toMatchObject({
            sessions: [expect.objectContaining({
                id: sessionId,
                active: false,
                runtimeActivityState: "unknown",
            })],
        });

        const presence = createSessionPublisherPresence();
        const socket = {};
        await expect(presence.resolveCurrentPublisher({
            socket,
            binding: { accountId: account.id, machineId: `unregistered-${randomUUID()}`, sessionId },
        })).resolves.toEqual({ status: "unregistered" });
        await expect(presence.registerPublisher({
            socket,
            binding: { accountId: account.id, machineId: `missing-${randomUUID()}`, sessionId },
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        })).resolves.toEqual({ status: "rejected", reason: "unauthorized" });
        await expect(db.session.findUniqueOrThrow({
            where: { id: sessionId },
            select: {
                active: true,
                lastActiveAt: true,
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
                runtimeActivityRevision: true,
            },
        })).resolves.toEqual(beforeRegistration);

        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId: account.id, metadata: "{}" } });
        await db.accessKey.create({
            data: { accountId: account.id, machineId, sessionId, data: "encrypted" },
        });
        const registered = await presence.registerPublisher({
            socket,
            binding: { accountId: account.id, machineId, sessionId },
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        expect(registered.status).toBe("registered");
        if (registered.status !== "registered") throw new Error("expected exact publisher registration");
        expect(registered.committedFence.getTime()).toBeGreaterThan(beforeRegistration.lastActiveAt.getTime());
        await expect(presence.resolveCurrentPublisher({
            socket,
            binding: { accountId: account.id, machineId, sessionId },
        })).resolves.toMatchObject({ status: "current" });

        const listAfterRegistration = await app.inject({
            method: "GET",
            url: "/v1/sessions",
            headers: { authorization: `Bearer ${token}` },
        });
        expect(listAfterRegistration.statusCode).toBe(200);
        expect(listAfterRegistration.json()).toMatchObject({
            sessions: [expect.objectContaining({
                id: sessionId,
                active: true,
                activeAt: registered.committedFence.getTime(),
                runtimeActivityState: "idle",
            })],
        });
    }, 120_000);

    it("clears archive intent on load without asserting reachability or replacing the publisher fence", async () => {
        const app = createTestApp();
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        const token = await auth.createToken(account.id);
        const tag = `archived-load-${randomUUID()}`;
        const publisherFence = new Date("2026-07-15T08:00:00.000Z");
        const archivedAt = new Date("2026-07-15T09:00:00.000Z");
        const previousMeaningfulActivityAt = new Date("2026-07-15T07:00:00.000Z");
        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag,
                metadata: "{}",
                active: false,
                lastActiveAt: publisherFence,
                archivedAt,
                meaningfulActivityAt: previousMeaningfulActivityAt,
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 4n,
            },
        });

        const loadedResponse = await app.inject({
            method: "POST",
            url: "/v1/sessions",
            headers: { authorization: `Bearer ${token}` },
            payload: { tag, metadata: "ignored-for-existing", encryptionMode: "e2ee" },
        });

        expect(loadedResponse.statusCode).toBe(200);
        expect(loadedResponse.json()).toMatchObject({
            resolution: "existing",
            session: {
                id: session.id,
                active: false,
                activeAt: publisherFence.getTime(),
                runtimeActivityState: "unknown",
                runtimeActivityRevision: 4,
            },
        });
        const stored = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                active: true,
                archivedAt: true,
                lastActiveAt: true,
                meaningfulActivityAt: true,
                runtimeActivityState: true,
                runtimeActivityRevision: true,
            },
        });
        expect(stored).toMatchObject({
            active: false,
            archivedAt: null,
            lastActiveAt: publisherFence,
            runtimeActivityState: "unknown",
            runtimeActivityRevision: 4n,
        });
        if (stored.meaningfulActivityAt === null) {
            throw new Error("expected load to retain a meaningful activity timestamp");
        }
        expect(stored.meaningfulActivityAt.getTime()).toBeGreaterThan(previousMeaningfulActivityAt.getTime());
    }, 120_000);
});
