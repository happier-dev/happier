import type { ScmBackendContribution } from '@happier-dev/protocol';
import type { ScmBackendRuntimeRegistration, ScmHostingProviderRuntimeServices } from '@happier-dev/plugin-sdk';

import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';

import type { ScmBackend } from '../types';
import { createRegisteredScmBackendAdapter } from './registeredScmBackendAdapter';

export type RegisteredScmBackendDefinition = Readonly<{
    pluginId: string;
    contributionId: string;
    definition: ScmBackendContribution;
}>;

export type RegisteredScmBackendActivation = Readonly<{
    pluginId: string;
    registration: ScmBackendRuntimeRegistration;
}>;

type SupportedLeaf = Readonly<{
    key: string;
    hasHandler: (registration: ScmBackendRuntimeRegistration) => boolean;
}>;

const EXECUTABLE_SUPPORTED_LEAVES: readonly SupportedLeaf[] = [
    {
        key: 'detection.repository',
        hasHandler: (registration) => typeof registration.handlers.detection?.detectRepo === 'function',
    },
    {
        key: 'read.status',
        hasHandler: (registration) => typeof registration.handlers.read?.statusSnapshot === 'function',
    },
    {
        key: 'read.diffFile',
        hasHandler: (registration) => typeof registration.handlers.read?.diffFile === 'function',
    },
    {
        key: 'read.diffCommit',
        hasHandler: (registration) => typeof registration.handlers.read?.diffCommit === 'function',
    },
    {
        key: 'read.log',
        hasHandler: (registration) => typeof registration.handlers.read?.logList === 'function',
    },
    {
        key: 'read.branches',
        hasHandler: (registration) => typeof registration.handlers.branch?.list === 'function',
    },
    {
        key: 'read.stash',
        hasHandler: (registration) => typeof registration.handlers.read?.stashList === 'function',
    },
    { key: 'read.hostingProvider', hasHandler: (registration) => typeof registration.handlers.read?.statusSnapshot === 'function' },
    { key: 'read.pullRequestStatus', hasHandler: (registration) => typeof registration.handlers.read?.statusSnapshot === 'function' },
    { key: 'changeSet.include', hasHandler: (registration) => typeof registration.handlers.changeSet?.include === 'function' },
    { key: 'changeSet.exclude', hasHandler: (registration) => typeof registration.handlers.changeSet?.exclude === 'function' },
    { key: 'changeSet.discard', hasHandler: (registration) => typeof registration.handlers.changeSet?.discard === 'function' },
    { key: 'commit.create', hasHandler: (registration) => typeof registration.handlers.commit?.create === 'function' },
    { key: 'commit.pathSelection', hasHandler: (registration) => typeof registration.handlers.commit?.create === 'function' },
    { key: 'commit.lineSelection', hasHandler: (registration) => typeof registration.handlers.commit?.create === 'function' },
    { key: 'commit.backout', hasHandler: (registration) => typeof registration.handlers.commit?.backout === 'function' },
    { key: 'remote.add', hasHandler: (registration) => typeof registration.handlers.remote?.add === 'function' },
    { key: 'remote.setUrl', hasHandler: (registration) => typeof registration.handlers.remote?.setUrl === 'function' },
    { key: 'remote.remove', hasHandler: (registration) => typeof registration.handlers.remote?.remove === 'function' },
    { key: 'remote.fetch', hasHandler: (registration) => typeof registration.handlers.remote?.fetch === 'function' },
    { key: 'remote.pull', hasHandler: (registration) => typeof registration.handlers.remote?.pull === 'function' },
    { key: 'remote.push', hasHandler: (registration) => typeof registration.handlers.remote?.push === 'function' },
    { key: 'remote.publish', hasHandler: (registration) => typeof registration.handlers.remote?.publish === 'function' },
    { key: 'branch.create', hasHandler: (registration) => typeof registration.handlers.branch?.create === 'function' },
    { key: 'branch.checkout', hasHandler: (registration) => typeof registration.handlers.branch?.checkout === 'function' },
    { key: 'branch.merge', hasHandler: (registration) => typeof registration.handlers.branch?.merge === 'function' },
    { key: 'branch.rebase', hasHandler: (registration) => typeof registration.handlers.branch?.rebase === 'function' },
    {
        key: 'branch.operationControl',
        hasHandler: (registration) => (
            typeof registration.handlers.branch?.operationContinue === 'function'
            && typeof registration.handlers.branch?.operationAbort === 'function'
        ),
    },
    { key: 'worktree.create', hasHandler: (registration) => typeof registration.handlers.worktree?.create === 'function' },
    { key: 'worktree.remove', hasHandler: (registration) => typeof registration.handlers.worktree?.remove === 'function' },
    { key: 'worktree.prune', hasHandler: (registration) => typeof registration.handlers.worktree?.prune === 'function' },
    { key: 'lifecycle.init', hasHandler: (registration) => typeof registration.handlers.lifecycle?.init === 'function' },
    { key: 'lifecycle.removeIndexLock', hasHandler: (registration) => typeof registration.handlers.lifecycle?.removeIndexLock === 'function' },
    { key: 'hosting.providerDetection', hasHandler: (registration) => typeof registration.handlers.read?.statusSnapshot === 'function' },
    {
        key: 'hosting.repositoryPublishTargets',
        hasHandler: (registration) => typeof registration.handlers.hosting?.repositoryDescribePublishTargets === 'function',
    },
    { key: 'hosting.repositoryPublish', hasHandler: (registration) => typeof registration.handlers.hosting?.repositoryPublish === 'function' },
    { key: 'hosting.pullRequestStatus', hasHandler: (registration) => typeof registration.handlers.read?.statusSnapshot === 'function' },
    { key: 'hosting.pullRequestCreate', hasHandler: (registration) => typeof registration.handlers.hosting?.pullRequestOpenCompose === 'function' },
    { key: 'hosting.pullRequestReuse', hasHandler: (registration) => typeof registration.handlers.hosting?.pullRequestOpenOrReuse === 'function' },
    { key: 'hosting.pullRequestCheckout', hasHandler: () => false },
    { key: 'hosting.pullRequestPrepareWorktree', hasHandler: () => false },
    { key: 'hosting.pullRequestRunStacked', hasHandler: () => false },
    { key: 'workspaceIntegration.inspectLocation', hasHandler: (registration) => typeof registration.handlers.workspaceIntegration?.inspectWorkspaceLocation === 'function' },
    {
        key: 'workspaceIntegration.checkoutMaterialization',
        hasHandler: (registration) => (
            typeof registration.handlers.workspaceIntegration?.realizeWorkspaceCheckout === 'function'
            || typeof registration.handlers.workspaceIntegration?.createWorkspaceCheckout === 'function'
            || typeof registration.handlers.workspaceIntegration?.materializeWorkspaceCheckout === 'function'
        ),
    },
    {
        key: 'workspaceIntegration.workspaceTransfer',
        hasHandler: (registration) => (
            typeof registration.handlers.workspaceIntegration?.resolveWorkspaceTransferEntries === 'function'
            && typeof registration.handlers.workspaceIntegration?.resolveWorkspaceTransferMetadata === 'function'
        ),
    },
    { key: 'workspaceIntegration.exportPortability', hasHandler: (registration) => typeof registration.handlers.workspaceIntegration?.assertPortableWorkspaceEntries === 'function' },
    { key: 'workspaceIntegration.portablePathClassification', hasHandler: (registration) => typeof registration.handlers.workspaceIntegration?.classifyPortableWorkspacePath === 'function' },
];

