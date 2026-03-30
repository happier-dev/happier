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
            assertDoesNotImportModule(source, 'transferChunkEncryption', filePath);
            assertDoesNotImportModule(source, 'sessionFileTransferRpcCaller', filePath);
            assertDoesNotImportModule(source, 'mergeTransferChunks', filePath);
            // Prevent bypass via importing other low-level transfer plumbing that is not part of
            // the feature-facing pipeline (for example local upload readers).
            assertDoesNotImportModule(source, 'sync/domains/files/transfers', filePath);
            assertDoesNotImportModule(source, 'uploadBulkPayloadFromFile', filePath);
            assertDoesNotImportModule(source, 'downloadBulkPayloadToFile', filePath);
            assertDoesNotImportModule(source, 'uploadBulkJsonPayload', filePath);
            assertDoesNotImportModule(source, 'downloadBulkJsonPayload', filePath);
            assertDoesNotImportModule(source, 'bulkTransferPipeline/daemonSessionFiles', filePath);
            assertDoesNotImportModule(source, 'bulkTransferPipeline/daemonSessionAttachments', filePath);
            assertDoesNotImportModule(source, 'bulkTransferPipeline/daemonPromptAssets', filePath);
            assertDoesNotImportModule(source, 'bulkTransferPipeline/daemonPromptRegistries', filePath);
            // Prevent bypass via direct base64 file writes. These must remain behind the
            // centralized policy/fallback choke point (and/or the bulk transfer pipeline).
            if (!filePath.endsWith('/sync/runtime/sessionMachineRpcFallback.ts')) {
                assertDoesNotContainToken(source, 'RPC_METHODS.WRITE_FILE', filePath);
                // Prevent bypass via raw method strings (no chunk-loop reimplementation outside the pipeline).
                assertDoesNotContainToken(source, 'daemon.bulkTransfer.', filePath);
            }
            // Prevent bypass via direct DAEMON_BULK_TRANSFER init/chunk/finalize loops outside the pipeline.
            assertDoesNotContainToken(source, 'DAEMON_BULK_TRANSFER_', filePath);
        }
    });
});
