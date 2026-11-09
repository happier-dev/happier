import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import * as github from '@happier-dev/plugins-scm-github';

import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';

it('reuses the real GitHub activation for concurrent and repeated authentication demand', async () => {
    const packageRoot = new URL('../../../../../packages/plugins/scm-github/', import.meta.url);
    const resources = await Promise.all(github.manifest.contributes.resources.flatMap(resource =>
        'path' in resource
            ? [readFile(new URL(resource.path, packageRoot)).then(bytes => [resource.path, bytes] as const)]
            : []));
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
        coldStart: true,
        plugins: [{
            manifest: { ...github.manifest, entrypoints: { daemon: './daemon.mjs' } },
            files: { ...Object.fromEntries(resources), 'daemon.mjs': 'export function activate() {}' },
            // Substitute only filesystem module loading; execute the real GitHub
            // definition, registration, setup and cleanup under the production host.
            instantiateCommittedModule: () => github,
        }],
        async resolveContributes(happyHomeDir) {
            return createResolvedContributionRegistry(projectLoadedPluginContributes({
                loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'first_party',
            }));
        },
    });
    try {
        const { registry } = fixture;
        expect(registry.activatedPluginIds.has(github.manifest.id)).toBe(false);
        const service = { pluginId: github.manifest.id, localId: 'github-account' };
        const resolve = registry.resolveConnectedAccountRuntime;
        if (!resolve) throw new Error('Missing connected account runtime resolver');
        const concurrent = await Promise.all([resolve(service), resolve(service)]);
        const repeated = await resolve(service);
        for (const lease of [...concurrent, repeated]) {
            expect(lease?.isCurrent()).toBe(true);
            expect(lease?.descriptor.authentication.modes).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: 'native-import' }),
            ]));
            expect(lease?.runtime).toBe(concurrent[0]?.runtime);
        }
        expect(registry.targetActivationFacts.filter(fact => fact.pluginId === service.pluginId))
            .toMatchObject([{ status: 'active' }]);
        expect(registry.pluginDiagnosticsByPluginId[service.pluginId] ?? [])
            .not.toEqual(expect.arrayContaining([expect.objectContaining({ code: 'plugin_activation_failed' })]));
    } finally {
        await fixture.dispose();
    }
});
