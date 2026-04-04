import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

function isProductionTsFile(filePath: string): boolean {
    return filePath.endsWith('.ts')
        && !filePath.endsWith('.d.ts')
        && !filePath.endsWith('.test.ts')
        && !filePath.endsWith('.spec.ts');
}

describe('session handoff (engine-client boundary)', () => {
    it('keeps workspace replication engine modules reachable only from workspaceReplicationAdapter/**', async () => {
        const handoffRoot = fileURLToPath(new URL('..', import.meta.url));
        const adapterRoot = fileURLToPath(new URL('.', import.meta.url));

        const files = (await listFilesRecursively(handoffRoot)).filter(isProductionTsFile);

        for (const filePath of files) {
            if (filePath.startsWith(adapterRoot)) {
                continue;
            }
            const content = await readFile(filePath, 'utf8');
            if (content.includes('workspaces/replication/')) {
                throw new Error(`Forbidden workspace replication engine import outside adapter boundary: ${filePath}`);
            }
        }
    });
});
