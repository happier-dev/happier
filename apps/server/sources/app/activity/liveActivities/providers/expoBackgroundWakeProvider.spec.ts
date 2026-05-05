import { beforeEach, describe, expect, it, vi } from "vitest";

import { LiveActivityRemoteUpdateRequestV1Schema } from "@happier-dev/protocol";
import { createRemoteUpdateRequestNearContentStateBudget } from "./directApnsLiveActivityProvider.testkit";

const sendPushNotificationsAsyncSpy = vi.hoisted(() => vi.fn(async (_messages: unknown[]) => [{ status: "ok" }]));

vi.mock("expo-server-sdk", () => {
    class Expo {
        static isExpoPushToken(token: unknown) {
            return typeof token === "string" && token.startsWith("ExponentPushToken[");
        }
        chunkPushNotifications(messages: unknown[]) {
            return [messages];
        }
        async sendPushNotificationsAsync(chunk: unknown[]) {
            return await sendPushNotificationsAsyncSpy(chunk);
        }
    }
    return { Expo };
});

async function loadProviderModule() {
    return import("./expoBackgroundWakeProvider").catch(() => null);
}

describe("expoBackgroundWakeProvider", () => {
    beforeEach(() => {
        sendPushNotificationsAsyncSpy.mockReset();
        sendPushNotificationsAsyncSpy.mockResolvedValue([{ status: "ok" }]);
    });

    it("returns a failed best-effort result when Expo push transport throws", async () => {
        const mod = await loadProviderModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        sendPushNotificationsAsyncSpy.mockRejectedValueOnce(new Error("expo outage"));

        const result = await mod.sendExpoBackgroundWakeLiveActivityUpdate({
            expoPushToken: "ExponentPushToken[wake]",
            request: {
                v: 1,
                requestId: "wake-transport-error",
                createdAt: 1_800_000_000_000,
                transportMode: "background_wake_best_effort",
                activityKey: {
                    serverId: "server-1",
                    sessionId: "session-1",
                    activityName: "HappierFocusLiveActivity",
                },
                snapshotFingerprint: "fp-wake-error",
                event: "end",
            },
        });

        expect(result).toEqual({
            status: "failed",
            reason: "expo_background_wake_transport_error",
        });
    });

    it("returns a failed best-effort result when Expo returns an error ticket", async () => {
        const mod = await loadProviderModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        sendPushNotificationsAsyncSpy.mockResolvedValueOnce([
            {
                status: "error",
            },
        ]);

        const result = await mod.sendExpoBackgroundWakeLiveActivityUpdate({
            expoPushToken: "ExponentPushToken[wake]",
            request: {
                v: 1,
                requestId: "wake-ticket-error",
                createdAt: 1_800_000_000_000,
                transportMode: "background_wake_best_effort",
                activityKey: {
                    serverId: "server-1",
                    sessionId: "session-1",
                    activityName: "HappierFocusLiveActivity",
                },
                snapshotFingerprint: "fp-wake-ticket-error",
                event: "end",
            },
        });

        expect(result).toEqual({
            status: "failed",
            reason: "expo_background_wake_ticket_error",
        });
    });

    it("sends only a data-only best-effort wake payload through Expo push infrastructure", async () => {
        const mod = await loadProviderModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const result = await mod.sendExpoBackgroundWakeLiveActivityUpdate({
            expoPushToken: "ExponentPushToken[wake]",
            request: {
                v: 1,
                requestId: "wake-1",
                createdAt: 1_800_000_000_000,
                transportMode: "background_wake_best_effort",
                activityKey: {
                    serverId: "server-1",
                    sessionId: "session-1",
                    activityName: "HappierFocusLiveActivity",
                },
                snapshotFingerprint: "fp-wake-1",
                event: "end",
            },
        });

        expect(result.status).toBe("sent_best_effort");
        const [chunk] = sendPushNotificationsAsyncSpy.mock.calls[0] ?? [];
        expect(chunk).toEqual([
            expect.objectContaining({
                to: "ExponentPushToken[wake]",
                _contentAvailable: true,
                data: expect.objectContaining({
                    type: "happier.liveActivityRemoteUpdate.v1",
                    requestId: "wake-1",
                    event: "end",
                }),
            }),
        ]);
        expect(JSON.stringify(chunk)).not.toContain("\"title\"");
        expect(JSON.stringify(chunk)).not.toContain("\"body\"");
    });

    it("rejects oversized background wake payloads before sending through Expo", async () => {
        const mod = await loadProviderModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const request = LiveActivityRemoteUpdateRequestV1Schema.parse({
            ...createRemoteUpdateRequestNearContentStateBudget("session-budget"),
            transportMode: "background_wake_best_effort",
            requestId: "wake-payload-budget",
            snapshotFingerprint: "fp-wake-payload-budget",
        });

        const result = await mod.sendExpoBackgroundWakeLiveActivityUpdate({
            expoPushToken: "ExponentPushToken[wake]",
            request,
        });

        expect(result).toEqual({
            status: "failed",
            reason: "expo_background_wake_payload_too_large",
        });
        expect(sendPushNotificationsAsyncSpy).not.toHaveBeenCalled();
    });
});
