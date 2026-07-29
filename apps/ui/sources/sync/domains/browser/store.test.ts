import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";
import type { BrowserTargetPolicyDecisionV1 } from "@happier-dev/protocol";
import type { DesktopWebViewNativeAvailability } from "./adapters/desktopWebView";

type BrowserStoreModule = typeof import("./store");

const UI_SOURCES_ROOT = join(__dirname, "..", "..", "..");

function walkSourceFiles(root: string): string[] {
    const results: string[] = [];
    for (const entry of readdirSync(root)) {
        const fullPath = join(root, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
            results.push(...walkSourceFiles(fullPath));
            continue;
        }
        if (!/\.(ts|tsx)$/.test(entry)) continue;
        if (/\.(test|spec)\.(ts|tsx)$/.test(entry)) continue;
        results.push(fullPath);
    }
    return results;
}

async function loadBrowserStoreModule(): Promise<BrowserStoreModule | null> {
    return import("./store").catch(() => null);
}

const previewTarget = {
    kind: "localServicePreview",
    targetId: "preview_123",
    sessionId: "session_123",
    machineId: "machine_123",
    display: {
        title: "Kitchen Sink",
        addressLabel: "localhost:5173",
        folderLabel: "happier",
    },
} as const;

const suggestion = {
    suggestionId: "suggestion_1",
    source: { kind: "localServiceInventory", serviceId: "service_1" },
    target: previewTarget,
    display: {
        title: "Kitchen Sink",
        addressLabel: "localhost:5173",
        folderLabel: "happier",
    },
    lastSeenAt: 1_000,
} as const;

const hostedPluginTarget = {
    kind: "hostedPluginWeb",
    targetId: "plugin_preview",
    pluginId: "acme.preview",
    contributionId: "preview-web",
    display: {
        title: "Plugin Preview",
        addressLabel: "plugin://acme.preview/preview-web",
    },
} as const;

const externalTarget = {
    kind: "externalUrl",
    targetId: "external_1",
    url: "https://example.com/",
    display: {
        title: "Example",
        addressLabel: "example.com",
    },
} as const;

const allowedExternalPolicy = {
    targetKind: "externalUrl",
    state: "allowed",
    profileId: "profile_browser_1",
    profileMode: "ephemeral",
    origin: "https://example.com",
    security: {
        url: "https://example.com/",
        origin: "https://example.com",
        securityLevel: "secure",
        reasonCodes: [],
    },
    permissions: {
        downloads: "deny",
        uploads: "deny",
        clipboard: "deny",
        camera: "deny",
        microphone: "deny",
        fileAccess: "deny",
        popups: "deny",
        browserUse: "prompt",
    },
    disabledReasons: [],
} satisfies BrowserTargetPolicyDecisionV1;

const availableDesktopWebView = {
    available: true,
    platform: "macos",
    primitive: "macosNsViewWebKit",
    renderEngine: "desktopWebView",
    producer: "tauriWryNativeChildView",
    privilegedIpc: false,
    supports: {
        navigation: true,
        goBackForward: false,
        reload: false,
        stop: false,
        pageInfoDiagnostics: true,
        nativeDevtools: true,
        capture: false,
        recording: false,
        automation: false,
    },
    disabledReasons: [],
} satisfies DesktopWebViewNativeAvailability;

