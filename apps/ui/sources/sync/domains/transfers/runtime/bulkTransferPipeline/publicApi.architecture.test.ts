import { access } from 'node:fs/promises';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as bulkTransferPipeline from './index';

async function listFilesRecursively(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const results: string[] = [];
    for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            results.push(...(await listFilesRecursively(path)));
            continue;
        }
        results.push(path);
    }
    return results;
}

describe('bulkTransferPipeline (public API)', () => {
    it('keeps the bulkTransferPipeline barrel as an empty compatibility marker', () => {
        expect(Object.keys(bulkTransferPipeline).sort()).toEqual([]);
    });

    it('does not retain the deleted workspace compatibility module', async () => {
        await expect(access(new URL('./daemonWorkspaceFiles.ts', import.meta.url))).rejects.toBeTruthy();
    });

    it('does not retain the moved scoped-route policy helper under bulkTransferPipeline', async () => {
        await expect(access(new URL('./resolvePreferScopedForBulkMachineTransfer.ts', import.meta.url))).rejects.toBeTruthy();
    });

    it('does not allow product code to import the bulkTransferPipeline barrel directly', async () => {
        const sourcesPath = fileURLToPath(new URL('../../../../../', import.meta.url));
        const files = (await listFilesRecursively(sourcesPath)).filter((filePath) =>
            (filePath.endsWith('.ts') || filePath.endsWith('.tsx'))
            && !filePath.endsWith('.test.ts')
            && !filePath.endsWith('.spec.ts')
            && !filePath.endsWith('.test.tsx')
            && !filePath.endsWith('.spec.tsx'),
        );

        for (const filePath of files) {
            if (filePath.endsWith('/sync/domains/transfers/runtime/bulkTransferPipeline/index.ts')) {
                continue;
            }

            const source = await readFile(filePath, 'utf8');
            expect(source).not.toMatch(/from\s+['"][^'"]*sync\/domains\/transfers\/runtime\/bulkTransferPipeline['"]/);
            expect(source).not.toMatch(/import\s*\(\s*['"][^'"]*sync\/domains\/transfers\/runtime\/bulkTransferPipeline['"]\s*\)/);
            expect(source).not.toMatch(/require\s*\(\s*['"][^'"]*sync\/domains\/transfers\/runtime\/bulkTransferPipeline['"]\s*\)/);
        }
    });
});
