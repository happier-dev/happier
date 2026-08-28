import { access, readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const cliSource = new URL('../../../../', import.meta.url);
const sourceFile = (path: string) => new URL(path, cliSource);

describe('OpenCode contraction after public handle and endpoint-read consumers are positive', () => {
    it('removes Agent-catalog state-path, PID claim and shutdown hooks', async () => {
        const [catalogHooks, catalogTypes] =
            await Promise.all([
                readFile(sourceFile('plugins/projection/registry/agentCatalogEntryHooks.ts'), 'utf8'),
                readFile(sourceFile('agent/catalog/types.ts'), 'utf8'),
            ]);
        const oldCatalogGraph = [
            catalogHooks,
            catalogTypes,
        ].join('\n');

        for (const retiredHook of [
            'ManagedServerContributionSource',
            'managedServerStatePath',
            'resolveManagedServerStatePath',
            'stopManagedProviderServerBestEffort',
            'readManagedProviderServerStateBestEffort',
            'managedServer?:',
        ]) {
            expect(oldCatalogGraph, retiredHook).not.toContain(retiredHook);
        }
        await expect(access(sourceFile('plugins/projection/registry/agentRuntimeContribution.ts')))
            .rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('removes the predecessor process-state and daemon catalog-hook modules', async () => {
        await expect(access(sourceFile('plugins/runtime/context/managedServerPersistence.ts')))
            .rejects.toMatchObject({ code: 'ENOENT' });
        await expect(access(sourceFile('daemon/managedServers/catalogHooks.ts')))
            .rejects.toMatchObject({ code: 'ENOENT' });
    });
});
