import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

function resolveBunExecutable(): string | null {
    const explicit = String(process.env.HAPPIER_TEST_BUN_EXECUTABLE ?? "").trim();
    if (explicit) return explicit;
    const result = spawnSync(process.platform === "win32" ? "where" : "which", ["bun"], { encoding: "utf8" });
    if (result.status !== 0) return null;
    return String(result.stdout ?? "").split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? null;
}

const bunExecutable = resolveBunExecutable();
const bunIt = bunExecutable ? it : it.skip;

describe("public share viewer residency in the single-file Bun server bundle", () => {
    // Bun's single-file bundle evaluates a same-bundle dynamic import's module scope eagerly,
    // so a top-level string literal is resident from startup, not from the first viewer request.
    bunIt("holds no viewer script on the heap until the first viewer demand", async () => {
        const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
        // Under the ignored package output tree, so runtime imports resolve like the real server's.
        await mkdir(join(serverDir, "dist"), { recursive: true });
        const tempDir = await mkdtemp(join(serverDir, "dist", "share-viewer-residency-"));
        try {
            const ownerPath = fileURLToPath(new URL("./registerPublicShareViewerRoutes.ts", import.meta.url));
            const probePath = join(tempDir, "probe.ts");
            const bundlePath = join(tempDir, "probe.js");
            const buildPath = join(tempDir, "build.ts");
            // The owner's own loader, bundled the way buildServerBunBinary bundles the server (one file, no splitting).
            await writeFile(probePath, [
                `import { heapStats } from "bun:jsc";`,
                `import { loadPublicShareViewerScript } from ${JSON.stringify(ownerPath)};`,
                `const heap = () => { Bun.gc(true); Bun.gc(true); return heapStats().heapSize; };`,
                `const beforeDemand = heap();`,
                `const script = await loadPublicShareViewerScript();`,
                `const afterDemand = heap();`,
                `console.log(JSON.stringify({ length: script.length, demandHeapGrowth: afterDemand - beforeDemand }));`,
            ].join("\n"), "utf8");
            await writeFile(buildPath, [
                `const result = await Bun.build({ entrypoints: [${JSON.stringify(probePath)}], target: "bun", conditions: ["happier-source"],`,
                `    tsconfig: ${JSON.stringify(join(serverDir, "tsconfig.json"))}, external: ["redis"] });`,
                `if (!result.success) { for (const log of result.logs) console.error(log); process.exit(1); }`,
                `await Bun.write(${JSON.stringify(bundlePath)}, result.outputs[0]);`,
            ].join("\n"), "utf8");
            const run = promisify(execFile);
            await run(bunExecutable!, [buildPath], { cwd: serverDir, maxBuffer: 64 * 1024 * 1024 });
            const { stdout } = await run(bunExecutable!, [bundlePath], { cwd: serverDir, maxBuffer: 64 * 1024 * 1024 });
            const result = JSON.parse(stdout.trim().split(/\r?\n/u).at(-1) ?? "{}") as { length?: number; demandHeapGrowth?: number };
            expect(result.length).toBeGreaterThan(1024 * 1024);
            // The script (one byte per character) arrives with the first demand, not before it.
            expect(result.demandHeapGrowth).toBeGreaterThan(result.length! * 0.9);
        } finally {
            await rm(tempDir, { recursive: true, force: true });
        }
    }, 300_000);
});
