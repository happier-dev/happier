import {
  createScmCapabilitiesFromBackendCapabilities,
  supportedCapability,
  unsupportedCapability,
  type ScmBackendCapabilities,
} from '@happier-dev/plugin-sdk/experimental/scm';

export const SAPLING_SCM_BACKEND_CAPABILITIES = {
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
        branches: unsupportedCapability(),
        stash: unsupportedCapability(),
        defaultBranch: unsupportedCapability(),
        hostingProvider: unsupportedCapability('hosting_provider_missing'),
        pullRequestStatus: unsupportedCapability('hosting_provider_missing'),
    },
    changeSet: {
        model: 'working-copy',
        diffAreas: ['pending', 'both'],
        include: unsupportedCapability(),
        exclude: unsupportedCapability(),
        discard: supportedCapability(),
    },
    commit: {
        create: supportedCapability(),
        pathSelection: supportedCapability(),
        lineSelection: unsupportedCapability(),
        backout: supportedCapability(),
    },
    remote: {
        read: supportedCapability(),
        add: unsupportedCapability(),
        setUrl: unsupportedCapability(),
        remove: unsupportedCapability(),
        fetch: unsupportedCapability(),
        pull: unsupportedCapability(),
        push: unsupportedCapability(),
        publish: unsupportedCapability(),
    },
    branch: {
        list: unsupportedCapability(),
        create: unsupportedCapability(),
        checkout: unsupportedCapability(),
        merge: unsupportedCapability(),
        rebase: unsupportedCapability(),
        operationControl: unsupportedCapability(),
    },
    worktree: {
        create: unsupportedCapability(),
        remove: unsupportedCapability(),
        prune: unsupportedCapability(),
        prepare: unsupportedCapability(),
    },
    lifecycle: {
        init: unsupportedCapability(),
        clone: unsupportedCapability(),
        publish: unsupportedCapability(),
        identityRediscovery: supportedCapability(),
        removeIndexLock: unsupportedCapability(),
    },
    hosting: {
        providerDetection: unsupportedCapability('hosting_provider_missing'),
        repositoryPublishTargets: unsupportedCapability('hosting_provider_missing'),
        repositoryPublish: unsupportedCapability('hosting_provider_missing'),
        pullRequestRead: unsupportedCapability('hosting_provider_missing'),
        pullRequestStatus: unsupportedCapability('hosting_provider_missing'),
        pullRequestCreate: unsupportedCapability('hosting_provider_missing'),
        pullRequestReuse: unsupportedCapability('hosting_provider_missing'),
        pullRequestCheckout: unsupportedCapability('hosting_provider_missing'),
        pullRequestPrepareWorktree: unsupportedCapability('hosting_provider_missing'),
        pullRequestRunStacked: unsupportedCapability('hosting_provider_missing'),
    },
    checkpoints: {
        capture: unsupportedCapability(),
        aliasFinalize: unsupportedCapability(),
        diff: unsupportedCapability(),
        cleanup: unsupportedCapability(),
        backup: unsupportedCapability(),
        rollbackApply: unsupportedCapability(),
    },
    workspaceIntegration: {
        inspectLocation: unsupportedCapability(),
        checkoutMaterialization: unsupportedCapability(),
        workspaceTransfer: unsupportedCapability(),
        exportPortability: unsupportedCapability(),
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
        commit: 'Commit changes',
    },
} satisfies ScmBackendCapabilities;

export function createSaplingCapabilities() {
    return createScmCapabilitiesFromBackendCapabilities(SAPLING_SCM_BACKEND_CAPABILITIES);
}
