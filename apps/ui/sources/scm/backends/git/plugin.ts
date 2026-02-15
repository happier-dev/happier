import type { ScmUiBackendPlugin } from '@/scm/registry/scmUiBackendPlugin';
import { resolveChangeSetModel, resolveSupportedDiffAreas } from '@/scm/registry/scmUiBackendPlugin';
import { inferScmRemoteTarget } from '@happier-dev/protocol';

export const gitScmUiPlugin: ScmUiBackendPlugin = {
    id: 'git',
    displayName: 'Git',
    mapCapabilitiesToUiPolicy(snapshot) {
        const capabilities = snapshot?.capabilities;
        const changeSetModel = resolveChangeSetModel(capabilities);
        const supportsIncludeExclude = capabilities?.writeInclude === true && capabilities?.writeExclude === true;
        return {
            supportsIncludeExclude,
            supportsLineSelection: capabilities?.writeCommitLineSelection === true || supportsIncludeExclude,
            changeSetModel,
            supportedDiffAreas: resolveSupportedDiffAreas(capabilities),
        };
    },
    diffModeConfig(snapshot) {
        const availableModes = snapshot?.capabilities
            ? resolveSupportedDiffAreas(snapshot.capabilities)
            : (['included', 'pending'] as const);
        const defaultMode = availableModes.includes('pending') ? 'pending' : (availableModes[0] ?? 'pending');
        return {
            defaultMode,
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
            label: snapshot?.capabilities?.operationLabels?.commit ?? 'Commit staged',
            supportsPathScopedCommit: snapshot?.capabilities?.writeCommitPathSelection === true,
            supportsLineSelection: snapshot?.capabilities?.writeCommitLineSelection === true,
        };
    },
    remoteActionConfig(snapshot) {
        return {
            fetch: snapshot?.capabilities?.writeRemoteFetch ?? true,
            pull: snapshot?.capabilities?.writeRemotePull ?? true,
            push: snapshot?.capabilities?.writeRemotePush ?? true,
            confirmationCopy: 'Git remote operation',
        };
    },
    inferRemoteTarget(snapshot) {
        return inferScmRemoteTarget({
            upstream: snapshot?.branch.upstream,
            head: snapshot?.branch.head,
            allowHeadFallback: true,
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
