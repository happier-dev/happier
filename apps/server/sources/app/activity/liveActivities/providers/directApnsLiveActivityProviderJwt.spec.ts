import { createPrivateKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { LiveActivityRemoteUpdateRequestV1 } from "@happier-dev/protocol";

import type { ApnsLiveActivityHttp2Request } from "./apnsLiveActivityHttp2Sender";
import { createP8PrivateKey, createRemoteUpdateRequest } from "./directApnsLiveActivityProvider.testkit";

async function loadProviderModule() {
    return import("./directApnsLiveActivityProvider").catch(() => null);
}

type BuildDirectApnsLiveActivityHttp2Request = (params: Readonly<{
    target: Readonly<{
        activityId: string;
        bundleId: string;
    }>;
    request: LiveActivityRemoteUpdateRequestV1;
    config: Readonly<{
        environment: "sandbox" | "production";
        teamId: string;
        keyId: string;
        privateKeyPem: string;
    }>;
    now: Date;
    deviceToken: string;
}>) => ApnsLiveActivityHttp2Request;

describe("direct APNs Live Activity JWT signing", () => {
    it("derives token-auth JWT header, payload, and ES256 signature from p8 credentials", async () => {
        const mod = await loadProviderModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const p8 = createP8PrivateKey();
        const jwt = mod.createApnsLiveActivityJwt({
            teamId: "TEAMID1234",
            keyId: "KEYID1234",
            privateKeyPem: p8,
            issuedAtEpochSeconds: 1_800_000_000,
        });

        const [headerRaw, payloadRaw, signatureRaw] = jwt.split(".");
        expect(JSON.parse(Buffer.from(headerRaw!, "base64url").toString("utf8"))).toEqual({
            alg: "ES256",
            kid: "KEYID1234",
        });
        expect(JSON.parse(Buffer.from(payloadRaw!, "base64url").toString("utf8"))).toEqual({
            iss: "TEAMID1234",
            iat: 1_800_000_000,
        });
        expect(Buffer.from(signatureRaw!, "base64url")).toHaveLength(64);
        expect(createPrivateKey(p8).asymmetricKeyType).toBe("ec");
    });

    it("rotates token-auth JWTs by issued-at time without exposing private key material", async () => {
        const mod = await loadProviderModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const privateKeyPem = createP8PrivateKey();
        const first = mod.createApnsLiveActivityJwt({
            teamId: "TEAMID1234",
            keyId: "KEYID1234",
            privateKeyPem,
            issuedAtEpochSeconds: 1_800_000_000,
        });
        const second = mod.createApnsLiveActivityJwt({
            teamId: "TEAMID1234",
            keyId: "KEYID1234",
            privateKeyPem,
            issuedAtEpochSeconds: 1_800_003_000,
        });

        expect(first).not.toBe(second);
        expect(JSON.stringify([first, second])).not.toContain(privateKeyPem);
        expect(createPrivateKey(privateKeyPem).asymmetricKeyType).toBe("ec");
    });

    it("builds APNs trace metadata from the server send time", async () => {
        const mod = await loadProviderModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const builder = (mod as Record<string, unknown>).buildDirectApnsLiveActivityHttp2Request;
        expect(typeof builder).toBe("function");
        if (typeof builder !== "function") return;

        const apnsRequest = (builder as BuildDirectApnsLiveActivityHttp2Request)({
            target: {
                activityId: "activity-1",
                bundleId: "dev.happier.custom",
            },
            request: createRemoteUpdateRequest("session-1"),
            config: {
                environment: "sandbox",
                teamId: "TEAMID1234",
                keyId: "KEYID1234",
                privateKeyPem: createP8PrivateKey(),
            },
            now: new Date("2026-05-03T12:00:00.000Z"),
            deviceToken: "activity-token-1",
        });

        expect(apnsRequest.headers["apns-id"]).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
        expect(apnsRequest.payload).toMatchObject({
            aps: {
                timestamp: 1_777_809_600,
            },
        });
        expect(apnsRequest.payload).not.toMatchObject({
            aps: {
                timestamp: 1_800_000_000,
            },
        });
    });

    it("reuses APNs provider JWTs inside the rotation window", async () => {
        const mod = await loadProviderModule();
        expect(mod).not.toBeNull();
        if (!mod) return;

        const builder = (mod as Record<string, unknown>).buildDirectApnsLiveActivityHttp2Request;
        expect(typeof builder).toBe("function");
        if (typeof builder !== "function") return;

        const privateKeyPem = createP8PrivateKey();
        const baseParams = {
            target: {
                activityId: "activity-jwt-cache",
                bundleId: "dev.happier.custom",
            },
            request: createRemoteUpdateRequest("session-jwt-cache"),
            config: {
                environment: "sandbox" as const,
                teamId: "TEAMID1234",
                keyId: "KEYID1234",
                privateKeyPem,
            },
            deviceToken: "activity-token-jwt-cache",
        };
        const first = (builder as BuildDirectApnsLiveActivityHttp2Request)({
            ...baseParams,
            now: new Date("2026-05-03T12:00:00.000Z"),
        });
        const withinWindow = (builder as BuildDirectApnsLiveActivityHttp2Request)({
            ...baseParams,
            now: new Date("2026-05-03T12:49:00.000Z"),
        });
        const afterWindow = (builder as BuildDirectApnsLiveActivityHttp2Request)({
            ...baseParams,
            now: new Date("2026-05-03T12:50:00.000Z"),
        });

        expect(withinWindow.headers.authorization).toBe(first.headers.authorization);
        expect(afterWindow.headers.authorization).not.toBe(first.headers.authorization);
        expect(JSON.stringify([first, withinWindow, afterWindow])).not.toContain(privateKeyPem);
    });
});
