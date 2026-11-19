import type { PluginApi } from '@happier-dev/plugin-sdk';
import type { PluginCleanup } from '@happier-dev/plugin-sdk';
import type { PluginActivationSource } from '../../activationSources';
import type { PluginDaemonModuleNamespace } from '../../types';
import type { ResolvedActivationTarget } from '../../../projection/registry/types';
import { loadPluginModule } from '../../loadPluginModule';
import { resolvePluginSourceCustody } from '../../sourceAuthority';

/**
 * Resolution of "where does this plugin's activation code come from and how
 * do we invoke it": the daemon module's `activate` export, the activation
 * source descriptor (file-backed vs. bundled), and the on-disk plugin root
 * used for auto ACP-backend registration.
 */

export type ActivationExport = (
    api: PluginApi,
) => void | PluginCleanup | Promise<void | PluginCleanup>;

/** Load the admitted daemon graph for both activation and pre-activation data preparation. */
export async function loadDaemonPluginActivationModule(input: Readonly<{
    source: PluginActivationSource<PluginDaemonModuleNamespace>;
    pluginId: string;
    generation: number;
    immutableGenerationId?: string;
    accountArtifactId?: string;
}>): Promise<PluginDaemonModuleNamespace> {
    const { source, pluginId } = input;
    let cacheGenerationId: string;
    if (source.kind === 'bundled') {
        cacheGenerationId = input.immutableGenerationId ?? `runtime:${input.generation}:${pluginId}`;
    } else {
        const committedId = source.committedAuthorization?.immutableGenerationId;
        const authority = source.sourceAuthority;
        if (committedId) {
            cacheGenerationId = committedId;
        } else if (authority?.kind === 'account_release') {
            cacheGenerationId = JSON.stringify(resolvePluginSourceCustody(authority));
        } else if (authority?.kind === 'development') {
            cacheGenerationId = `development:${authority.registeredRootId}:${authority.observedRevision}`;
        } else {
            throw new Error(`Plugin '${pluginId}' has no committed authorization for daemon activation`);
        }
    }
    if (input.accountArtifactId !== undefined) {
        const admitted = await source.resolveRelativeModule?.(input.accountArtifactId);
        if (!admitted) throw new Error(`Account artifact '${input.accountArtifactId}' has no admitted module source`);
        return admitted.module;
    }
    return await loadPluginModule({ source, cacheKey: `generation:${cacheGenerationId}` });
}

export function resolveActivationExport(moduleNamespace: PluginDaemonModuleNamespace, exportName = 'activate'): Readonly<
    | { status: 'found'; activate: ActivationExport }
    | { status: 'missing' }
    | { status: 'invalid' }
> {
    if (typeof moduleNamespace[exportName] === 'function') {
        return { status: 'found', activate: moduleNamespace[exportName] as ActivationExport };
    }

    if (moduleNamespace[exportName] !== undefined) {
        return { status: 'invalid' };
    }

    return { status: 'missing' };
}

export function resolveActivationSource<TTarget extends ResolvedActivationTarget>(
    target: TTarget,
    resolver: ((target: TTarget) => PluginActivationSource<PluginDaemonModuleNamespace> | null) | undefined,
): PluginActivationSource<PluginDaemonModuleNamespace> {
    const resolved = resolver?.(target) ?? null;
    if (resolved) {
        return resolved;
    }

    const message = target.sourceSpec?.trustPolicy === 'prompt'
        ? `Plugin '${target.pluginId}' requires approval before its daemon activation source can be committed`
        : target.sourceSpec?.trustPolicy === 'untrusted'
            ? `Plugin '${target.pluginId}' is untrusted and has no committed daemon activation source`
            : `Plugin '${target.pluginId}' has no committed activation source for the daemon-applied generation`;
    const error = new Error(message);
    (error as Error & { code: string }).code = target.sourceSpec?.trustPolicy === 'prompt'
        ? 'PLUGIN_DAEMON_TRUST_APPROVAL_REQUIRED'
        : target.sourceSpec?.trustPolicy === 'untrusted'
            ? 'PLUGIN_DAEMON_TRUST_UNTRUSTED'
            : 'PLUGIN_DAEMON_ENTRY_MISSING';
    throw error;
}
