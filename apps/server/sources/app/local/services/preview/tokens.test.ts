import { describe, expect, it } from "vitest";

type PreviewTokensModule = typeof import("./tokens");

async function loadPreviewTokensModule(): Promise<PreviewTokensModule | null> {
    return import("./tokens").catch(() => null);
}

describe("local service preview access tokens", () => {
    it("creates token records without storing raw token material", async () => {
        const mod = await loadPreviewTokensModule();

        const issued = mod?.createLocalServicePreviewToken({
            secret: "server-secret",
            tokenId: "token_1",
            rawToken: "raw-preview-token",
            previewId: "preview_1",
            sessionId: "session_1",
            machineId: "machine_1",
            issuedAt: 1_000,
            expiresAt: 61_000,
            exchangeMode: "cookie",
        });

        expect(issued?.token).toBe("raw-preview-token");
        expect(issued?.record.tokenHash).not.toBe("raw-preview-token");
        expect(JSON.stringify(issued?.record)).not.toContain("raw-preview-token");
    });

    it("validates token binding to preview, session, and machine", async () => {
        const mod = await loadPreviewTokensModule();
        const issued = mod?.createLocalServicePreviewToken({
            secret: "server-secret",
            tokenId: "token_1",
            rawToken: "raw-preview-token",
            previewId: "preview_1",
            sessionId: "session_1",
            machineId: "machine_1",
            issuedAt: 1_000,
            expiresAt: 61_000,
            exchangeMode: "cookie",
        });

        expect(mod?.validateLocalServicePreviewToken({
            secret: "server-secret",
            rawToken: "raw-preview-token",
            record: issued!.record,
            previewId: "preview_1",
            sessionId: "session_1",
            machineId: "machine_1",
            nowMs: 2_000,
        })).toEqual({ ok: true });

        expect(mod?.validateLocalServicePreviewToken({
            secret: "server-secret",
            rawToken: "raw-preview-token",
            record: issued!.record,
            previewId: "preview_1",
            sessionId: "session_1",
            machineId: "machine_1",
            nowMs: 2_000,
            expectedExchangeMode: "url",
        })).toEqual({ ok: false, reasonCode: "exchange_mode_mismatch" });

        expect(mod?.validateLocalServicePreviewToken({
            secret: "server-secret",
            rawToken: "raw-preview-token",
            record: issued!.record,
            previewId: "preview_1",
            sessionId: "session_2",
            machineId: "machine_1",
            nowMs: 2_000,
        })).toEqual({ ok: false, reasonCode: "binding_mismatch" });
    });

    it("rejects token records before their issued time", async () => {
        const mod = await loadPreviewTokensModule();
        const issued = mod?.createLocalServicePreviewToken({
            secret: "server-secret",
            tokenId: "token_1",
            rawToken: "raw-preview-token",
            previewId: "preview_1",
            sessionId: "session_1",
            machineId: "machine_1",
            issuedAt: 1_000,
            expiresAt: 61_000,
            exchangeMode: "cookie",
        });

        expect(mod?.validateLocalServicePreviewToken({
            secret: "server-secret",
            rawToken: "raw-preview-token",
            record: issued!.record,
            previewId: "preview_1",
            sessionId: "session_1",
            machineId: "machine_1",
            nowMs: 999,
        })).toEqual({ ok: false, reasonCode: "not_yet_valid" });
    });

    it("rejects empty secret or token material at issuance", async () => {
        const mod = await loadPreviewTokensModule();
        const baseInput = {
            secret: "server-secret",
            tokenId: "token_1",
            rawToken: "raw-preview-token",
            previewId: "preview_1",
            sessionId: "session_1",
            machineId: "machine_1",
            issuedAt: 1_000,
            expiresAt: 61_000,
            exchangeMode: "cookie",
        } as const;

        expect(() => mod?.createLocalServicePreviewToken({ ...baseInput, secret: "" })).toThrow();
        expect(() => mod?.createLocalServicePreviewToken({ ...baseInput, rawToken: "" })).toThrow();
        expect(() => mod?.createLocalServicePreviewToken({ ...baseInput, expiresAt: 1_000 })).toThrow();
    });

    it("rejects expired, revoked, and mismatched token material", async () => {
        const mod = await loadPreviewTokensModule();
        const issued = mod?.createLocalServicePreviewToken({
            secret: "server-secret",
            tokenId: "token_1",
            rawToken: "raw-preview-token",
            previewId: "preview_1",
            sessionId: "session_1",
            machineId: "machine_1",
            issuedAt: 1_000,
            expiresAt: 61_000,
            exchangeMode: "cookie",
        });

        expect(mod?.validateLocalServicePreviewToken({
            secret: "server-secret",
            rawToken: "other-token",
            record: issued!.record,
            previewId: "preview_1",
            sessionId: "session_1",
            machineId: "machine_1",
            nowMs: 2_000,
        })).toEqual({ ok: false, reasonCode: "token_mismatch" });

        expect(mod?.validateLocalServicePreviewToken({
            secret: "server-secret",
            rawToken: "raw-preview-token",
            record: { ...issued!.record, revokedAt: 2_000 },
            previewId: "preview_1",
            sessionId: "session_1",
            machineId: "machine_1",
            nowMs: 3_000,
        })).toEqual({ ok: false, reasonCode: "revoked" });

        expect(mod?.validateLocalServicePreviewToken({
            secret: "server-secret",
            rawToken: "raw-preview-token",
            record: issued!.record,
            previewId: "preview_1",
            sessionId: "session_1",
            machineId: "machine_1",
            nowMs: 61_000,
        })).toEqual({ ok: false, reasonCode: "expired" });
    });
});