function isLeafAdvertised(definition: ScmBackendContribution, key: string): boolean {
    const [group, leaf] = key.split('.') as [keyof ScmBackendContribution['capabilities'], string];
    const groupValue = definition.capabilities[group];
    if (!groupValue || typeof groupValue !== 'object' || Array.isArray(groupValue)) {
        return false;
    }
    const leafValue = (groupValue as Record<string, unknown>)[leaf];
    return Boolean(
        leafValue
        && typeof leafValue === 'object'
        && !Array.isArray(leafValue)
        && ((leafValue as { support?: unknown }).support === 'supported'
            || (leafValue as { support?: unknown }).support === 'experimental'),
    );
}

function createOwnerContributionKey(input: Readonly<{
    pluginId: string;
    contributionId: string;
}>): string {
    return `${input.pluginId}\0${input.contributionId}`;
}

export function createRegisteredScmBackendRegistry(input: Readonly<{
    definitions: readonly RegisteredScmBackendDefinition[];
    registrations: readonly RegisteredScmBackendActivation[];
    hostingProviderRuntimeServices?: ScmHostingProviderRuntimeServices;
}>): Readonly<{
    backends: readonly ScmBackend[];
    diagnostics: readonly PluginCompatibilityDiagnostic[];
    diagnosticsByPluginId: Readonly<Record<string, readonly PluginCompatibilityDiagnostic[]>>;
}> {
    const diagnostics: PluginCompatibilityDiagnostic[] = [];
    const diagnosticsByPluginId: Record<string, PluginCompatibilityDiagnostic[]> = {};
    const registrationsByOwnerAndId = new Map(input.registrations.map((activation) => [
        createOwnerContributionKey({
            pluginId: activation.pluginId,
            contributionId: activation.registration.id,
        }),
        activation,
    ] as const));
    const backends: ScmBackend[] = [];

    function appendDiagnostic(pluginId: string, diagnostic: PluginCompatibilityDiagnostic): void {
        diagnostics.push(diagnostic);
        const existing = diagnosticsByPluginId[pluginId] ?? [];
        existing.push(diagnostic);
        diagnosticsByPluginId[pluginId] = existing;
    }

    for (const entry of input.definitions) {
        const registrationEntry = registrationsByOwnerAndId.get(createOwnerContributionKey({
            pluginId: entry.pluginId,
            contributionId: entry.contributionId,
        }));
        if (!registrationEntry) {
            appendDiagnostic(entry.pluginId, {
                code: 'plugin_scm_backend_missing_activation',
                message: `Plugin '${entry.pluginId}' SCM backend '${entry.contributionId}' declared executable capabilities without activation registration`,
            });
            continue;
        }

        const missingHandlers = EXECUTABLE_SUPPORTED_LEAVES
            .filter((leaf) => isLeafAdvertised(entry.definition, leaf.key) && !leaf.hasHandler(registrationEntry.registration))
            .map((leaf) => leaf.key);
        if (missingHandlers.length > 0) {
            appendDiagnostic(entry.pluginId, {
                code: 'plugin_scm_backend_activation_drift',
                message: `Plugin '${entry.pluginId}' SCM backend '${entry.contributionId}' is missing handlers for advertised leaves: ${missingHandlers.join(', ')}`,
            });
            continue;
        }

        backends.push(createRegisteredScmBackendAdapter({
            definition: entry.definition,
            registration: registrationEntry.registration,
            hostingProviderRuntimeServices: input.hostingProviderRuntimeServices,
        }));
    }

    for (const entry of input.registrations) {
        if (!input.definitions.some((definition) => (
            definition.pluginId === entry.pluginId
            && definition.contributionId === entry.registration.id
        ))) {
            appendDiagnostic(entry.pluginId, {
                code: 'plugin_scm_backend_undeclared_id',
                message: `Plugin '${entry.pluginId}' SCM backend '${entry.registration.id}' activation has no matching manifest contribution`,
            });
        }
    }

    return {
        backends: Object.freeze(backends),
        diagnostics: Object.freeze(diagnostics),
        diagnosticsByPluginId: Object.freeze(Object.fromEntries(
            Object.entries(diagnosticsByPluginId).map(([pluginId, pluginDiagnostics]) => [
                pluginId,
                Object.freeze([...pluginDiagnostics]),
            ]),
        )),
    };
}
