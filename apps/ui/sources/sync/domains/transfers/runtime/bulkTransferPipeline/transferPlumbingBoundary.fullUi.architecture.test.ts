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

describe('bulkTransferPipeline (architecture)', () => {
    it('keeps chunk transfer plumbing scoped to bulkTransferPipeline/** across the entire UI sources tree', async () => {
        const sourcesPath = fileURLToPath(new URL('../../../../../', import.meta.url));
        const files = (await listFilesRecursively(sourcesPath)).filter((filePath) =>
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
            // Prevent bypass via relative imports, dynamic imports, or require().
            assertDoesNotImportModule(source, 'chunkTransferClient', filePath);
            assertDoesNotImportModule(source, 'sessionFileTransferRpcCaller', filePath);
            assertDoesNotImportModule(source, 'mergeTransferChunks', filePath);

            // Prevent legacy helper reintroduction (these were the old feature-facing bulk-byte paths).
            expect(source).not.toContain('uploadMachineTransferJsonPayload');
            expect(source).not.toContain('downloadMachineTransferJsonPayload');

            // Feature code must not open-code the session-scoped RPC method family; only the canonical pipeline may.
            expect(source).not.toContain('RPC_METHODS.DAEMON_SESSION_FILES_');
            expect(source).not.toContain('RPC_METHODS.DAEMON_SESSION_ATTACHMENTS_UPLOAD_');

            // Deletion-proofing: the old FILES_* / ATTACHMENTS_CONFIGURE family must not reappear anywhere.
            expect(source).not.toContain('RPC_METHODS.FILES_UPLOAD_');
            expect(source).not.toContain('RPC_METHODS.FILES_DOWNLOAD_');
            expect(source).not.toContain('RPC_METHODS.ATTACHMENTS_CONFIGURE');
            expect(source).not.toMatch(/\bFILES_UPLOAD_(INIT|CHUNK|FINALIZE|ABORT)\b/u);
            expect(source).not.toMatch(/\bFILES_DOWNLOAD_(INIT|CHUNK|FINALIZE|ABORT)\b/u);
            expect(source).not.toMatch(/\bATTACHMENTS_CONFIGURE\b/u);
        }
    });
});
