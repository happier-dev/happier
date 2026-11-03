import type { PluginProjectionV2 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';
import { createScmContributionCatalog } from '@/scm/registry/scmContributionCatalog';
import { createScmBackendSettingsRegistry } from '@/scm/settings/scmBackendSettingsRegistry';

describe('scmBackendSettingsRegistry', () => {
    const registry = createScmBackendSettingsRegistry(createScmContributionCatalog(null));

    it('registers git and sapling backend settings plugins and returns them by backend id', () => {
        expect(registry.listPlugins().map((plugin) => plugin.backendId).sort()).toEqual(['git', 'sapling']);
        expect(registry.getPlugin('git')?.title).toBe('Git');
        expect(registry.getPlugin('sapling')?.title).toBe('Sapling');
        expect(registry.getPlugin('unknown')).toBeNull();
    });

    it('does not grant first-party Git settings policy to an external same-local-id backend', () => {
        const projection = {
            v: 2,
            generation: 1,
            installedPackagesById: {},
            agentsById: {},
            actionsById: {},


            resourcesById: {},
            settingsById: {},
            familiesById: {
                scmBackends: {
                    family: 'scmBackends',
                    entriesById: {
                        'acme.scm/git': {
                            id: 'acme.scm/git',
                            localId: 'git',
                            pluginId: 'acme.scm',
                            displayName: 'Acme Git-shaped SCM',
                            description: 'External backend with a colliding local id.',
                            kind: 'acme',
                            capabilities: ['detect', 'status'],
                        },
                    },
                },
                scmHostingProviders: {
                    family: 'scmHostingProviders',
                    entriesById: {},
                },
            },
            diagnostics: [],
        } as unknown as PluginProjectionV2;

        const external = createScmBackendSettingsRegistry(
            createScmContributionCatalog(projection),
        ).getPlugin('acme.scm/git');

        expect(external).toEqual(expect.objectContaining({
            backendId: 'acme.scm/git',
            title: 'Acme Git-shaped SCM',
            infoItems: [],
        }));
    });
});
