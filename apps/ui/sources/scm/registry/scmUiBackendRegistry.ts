import { selectScmChangedFiles } from '@/scm/scmStatusFiles';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import {
    resolveScmCommitSelectionPolicy,
    resolveScmUiPolicy,
    resolveSupportedDiffAreas,
    type ScmUiBackendPlugin,
} from './scmUiBackendPlugin';
import { gitScmUiPlugin } from '@/scm/backends/git/plugin';
import { saplingScmUiPlugin } from '@/scm/backends/sapling/plugin';
import { inferScmRemoteTarget } from '@happier-dev/protocol/scm';
import { createScmContributionCatalog, type ScmContributionCatalog } from './scmContributionCatalog';
import { getFirstPartyScmBackendQualifiedId } from './firstPartyScmBackendIdentity';

function createFallbackPlugin(id: string, displayName: string): ScmUiBackendPlugin {
    return {
        id,
        displayName,
        mapCapabilitiesToUiPolicy(snapshot) {
            return resolveScmUiPolicy(snapshot?.capabilities);
        },
        diffModeConfig(snapshot) {
            const availableModes = resolveSupportedDiffAreas(snapshot?.capabilities);
            return {
                defaultMode: availableModes.includes('pending') ? 'pending' : (availableModes[0] ?? 'pending'),
                availableModes: [...availableModes],
            };
        },
        commitActionConfig(snapshot) {
            return {
                label: snapshot?.capabilities?.operationLabels?.commit ?? 'Commit',
                ...resolveScmCommitSelectionPolicy(snapshot?.capabilities),
            };
        },
        remoteActionConfig(snapshot) {
            return {
                fetch: snapshot?.capabilities?.writeRemoteFetch ?? false,
                pull: snapshot?.capabilities?.writeRemotePull ?? false,
                push: snapshot?.capabilities?.writeRemotePush ?? false,
                confirmationCopy: 'Source-control remote operation',
            };
        },
        inferRemoteTarget(snapshot) {
            return inferScmRemoteTarget({
                upstream: snapshot?.branch.upstream,
                head: snapshot?.branch.head,
                allowHeadFallback: false,
            });
        },
        errorNormalizer(input) {
            return input instanceof Error ? input.message : String(input ?? 'Unknown source-control error');
        },
        statusSummaryMapper(snapshot) {
            if (!snapshot) return null;
            return {
                changedFiles: selectScmChangedFiles(snapshot).length,
                includedFiles: snapshot.totals.includedFiles,
                pendingFiles: snapshot.totals.pendingFiles,
                untrackedFiles: snapshot.totals.untrackedFiles,
            };
        },
    };
}

const fallbackPlugin = createFallbackPlugin('git', 'Source control');

const scmUiPlugins: readonly ScmUiBackendPlugin[] = [gitScmUiPlugin, saplingScmUiPlugin];

function buildBuiltInPluginMap() {
    const map = new Map<string, ScmUiBackendPlugin>();
    for (const plugin of scmUiPlugins) {
        if (map.has(plugin.id)) {
            throw new Error(`Duplicate SCM UI backend plugin id: ${plugin.id}`);
        }
        map.set(plugin.id, plugin);
        const qualifiedId = getFirstPartyScmBackendQualifiedId(plugin.id);
        if (qualifiedId) {
            map.set(qualifiedId, { ...plugin, id: qualifiedId });
        }
    }
    return map;
}

const builtInPluginMap = buildBuiltInPluginMap();

export function createScmUiBackendRegistry(catalog: ScmContributionCatalog) {
    const projectedPlugins = catalog.backends.map((backend) => {
        const builtIn = builtInPluginMap.get(backend.id)
            ?? (backend.pluginId === null ? builtInPluginMap.get(backend.localId) : undefined);
        return builtIn
            ? { ...builtIn, id: backend.id, displayName: backend.title }
            : createFallbackPlugin(backend.id, backend.title);
    });
    const projectedPluginMap = new Map(projectedPlugins.map((plugin) => [plugin.id, plugin]));
    return {
        listPlugins(): readonly ScmUiBackendPlugin[] {
            return projectedPlugins;
        },
        getPlugin(backendId: string | null | undefined): ScmUiBackendPlugin {
            if (!backendId) return fallbackPlugin;
            return projectedPluginMap.get(backendId) ?? builtInPluginMap.get(backendId) ?? createFallbackPlugin(backendId, 'Source control');
        },
        getPluginForSnapshot(snapshot: ScmWorkingSnapshot | null): ScmUiBackendPlugin {
            return this.getPlugin(snapshot?.repo?.backendId);
        },
        assertRegistryValid(): void {
            void buildBuiltInPluginMap();
        },
    };
}

// Operational consumers ask this registry for leaf UI policy after a canonical
// snapshot already names the selected backend. It is not contribution inventory;
// settings and selection enumerate only the daemon-projected factory above.
export const scmUiBackendRegistry = createScmUiBackendRegistry(createScmContributionCatalog(null));
