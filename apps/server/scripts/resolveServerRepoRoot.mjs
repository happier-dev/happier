import { existsSync as defaultExistsSync } from "node:fs";
import { resolve } from "node:path";

export function resolveServerRepoRoot(params) {
    let dir = params.startDir;
    const existsSync = params.existsSync ?? defaultExistsSync;

    for (let i = 0; i < 10; i += 1) {
        if (existsSync(resolve(dir, "package.json")) && existsSync(resolve(dir, "yarn.lock"))) {
            return dir;
        }
        const parent = resolve(dir, "..");
        if (parent === dir) {
            break;
        }
        dir = parent;
    }

    return resolve(params.startDir, "..", "..", "..");
}
