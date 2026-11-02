import { describe, expect, it } from 'vitest';
import { createPluginRegistrationScope } from './registration/scope.js';
import { derivePluginDaemonContributionRegistrationRights } from '@happier-dev/protocol/plugins/contributions/catalog';
import { definePlugin } from './definePlugin.js';

describe('secret source authoring', () => {
    it('derives cold list and store capabilities from the registered runtime without native work', () => {
        const plugin = definePlugin({ id: 'acme.bulk-vault', version: '1.0.0', displayName: 'Vault',
            entrypoints: { daemon: './daemon.mjs' }, secretSources: { vault: {
                declaration: { title: 'Vault' }, runtime: {
                    async acquire() { throw new Error('must not acquire'); },
                    async list() { throw new Error('must not list'); },
                    async store() { throw new Error('must not store'); },
                },
            } } });
        expect(plugin.manifest.contributes.secretSources).toEqual([{ id: 'vault', title: 'Vault', capabilities: { list: true, store: true } }]);
    });
    it('admits a declared source through the public activation ABI without acquiring its value', async () => {
        let reads = 0;
        const plugin = definePlugin({
            id: 'acme.vault', version: '1.0.0', displayName: 'Vault',
            entrypoints: { daemon: './daemon.mjs' },
            secretSources: { vault: {
                declaration: { title: 'Vault' },
                runtime: { async acquire() { reads += 1; return { ok: true as const, value: 'private-value' }; } },
            } },
        });
        expect(plugin.manifest.contributes.secretSources).toEqual([{ id: 'vault', title: 'Vault' }]);
        const scope = createPluginRegistrationScope({
            pluginId: plugin.manifest.id,
            target: { realm: 'daemon' },
            rights: derivePluginDaemonContributionRegistrationRights(plugin.manifest.contributes),
        });
        await plugin.activate(scope.api);
        const registration = scope.commit().find(row => row.family === 'secretSources');
        expect(registration?.localId).toBe('vault');
        expect(reads).toBe(0);
        await scope.dispose();
    });
});
