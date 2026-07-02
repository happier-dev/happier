import { describe, expect, it } from "vitest";

type BrowserStoreModule = typeof import("./store");

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

describe("browser view store", () => {
    it("opens targets from suggestions", async () => {
        const mod = await loadBrowserStoreModule();
        const state = mod?.applyBrowserTargetSuggestions(mod.createBrowserViewState(), {
            suggestions: [suggestion],
            generation: 1,
        });

        const opened = mod?.openBrowserTarget(state!, previewTarget);

        expect(opened?.currentTarget).toEqual(previewTarget);
    });

    it("keeps current target and stale suggestions while refresh is in flight", async () => {
        const mod = await loadBrowserStoreModule();
        const state = mod?.openBrowserTarget(
            mod.applyBrowserTargetSuggestions(mod.createBrowserViewState(), {
                suggestions: [suggestion],
                generation: 1,
            }),
            previewTarget,
        );

        const refreshing = mod?.beginBrowserTargetSuggestionRefresh(state!);

        expect(refreshing?.refreshStatus).toBe("refreshing");
        expect(refreshing?.currentTarget).toEqual(previewTarget);
        expect(refreshing?.suggestions).toEqual([suggestion]);
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
