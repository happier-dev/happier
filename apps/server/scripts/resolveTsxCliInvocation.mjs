import { existsSync as defaultExistsSync } from "node:fs";
import { resolve } from "node:path";

export function resolveTsxCliInvocation(params) {
    const processExecPath = params.processExecPath ?? process.execPath;
    const existsSync = params.existsSync ?? defaultExistsSync;
    const platform = params.platform ?? process.platform;
    // This launcher executes server source; built entrypoints keep default exports.
    const sourceArgs = ["--conditions=happier-source"];
    const directCliCandidates = [
        resolve(params.repoRoot, "node_modules", "tsx", "dist", "cli.cjs"),
        resolve(params.repoRoot, "apps", "server", "node_modules", "tsx", "dist", "cli.cjs"),
    ];
    for (const candidate of directCliCandidates) {
        if (existsSync(candidate)) {
            return {
                command: processExecPath,
                argsPrefix: [candidate, ...sourceArgs],
            };
        }
    }

    const binName = platform === "win32" ? "tsx.cmd" : "tsx";
    const fallbackCandidates = [
        resolve(params.repoRoot, "node_modules", ".bin", binName),
        resolve(params.repoRoot, "apps", "server", "node_modules", ".bin", binName),
    ];
    for (const candidate of fallbackCandidates) {
        if (existsSync(candidate)) {
            return { command: candidate, argsPrefix: sourceArgs };
        }
    }
    return { command: fallbackCandidates[0], argsPrefix: sourceArgs };
}