describe("browser view store", () => {
    it("keeps browser view identity construction in the store owner", () => {
        const rawBrowserViewTemplate = new RegExp("browser_view:" + "\\$\\{");
        const allowedOwners = new Set(["sync/domains/browser/store.ts"]);
        const scannedRoots = [
            join(UI_SOURCES_ROOT, "components/browser"),
            join(UI_SOURCES_ROOT, "sync/domains/browser"),
        ];

        const violations = scannedRoots
            .flatMap((root) => walkSourceFiles(root))
            .map((fullPath) => ({
                relativePath: relative(UI_SOURCES_ROOT, fullPath).replaceAll("\\", "/"),
                contents: readFileSync(fullPath, "utf8"),
            }))
            .filter(({ relativePath }) => !allowedOwners.has(relativePath))
            .filter(({ contents }) => rawBrowserViewTemplate.test(contents))
            .map(({ relativePath }) => relativePath)
            .sort();

        expect(violations).toEqual([]);
    });

    it("opens targets from suggestions", async () => {
        const mod = await loadBrowserStoreModule();
        const state = mod?.applyBrowserTargetSuggestions(mod.createBrowserViewState(), {
            suggestions: [suggestion],
            generation: 1,
        });

        const opened = mod?.openBrowserTarget(state!, previewTarget, { platform: "web" });

        expect(opened?.currentTarget).toEqual(previewTarget);
        expect(opened?.viewsById[`browser_view:${previewTarget.targetId}`]?.target).toEqual(previewTarget);
        expect(opened?.viewsById[`browser_view:${previewTarget.targetId}`]?.browserSessionId)
            .toBe('browser_session_default');
    });

    it("keeps current target and stale suggestions while refresh is in flight", async () => {
        const mod = await loadBrowserStoreModule();
        const state = mod?.openBrowserTarget(
            mod.applyBrowserTargetSuggestions(mod.createBrowserViewState(), {
                suggestions: [suggestion],
                generation: 1,
            }),
            previewTarget,
            { platform: "web" },
        );

        const refreshing = mod?.beginBrowserTargetSuggestionRefresh(state!);

        expect(refreshing?.refreshStatus).toBe("refreshing");
        expect(refreshing?.currentTarget).toEqual(previewTarget);
        expect(refreshing?.suggestions).toEqual([suggestion]);
    });

    it("opens targets with the caller platform and resolved current URL", async () => {
        const mod = await loadBrowserStoreModule();

        const opened = mod?.openBrowserTarget(
            mod.createBrowserViewState(),
            hostedPluginTarget,
            {
                platform: "ios",
                currentUrl: "https://preview.happier.test/plugin/acme/",
                currentUrlExpiresAt: 1_700_000_000_000,
            },
        );

        const view = opened?.viewsById[`browser_view:${hostedPluginTarget.targetId}`];
        expect(view).toMatchObject({
            platform: "ios",
            adapterKind: "hostedPlugin",
            engineKind: "nativeWebView",
            currentUrl: "https://preview.happier.test/plugin/acme/",
            currentUrlExpiresAt: 1_700_000_000_000,
        });
    });

    it("opens targets under the caller browser session id", async () => {
        const mod = await loadBrowserStoreModule();

        const opened = mod?.openBrowserTarget(
            mod.createBrowserViewState(),
            previewTarget,
            {
                browserSessionId: "browser_session_custom",
                platform: "web",
            },
        );

        expect(opened?.viewsById[`browser_view:${previewTarget.targetId}`]?.browserSessionId).toBe("browser_session_custom");
        expect(opened?.currentTarget).toEqual(previewTarget);
    });

    it("opens allowed external URL targets through desktop WebView when the native producer is available", async () => {
        const mod = await loadBrowserStoreModule();

        const opened = mod?.openBrowserTarget(
            mod.createBrowserViewState(),
            externalTarget,
            {
                browserSessionId: "browser_session_external",
                platform: "desktop",
                targetPolicyDecision: allowedExternalPolicy,
                desktopWebViewAvailability: availableDesktopWebView,
            },
        );

        const view = opened?.viewsById[`browser_view:${externalTarget.targetId}`];
        expect(view).toMatchObject({
            browserSessionId: "browser_session_external",
            adapterKind: "externalUrl",
            engineKind: "desktopWebView",
            currentUrl: "https://example.com/",
            securityOrigin: null,
            adapterCapabilities: {
                supportedTargetKinds: ["externalUrl"],
                supportedRenderEngines: ["desktopWebView"],
                inputRouting: "native",
                disabledReasons: [],
            },
        });
        expect(opened?.currentTarget).toEqual(externalTarget);
    });

    it("resolves the canonical view id for a target matching the opened record key", async () => {
        const mod = await loadBrowserStoreModule();

        const viewId = mod?.resolveBrowserViewIdForTarget(previewTarget);
        expect(viewId).toBe(`browser_view:${previewTarget.targetId}`);

        const opened = mod?.openBrowserTarget(mod.createBrowserViewState(), previewTarget, { platform: "web" });
        expect(opened?.viewsById[viewId!]).toBeDefined();
    });

    it("opens a target under an explicit caller-owned view id", async () => {
        const mod = await loadBrowserStoreModule();

        const opened = mod?.openBrowserTarget(
            mod.createBrowserViewState(),
            externalTarget,
            {
                browserSessionId: "browser_session_existing",
                viewId: "browser_view:existing_preview",
                platform: "web",
                targetPolicyDecision: allowedExternalPolicy,
            },
        );

        expect(opened?.viewsById["browser_view:existing_preview"]).toMatchObject({
            browserSessionId: "browser_session_existing",
            target: externalTarget,
            currentUrl: "https://example.com/",
        });
        expect(opened?.viewsById[`browser_view:${externalTarget.targetId}`]).toBeUndefined();
    });

    it("keeps stale suggestions on refresh failure", async () => {
        const mod = await loadBrowserStoreModule();
        const state = mod?.applyBrowserTargetSuggestions(mod.createBrowserViewState(), {
            suggestions: [suggestion],
            generation: 1,
        });

        const failed = mod?.failBrowserTargetSuggestionRefresh(state!, "network");

        expect(failed?.refreshStatus).toBe("error");
        expect(failed?.refreshError).toBe("network");
        expect(failed?.suggestions).toEqual([suggestion]);
    });
});
