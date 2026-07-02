import type { LocalServicePreviewResourceV1 } from "@happier-dev/protocol";
import { describe, expect, it } from "vitest";

type PreviewRuntimeModule = typeof import("./runtime");

async function loadPreviewRuntimeModule(): Promise<PreviewRuntimeModule | null> {
    return import("./runtime.js").catch(() => null) as Promise<PreviewRuntimeModule | null>;
}

const resource: LocalServicePreviewResourceV1 = {
    previewId: "preview_1",
    sessionId: "session_1",
    machineId: "machine_1",
    owner: { kind: "session", id: "session_1" },
    target: { scheme: "http", host: "127.0.0.1", port: 5173 },
    initialPath: { pathname: "/dashboard", search: "?tab=preview" },
    display: {
        title: "Vite App",
        addressLabel: "127.0.0.1:5173",
    },
    originMode: "path",
    policy: {
        allowedMethods: ["GET", "HEAD"],
        cookiePolicy: "drop",
        compressionPolicy: "identity",
        redirectPolicy: "rewrite_path_mode",
        maxRequestBodyBytes: 1024 * 1024,
        maxResponseBodyBytes: 1024 * 1024,
    },
};

describe("local service preview runtime", () => {
    it("registers a preview resource, issues a scoped token, and resolves a load URL", async () => {
        const mod = await loadPreviewRuntimeModule();
        expect(mod?.createLocalServicePreviewRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePreviewRuntime) return;

        const runtime = mod.createLocalServicePreviewRuntime({
            tokenSecret: "secret",
            publicBaseUrl: "https://app.happier.test",
            hostOriginBaseDomain: null,
            nowMs: () => 1_000,
            generateTokenId: () => "token_id_1",
            generateRawToken: () => "raw_token_1",
            tokenTtlMs: 60_000,
        });

        const registered = runtime.registerPreview({
            resource,
            accountId: "account_1",
        });
        expect(registered).toEqual({
            ok: true,
            resource,
            accessUrl: "https://app.happier.test/v1/local-services/preview/preview_1/dashboard?tab=preview&previewToken=raw_token_1",
            expiresAt: 61_000,
        });
        expect(runtime.resolvePreview("preview_1")).toEqual(resource);
        expect(runtime.resolvePreviewContext("preview_1")).toEqual({
            resource,
            accountId: "account_1",
        });
        expect(runtime.validateAccess({
            previewId: "preview_1",
            rawToken: "raw_token_1",
            sessionId: "session_1",
            machineId: "machine_1",
        })).toEqual({ ok: true });
    });

    it("fails closed when token configuration is incomplete", async () => {
        const mod = await loadPreviewRuntimeModule();
        expect(mod?.createLocalServicePreviewRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePreviewRuntime) return;

        const runtime = mod.createLocalServicePreviewRuntime({
            tokenSecret: "",
            publicBaseUrl: "https://app.happier.test",
            hostOriginBaseDomain: null,
            nowMs: () => 1_000,
        });

        expect(runtime.registerPreview({
            resource,
            accountId: "account_1",
        })).toEqual({
            ok: false,
            reasonCode: "preview_token_secret_missing",
        });
    });

    it("revokes token access when a preview is unregistered", async () => {
        const mod = await loadPreviewRuntimeModule();
        expect(mod?.createLocalServicePreviewRuntime).toBeTypeOf("function");
        if (!mod?.createLocalServicePreviewRuntime) return;

        let now = 1_000;
        const runtime = mod.createLocalServicePreviewRuntime({
            tokenSecret: "secret",
            publicBaseUrl: "https://app.happier.test",
            hostOriginBaseDomain: null,
            nowMs: () => now,
            generateTokenId: () => "token_id_1",
            generateRawToken: () => "raw_token_1",
            tokenTtlMs: 60_000,
        });

        expect(runtime.registerPreview({
            resource,
            accountId: "account_1",
        }).ok).toBe(true);
        now = 2_000;
        expect(runtime.unregisterPreview("preview_1")).toEqual({ ok: true });
        expect(runtime.resolvePreview("preview_1")).toBeNull();
        expect(runtime.resolvePreviewContext("preview_1")).toBeNull();
        expect(runtime.validateAccess({
            previewId: "preview_1",
            rawToken: "raw_token_1",
            sessionId: "session_1",
            machineId: "machine_1",
        })).toEqual({ ok: false, reasonCode: "preview_not_found" });
    });
});
