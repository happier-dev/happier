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
import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import {
    resolveAuthoritativePackagedRuntimeCustody,
    type AuthoritativePackagedRuntimeCustody,
} from '@/packagedRuntime/resolvePackagedRuntimeEntrypoint';
import { PluginCodeUnreadableError, readPluginModuleFailureCause } from '../../moduleFailure';
import {
    createRuntimeBundledActivationSourceResolver,
    type createBundledActivationSourceResolver,
} from '../../bundledActivationSource';

/** Shared child registration loader. The parent supplies admitted sources;
 * managed placement and packaged child copies (such as published Linux member
 * CLIs) resolve bundled paths in the executing runtime. This owner never
 * discovers Account state or starts sibling services. */
export async function loadAdmittedPluginProcessRegistrations(
    plugins: readonly AdmittedBackgroundServicePlugin[],
    generation: number,
    createAgentInvocationServices: CreateAgentInvocationServices,
    preparedContributes?: ResolvedContributionRegistry,
    options?: Readonly<{
        resolveBundledActivationSource?: ReturnType<typeof createBundledActivationSourceResolver>;
        resolveExecutingPackagedRuntimeCustody?: () => AuthoritativePackagedRuntimeCustody | null;
    }>,
) {
    const executingPackagedRuntime = (() => {
        if (options?.resolveBundledActivationSource) return null;
        if (!plugins.some((plugin) => plugin.target.sourceSpec.kind === 'bundled')) return null;
        try {
            return (options?.resolveExecutingPackagedRuntimeCustody ?? resolveAuthoritativePackagedRuntimeCustody)();
        } catch {
            return null;
        }
    })();
    const packagedBundledTargets = executingPackagedRuntime
        ? plugins
            .filter((plugin) => (
                plugin.target.sourceSpec.kind === 'bundled'
                && !isCanonicalAbsolutePathInsideRoot(executingPackagedRuntime.root, plugin.processEntry.rootPath)
            ))
            .map((plugin) => plugin.target)
        : [];
    const resolveExecutingBundledActivationSource = executingPackagedRuntime && packagedBundledTargets.length > 0
        ? createRuntimeBundledActivationSourceResolver({
            activationTargets: packagedBundledTargets,
            packagedRuntime: executingPackagedRuntime,
        })
        : undefined;
    const sources = new Map(plugins.map((plugin) => {
        // Managed guests and packaged child copies outside the daemon's root
        // (e.g. /opt/happier-member-cli-*) load admitted bundled plugins from
        // their own verified runtime closure; external and same-root sources
        // keep their exact admitted process entry.
        const resolveBundled = plugin.target.sourceSpec.kind === 'bundled'
            ? options?.resolveBundledActivationSource
                ?? (executingPackagedRuntime
                    && !isCanonicalAbsolutePathInsideRoot(executingPackagedRuntime.root, plugin.processEntry.rootPath)
                    ? resolveExecutingBundledActivationSource
                    : undefined)
            : undefined;
        const placed = resolveBundled?.(plugin.target);
        if (resolveBundled && (!placed?.processEntry || !placed.sourceAuthority)) return [plugin.target.pluginId, null] as const;
        const processEntry = placed?.processEntry ?? plugin.processEntry;
        const generationScope = createPluginTypeScriptGenerationScope();
        const loadModule = (entryPath: string) => loadVerifiedPluginModule({
            entryPath, loadMode: processEntry.loadMode, generationScope,
            cacheKey: plugin.committedAuthorization?.immutableGenerationId ?? plugin.occurrenceId,
            nativeFileUrlMode: 'canonical',
        });
        const source: PluginActivationSource<PluginDaemonModuleNamespace> = {
            kind: 'bundled',
            moduleId: placed?.moduleId ?? plugin.moduleId ?? processEntry.entryPath,
            sourceAuthority: placed?.sourceAuthority ?? plugin.sourceAuthority,
            load: async () => { await placed?.prepare?.(); return loadModule(processEntry.entryPath); },
            resolveRelativeModule: async (module) => {
                await placed?.prepare?.();
                return resolvePluginAuthorStagingModule({ graph: { ...processEntry, loadModule }, module });
            },
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
        const unreadableManagedCode = plugins.some(plugin => plugin.sourceAuthority.kind === 'managed'
            && registry.failedActivationPluginIds.has(plugin.target.pluginId)
            && registry.pluginDiagnosticsByPluginId[plugin.target.pluginId]?.some(diagnostic => {
                const cause = readPluginModuleFailureCause(diagnostic.details);
                return cause?.phase === 'resolve' && (cause.code === 'EACCES' || cause.code === 'EPERM');
            }));
        if (unreadableManagedCode) throw new PluginCodeUnreadableError();
        throw new Error(`background_service_process_activation_failed: ${failed.map(({ code, message }) => `${code}: ${message}`).join('; ')}`);
    }
    return registry;
}
