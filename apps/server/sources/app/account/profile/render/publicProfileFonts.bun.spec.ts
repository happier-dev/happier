import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { stagePublicProfileAssets } from "../../../../../scripts/buildPublicProfileRenderer.mjs";
import { PUBLIC_PROFILE_FONT_FILES } from "./publicProfileFonts";

function resolveBunExecutable(): string | null {
    const explicit = String(process.env.HAPPIER_TEST_BUN_EXECUTABLE ?? "").trim();
    if (explicit) return explicit;
    const result = spawnSync(process.platform === "win32" ? "where" : "which", ["bun"], { encoding: "utf8" });
    if (result.status !== 0) return null;
    return String(result.stdout ?? "").split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? null;
}

const bunExecutable = resolveBunExecutable();
const runtimeIt = bunExecutable ? it : it.skip;

describe("public profile fonts in a Bun-compiled server executable", () => {
    // A compiled executable's import.meta.url is Bun's virtual /$bunfs root, so module-relative
    // and source-tree font paths do not exist there. The payload stages the faces beside the
    // executable, through the same staging owner as the esbuild runtime.
    runtimeIt("reads every shipped face from the assets staged beside the executable", async () => {
        const tempDir = await mkdtemp(join(tmpdir(), "happier-public-profile-fonts-bun-"));
        try {
            const ownerPath = fileURLToPath(new URL("./publicProfileFonts.ts", import.meta.url));
            const probePath = join(tempDir, "probe.ts");
            await writeFile(probePath, [
                `import { PUBLIC_PROFILE_FONT_FILES, readPublicProfileFont } from ${JSON.stringify(ownerPath)};`,
                "const read: string[] = [];",
                "for (const face of Object.keys(PUBLIC_PROFILE_FONT_FILES) as (keyof typeof PUBLIC_PROFILE_FONT_FILES)[]) {",
                "  try { if ((await readPublicProfileFont(face)).bytes.length > 0) read.push(face); } catch {}",
                "}",
                "console.log(JSON.stringify({ read }));",
            ].join("\n"), "utf8");
            const executable = join(tempDir, process.platform === "win32" ? "probe.exe" : "probe");
            await promisify(execFile)(bunExecutable!, ["build", "--compile", probePath, "--outfile", executable], { cwd: tempDir });
            await stagePublicProfileAssets({ outDir: tempDir });
            const { stdout } = await promisify(execFile)(executable, [], { cwd: tmpdir() });
            const result = JSON.parse(stdout.trim().split(/\r?\n/u).at(-1) ?? "{}") as { read?: string[] };
            expect(result.read?.length).toBe(Object.keys(PUBLIC_PROFILE_FONT_FILES).length);
        } finally {
            await rm(tempDir, { recursive: true, force: true });
        }
    }, 120_000);
});
