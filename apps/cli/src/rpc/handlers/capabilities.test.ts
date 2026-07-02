import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import * as tar from 'tar';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CapabilitiesDescribeResponse, CapabilitiesInvokeResponse } from '@/capabilities/types';
import { reloadConfiguration } from '@/configuration';
import { createMarketplaceCatalogDocument, createMarketplaceCatalogEntry } from '@/plugins/testkit/marketplaceCatalog';
import { materializeSamplePluginFixture, SAMPLE_PLUGIN_ID } from '@/plugins/testkit/samplePackage';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

import { createCliCapabilitiesService } from './capabilities';

describe('createCliCapabilitiesService installable dependencies', () => {
    afterEach(() => {
        vi.doUnmock('@/backends/catalog');
        vi.resetModules();
    });

    it('describes Codex ACP from installable contributions when the backend has no local capability hook', async () => {
        vi.resetModules();
        vi.doMock('@/backends/catalog', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/backends/catalog')>();
            return {
                ...actual,
                AGENTS: {
                    ...actual.AGENTS,
                    codex: {
                        ...actual.AGENTS.codex,
                        getCapabilities: undefined,
                    },
                },
            };
        });

        const home = await createTempDir('happier-cli-capabilities-installables-');
        const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
        envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
        reloadConfiguration();

        try {
            const { createCliCapabilitiesService: createService } = await import('./capabilities');
            const service = await createService();
            const described = service.describe() as CapabilitiesDescribeResponse;

            expect(described.capabilities.find((capability) => capability.id === 'dep.codex-acp')).toMatchObject({
                id: 'dep.codex-acp',
                kind: 'dep',
                title: 'Codex ACP',
                methods: expect.objectContaining({
                    install: expect.any(Object),
                    upgrade: expect.any(Object),
                }),
            });
        } finally {
            await removeTempDir(home);
            envScope.restore();
            reloadConfiguration();
        }
    });
});

describe('createCliCapabilitiesService dep.gh', () => {
    it('describes gh as a generic installable dependency capability', async () => {
        const home = await createTempDir('happier-cli-capabilities-gh-');
        const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
        envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
        reloadConfiguration();

        try {
            const service = await createCliCapabilitiesService();
            const described = service.describe() as CapabilitiesDescribeResponse;

            expect(described.capabilities.find((capability) => capability.id === 'dep.gh')).toMatchObject({
                id: 'dep.gh',
                kind: 'dep',
                methods: expect.objectContaining({
                    install: expect.any(Object),
                    upgrade: expect.any(Object),
                }),
            });
        } finally {
            await removeTempDir(home);
            envScope.restore();
            reloadConfiguration();
        }
    });
});

describe('createCliCapabilitiesService dep.az', () => {
    it('describes Azure CLI as a detect-only generic installable dependency capability', async () => {
        const home = await createTempDir('happier-cli-capabilities-az-');
        const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
        envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
        reloadConfiguration();

        try {
            const service = await createCliCapabilitiesService();
            const described = service.describe() as CapabilitiesDescribeResponse;

            const azCapability = described.capabilities.find((capability) => capability.id === 'dep.az');
            expect(azCapability).toMatchObject({
                id: 'dep.az',
                kind: 'dep',
            });
            expect(azCapability).not.toHaveProperty('methods');
        } finally {
            await removeTempDir(home);
            envScope.restore();
            reloadConfiguration();
        }
    });
});

describe('createCliCapabilitiesService tool.plugins', () => {
    it('describes and invokes reload through the canonical plugin capability', async () => {
        const home = await createTempDir('happier-cli-capabilities-plugins-reload-');
        const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
        envScope.patch({ HAPPIER_HOME_DIR: home, PATH: '' });
        reloadConfiguration();

        const sourceParent = await mkdtemp(join(tmpdir(), 'happier-cli-capabilities-plugin-source-'));
        const sourceRoot = join(sourceParent, 'sample-plugin');
        await materializeSamplePluginFixture(sourceRoot);
        const archivePath = join(home, `${SAMPLE_PLUGIN_ID}.tar.gz`);
        await tar.c({
            gzip: true,
            file: archivePath,
            cwd: sourceParent,
            portable: true,
        }, [basename(sourceRoot)]);
        const catalogPath = join(home, 'catalog.json');
        await writeFile(
            catalogPath,
            JSON.stringify(createMarketplaceCatalogDocument({
                sourceUrl: catalogPath,
                title: 'Curated plugins',
                description: 'Descriptor-only plugin discovery',
                entries: [
                    createMarketplaceCatalogEntry({
                        pluginId: SAMPLE_PLUGIN_ID,
                        title: 'Sample Plugin',
                        description: 'Descriptor-only plugin discovery',
                        sourceUrl: `${catalogPath}#${SAMPLE_PLUGIN_ID}`,
                        packageUrl: archivePath,
                        categories: ['plugins'],
                    }),
                ],
            }), null, 2),
            'utf8',
        );

        try {
            const service = await createCliCapabilitiesService();
            const described = service.describe() as CapabilitiesDescribeResponse;

            expect(described.capabilities.find((capability) => capability.id === 'tool.plugins')).toMatchObject({
                methods: expect.objectContaining({
                    install: expect.any(Object),
                    update: expect.any(Object),
                    enable: expect.any(Object),
                    disable: expect.any(Object),
                    reload: expect.any(Object),
                }),
            });

            const installResult = await service.invoke({
                id: 'tool.plugins',
                method: 'install',
                params: {
                    sourceUrl: catalogPath,
                    pluginId: SAMPLE_PLUGIN_ID,
                },
            }) as CapabilitiesInvokeResponse;

            expect(installResult.ok).toBe(true);
            if (!installResult.ok) return;

            const reloaded = await service.invoke({
                id: 'tool.plugins',
                method: 'reload',
                params: {
                    pluginId: SAMPLE_PLUGIN_ID,
                },
            }) as CapabilitiesInvokeResponse;

            expect(reloaded.ok).toBe(true);
            if (!reloaded.ok) return;
            expect(reloaded.result).toMatchObject({
                action: 'reload',
                pluginId: SAMPLE_PLUGIN_ID,
                reload: {
                    ok: expect.any(Boolean),
                    attemptedGeneration: expect.any(Number),
                    affectedPluginIds: [SAMPLE_PLUGIN_ID],
                },
            });
        } finally {
            envScope.restore();
            reloadConfiguration();
            await removeTempDir(home);
            await rm(sourceParent, { recursive: true, force: true });
        }
    });
});
