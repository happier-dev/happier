import { basename } from 'node:path';

const DISALLOWED_PATH_ONLY_RUNTIME_NAMES = new Set([
    'node',
    'npm',
    'npx',
    'pnpm',
    'yarn',
    'bun',
    'bunx',
]);

const WINDOWS_RUNTIME_SHIM_EXTENSIONS = ['.exe', '.cmd', '.bat', '.ps1'] as const;

export function normalizePathOnlyRuntimeName(value: string): string {
    let normalized = basename(value).toLowerCase();
    for (const extension of WINDOWS_RUNTIME_SHIM_EXTENSIONS) {
        if (normalized.endsWith(extension)) {
            normalized = normalized.slice(0, -extension.length);
            break;
        }
    }
    return normalized;
}

export function isDeniedPathOnlyRuntimeName(value: string): boolean {
    return DISALLOWED_PATH_ONLY_RUNTIME_NAMES.has(normalizePathOnlyRuntimeName(value));
}
