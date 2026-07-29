import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import tweetnacl from "tweetnacl";

import { encodeBase64 } from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { registerConnectedServiceOpenAiCodexDeviceAuthRoutes } from "./connectedServicesV2/registerConnectedServiceOpenAiCodexDeviceAuthRoutes";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    typed.decorate("authenticate", async (request: any, reply: any) => {
        const userId = request.headers["x-test-user-id"];
        if (typeof userId !== "string" || !userId) return reply.code(401).send({ error: "Unauthorized" });
        request.userId = userId;
    });
    registerConnectedServiceOpenAiCodexDeviceAuthRoutes(typed);
    return trackApp(typed);
}

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function recipientKey(): string {
    return encodeBase64(tweetnacl.box.keyPair().publicKey, "base64url");
}

describe("OpenAI Codex device-auth durable transaction routes", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-dev-connected-service-device-auth-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterEach(async () => {
        await closeTrackedApps();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        harness.resetEnv();
        await db.repeatKey.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => await harness.close());

    it("persists an opaque encrypted account/key-bound transaction and hides it cross-account", async () => {
        const [accountA, accountB] = await Promise.all([
            db.account.create({ data: { publicKey: "a" }, select: { id: true } }),
            db.account.create({ data: { publicKey: "b" }, select: { id: true } }),
        ]);
        const publicKey = recipientKey();
        const fetcher = vi.fn(async () => jsonResponse(200, {
            device_auth_id: "device-secret",
            user_code: "user-secret",
            interval: 5,
        }));
        vi.stubGlobal("fetch", fetcher);
        const app = createTestApp();
        await app.ready();
        const start = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/oauth/device/start",
            headers: { "content-type": "application/json", "x-test-user-id": accountA.id },
            payload: { publicKey },
        });
        expect(start.json()).toEqual(expect.objectContaining({
            transactionId: expect.stringMatching(/^csda_/),
            deviceAuthId: expect.stringMatching(/^csda_/),
        }));
        expect(start.json().deviceAuthId).toBe(start.json().transactionId);
        const transactionId = start.json().transactionId as string;
        const row = await db.repeatKey.findUniqueOrThrow({ where: { key: transactionId } });
        expect(row.value).not.toContain("device-secret");
        expect(row.value).not.toContain("user-secret");
        expect(row.value).not.toContain(publicKey);
        const crossAccount = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/oauth/device/poll",
            headers: { "content-type": "application/json", "x-test-user-id": accountB.id },
            payload: { transactionId },
        });
        expect(crossAccount.statusCode).toBe(404);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("routes the released deviceAuthId shape into the same current transaction and rejects conflicts", async () => {
        const account = await db.account.create({ data: { publicKey: "released" }, select: { id: true } });
        const fetcher = vi.fn(async () => jsonResponse(200, {
            device_auth_id: "provider-secret",
            user_code: "ABCD-EFGH",
            interval: 5,
        }));
        vi.stubGlobal("fetch", fetcher);
        const app = createTestApp();
        await app.ready();
        const publicKey = recipientKey();
        const start = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/oauth/device/start",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: { publicKey },
        });
        const started = start.json();
        expect(started.deviceAuthId).toBe(started.transactionId);
        expect(started.deviceAuthId).not.toBe("provider-secret");

        const releasedPoll = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/oauth/device/poll",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                publicKey,
                deviceAuthId: started.deviceAuthId,
                userCode: started.userCode,
                intervalMs: started.intervalMs,
            },
        });
        expect(releasedPoll.json()).toEqual(expect.objectContaining({ status: "pending" }));

        const conflict = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/oauth/device/poll",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: {
                transactionId: started.transactionId,
                deviceAuthId: "different",
                publicKey,
                userCode: started.userCode,
            },
        });
        expect(conflict.statusCode).toBe(400);
    });

    it("rejects an invalid start key before contacting the provider", async () => {
        const account = await db.account.create({ data: { publicKey: "invalid" }, select: { id: true } });
        const fetcher = vi.fn();
        vi.stubGlobal("fetch", fetcher);
        const app = createTestApp();
        await app.ready();
        const response = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/oauth/device/start",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: { publicKey: "invalid" },
        });
        expect(response.statusCode).toBe(400);
        expect(fetcher).not.toHaveBeenCalled();
    });

    it("enforces server cadence and a single concurrent provider claim", async () => {
        let now = 10_000;
        vi.spyOn(Date, "now").mockImplementation(() => now);
        const account = await db.account.create({ data: { publicKey: "cadence" }, select: { id: true } });
        let releasePoll!: (response: Response) => void;
        const blockedPoll = new Promise<Response>((resolve) => { releasePoll = resolve; });
        const fetcher = vi.fn(async () => fetcher.mock.calls.length === 1
            ? jsonResponse(200, { device_auth_id: "device", user_code: "user", interval: 1 })
            : await blockedPoll);
        vi.stubGlobal("fetch", fetcher);
        const app = createTestApp();
        await app.ready();
        const start = await app.inject({
            method: "POST",
            url: "/v2/connect/openai-codex/oauth/device/start",
            headers: { "content-type": "application/json", "x-test-user-id": account.id },
            payload: { publicKey: recipientKey() },
        });
        const payload = { transactionId: start.json().transactionId };
        const early = await app.inject({
            method: "POST", url: "/v2/connect/openai-codex/oauth/device/poll",
            headers: { "content-type": "application/json", "x-test-user-id": account.id }, payload,
        });
        expect(early.json()).toEqual({ status: "pending", retryAfterMs: 1_000 });
        expect(fetcher).toHaveBeenCalledTimes(1);
        now += 1_000;
        const first = app.inject({
            method: "POST", url: "/v2/connect/openai-codex/oauth/device/poll",
            headers: { "content-type": "application/json", "x-test-user-id": account.id }, payload,
        });
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
        const second = await app.inject({
            method: "POST", url: "/v2/connect/openai-codex/oauth/device/poll",
            headers: { "content-type": "application/json", "x-test-user-id": account.id }, payload,
        });
        releasePoll(jsonResponse(403, {}));
        expect(second.json()).toEqual(expect.objectContaining({ status: "pending" }));
        expect((await first).json()).toEqual(expect.objectContaining({ status: "pending" }));
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it("replays the exact requester-sealed completion bundle without repeating provider exchange", async () => {
        let now = 20_000;
        vi.spyOn(Date, "now").mockImplementation(() => now);
        const account = await db.account.create({ data: { publicKey: "delivery" }, select: { id: true } });
        const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
            const body = String(init?.body ?? "");
            if (fetcher.mock.calls.length === 1) return jsonResponse(200, { device_auth_id: "device-x", user_code: "user-x", interval: 1 });
            if (body.includes("device_auth_id")) return jsonResponse(200, { authorization_code: "code-x", code_verifier: "verifier-x" });
            return jsonResponse(200, { access_token: "access-x", refresh_token: "refresh-x", expires_in: 3600 });
        });
        vi.stubGlobal("fetch", fetcher);
        const app = createTestApp();
        await app.ready();
        const start = await app.inject({
            method: "POST", url: "/v2/connect/openai-codex/oauth/device/start",
            headers: { "content-type": "application/json", "x-test-user-id": account.id }, payload: { publicKey: recipientKey() },
        });
        const transactionId = start.json().transactionId as string;
        now += 1_000;
        const success = await app.inject({
            method: "POST", url: "/v2/connect/openai-codex/oauth/device/poll",
            headers: { "content-type": "application/json", "x-test-user-id": account.id }, payload: { transactionId },
        });
        const replay = await app.inject({
            method: "POST", url: "/v2/connect/openai-codex/oauth/device/poll",
            headers: { "content-type": "application/json", "x-test-user-id": account.id }, payload: { transactionId },
        });
        expect(success.json()).toEqual({ status: "success", bundle: expect.any(String) });
        expect(replay.statusCode).toBe(200);
        expect(replay.json()).toEqual(success.json());
        expect(fetcher).toHaveBeenCalledTimes(3);
        const row = await db.repeatKey.findUniqueOrThrow({ where: { key: transactionId } });
        for (const secret of ["device-x", "user-x", "code-x", "verifier-x", "access-x", "refresh-x"]) {
            expect(row.value).not.toContain(secret);
        }
    });
});
