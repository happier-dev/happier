import { access, readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
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

describe('transferRuntime (public API)', () => {
    it('freezes the transferRuntime index runtime exports', async () => {
        const transferRuntime = await import(new URL('./index.ts', import.meta.url).href);

        expect(Object.keys(transferRuntime).sort()).toEqual([
            'callDaemonWorkspaceStatFileRpc',
            'callDaemonWorkspaceWriteFileRpc',
            'deleteDaemonPromptAsset',
            'discoverDaemonPromptAssets',
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
            'uploadDaemonPromptAsset',
            'uploadDaemonSessionAttachmentFromReader',
            'uploadDaemonWorkspaceFileFromReader',
        ]);
    });

    it('requires the new transferRuntime subfolders to exist', async () => {
        const transferRuntimePath = fileURLToPath(new URL('./', import.meta.url));
        const expectedSubfolders = [
            'availability',
            'routing',
            'families',
            'carriers',
            'plumbing',
        ] as const;

        for (const subfolder of expectedSubfolders) {
            await expect(access(join(transferRuntimePath, subfolder))).resolves.toBeUndefined();
        }
    });

    it('does not retain legacy transfer folders or imports anywhere under apps/ui/sources', async () => {
        const legacyFolderTokens = [
            ['bulk', 'Transfer', 'Pipeline'].join(''),
            ['transfer', 'Substrate'].join(''),
        ] as const;
        const sourcesPath = fileURLToPath(new URL('../../../../../', import.meta.url));
        const files = (await listFilesRecursively(sourcesPath)).filter((filePath) =>
            filePath.endsWith('.ts') || filePath.endsWith('.tsx'),
        );

        const legacyReferences: string[] = [];
        for (const filePath of files) {
            const source = await readFile(filePath, 'utf8');
            if (legacyFolderTokens.some((token) => source.includes(token))) {
                legacyReferences.push(relative(sourcesPath, filePath));
            }
        }

        expect(legacyReferences.sort()).toEqual([]);
    });

    it('keeps plumbing imports scoped to transferRuntime/**', async () => {
        const sourcesPath = fileURLToPath(new URL('../../../../../', import.meta.url));
        const files = (await listFilesRecursively(sourcesPath)).filter((filePath) =>
            (filePath.endsWith('.ts') || filePath.endsWith('.tsx'))
            && !filePath.endsWith('.test.ts')
            && !filePath.endsWith('.spec.ts')
            && !filePath.endsWith('.test.tsx')
            && !filePath.endsWith('.spec.tsx'),
        );

        const externalPlumbingImports: string[] = [];
        for (const filePath of files) {
            if (filePath.includes('/sync/domains/transfers/runtime/transferRuntime/')) {
                continue;
            }

            const source = await readFile(filePath, 'utf8');
            if (source.includes('/sync/domains/transfers/runtime/transferRuntime/plumbing/')) {
                externalPlumbingImports.push(relative(sourcesPath, filePath));
            }
        }

        expect(externalPlumbingImports.sort()).toEqual([]);
    });
});
