import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol';

async function listFilesRecursively(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const results: string[] = [];
    for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            results.push(...(await listFilesRecursively(path)));
        } else {
            results.push(path);
        }
    }
    return results;
}

const GUARDED_FILE_SYSTEM_RPC_METHOD_TOKENS = [
    'RPC_METHODS.CREATE_DIRECTORY',
    'RPC_METHODS.LIST_DIRECTORY',
    'RPC_METHODS.GET_DIRECTORY_TREE',
    'RPC_METHODS.STAT_FILE',
    'RPC_METHODS.RENAME_PATH',
    'RPC_METHODS.DELETE_PATH',
    'RPC_METHODS.WRITE_FILE',
] as const;

const GUARDED_FILE_SYSTEM_RPC_METHOD_STRINGS = [
    RPC_METHODS.CREATE_DIRECTORY,
    RPC_METHODS.LIST_DIRECTORY,
    RPC_METHODS.GET_DIRECTORY_TREE,
    RPC_METHODS.STAT_FILE,
    RPC_METHODS.RENAME_PATH,
    RPC_METHODS.DELETE_PATH,
    RPC_METHODS.WRITE_FILE,
] as const;

function escapeRegexLiteral(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('sessionMachineRpcFallback (architecture)', () => {
    it('forbids calling guarded file-system RPC methods via apiSocket.machineRPC outside the choke point', async () => {
        const syncRoot = fileURLToPath(new URL('../', import.meta.url));
        const files = (await listFilesRecursively(syncRoot)).filter((filePath) =>
            (filePath.endsWith('.ts') || filePath.endsWith('.tsx'))
            && !filePath.endsWith('.test.ts')
            && !filePath.endsWith('.spec.ts')
            && !filePath.endsWith('.test.tsx')
            && !filePath.endsWith('.spec.tsx'),
        );

        for (const filePath of files) {
            if (filePath.endsWith('/sync/runtime/sessionMachineRpcFallback.ts')) {
                continue;
            }

            const source = await readFile(filePath, 'utf8');
            for (const token of GUARDED_FILE_SYSTEM_RPC_METHOD_TOKENS) {
                // Match direct calls like: `apiSocket.machineRPC(..., RPC_METHODS.STAT_FILE, ...)`
                // We do not flag files that merely reference `RPC_METHODS.*` for other routing helpers.
                const re = new RegExp(`\\bmachineRPC\\s*(?:<[^>]*>)?\\s*\\(\\s*[^,]+\\s*,\\s*${escapeRegexLiteral(token)}`);
                if (re.test(source)) {
                    throw new Error(`Forbidden machineRPC(${token}) usage outside sessionMachineRpcFallback: ${filePath}`);
                }
            }

            for (const method of GUARDED_FILE_SYSTEM_RPC_METHOD_STRINGS) {
                // Also forbid string literal bypasses like: `machineRPC(..., "daemon.statFile", ...)`.
                const re = new RegExp(
                    `\\bmachineRPC\\s*(?:<[^>]*>)?\\s*\\(\\s*[^,]+\\s*,\\s*['"\`]${escapeRegexLiteral(method)}['"\`]`,
                );
                if (re.test(source)) {
                    throw new Error(`Forbidden machineRPC("${method}") usage outside sessionMachineRpcFallback: ${filePath}`);
                }
            }
        }
    });
});
