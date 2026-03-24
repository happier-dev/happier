import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

function assertDoesNotImportModule(source: string, moduleToken: string, filePath: string): void {
    const importFrom = new RegExp(String.raw`\\bfrom\\s+['"][^'"]*${moduleToken}[^'"]*['"]`, 'g');
    const dynamicImport = new RegExp(String.raw`\\bimport\\s*\\(\\s*['"][^'"]*${moduleToken}[^'"]*['"]\\s*\\)`, 'g');
    const requireCall = new RegExp(String.raw`\\brequire\\s*\\(\\s*['"][^'"]*${moduleToken}[^'"]*['"]\\s*\\)`, 'g');

    const hit = source.match(importFrom) ?? source.match(dynamicImport) ?? source.match(requireCall);
    if (hit && hit.length > 0) {
        throw new Error(`Forbidden import of "${moduleToken}" in ${filePath}: ${hit[0]}`);
    }
}

function assertDoesNotContainToken(source: string, token: string, filePath: string): void {
    if (source.includes(token)) {
        throw new Error(`Forbidden token "${token}" in ${filePath}`);
    }
}

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

describe('bulkTransferPipeline (architecture)', () => {
    it('keeps chunk transfer plumbing scoped to bulkTransferPipeline/**', async () => {
        const runtimeDirectory = new URL('../', import.meta.url);
        const runtimePath = runtimeDirectory.pathname;
        const files = (await listFilesRecursively(runtimePath)).filter((filePath) =>
            (filePath.endsWith('.ts') || filePath.endsWith('.tsx'))
            && !filePath.endsWith('.test.ts')
            && !filePath.endsWith('.spec.ts')
            && !filePath.endsWith('.test.tsx')
            && !filePath.endsWith('.spec.tsx'),
        );

        for (const filePath of files) {
            if (filePath.includes('/bulkTransferPipeline/')) {
                continue;
            }
            const source = await readFile(filePath, 'utf8');
            assertDoesNotImportModule(source, 'chunkTransferClient', filePath);
            assertDoesNotImportModule(source, 'sessionFileTransferRpcCaller', filePath);
            assertDoesNotImportModule(source, 'mergeTransferChunks', filePath);
            assertDoesNotContainToken(source, 'DAEMON_BULK_TRANSFER_', filePath);
        }
    });
});
