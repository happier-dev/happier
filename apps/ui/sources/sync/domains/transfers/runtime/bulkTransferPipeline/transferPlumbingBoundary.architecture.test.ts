import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

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
            expect(source).not.toContain("from '@/sync/domains/files/transfers/chunkTransferClient'");
            expect(source).not.toContain("from '@/sync/domains/transfers/runtime/sessionFileTransferRpcCaller'");
            expect(source).not.toContain("from '@/sync/domains/transfers/runtime/mergeTransferChunks'");
        }
    });
});
