import { describe, expect, it } from 'vitest';
import { INSTALLABLES_CATALOG, type PluginProjectionV2 } from '@happier-dev/protocol';

import { getInstallablesRegistryEntries } from './installablesRegistry';

describe('getInstallablesRegistryEntries', () => {
    it('returns the expected built-in installables', () => {
        const entries = getInstallablesRegistryEntries();

        expect(entries.map((e) => e.key)).toEqual(INSTALLABLES_CATALOG.map((e) => e.key));
        expect(entries.map((e) => e.capabilityId)).toEqual(INSTALLABLES_CATALOG.map((e) => e.capabilityId));
        expect(entries.filter((e) => e.supportsManagedOverrideInstall).map((e) => e.key)).toEqual(['gh']);
        expect(entries.map((e) => e.defaultPolicy)).toEqual(INSTALLABLES_CATALOG.map((e) => e.defaultPolicy));
    });

    it('projects gh as an optional generic dependency', () => {
        const entries = getInstallablesRegistryEntries();
        const gh = entries.find((entry) => entry.key === 'gh');

        expect(gh).toEqual(expect.objectContaining({
            key: 'gh',
            kind: 'dep',
            capabilityId: 'dep.gh',
            supportsManagedOverrideInstall: true,
            experimental: false,
        }));
        expect(gh?.buildLatestVersionDetectRequest()).toEqual({
            requests: [{
                id: 'dep.gh',
                params: { includeLatestVersion: true, onlyIfInstalled: true },
            }],
        });
    });

    it('projects Azure CLI as a manual system dependency without managed override install', () => {
        const entries = getInstallablesRegistryEntries();
        const az = entries.find((entry) => entry.key === 'az');

        expect(az).toEqual(expect.objectContaining({
            key: 'az',
            kind: 'dep',
            capabilityId: 'dep.az',
            supportsManagedOverrideInstall: false,
            experimental: false,
        }));
        expect(az?.buildLatestVersionDetectRequest()).toEqual({
            requests: [{
                id: 'dep.az',
                params: { includeLatestVersion: true, onlyIfInstalled: true },
            }],
        });
    });

    it('includes projected plugin managed dependencies beyond the compatibility catalog with generic UI metadata', () => {
        const getEntries = getInstallablesRegistryEntries as (params?: {
            pluginProjection?: PluginProjectionV2;
        }) => readonly ReturnType<typeof getInstallablesRegistryEntries>[number][];
        const entries = getEntries({
            pluginProjection: {
                v: 2,
                generation: 1,
                installedPackagesById: {},
                agentsById: {},
                backendsById: {},
                actionsById: {},
                toolsById: {},
                commandsById: {},
                resourcesById: {},
                settingsById: {},
                diagnostics: [],
                familiesById: {
                    managedDependencies: {
                        family: 'managedDependencies',
                        entriesById: {
                            'acme-tool': {
                                id: 'acme-tool',
                                pluginId: 'acme.installables',
                                key: 'acme-tool',
                                capabilityId: 'dep.acme-tool',
                                sourceKind: 'manual_only',
                                display: {
                                    name: 'Acme Tool',
                                },
                                defaultPolicy: {
                                    autoInstallWhenNeeded: false,
                                    autoUpdateMode: 'notify',
                                },
                                experimental: false,
                            },
                        },
                    },
                },
            },
        });

        const acme = entries.find((entry) => entry.key === 'acme-tool');
        expect(acme).toEqual(expect.objectContaining({
            key: 'acme-tool',
            capabilityId: 'dep.acme-tool',
            title: 'Acme Tool',
            supportsManagedOverrideInstall: false,
            defaultPolicy: {
                autoInstallWhenNeeded: false,
                autoUpdateMode: 'notify',
            },
        }));
    });

    it('uses supplied projection entries as the source of truth instead of prepending compatibility catalog entries', () => {
        const entries = getInstallablesRegistryEntries({
            projectedInstallables: [{
                id: 'acme-tool',
                key: 'acme-tool',
                capabilityId: 'dep.acme-tool',
                sourceKind: 'manual_only',
                display: {
                    name: 'Acme Tool',
                },
                defaultPolicy: {
                    autoInstallWhenNeeded: false,
                    autoUpdateMode: 'notify',
                },
                experimental: false,
            }],
        });

        expect(entries.map((entry) => entry.key)).toEqual(['acme-tool']);
    });
});
