import {
  createScmCapabilitiesFromBackendCapabilities,
  supportedCapability,
  unsupportedCapability,
  type ScmBackendCapabilities,
} from '@happier-dev/plugin-sdk/scm';

export const GIT_SCM_BACKEND_CAPABILITIES = {
    detection: {
        repository: supportedCapability(),
        repoIdentity: supportedCapability(),
        ignoredPath: supportedCapability(),
        repoMode: supportedCapability(),
        executable: supportedCapability(),
    },
    read: {
        status: supportedCapability(),
        diffFile: supportedCapability(),
        diffCommit: supportedCapability(),
        log: supportedCapability(),
        branches: supportedCapability(),
        stash: supportedCapability(),
        defaultBranch: supportedCapability(),
        hostingProvider: supportedCapability(),
        pullRequestStatus: supportedCapability(),
    },
    changeSet: {
        model: 'index',
        diffAreas: ['included', 'pending', 'both'],
        include: supportedCapability(),
        exclude: supportedCapability(),
        discard: supportedCapability(),
    },
    commit: {
        create: supportedCapability(),
        pathSelection: supportedCapability(),
        lineSelection: supportedCapability(),
        backout: supportedCapability(),
    },
    remote: {
        read: supportedCapability(),
        add: supportedCapability(),
        setUrl: supportedCapability(),
        remove: supportedCapability(),
        fetch: supportedCapability(),
        pull: supportedCapability(),
        push: supportedCapability(),
        publish: supportedCapability(),
    },
    branch: {
        list: supportedCapability(),
        create: supportedCapability(),
        checkout: supportedCapability(),
        merge: supportedCapability(),
        rebase: supportedCapability(),
        operationControl: supportedCapability(),
    },
    worktree: {
        create: supportedCapability(),
        remove: supportedCapability(),
        prune: supportedCapability(),
        prepare: supportedCapability(),
    },
    lifecycle: {
        init: supportedCapability(),
        clone: supportedCapability(),
        publish: supportedCapability(),
        identityRediscovery: supportedCapability(),
        removeIndexLock: supportedCapability(),
    },
    hosting: {
        providerDetection: supportedCapability(),
        repositoryPublishTargets: supportedCapability(),
        repositoryPublish: supportedCapability(),
        pullRequestRead: supportedCapability(),
        pullRequestStatus: supportedCapability(),
        pullRequestCreate: supportedCapability(),
        pullRequestReuse: supportedCapability(),
        pullRequestCheckout: supportedCapability(),
        pullRequestPrepareWorktree: supportedCapability(),
        pullRequestRunStacked: supportedCapability(),
    },
    checkpoints: {
        capture: supportedCapability(),
        aliasFinalize: supportedCapability(),
        diff: supportedCapability(),
        cleanup: supportedCapability(),
        backup: supportedCapability(),
        rollbackApply: supportedCapability(),
    },
    workspaceIntegration: {
        inspectLocation: supportedCapability(),
        checkoutMaterialization: supportedCapability(),
        workspaceTransfer: supportedCapability(),
        exportPortability: supportedCapability(),
        portablePathClassification: supportedCapability(),
    },
    tooling: {
        systemCliResolution: supportedCapability(),
        managedCliResolution: unsupportedCapability(),
        binarySafe: supportedCapability(),
    },
    freshness: {
        observed: supportedCapability(),
        expiry: supportedCapability(),
    },
    operationLabels: {
        commit: 'Commit staged',
    },
} satisfies ScmBackendCapabilities;

export function createGitCapabilities() {
    return createScmCapabilitiesFromBackendCapabilities(GIT_SCM_BACKEND_CAPABILITIES);
}
