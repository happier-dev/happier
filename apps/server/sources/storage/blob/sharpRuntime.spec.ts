import { createRequire } from "node:module";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadSharp, resolveSharpPackageJsonCandidates } from "./sharpRuntime";

describe("sharpRuntime", () => {
    it("prefers the sharp package beside the runtime working directory and executable", () => {
        const root = "/opt/happier-server/current";

        expect(resolveSharpPackageJsonCandidates({
            cwd: root,
            executablePath: join(root, "happier-server"),
            execPath: "/usr/local/bin/bun",
        })).toEqual([
            join(root, "node_modules", "sharp", "package.json"),
            join("/usr/local/bin", "node_modules", "sharp", "package.json"),
        ]);
    });

    it("loads sharp from an explicit package.json require base", async () => {
        const requireFromTest = createRequire(import.meta.url);
        const sharpPackageJsonPath = requireFromTest.resolve("sharp/package.json");
        const sharp = loadSharp({ candidatePackageJsonPaths: [sharpPackageJsonPath] });
        const png = await sharp({
            create: {
                width: 1,
                height: 1,
                channels: 4,
                background: { r: 255, g: 0, b: 0, alpha: 1 },
            },
        }).png().toBuffer();

        expect(png.byteLength).toBeGreaterThan(0);
    });
});
