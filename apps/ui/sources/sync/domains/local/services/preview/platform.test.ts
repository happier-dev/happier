import { afterEach, describe, expect, it } from "vitest";

import { resolveLocalServicePreviewPlatform } from "./platform";

const TAURI_INTERNALS_KEY = "__TAURI_INTERNALS__";

function setTauriHost(): void {
    (globalThis as Record<string, unknown>)[TAURI_INTERNALS_KEY] = { invoke: () => undefined };
}

function clearTauriHost(): void {
    delete (globalThis as Record<string, unknown>)[TAURI_INTERNALS_KEY];
}

describe("resolveLocalServicePreviewPlatform", () => {
    afterEach(() => {
        clearTauriHost();
    });

    it("returns a genuine explicit override unchanged", () => {
        expect(resolveLocalServicePreviewPlatform("ios")).toBe("ios");
        expect(resolveLocalServicePreviewPlatform("android")).toBe("android");
        expect(resolveLocalServicePreviewPlatform("desktop")).toBe("desktop");
        expect(resolveLocalServicePreviewPlatform("web")).toBe("web");
    });

    it("resolves desktop inside Tauri even though the web bundle reports Platform.OS === 'web' (finding #13)", () => {
        setTauriHost();
        expect(resolveLocalServicePreviewPlatform()).toBe("desktop");
        expect(resolveLocalServicePreviewPlatform(null)).toBe("desktop");
    });

    it("falls back to web outside Tauri with no override (a plain browser tab)", () => {
        clearTauriHost();
        expect(resolveLocalServicePreviewPlatform()).toBe("web");
        expect(resolveLocalServicePreviewPlatform(null)).toBe("web");
    });
});
