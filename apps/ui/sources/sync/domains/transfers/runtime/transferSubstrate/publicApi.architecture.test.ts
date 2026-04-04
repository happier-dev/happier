import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as transferSubstrate from './index';

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

describe('transferSubstrate (public API)', () => {
    it('freezes the transferSubstrate index runtime exports', () => {
        expect(Object.keys(transferSubstrate).sort()).toEqual([
            'callDaemonWorkspaceStatFileRpc',
            'callDaemonWorkspaceWriteFileRpc',
            'deleteDaemonPromptAsset',
            'discoverDaemonPromptAssets',
            'downloadBulkJsonPayload',
            'downloadBulkPayloadToFile',
            'downloadDaemonPromptAsset',
            'downloadDaemonPromptRegistryItem',
            'downloadDaemonWorkspaceFileToBase64',
            'downloadDaemonWorkspaceFileToDestination',
            'installDaemonPromptRegistryItem',
            'listDaemonPromptAssetTypes',
            'listDaemonPromptRegistryAdapters',
            'listDaemonPromptRegistrySources',
            'resolveSessionFileTransferAvailability',
            'resolveTransferAvailability',
            'resolveTransferRouteDecision',
            'scanDaemonPromptRegistrySource',
            'shouldPreferScopedMachineRpcForBulkTransfer',
            'uploadBulkJsonPayload',
            'uploadBulkPayloadFromFile',
            'uploadDaemonPromptAsset',
            'uploadDaemonSessionAttachmentFromReader',
            'uploadDaemonWorkspaceFileFromReader',
        ]);
    });

    it('keeps direct bulkTransferPipeline imports behind the substrate boundary', async () => {
        const sourcesPath = fileURLToPath(new URL('../../../../../', import.meta.url));
        const files = (await listFilesRecursively(sourcesPath)).filter((filePath) =>
            (filePath.endsWith('.ts') || filePath.endsWith('.tsx'))
            && !filePath.endsWith('.test.ts')
            && !filePath.endsWith('.spec.ts')
            && !filePath.endsWith('.test.tsx')
            && !filePath.endsWith('.spec.tsx'),
        );

        for (const filePath of files) {
            if (filePath.includes('/bulkTransferPipeline/') || filePath.includes('/transferSubstrate/')) {
                continue;
            }

            const source = await readFile(filePath, 'utf8');
            assertDoesNotImportModule(source, 'bulkTransferPipeline', filePath);
        }
    });
});
