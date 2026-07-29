import { describe, expect, it } from "vitest";

import type { LocalServicePreviewResourceV1 } from "@happier-dev/protocol";

type OwnerModule = typeof import("./previewAccessUrlOwner");

async function loadOwnerModule(): Promise<OwnerModule | null> {
    return import("./previewAccessUrlOwner").catch(() => null);
}

function createResource(
    overrides: Partial<LocalServicePreviewResourceV1> = {},
): LocalServicePreviewResourceV1 {
    return {
        previewId: "preview_1",
        sessionId: "session_1",
        machineId: "machine_1",
        owner: { kind: "session", id: "session_1" },
        target: { scheme: "http", host: "127.0.0.1", port: 5173 },
        initialPath: { pathname: "/dashboard", search: "?tab=preview" },
        display: { title: "Dashboard", addressLabel: "localhost:5173" },
        originMode: "host",
        browserTarget: {
            kind: "localServicePreview",
            targetId: "preview_1",
            sessionId: "session_1",
            machineId: "machine_1",
        },
        ...overrides,
    };
}

describe("private preview access url owner", () => {
    it("mints a stable loopback url for an owned dev server", async () => {
        const mod = await loadOwnerModule();
        const resource = createResource();

        const first = mod!.mintPrivatePreviewAccessUrl(resource);
        const second = mod!.mintPrivatePreviewAccessUrl(resource);

        expect(first).toBe("http://127.0.0.1:5173/dashboard?tab=preview");
        // Stable: identical resource mints an identical URL.
        expect(second).toBe(first);
    });

    it("brackets the ipv6 loopback host so the embed origin is well-formed", async () => {
        const mod = await loadOwnerModule();
        const resource = createResource({
            target: { scheme: "http", host: "::1", port: 4000 },
            initialPath: { pathname: "/", search: "" },
        });

        expect(mod!.mintPrivatePreviewAccessUrl(resource)).toBe("http://[::1]:4000/");
    });

    it("projects a snapshot row carrying the minted access url and no diagnostics", async () => {
        const mod = await loadOwnerModule();
        const resource = createResource();

        const row = mod!.projectLocalServicePreviewSnapshotRow(resource);

        expect(row.previewId).toBe("preview_1");
        expect(row.resource).toBe(resource);
        expect(row.accessUrl).toBe("http://127.0.0.1:5173/dashboard?tab=preview");
        expect(row.expiresAt).toBeNull();
        expect(row.diagnostics).toEqual([]);
    });

    it("reports an unavailable private preview without a usable origin instead of crashing", async () => {
        const mod = await loadOwnerModule();
        // A malformed/corrupted target authority that cannot form a valid http(s) URL.
        const resource = createResource({
            target: { scheme: "http", host: "bad host", port: 5173 },
        });

        const row = mod!.projectLocalServicePreviewSnapshotRow(resource);

        expect(row.accessUrl).toBeNull();
        expect(row.diagnostics).toHaveLength(1);
        expect(row.diagnostics[0]).toMatchObject({
            code: "host_origin_unavailable",
            scope: "privatePreview",
            previewId: "preview_1",
        });
    });

    it("projects rows for every registered resource (absent when no server is registered)", async () => {
        const mod = await loadOwnerModule();

        expect(mod!.projectLocalServicePreviewSnapshotRows([])).toEqual([]);

        const rows = mod!.projectLocalServicePreviewSnapshotRows([
            createResource({ previewId: "preview_a" }),
            createResource({ previewId: "preview_b", target: { scheme: "https", host: "localhost", port: 8443 } }),
        ]);

        expect(rows.map((row) => row.previewId)).toEqual(["preview_a", "preview_b"]);
        expect(rows[1]?.accessUrl).toBe("https://localhost:8443/dashboard?tab=preview");
    });
});
