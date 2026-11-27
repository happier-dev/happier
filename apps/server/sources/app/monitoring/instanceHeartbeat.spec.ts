import { afterEach, describe, expect, it, vi } from "vitest";

const loggingMocks = vi.hoisted(() => ({ log: vi.fn(), debug: vi.fn() }));
vi.mock("@/utils/logging/log", () => loggingMocks);

import { readServerReleaseVersion } from "@/app/runtime/serverRelease";
import {
    buildInstanceHeartbeatEvent,
    INSTANCE_HEARTBEAT_CAPTURE_URL,
    INSTANCE_HEARTBEAT_POSTHOG_KEY,
    isInstanceHeartbeatEnabled,
    startInstanceHeartbeat,
} from "./instanceHeartbeat";

afterEach(() => {
    loggingMocks.log.mockReset();
    loggingMocks.debug.mockReset();
});

describe("isInstanceHeartbeatEnabled", () => {
    it("is on by default", () => {
        expect(isInstanceHeartbeatEnabled({})).toBe(true);
    });

    it.each(["0", "false", "off", "no"])("is disabled by HAPPIER_INSTANCE_PING=%s", (value) => {
        expect(isInstanceHeartbeatEnabled({ HAPPIER_INSTANCE_PING: value })).toBe(false);
    });

    it.each(["1", "true"])("is disabled by DO_NOT_TRACK=%s, even when the ping is explicitly on", (value) => {
        expect(isInstanceHeartbeatEnabled({ DO_NOT_TRACK: value })).toBe(false);
        expect(isInstanceHeartbeatEnabled({ DO_NOT_TRACK: value, HAPPIER_INSTANCE_PING: "1" })).toBe(false);
    });
});

describe("buildInstanceHeartbeatEvent", () => {
    it("sends only the allowed fields", () => {
        const event = buildInstanceHeartbeatEvent({
            env: {},
            instanceId: "0b6c2f7e-3c1a-4d8e-9f2a-1b2c3d4e5f60",
            flavor: "light",
            dbProvider: "sqlite",
        });

        expect(Object.keys(event).sort()).toEqual(["api_key", "distinct_id", "event", "properties"]);
        expect(Object.keys(event.properties).sort()).toEqual([
            "$geoip_disable",
            "$process_person_profile",
            "arch",
            "db_provider",
            "flavor",
            "os",
            "version",
        ]);
        expect(event).toEqual({
            api_key: INSTANCE_HEARTBEAT_POSTHOG_KEY,
            event: "instance_heartbeat",
            distinct_id: "0b6c2f7e-3c1a-4d8e-9f2a-1b2c3d4e5f60",
            properties: {
                version: readServerReleaseVersion(),
                flavor: "light",
                db_provider: "sqlite",
                os: process.platform,
                arch: process.arch,
                $process_person_profile: false,
                $geoip_disable: true,
            },
        });
    });

    it("uses the env project key override", () => {
        const event = buildInstanceHeartbeatEvent({
            env: { HAPPIER_INSTANCE_PING_POSTHOG_KEY: "phc_test" },
            instanceId: "id",
            flavor: "full",
            dbProvider: "postgres",
        });
        expect(event.api_key).toBe("phc_test");
    });

    it("targets the PostHog EU capture endpoint", () => {
        expect(INSTANCE_HEARTBEAT_CAPTURE_URL).toBe("https://eu.i.posthog.com/i/v0/e/");
    });
});

describe("startInstanceHeartbeat", () => {
    it("logs one info line naming every field sent and how to disable it", () => {
        const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
        const heartbeat = startInstanceHeartbeat({ env: {}, flavor: "full", dbProvider: "postgres", fetch: fetchImpl });
        heartbeat?.stop();

        expect(heartbeat).not.toBeNull();
        expect(loggingMocks.log).toHaveBeenCalledTimes(1);
        const [, message] = loggingMocks.log.mock.calls[0]!;
        for (const field of ["version", "flavor", "db_provider", "os", "arch", "instance id"]) {
            expect(message).toContain(field);
        }
        expect(message).toContain("eu.i.posthog.com");
        expect(message).toContain("HAPPIER_INSTANCE_PING=0");
        expect(message).toContain("DO_NOT_TRACK=1");
    });

    it.each([{ HAPPIER_INSTANCE_PING: "0" }, { DO_NOT_TRACK: "1" }])("does nothing when opted out (%o)", async (env) => {
        const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
        const heartbeat = startInstanceHeartbeat({ env, flavor: "full", dbProvider: "postgres", fetch: fetchImpl });
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(heartbeat).toBeNull();
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(loggingMocks.log).not.toHaveBeenCalled();
    });

    it("swallows an instance id storage failure without throwing", async () => {
        // The database is not initialized in this unit test, so reading the instance id fails.
        const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
        const heartbeat = startInstanceHeartbeat({ env: {}, flavor: "full", dbProvider: "postgres", fetch: fetchImpl });

        await vi.waitFor(() => expect(loggingMocks.debug).toHaveBeenCalled());
        heartbeat?.stop();
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
