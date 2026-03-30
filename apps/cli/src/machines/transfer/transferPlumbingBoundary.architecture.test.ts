import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

describe('machines/transfer (architecture)', () => {
    it('removes the legacy session-handoffs/direct-transfer URL family from CLI runtime sources', async () => {
        const srcRoot = fileURLToPath(new URL('../../', import.meta.url));
        const files = (await listFilesRecursively(srcRoot)).filter(isRuntimeSourceFile);

        for (const filePath of files) {
            const source = await readFile(filePath, 'utf8');
            expect(source).not.toContain('session-handoffs/direct-transfer');
            expect(source).not.toMatch(/\bmachine-transfers\/direct\/[^'"\s]*\?token=/u);
        }
    });

    it('keeps the transfer substrate handoff-agnostic', async () => {
        const transferRoot = fileURLToPath(new URL('./', import.meta.url));
        const files = (await listFilesRecursively(transferRoot)).filter(isRuntimeSourceFile);

        for (const filePath of files) {
            const source = await readFile(filePath, 'utf8');
            assertDoesNotImportModule(source, '/session/handoff/', filePath);
            assertDoesNotImportModule(source, 'session/handoff', filePath);
            assertDoesNotImportModule(source, 'rpcHandlers.sessionHandoff', filePath);
            assertDoesNotImportModule(source, '/api/machine/rpcHandlers.sessionHandoff', filePath);
        }
    });
});
