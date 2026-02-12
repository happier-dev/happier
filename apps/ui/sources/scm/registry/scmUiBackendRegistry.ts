import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { ScmUiBackendPlugin } from './scmUiBackendPlugin';
import { gitScmUiPlugin } from '@/scm/backends/git/plugin';
import { saplingScmUiPlugin } from '@/scm/backends/sapling/plugin';
import { inferScmRemoteTarget } from '@happier-dev/protocol';

const fallbackPlugin: ScmUiBackendPlugin = {
    id: 'git',
    displayName: 'Source control',
    mapCapabilitiesToUiPolicy(snapshot) {
        const supportsIncludeExclude = snapshot?.capabilities?.writeInclude === true
            && snapshot?.capabilities?.writeExclude === true;
        return {
            supportsIncludeExclude,
            supportsLineSelection: supportsIncludeExclude,
            changeSetModel: supportsIncludeExclude ? 'index' : 'working-copy',
            supportedDiffAreas: supportsIncludeExclude ? ['included', 'pending', 'both'] : ['pending', 'both'],
        };
    },
    diffModeConfig(snapshot) {
        const supportsIncludeExclude = snapshot?.capabilities?.writeInclude === true
            && snapshot?.capabilities?.writeExclude === true;
        return {
            defaultMode: supportsIncludeExclude ? 'both' : 'pending',
            availableModes: supportsIncludeExclude ? ['included', 'pending', 'both'] : ['pending', 'both'],
            labels: {
                included: 'Included',
                pending: 'Pending',
                both: 'Combined',
            },
        };
    },
    commitActionConfig(snapshot) {
        return {
            label: snapshot?.capabilities?.operationLabels?.commit ?? 'Commit',
            supportsPathScopedCommit: true,
            supportsLineSelection: snapshot?.capabilities?.writeInclude === true
                && snapshot?.capabilities?.writeExclude === true,
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
            changedFiles: snapshot.entries.length,
            includedFiles: snapshot.totals.includedFiles,
            pendingFiles: snapshot.totals.pendingFiles,
            untrackedFiles: snapshot.totals.untrackedFiles,
        };
    },
};

const scmUiPlugins: readonly ScmUiBackendPlugin[] = [gitScmUiPlugin, saplingScmUiPlugin];

function buildPluginMap() {
    const map = new Map<string, ScmUiBackendPlugin>();
    for (const plugin of scmUiPlugins) {
        if (map.has(plugin.id)) {
            throw new Error(`Duplicate SCM UI backend plugin id: ${plugin.id}`);
        }
        map.set(plugin.id, plugin);
    }
    return map;
}

const scmPluginMap = buildPluginMap();

export const scmUiBackendRegistry = {
    getPlugin(backendId: string | null | undefined): ScmUiBackendPlugin {
        if (!backendId) return fallbackPlugin;
        return scmPluginMap.get(backendId) ?? fallbackPlugin;
    },
    getPluginForSnapshot(snapshot: ScmWorkingSnapshot | null): ScmUiBackendPlugin {
        return scmUiBackendRegistry.getPlugin(snapshot?.repo?.backendId);
    },
    assertRegistryValid(): void {
        void buildPluginMap();
    },
};
