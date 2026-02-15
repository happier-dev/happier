import type { ScmUiBackendPlugin } from '@/scm/registry/scmUiBackendPlugin';
import { resolveChangeSetModel, resolveSupportedDiffAreas } from '@/scm/registry/scmUiBackendPlugin';
import { inferScmRemoteTarget } from '@happier-dev/protocol';

export const saplingScmUiPlugin: ScmUiBackendPlugin = {
    id: 'sapling',
    displayName: 'Sapling',
    mapCapabilitiesToUiPolicy(snapshot) {
        const capabilities = snapshot?.capabilities;
        const supportsIncludeExclude = capabilities?.writeInclude === true && capabilities?.writeExclude === true;
        return {
            supportsIncludeExclude,
            supportsLineSelection: capabilities?.writeCommitLineSelection === true || supportsIncludeExclude,
            changeSetModel: resolveChangeSetModel(capabilities),
            supportedDiffAreas: resolveSupportedDiffAreas(capabilities),
        };
    },
    diffModeConfig(snapshot) {
        const availableModes = snapshot?.capabilities
            ? resolveSupportedDiffAreas(snapshot.capabilities)
            : (['pending'] as const);
        return {
            defaultMode: 'pending',
            availableModes: [...availableModes],
            labels: {
                included: 'Included',
                pending: 'Pending',
                both: 'Combined',
            },
        };
    },
    commitActionConfig(snapshot) {
        return {
            label: snapshot?.capabilities?.operationLabels?.commit ?? 'Commit changes',
            supportsPathScopedCommit: snapshot?.capabilities?.writeCommitPathSelection === true,
            supportsLineSelection: snapshot?.capabilities?.writeCommitLineSelection === true,
        };
    },
    remoteActionConfig(snapshot) {
        return {
            fetch: snapshot?.capabilities?.writeRemoteFetch ?? true,
            pull: snapshot?.capabilities?.writeRemotePull ?? true,
            push: snapshot?.capabilities?.writeRemotePush ?? true,
            confirmationCopy: 'Sapling remote operation',
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
