import { describe, expect, it } from "vitest";

import {
    createPublicShareMessagesAccessToken,
    requirePublicShareAccessGrantSecret,
    resolvePublicShareUseLimit,
    validatePublicShareMessagesAccessToken,
} from "./publicShareMessageAccessGrant";

const SECRET = "public-share-message-grant-test-secret";
const PUBLIC_SHARE_ID = "ps_1";
const SESSION_ID = "session_1";
const TOKEN_HASH_HEX = "0".repeat(64);

function createToken(overrides: Partial<Parameters<typeof createPublicShareMessagesAccessToken>[0]> = {}): string {
    return createPublicShareMessagesAccessToken({
        secret: SECRET,
        publicShareId: PUBLIC_SHARE_ID,
        sessionId: SESSION_ID,
        tokenHashHex: TOKEN_HASH_HEX,
        nowMs: 1_000,
        ttlMs: 500,
        ...overrides,
    });
}

describe("public share message access grants", () => {
    it("validates a grant only while it is bound to the same share, session, and token hash", () => {
        const token = createToken();

        expect(validatePublicShareMessagesAccessToken({
            secret: SECRET,
            token,
            publicShareId: PUBLIC_SHARE_ID,
            sessionId: SESSION_ID,
            tokenHashHex: TOKEN_HASH_HEX,
            nowMs: 1_499,
        })).toBe(true);
        expect(validatePublicShareMessagesAccessToken({
            secret: SECRET,
            token,
            publicShareId: "ps_other",
            sessionId: SESSION_ID,
            tokenHashHex: TOKEN_HASH_HEX,
            nowMs: 1_499,
        })).toBe(false);
        expect(validatePublicShareMessagesAccessToken({
            secret: SECRET,
            token,
            publicShareId: PUBLIC_SHARE_ID,
            sessionId: "session_other",
            tokenHashHex: TOKEN_HASH_HEX,
            nowMs: 1_499,
        })).toBe(false);
        expect(validatePublicShareMessagesAccessToken({
            secret: SECRET,
            token,
            publicShareId: PUBLIC_SHARE_ID,
            sessionId: SESSION_ID,
            tokenHashHex: "1".repeat(64),
            nowMs: 1_499,
        })).toBe(false);
    });

    it("rejects expired or tampered grants", () => {
        const token = createToken();
        const tamperedToken = token.replace(/.$/, token.endsWith("0") ? "1" : "0");

        expect(validatePublicShareMessagesAccessToken({
            secret: SECRET,
            token,
            publicShareId: PUBLIC_SHARE_ID,
            sessionId: SESSION_ID,
            tokenHashHex: TOKEN_HASH_HEX,
            nowMs: 1_500,
        })).toBe(false);
        expect(validatePublicShareMessagesAccessToken({
            secret: SECRET,
            token: tamperedToken,
            publicShareId: PUBLIC_SHARE_ID,
            sessionId: SESSION_ID,
            tokenHashHex: TOKEN_HASH_HEX,
            nowMs: 1_499,
        })).toBe(false);
    });

    it("requires a configured master secret", () => {
        expect(requirePublicShareAccessGrantSecret({ HANDY_MASTER_SECRET: "  configured-secret  " })).toBe("configured-secret");
        expect(() => requirePublicShareAccessGrantSecret({ HANDY_MASTER_SECRET: "   " })).toThrow(
            "HANDY_MASTER_SECRET is required for public share message access grants",
        );
    });

    it("distinguishes unlimited, capped, and malformed persisted use limits", () => {
        expect(resolvePublicShareUseLimit(null)).toEqual({ type: "unlimited" });
        expect(resolvePublicShareUseLimit(2)).toEqual({ type: "capped", maxUses: 2 });
        expect(resolvePublicShareUseLimit(0)).toEqual({ type: "invalid" });
        expect(resolvePublicShareUseLimit(-1)).toEqual({ type: "invalid" });
        expect(resolvePublicShareUseLimit(1.5)).toEqual({ type: "invalid" });
    });
});
