import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import type sharpFactory from "sharp";

type SharpFactory = typeof sharpFactory;

const moduleRequire = createRequire(import.meta.url);
let cachedSharp: SharpFactory | null = null;

function unique(values: string[]): string[] {
    return [...new Set(values.filter((value) => value.trim()))];
}

export function resolveSharpPackageJsonCandidates({
    cwd = process.cwd(),
    executablePath = process.argv[1] ?? process.execPath,
    execPath = process.execPath,
}: Readonly<{
    cwd?: string;
    executablePath?: string;
    execPath?: string;
}> = {}): string[] {
    const executableDir = executablePath ? dirname(executablePath) : "";
    const execDir = execPath ? dirname(execPath) : "";
    return unique([
        join(cwd, "node_modules", "sharp", "package.json"),
        executableDir ? join(executableDir, "node_modules", "sharp", "package.json") : "",
        execDir ? join(execDir, "node_modules", "sharp", "package.json") : "",
    ]);
}

export function loadSharp({
    candidatePackageJsonPaths = resolveSharpPackageJsonCandidates(),
}: Readonly<{
    candidatePackageJsonPaths?: string[];
}> = {}): SharpFactory {
    if (cachedSharp) return cachedSharp;

    for (const packageJsonPath of candidatePackageJsonPaths) {
        if (!existsSync(packageJsonPath)) continue;
        cachedSharp = createRequire(packageJsonPath)("sharp") as SharpFactory;
        return cachedSharp;
    }

    cachedSharp = moduleRequire("sharp") as SharpFactory;
    return cachedSharp;
}
