import { beforeEach, describe, expect, it, vi } from "vitest";

type FakeHandler = (...args: unknown[]) => void;

const http2State = vi.hoisted(() => {
    class FakeRequest {
        private readonly handlers = new Map<string, FakeHandler[]>();

        body: string | null = null;
        closed = false;

        setEncoding(_encoding: string): void {}

        on(event: string, handler: FakeHandler): this {
            const handlers = this.handlers.get(event) ?? [];
            handlers.push(handler);
            this.handlers.set(event, handlers);
            return this;
        }

        end(body: string): void {
            this.body = body;
            if (http2State.hangRequests) return;
            this.emit("response", { ":status": 200, "apns-id": "apns-1" });
            this.emit("end");
        }

        close(): void {
            this.closed = true;
        }

        private emit(event: string, ...args: unknown[]): void {
            for (const handler of this.handlers.get(event) ?? []) {
                handler(...args);
            }
        }
    }

    class FakeSession {
        readonly requests: Array<Readonly<Record<string, unknown>>> = [];
        private readonly handlers = new Map<string, FakeHandler[]>();
        readonly destroyed = false;
        readonly closed = false;

        request(headers: Readonly<Record<string, unknown>>): FakeRequest {
            this.requests.push(headers);
            return new FakeRequest();
        }

        once(event: string, handler: FakeHandler): this {
            const handlers = this.handlers.get(event) ?? [];
            handlers.push(handler);
            this.handlers.set(event, handlers);
            return this;
        }

        emit(event: string, ...args: unknown[]): void {
            for (const handler of this.handlers.get(event) ?? []) {
                handler(...args);
            }
            this.handlers.delete(event);
        }
    }

    const sessions: FakeSession[] = [];
    let hangRequests = false;
    const connect = vi.fn((_endpoint: string) => {
        const session = new FakeSession();
        sessions.push(session);
        return session;
    });

    return { connect, sessions, hangRequests };
});

vi.mock("node:http2", () => ({
    connect: http2State.connect,
}));

describe("apnsLiveActivityHttp2Sender", () => {
    beforeEach(() => {
        vi.resetModules();
        http2State.connect.mockClear();
        http2State.sessions.length = 0;
        http2State.hangRequests = false;
    });

    it("uses separate persistent HTTP/2 sessions per endpoint and APNs topic", async () => {
        const { sendApnsLiveActivityHttp2Request } = await import("./apnsLiveActivityHttp2Sender");

        await sendApnsLiveActivityHttp2Request({
            endpoint: "https://api.sandbox.push.apple.com",
            deviceToken: "token-1",
            headers: {
                "apns-topic": "dev.happier.one.push-type.liveactivity",
            },
            payload: { aps: { event: "update" } },
        });
        await sendApnsLiveActivityHttp2Request({
            endpoint: "https://api.sandbox.push.apple.com",
            deviceToken: "token-2",
            headers: {
                "apns-topic": "dev.happier.one.push-type.liveactivity",
            },
            payload: { aps: { event: "update" } },
        });
        await sendApnsLiveActivityHttp2Request({
            endpoint: "https://api.sandbox.push.apple.com",
            deviceToken: "token-3",
            headers: {
                "apns-topic": "dev.happier.two.push-type.liveactivity",
            },
            payload: { aps: { event: "update" } },
        });

        expect(http2State.connect).toHaveBeenCalledTimes(2);
        expect(http2State.sessions[0]?.requests).toHaveLength(2);
        expect(http2State.sessions[1]?.requests).toHaveLength(1);
    });

    it("rejects stalled APNs requests after the configured request timeout", async () => {
        http2State.hangRequests = true;
        const { sendApnsLiveActivityHttp2Request } = await import("./apnsLiveActivityHttp2Sender");

        await expect(sendApnsLiveActivityHttp2Request({
            endpoint: "https://api.sandbox.push.apple.com",
            deviceToken: "token-1",
            headers: {
                "apns-topic": "dev.happier.one.push-type.liveactivity",
            },
            payload: { aps: { event: "update" } },
            timeoutMs: 5,
        })).rejects.toThrow("APNs Live Activity request timed out");
    });

    it.each(["close", "error"] as const)("fails fast during reconnect backoff after APNs session %s", async (event) => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-05-04T12:00:00.000Z"));
        vi.stubEnv("HAPPIER_LIVE_ACTIVITY_APNS_RECONNECT_BACKOFF_MS", "1000");
        try {
            const { sendApnsLiveActivityHttp2Request } = await import("./apnsLiveActivityHttp2Sender");
            const request = {
                endpoint: "https://api.sandbox.push.apple.com",
                deviceToken: "token-1",
                headers: {
                    "apns-topic": "dev.happier.one.push-type.liveactivity",
                },
                payload: { aps: { event: "update" } },
            };

            await sendApnsLiveActivityHttp2Request(request);
            expect(http2State.connect).toHaveBeenCalledTimes(1);

            http2State.sessions[0]?.emit(event, new Error("session dropped"));

            await expect(sendApnsLiveActivityHttp2Request({
                ...request,
                deviceToken: "token-2",
            })).rejects.toThrow("APNs Live Activity HTTP/2 session is in reconnect backoff");
            expect(http2State.connect).toHaveBeenCalledTimes(1);

            vi.advanceTimersByTime(1000);
            await sendApnsLiveActivityHttp2Request({
                ...request,
                deviceToken: "token-3",
            });
            expect(http2State.connect).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
            vi.unstubAllEnvs();
        }
    });
});
