import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { projectManifestAgentContribution } from '@/plugins/projection/registry/projectManifestAgentContribution';
import { resolvePluginAuthorStagingModule } from '@/plugins/authoring/sourceModule';
import type { PluginActivationSource } from '../../activationSources';
import { createPluginTypeScriptGenerationScope, loadVerifiedPluginModule } from '../../loadPluginModule';
import type { PluginDaemonModuleNamespace } from '../../types';
import type { AdmittedBackgroundServicePlugin } from '../contributions/backgroundServiceProcessSource';
import { activatePluginRuntimeRegistry } from '../manager';
import type { CreateAgentInvocationServices } from '../../invocation/services/types';

/** Shared child registration loader. The parent supplies already admitted exact
 * sources; this owner never discovers Account state or starts sibling services. */
export async function loadAdmittedPluginProcessRegistrations(
    plugins: readonly AdmittedBackgroundServicePlugin[],
    generation: number,
    createAgentInvocationServices: CreateAgentInvocationServices,
  preparedContributes?: ResolvedContributionRegistry,
) {
    const sources = new Map(plugins.map((plugin) => {
        const generationScope = createPluginTypeScriptGenerationScope();
        const loadModule = (entryPath: string) => loadVerifiedPluginModule({
            entryPath, loadMode: plugin.processEntry.loadMode, generationScope,
            cacheKey: plugin.committedAuthorization?.immutableGenerationId ?? plugin.occurrenceId,
            nativeFileUrlMode: 'canonical',
        });
        const source: PluginActivationSource<PluginDaemonModuleNamespace> = {
            kind: 'bundled',
            moduleId: plugin.moduleId ?? plugin.processEntry.entryPath,
            sourceAuthority: plugin.sourceAuthority,
            load: () => loadModule(plugin.processEntry.entryPath),
            resolveRelativeModule: (module) => resolvePluginAuthorStagingModule({
                graph: { ...plugin.processEntry, loadModule }, module,
            }),
        };
        return [plugin.target.pluginId, source] as const;
    }));
    const contributes = preparedContributes ?? createResolvedContributionRegistry({
        activationTargets: plugins.map(({ target }) => target),
        agents: plugins.flatMap(({ target }) => target.manifest.contributes.agents.map((definition) => (
            projectManifestAgentContribution({
                definition, pluginId: target.pluginId, provenance: target.provenance,
                source: target.source, sourceSpec: target.sourceSpec,
                hostAccess: target.manifest.hostAccess,
                systemTools: target.manifest.contributes.systemTools,
                manifestPath: target.manifestPath, daemonEntryPath: target.daemonEntryPath,
                devDaemonEntryPath: target.devDaemonEntryPath,
            })
        ))),
    });
    const registry = await activatePluginRuntimeRegistry({
        contributes, generation, serviceHost: true,
        serviceHostCreateAgentInvocationServices: createAgentInvocationServices,
        pluginIds: plugins.map(({ target }) => target.pluginId),
        occurrenceIdsByPluginId: new Map(plugins.map(({ target, occurrenceId }) => [target.pluginId, occurrenceId])),
        admittedPluginSourceCustodiesByPluginId: new Map(plugins.map(({ target, sourceCustody }) => [target.pluginId, sourceCustody])),
        resolveActivationSource: (target) => sources.get(target.pluginId) ?? null,
    });
    const failed = [...registry.failedActivationPluginIds].flatMap((pluginId) => registry.pluginDiagnosticsByPluginId[pluginId] ?? []);
    if (failed.length > 0) {
        await registry.dispose();
        throw new Error(`background_service_process_activation_failed: ${failed.map(({ code, message }) => `${code}: ${message}`).join('; ')}`);
    }
    return registry;
}
