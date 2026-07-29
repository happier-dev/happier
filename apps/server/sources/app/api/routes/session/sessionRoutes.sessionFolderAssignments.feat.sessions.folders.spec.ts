import { beforeEach, describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import {
    createSessionRouteTestBuilder,
    resetSessionRouteMocks,
} from "./sessionRoutes.testkit";

function listFilesRecursively(directory: string): string[] {
    if (!existsSync(directory)) {
        return [];
    }
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const childPath = resolve(directory, entry.name);
        return entry.isDirectory()
            ? listFilesRecursively(childPath)
            : [childPath];
    });
}

describe("legacy session folder assignment routes", () => {
    beforeEach(() => {
        resetSessionRouteMocks();
    });

    it("does not register the retired /v2/session-folder-assignments API", async () => {
        await expect(createSessionRouteTestBuilder("GET", "/v2/session-folder-assignments"))
            .resolves.toMatchObject({ routeExists: false });
        await expect(createSessionRouteTestBuilder("PUT", "/v2/session-folder-assignments/:sessionId"))
            .resolves.toMatchObject({ routeExists: false });
        await expect(createSessionRouteTestBuilder("POST", "/v2/session-folder-assignments/query"))
            .resolves.toMatchObject({ routeExists: false });
        await expect(createSessionRouteTestBuilder("POST", "/v2/session-folder-assignments/move"))
            .resolves.toMatchObject({ routeExists: false });
    });

    it("does not keep a legacy session folder assignment server owner", () => {
        const legacyOwnerFiles = listFilesRecursively(resolve(process.cwd(), "sources/app/session/folders"))
            .filter((filePath) => /\.[cm]?[tj]sx?$/.test(filePath));
        expect(legacyOwnerFiles).toEqual([]);
    });
});
