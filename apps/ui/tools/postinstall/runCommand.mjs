import { spawnSync as defaultSpawnSync } from 'node:child_process';
import process from 'node:process';

export function runCommandBestEffort(params) {
    const spawnSync = params.spawnSync ?? defaultSpawnSync;
    const args = Array.isArray(params.args) ? params.args : [];
    const options = params.options ?? {};

    const result = spawnSync(params.command, args, { stdio: 'inherit', ...options });
    const status = typeof result.status === 'number' ? result.status : (result.error ? 1 : 0);
    return { ok: status === 0, status };
}

export function runCommandOrExit(params) {
    const spawnSync = params.spawnSync ?? defaultSpawnSync;
    const args = Array.isArray(params.args) ? params.args : [];
    const options = params.options ?? {};

    const result = spawnSync(params.command, args, { stdio: 'inherit', ...options });
    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
    return { ok: true, status: 0 };
}
