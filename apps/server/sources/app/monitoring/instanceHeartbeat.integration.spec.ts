import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const loggingMocks = vi.hoisted(() => ({ log: vi.fn(), debug: vi.fn() }));
vi.mock("@/utils/logging/log", () => loggingMocks);

import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { db } from "@/storage/db";

import {
    INSTANCE_HEARTBEAT_CAPTURE_URL,
    INSTANCE_HEARTBEAT_ID_CACHE_KEY,
    startInstanceHeartbeat,
} from "./instanceHeartbeat";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

type CapturedRequest = { url: string; body: { distinct_id: string; event: string } };

function createFetchRecorder(respond: () => Promise<Response> = async () => new Response(null, { status: 200 })) {
    const requests: CapturedRequest[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return respond();
    });
    return { fetchImpl, requests };
}

describe("instance heartbeat (sqlite)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-instance-heartbeat-" });
    }, 60_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        vi.useRealTimers();
        loggingMocks.log.mockReset();
        loggingMocks.debug.mockReset();
        await db.simpleCache.deleteMany({ where: { key: INSTANCE_HEARTBEAT_ID_CACHE_KEY } });
    });

    it("keeps one random instance id across restarts", async () => {
        const first = createFetchRecorder();
        const firstRun = startInstanceHeartbeat({ env: {}, flavor: "light", dbProvider: "sqlite", fetch: first.fetchImpl });
        await vi.waitFor(() => expect(first.requests).toHaveLength(1));
        firstRun?.stop();

        const second = createFetchRecorder();
        const secondRun = startInstanceHeartbeat({ env: {}, flavor: "light", dbProvider: "sqlite", fetch: second.fetchImpl });
        await vi.waitFor(() => expect(second.requests).toHaveLength(1));
        secondRun?.stop();

        const instanceId = first.requests[0]!.body.distinct_id;
        expect(instanceId).toMatch(UUID_V4);
        expect(second.requests[0]!.body.distinct_id).toBe(instanceId);
        expect(first.requests[0]!.url).toBe(INSTANCE_HEARTBEAT_CAPTURE_URL);
        expect(first.requests[0]!.body.event).toBe("instance_heartbeat");
        await expect(db.simpleCache.count({ where: { key: INSTANCE_HEARTBEAT_ID_CACHE_KEY } })).resolves.toBe(1);
    });

    it("pings again every 24 hours", async () => {
        vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
        const recorder = createFetchRecorder();
        const heartbeat = startInstanceHeartbeat({ env: {}, flavor: "light", dbProvider: "sqlite", fetch: recorder.fetchImpl });
        await vi.waitFor(() => expect(recorder.requests).toHaveLength(1));

        vi.advanceTimersByTime(DAY_MS);
        await vi.waitFor(() => expect(recorder.requests).toHaveLength(2));
        heartbeat?.stop();
    });

    it.each([
        ["a network error", async () => { throw new TypeError("fetch failed"); }],
        ["a non-2xx response", async () => new Response("nope", { status: 503 })],
    ])("swallows %s with a debug log", async (_label, respond) => {
        const recorder = createFetchRecorder(respond as () => Promise<Response>);
        const heartbeat = startInstanceHeartbeat({ env: {}, flavor: "light", dbProvider: "sqlite", fetch: recorder.fetchImpl });

        await vi.waitFor(() => expect(loggingMocks.debug).toHaveBeenCalledTimes(1));
        heartbeat?.stop();
        expect(recorder.requests).toHaveLength(1);
    });
});
