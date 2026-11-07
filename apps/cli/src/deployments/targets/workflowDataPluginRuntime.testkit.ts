import * as neon from '../../../../../packages/plugins/deployment-neon/src/index';
import * as supabase from '../../../../../packages/plugins/deployment-supabase/src/index';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';

/** Admits the actual provider declarations without depending on bundled build
 * membership. Imported callback bodies are unit evidence, not package evidence. */
export function createWorkflowDataPluginRuntimeFixture(
    runtimeOptions?: Parameters<typeof createAuthoredAdmittedPluginRuntimeFixture>[0]['runtimeOptions'],
) {
    return createAuthoredAdmittedPluginRuntimeFixture({
        ...(runtimeOptions ? { runtimeOptions } : {}),
        plugins: [neon, supabase].map(plugin => ({
            manifest: plugin.manifest,
            files: { '.happier-plugin/daemon.js': 'export function activate() {}' },
            instantiateCommittedModule: () => ({ activate: plugin.activate }),
        })),
        resolveContributes: async happyHomeDir => createResolvedContributionRegistry(projectLoadedPluginContributes({
            loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external',
        })),
    });
}
