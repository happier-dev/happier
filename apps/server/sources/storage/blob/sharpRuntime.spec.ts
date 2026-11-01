import { afterEach, describe, expect, it } from "vitest";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileBunBinary, resolveBunCommand, resolveCurrentBinaryTarget, resolveSharpRuntimeSidecarEntries, SERVER_BINARY_TARGETS } from "@happier-dev/cli-common/componentArtifacts";

const tempDirs: string[] = [];
const bunCommand = resolveBunCommand() ?? "";

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

describe("sharpRuntime", () => {
    it.skipIf(!bunCommand)("defers an absent optional Sharp addon until its runtime branch is selected", async () => {
        const root = await mkdtemp(join(tmpdir(), "happier-sharp-optional-addon-"));
        tempDirs.push(root);
        const optionalPackageDir = join(root, "node_modules", "@img", "sharp-wasm32");
        await mkdir(optionalPackageDir, { recursive: true });
        // Matches the optional WASM package exposed by CI's --ignore-platform install.
        await writeFile(join(optionalPackageDir, "index.cjs"), "module.exports = require('./lib/sharp-wasm32-0.35.5.node');\n");
        const entrypoint = join(root, "entrypoint.ts");
        await writeFile(entrypoint, "if (process.env.SELECT_OPTIONAL_ADDON) require('./node_modules/@img/sharp-wasm32/index.cjs');\nelse process.stdout.write('optional-not-selected');\n");
        const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
        const target = resolveCurrentBinaryTarget({ availableTargets: SERVER_BINARY_TARGETS });
        const executablePath = join(root, `optional-probe${target.exeExt}`);

        await compileBunBinary({
            entrypoint,
            bunTarget: target.bunTarget,
            outfile: executablePath,
            bunCommand,
            buildRunnerEntrypoint: join(repoRoot, "packages/cli-common/scripts/buildBunBinary.mjs"),
        });

        const ignored = spawnSync(executablePath, [], { cwd: root, encoding: "utf8", env: { PATH: "" } });
        expect(ignored.status, ignored.stderr).toBe(0);
        expect(ignored.stdout).toBe("optional-not-selected");
        const selected = spawnSync(executablePath, [], { cwd: root, encoding: "utf8", env: { PATH: "", SELECT_OPTIONAL_ADDON: "1" } });
        expect(selected.status).not.toBe(0);
        expect(selected.stderr).toContain("sharp-wasm32-0.35.5.node");
    });

    it.skipIf(!bunCommand)("does not embed libvips libraries named by Sharp's platform resolution hint", async () => {
        const root = await mkdtemp(join(tmpdir(), "happier-sharp-libvips-hint-"));
        tempDirs.push(root);
        const libvipsMarker = "happier-libvips-embedding-probe-7f3c9a";
        const libvipsPackageDir = join(root, "node_modules", "@img", "sharp-libvips-linux-x64");
        await mkdir(join(libvipsPackageDir, "lib"), { recursive: true });
        await writeFile(join(libvipsPackageDir, "package.json"), JSON.stringify({
            name: "@img/sharp-libvips-linux-x64",
            exports: { "./binary": "./lib/libvips-cpp.so.8.18.7" },
        }));
        await writeFile(join(libvipsPackageDir, "lib", "libvips-cpp.so.8.18.7"), libvipsMarker);
        const shimDir = join(root, "node_modules", "@img", "sharp-linux-x64");
        await mkdir(shimDir, { recursive: true });
        // Mirrors Sharp 0.35's platform shim; the libvips library ships as a sidecar instead.
        await writeFile(join(shimDir, "index.cjs"), "try { require.resolve('@img/sharp-libvips-linux-x64/binary'); } catch {}\nmodule.exports = 'shim-loaded';\n");
        const entrypoint = join(root, "entrypoint.ts");
        await writeFile(entrypoint, "process.stdout.write(require('./node_modules/@img/sharp-linux-x64/index.cjs'));\n");
        const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
        const target = resolveCurrentBinaryTarget({ availableTargets: SERVER_BINARY_TARGETS });
        const executablePath = join(root, `libvips-hint-probe${target.exeExt}`);

        await compileBunBinary({
            entrypoint,
            bunTarget: target.bunTarget,
            outfile: executablePath,
            bunCommand,
            buildRunnerEntrypoint: join(repoRoot, "packages/cli-common/scripts/buildBunBinary.mjs"),
        });

        expect((await readFile(executablePath)).includes(libvipsMarker)).toBe(false);
        const launched = spawnSync(executablePath, [], { cwd: root, encoding: "utf8", env: { PATH: "" } });
        expect(launched.status, launched.stderr).toBe(0);
        expect(launched.stdout).toBe("shim-loaded");
    });

    it.skipIf(!bunCommand).each(["server", "cli"] as const)("loads packaged Sharp native sidecars for %s in a standalone Bun executable", async (role) => {
        const root = await mkdtemp(join(tmpdir(), "happier-sharp-compiled-"));
        tempDirs.push(root);
        const entrypoint = join(root, "entrypoint.ts");
        const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
        const builder = join(repoRoot, "packages/cli-common/scripts/buildBunBinary.mjs");
        const target = resolveCurrentBinaryTarget({ availableTargets: SERVER_BINARY_TARGETS });
        const executablePath = join(root, `happier-sharp-probe${target.exeExt}`);
        const unrelatedWorkingDirectory = join(root, "unrelated-cwd");
        const sharpRuntimePath = join(dirname(fileURLToPath(import.meta.url)), "sharpRuntime.ts");
        let program: string[];
        if (role === "server") {
            program = [
                `import { loadSharp } from ${JSON.stringify(sharpRuntimePath)};`,
                "const sharp = loadSharp();",
                "const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#ff0000' } }).png().toBuffer();",
                "process.stdout.write(`sharp-ok:${png.byteLength}`);",
            ];
        } else {
            const { loadSharp } = await import("./sharpRuntime");
            const png = await loadSharp()({ create: { width: 1, height: 1, channels: 4, background: '#ff0000' } }).png().toBuffer();
            program = [
                `import { defaultPetImageInfoDecoder } from ${JSON.stringify(join(repoRoot, "apps/cli/src/pets/validation/validatePetAtlas.ts"))};`,
                "if (process.env.HAPPIER_SHARP_AMBIENT_TRAP) throw new Error('Project dotenv was loaded');",
                `const info = await defaultPetImageInfoDecoder({ bytes: Buffer.from(${JSON.stringify(png.toString("base64"))}, 'base64'), filename: 'probe.png', strict: true });`,
                "if (info?.contentInspected !== true || info.width !== 1) throw new Error('Sharp content inspection did not run');",
                "process.stdout.write(`sharp-ok:${info.width}`);",
            ];
        }
        await writeFile(entrypoint, program.join("\n"), "utf8");
        await compileBunBinary({
            entrypoint,
            bunTarget: target.bunTarget,
            outfile: executablePath,
            bunCommand,
            buildRunnerEntrypoint: builder,
            ...(role === "cli" ? { autoloadDotenv: false } : {}),
        });

        for (const entry of await resolveSharpRuntimeSidecarEntries({ resolveFromPackageJsonPath: join(repoRoot, 'apps', role, 'package.json'), target })) {
            const targetDir = join(root, entry.targetPath);
            await mkdir(dirname(targetDir), { recursive: true });
            await cp(entry.sourcePath, targetDir, { recursive: true });
        }
        await mkdir(unrelatedWorkingDirectory);
        await writeFile(join(unrelatedWorkingDirectory, "package.json"), JSON.stringify({ name: "untrusted-cwd", type: "module" }));
        if (role === "cli") await writeFile(join(unrelatedWorkingDirectory, ".env"), "HAPPIER_SHARP_AMBIENT_TRAP=1\n");
        await writeFile(join(unrelatedWorkingDirectory, "bunfig.toml"), 'preload = ["./preload.cjs"]\n');
        await writeFile(join(unrelatedWorkingDirectory, "preload.cjs"), "throw new Error('Project bunfig preload was executed');\n");
        const platform = target.os === "windows" ? "win32" : target.os;
        for (const packageName of ["sharp", `@img/sharp-${platform}-${target.arch}`]) {
            const packageDir = join(unrelatedWorkingDirectory, "node_modules", ...packageName.split("/"));
            await mkdir(packageDir, { recursive: true });
            await writeFile(join(packageDir, "package.json"), JSON.stringify({
                name: packageName,
                exports: packageName === "sharp" ? { ".": "./index.cjs" } : { "./sharp.node": "./index.cjs" },
            }));
            await writeFile(join(packageDir, "index.cjs"), "throw new Error('Untrusted working-directory Sharp was loaded');\n");
        }

        const launched = spawnSync(executablePath, [], {
            cwd: unrelatedWorkingDirectory,
            encoding: "utf8",
            env: { PATH: "" },
        });
        expect(launched.status, launched.stderr).toBe(0);
        expect(launched.stdout).toMatch(/^sharp-ok:\d+$/);
    }, 20_000);
});
