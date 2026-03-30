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

function isRuntimeSourceFile(filePath: string): boolean {
    if (!(filePath.endsWith('.ts') || filePath.endsWith('.tsx'))) {
        return false;
    }
    if (
        filePath.endsWith('.test.ts')
        || filePath.endsWith('.spec.ts')
        || filePath.endsWith('.test.tsx')
        || filePath.endsWith('.spec.tsx')
        || filePath.endsWith('.integration.test.ts')
        || filePath.endsWith('.real.integration.test.ts')
        || filePath.endsWith('.integration.spec.ts')
    ) {
        return false;
    }
    return true;
}

describe('session handoffs (architecture)', () => {
    it('does not embed legacy direct-transfer URLs in UI runtime sources', async () => {
        const sourcesRoot = fileURLToPath(new URL('../..', import.meta.url));
        const files = (await listFilesRecursively(sourcesRoot)).filter(isRuntimeSourceFile);

        for (const filePath of files) {
            const source = await readFile(filePath, 'utf8');
            expect(source).not.toContain('session-handoffs/direct-transfer');
            expect(source).not.toMatch(/\bmachine-transfers\/direct\/[^'"\s]*\?token=/u);
        }
    });
});
