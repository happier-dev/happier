import { afterEach, describe, expect, it } from "vitest";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const tempDirs: string[] = [];
const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

describe("sharpRuntime", () => {
    it.skipIf(!bunAvailable)("loads the packaged Sharp native sidecars in a standalone Bun executable", async () => {
        const root = await mkdtemp(join(tmpdir(), "happier-sharp-compiled-"));
        tempDirs.push(root);
        const entrypoint = join(root, "entrypoint.ts");
        const builder = join(
            dirname(fileURLToPath(import.meta.url)),
            "../../../../../packages/cli-common/scripts/buildServerBunBinary.mjs",
        );
        const executablePath = join(root, "happier-sharp-probe");
        const unrelatedWorkingDirectory = join(root, "unrelated-cwd");
        const sharpRuntimePath = join(dirname(fileURLToPath(import.meta.url)), "sharpRuntime.ts");
        const requireFromTest = createRequire(import.meta.url);
        await writeFile(
            entrypoint,
            [
                `import { loadSharp } from ${JSON.stringify(sharpRuntimePath)};`,
                "const sharp = await loadSharp();",
                "const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#ff0000' } }).png().toBuffer();",
                "process.stdout.write(`sharp-ok:${png.byteLength}`);",
            ].join("\n"),
            "utf8",
        );
        const compiled = spawnSync(
            "bun",
            [
                builder,
                `--target=bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`,
                `--entrypoint=${entrypoint}`,
                `--outfile=${executablePath}`,
            ],
            { encoding: "utf8" },
        );
        expect(compiled.status, compiled.stderr).toBe(0);

        const runtimePlatform = `${process.platform}-${process.arch}`;
        for (const packageName of [
            "sharp",
            "detect-libc",
            "semver",
            "@img/colour",
            `@img/sharp-${runtimePlatform}`,
            `@img/sharp-libvips-${runtimePlatform}`,
        ]) {
            const packageJsonPath = requireFromTest.resolve(`${packageName}/package`);
            const targetDir = join(root, "node_modules", ...packageName.split("/"));
            await mkdir(dirname(targetDir), { recursive: true });
            await cp(dirname(packageJsonPath), targetDir, { recursive: true });
        }
        await mkdir(unrelatedWorkingDirectory);

        const launched = spawnSync(executablePath, [], {
            cwd: unrelatedWorkingDirectory,
            encoding: "utf8",
            env: { PATH: process.env.PATH ?? "" },
        });
        expect(launched.status, launched.stderr).toBe(0);
        expect(launched.stdout).toMatch(/^sharp-ok:\d+$/);
    }, 20_000);

});
