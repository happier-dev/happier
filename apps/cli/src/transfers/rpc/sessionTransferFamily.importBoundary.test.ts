import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const CANONICAL_SESSION_TRANSFER_RPC_TOKENS = [
    'RPC_METHODS.DAEMON_SESSION_FILES_UPLOAD_',
    'RPC_METHODS.DAEMON_SESSION_FILES_DOWNLOAD_',
    'RPC_METHODS.DAEMON_SESSION_ATTACHMENTS_UPLOAD_',
] as const;

const DEPRECATED_SESSION_TRANSFER_RPC_METHOD_KEYS = [
    'FILES_UPLOAD_INIT',
    'FILES_UPLOAD_CHUNK',
    'FILES_UPLOAD_FINALIZE',
    'FILES_UPLOAD_ABORT',
    'FILES_DOWNLOAD_INIT',
    'FILES_DOWNLOAD_CHUNK',
    'FILES_DOWNLOAD_FINALIZE',
    'FILES_DOWNLOAD_ABORT',
    'ATTACHMENTS_CONFIGURE',
] as const;

const DEPRECATED_SESSION_TRANSFER_RPC_TOKENS = [
    'RPC_METHODS.FILES_UPLOAD_INIT',
    'RPC_METHODS.FILES_UPLOAD_CHUNK',
    'RPC_METHODS.FILES_UPLOAD_FINALIZE',
    'RPC_METHODS.FILES_UPLOAD_ABORT',
    'RPC_METHODS.FILES_DOWNLOAD_INIT',
    'RPC_METHODS.FILES_DOWNLOAD_CHUNK',
    'RPC_METHODS.FILES_DOWNLOAD_FINALIZE',
    'RPC_METHODS.FILES_DOWNLOAD_ABORT',
    'RPC_METHODS.ATTACHMENTS_CONFIGURE',
] as const;

const CANONICAL_SESSION_TRANSFER_RPC_LITERAL_PREFIXES = [
    'daemon.sessionFiles.',
    'daemon.sessionAttachments.',
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
    it('keeps deleted legacy FILES_*/ATTACHMENTS_CONFIGURE RPC method keys absent from RPC_METHODS', async () => {
        const { RPC_METHODS } = await import('@happier-dev/protocol/rpc');
        for (const key of DEPRECATED_SESSION_TRANSFER_RPC_METHOD_KEYS) {
            expect(key in RPC_METHODS).toBe(false);
        }
    });

    it('keeps deleted legacy FILES_*/ATTACHMENTS_CONFIGURE tokens absent, and confines canonical DAEMON_SESSION_* tokens to the transfer substrate', async () => {
        const cliRoot = fileURLToPath(new URL('../../..', import.meta.url)); // apps/cli/src
        const transfersRoot = fileURLToPath(new URL('..', import.meta.url)); // apps/cli/src/transfers
        const rpcHandlersRoot = fileURLToPath(new URL('../../rpc/handlers', import.meta.url)); // apps/cli/src/rpc/handlers

        const files = (await listFilesRecursively(cliRoot)).filter(isProductionTsFile);

        for (const filePath of files) {
            const content = await readFile(filePath, 'utf8');

            for (const token of DEPRECATED_SESSION_TRANSFER_RPC_TOKENS) {
                expect(content).not.toContain(token);
            }
            for (const token of DEPRECATED_SESSION_TRANSFER_RPC_METHOD_KEYS) {
                expect(content).not.toMatch(new RegExp(`\\b${token}\\b`, 'u'));
            }
            for (const prefix of CANONICAL_SESSION_TRANSFER_RPC_LITERAL_PREFIXES) {
                expect(content).not.toContain(prefix);
            }

            // Canonical DAEMON_SESSION_* tokens are allowed only in canonical transfer registrar/handler code.
            if (filePath.startsWith(transfersRoot) || filePath.startsWith(rpcHandlersRoot)) {
                continue;
            }
            for (const token of CANONICAL_SESSION_TRANSFER_RPC_TOKENS) {
                expect(content).not.toContain(token);
            }
        }
    });
});
