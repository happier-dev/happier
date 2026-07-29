import { describe, expect, it } from "vitest";

type PreviewUrlModule = typeof import("./url");

async function loadPreviewUrlModule(): Promise<PreviewUrlModule | null> {
    return import("./url").catch(() => null);
}

describe("local service preview load url policy", () => {
    it("rejects loopback urls for native preview surfaces", async () => {
        const mod = await loadPreviewUrlModule();

        expect(mod?.resolveLocalServicePreviewLoadUrl({
            platform: "ios",
            url: "http://127.0.0.1:5173/",
        })).toEqual({ ok: false, reasonCode: "native_loopback_not_allowed" });

        expect(mod?.resolveLocalServicePreviewLoadUrl({
            platform: "android",
            url: "http://localhost:5173/",
        })).toEqual({ ok: false, reasonCode: "native_loopback_not_allowed" });

        expect(mod?.resolveLocalServicePreviewLoadUrl({
            platform: "ios",
            url: "http://[::ffff:127.0.0.1]:5173/",
        })).toEqual({ ok: false, reasonCode: "native_loopback_not_allowed" });
    });

    it("allows server preview urls on native and loopback fallback on web", async () => {
        const mod = await loadPreviewUrlModule();

        expect(mod?.resolveLocalServicePreviewLoadUrl({
            platform: "ios",
            url: "https://preview.happier.test/v1/local-services/preview/preview_1/",
        })).toEqual({ ok: true, url: "https://preview.happier.test/v1/local-services/preview/preview_1/" });

        expect(mod?.resolveLocalServicePreviewLoadUrl({
            platform: "web",
            url: "http://127.0.0.1:5173/",
        })).toEqual({ ok: true, url: "http://127.0.0.1:5173/" });
    });

    it("treats desktop as a non-native host: loopback dev servers are allowed", async () => {
        const mod = await loadPreviewUrlModule();

        // The Tauri/Wry desktop WebView can load a loopback dev server, so `desktop` (Phase 5.5) is
        // non-native like `web` for the loopback policy — it must NOT be rejected.
        expect(mod?.resolveLocalServicePreviewLoadUrl({
            platform: "desktop",
            url: "http://127.0.0.1:5173/",
        })).toEqual({ ok: true, url: "http://127.0.0.1:5173/" });
    });

    it("rejects non-http preview urls", async () => {
        const mod = await loadPreviewUrlModule();

        expect(mod?.resolveLocalServicePreviewLoadUrl({
            platform: "web",
            url: "javascript:alert(1)",
        })).toEqual({ ok: false, reasonCode: "unsupported_scheme" });
    });
});
