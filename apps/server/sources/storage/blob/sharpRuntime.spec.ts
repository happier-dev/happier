import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { resolveSharpModule } from "./sharpRuntime";

const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

describe("resolveSharpModule", () => {
    it("loads the staged sidecar package next to a compiled executable", async () => {
        const root = await mkdtemp(join(tmpdir(), "happier-sharp-runtime-"));
        tempDirs.push(root);
        const executablePath = join(root, "payload", "happier-server");
        const sharpPackageDir = join(dirname(executablePath), "node_modules", "sharp");
        await mkdir(sharpPackageDir, { recursive: true });
        await writeFile(
            join(sharpPackageDir, "package.json"),
            JSON.stringify({ name: "sharp", main: "index.cjs" }),
            "utf8",
        );
        await writeFile(
            join(sharpPackageDir, "index.cjs"),
            "module.exports = function stagedSharp() {};\n",
            "utf8",
        );

        const sharp = resolveSharpModule({
            moduleUrl: pathToFileURL(join(root, "bunfs", "root", "happier-server.js")).href,
            executablePath,
        });

        expect(sharp.name).toBe("stagedSharp");
    });
});
