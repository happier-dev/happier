import { describe, expect, it } from "vitest";

type PreviewOriginModule = typeof import("./origin");

async function loadPreviewOriginModule(): Promise<PreviewOriginModule | null> {
    return import("./origin").catch(() => null);
}

describe("local service preview origin policy", () => {
    it("builds host-origin preview urls and preserves initial path query", async () => {
        const mod = await loadPreviewOriginModule();

        const result = mod?.resolveLocalServicePreviewUrl({
            originMode: "host",
            publicBaseUrl: "https://app.happier.test",
            hostOriginBaseDomain: "preview.happier.test",
            previewId: "preview_123",
            initialPath: { pathname: "/dashboard", search: "?tab=preview" },
            token: "token_123",
        });

        expect(result).toEqual({
            ok: true,
            url: "https://preview-123.preview.happier.test/dashboard?tab=preview&previewToken=token_123",
            origin: "https://preview-123.preview.happier.test",
        });
    });

    it("builds path-mode fallback urls without losing query strings", async () => {
        const mod = await loadPreviewOriginModule();

        const result = mod?.resolveLocalServicePreviewUrl({
            originMode: "path",
            publicBaseUrl: "https://app.happier.test",
            hostOriginBaseDomain: null,
            previewId: "preview_123",
            initialPath: { pathname: "/dashboard", search: "?tab=preview" },
            token: "token_123",
        });

        expect(result).toEqual({
            ok: true,
            url: "https://app.happier.test/v1/local-services/preview/preview_123/dashboard?tab=preview&previewToken=token_123",
            origin: "https://app.happier.test",
        });
    });

    it("rejects path-mode fallback for non-http public base URLs", async () => {
        const mod = await loadPreviewOriginModule();

        expect(mod?.resolveLocalServicePreviewUrl({
            originMode: "path",
            publicBaseUrl: "ftp://app.happier.test",
            hostOriginBaseDomain: null,
            previewId: "preview_123",
            initialPath: { pathname: "/", search: "" },
            token: "token_123",
        })).toEqual({ ok: false, reasonCode: "invalid_public_base_url" });
    });

    it("rejects host-origin mode when DNS/TLS host configuration is absent or non-https", async () => {
        const mod = await loadPreviewOriginModule();

        expect(mod?.resolveLocalServicePreviewUrl({
            originMode: "host",
            publicBaseUrl: "https://app.happier.test",
            hostOriginBaseDomain: null,
            previewId: "preview_123",
            initialPath: { pathname: "/", search: "" },
            token: "token_123",
        })).toEqual({ ok: false, reasonCode: "host_origin_unavailable" });

        expect(mod?.resolveLocalServicePreviewUrl({
            originMode: "host",
            publicBaseUrl: "http://app.happier.test",
            hostOriginBaseDomain: "preview.happier.test",
            previewId: "preview_123",
            initialPath: { pathname: "/", search: "" },
            token: "token_123",
        })).toEqual({ ok: false, reasonCode: "https_required" });
    });

    it("rejects host-origin base domains that are not plain DNS names", async () => {
        const mod = await loadPreviewOriginModule();

        for (const hostOriginBaseDomain of [
            "https://preview.happier.test",
            "preview.happier.test/path",
            "preview.happier.test:8443",
            "-preview.happier.test",
        ]) {
            expect(mod?.resolveLocalServicePreviewUrl({
                originMode: "host",
                publicBaseUrl: "https://app.happier.test",
                hostOriginBaseDomain,
                previewId: "preview_123",
                initialPath: { pathname: "/", search: "" },
                token: "token_123",
            })).toEqual({ ok: false, reasonCode: "host_origin_unavailable" });
        }
    });
});
