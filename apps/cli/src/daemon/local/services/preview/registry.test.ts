import { describe, expect, it } from "vitest";

type PreviewRegistryModule = typeof import("./registry");

async function loadPreviewRegistryModule(): Promise<PreviewRegistryModule | null> {
    return import("./registry").catch(() => null);
}

describe("daemon local service preview registry", () => {
    it("registers preview resources with preserved query and browser target", async () => {
        const mod = await loadPreviewRegistryModule();
        const registry = mod!.createLocalServicePreviewRegistry();

        const result = mod!.registerLocalServicePreview(registry, {
            previewId: "preview_123",
            sessionId: "session_123",
            machineId: "machine_123",
            owner: { kind: "agent", id: "agent_1" },
            target: { scheme: "http", host: "127.0.0.1", port: 5173 },
            initialPath: { pathname: "/dashboard", search: "?tab=preview" },
            display: {
                title: "Kitchen Sink",
                addressLabel: "localhost:5173",
                folderLabel: "happier",
            },
            originMode: "host",
        });

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.resource.initialPath.search).toBe("?tab=preview");
            expect(result.resource.browserTarget).toEqual({
                kind: "localServicePreview",
                targetId: "preview_123",
                sessionId: "session_123",
                machineId: "machine_123",
                display: {
                    title: "Kitchen Sink",
                    addressLabel: "localhost:5173",
                    folderLabel: "happier",
                },
            });
        }
    });

    it("rejects non-loopback preview targets", async () => {
        const mod = await loadPreviewRegistryModule();
        const registry = mod!.createLocalServicePreviewRegistry();

        const result = mod!.registerLocalServicePreview(registry, {
            previewId: "preview_123",
            sessionId: "session_123",
            machineId: "machine_123",
            owner: { kind: "agent", id: "agent_1" },
            target: { scheme: "http", host: "192.168.1.10", port: 5173 },
            initialPath: { pathname: "/", search: "" },
            display: { title: "Kitchen Sink", addressLabel: "192.168.1.10:5173" },
            originMode: "host",
        });

        expect(result).toEqual({ ok: false, reasonCode: "non_loopback_target" });
    });

    it("unregisters resources without clearing unrelated previews", async () => {
        const mod = await loadPreviewRegistryModule();
        const registry = mod!.createLocalServicePreviewRegistry();

        for (const previewId of ["preview_1", "preview_2"]) {
            mod!.registerLocalServicePreview(registry, {
                previewId,
                sessionId: "session_123",
                machineId: "machine_123",
                owner: { kind: "agent", id: "agent_1" },
                target: { scheme: "http", host: "127.0.0.1", port: 5173 },
                initialPath: { pathname: "/", search: "" },
                display: { title: previewId, addressLabel: "localhost:5173" },
                originMode: "host",
            });
        }

        expect(mod!.unregisterLocalServicePreview(registry, "preview_1")).toEqual({ ok: true });
        expect(mod!.listLocalServicePreviewResources(registry).map((resource) => resource.previewId)).toEqual(["preview_2"]);
    });
});
