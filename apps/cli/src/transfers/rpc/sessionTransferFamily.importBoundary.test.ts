import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const CANONICAL_SESSION_TRANSFER_RPC_TOKENS = [
    'RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_',
    'RPC_METHODS.DAEMON_BULK_TRANSFER_DOWNLOAD_',
] as const;

const CANONICAL_SESSION_TRANSFER_RPC_LITERAL_PREFIXES = [
    'daemon.bulkTransfer.upload.',
    'daemon.bulkTransfer.download.',
] as const;

const LEGACY_SESSION_TRANSFER_RPC_TOKENS = [
    ['DAEMON_SESSION_', 'FILES_'].join(''),
    ['DAEMON_SESSION_ATTACHMENTS_', 'UPLOAD_'].join(''),
    ['ATTACHMENTS_', 'CONFIGURE'].join(''),
    ['daemon.sessionFiles.', 'upload.'].join(''),
    ['daemon.sessionFiles.', 'download.'].join(''),
    ['daemon.sessionAttachments.', 'upload.'].join(''),
] as const;

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
    if (!filePath.endsWith('.ts')) return false;
    if (filePath.endsWith('.d.ts')) return false;
    if (filePath.endsWith('.test.ts')) return false;
    if (filePath.endsWith('.spec.ts')) return false;
    return true;
}

describe('session transfer rpc family (import-boundary)', () => {
    it('confines canonical DAEMON_BULK_TRANSFER_* tokens to the transfer substrate', async () => {
        const cliRoot = fileURLToPath(new URL('../../..', import.meta.url)); // apps/cli/src
        const transfersRoot = fileURLToPath(new URL('..', import.meta.url)); // apps/cli/src/transfers
        const rpcHandlersRoot = fileURLToPath(new URL('../../rpc/handlers', import.meta.url)); // apps/cli/src/rpc/handlers

        const files = (await listFilesRecursively(cliRoot)).filter(isProductionTsFile);

        for (const filePath of files) {
            const content = await readFile(filePath, 'utf8');

            for (const prefix of CANONICAL_SESSION_TRANSFER_RPC_LITERAL_PREFIXES) {
                expect(content).not.toContain(prefix);
            }

            for (const token of LEGACY_SESSION_TRANSFER_RPC_TOKENS) {
                expect(content).not.toContain(token);
            }

            // Canonical DAEMON_BULK_TRANSFER_* tokens are allowed only in canonical transfer registrar/handler code.
            if (filePath.startsWith(transfersRoot) || filePath.startsWith(rpcHandlersRoot)) {
                continue;
            }
            for (const token of CANONICAL_SESSION_TRANSFER_RPC_TOKENS) {
                expect(content).not.toContain(token);
            }
        }
    });
});
