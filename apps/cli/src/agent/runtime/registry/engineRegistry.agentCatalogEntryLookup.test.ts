import { describe, expect, it } from 'vitest';
import { InstallableDependencyDescriptorSchema } from '@happier-dev/protocol';

import type {
    ResolvedAgentContribution,
    ResolvedCatalogEntry,
    ResolvedContributionRegistry,
    ResolvedInstallableContribution,
} from '../../../plugins/projection/registry/types';
import { createPluginExecInstallablesRegistry } from './engineRegistry/contributions';

const AGENT_ID = 'antigravity';

function createAgentCatalogEntry(params?: Readonly<{
    getTerminalPromptSubmitVerificationPolicy?: ResolvedCatalogEntry['getTerminalPromptSubmitVerificationPolicy'];
}>): ResolvedCatalogEntry {
    return {
        id: AGENT_ID,
        cliSubcommand: AGENT_ID,
        vendorResumeSupport: 'unsupported',
        ...params,
    } as ResolvedCatalogEntry;
}

function createAgentContribution(catalogEntry: ResolvedCatalogEntry): ResolvedAgentContribution {
    return {
        id: AGENT_ID,
        provenance: 'first_party',
        source: { kind: 'bundled' },
        definition: {
            kindVersion: 1,
            id: AGENT_ID,
            ownedBackendIds: [AGENT_ID],
        },
        runtimeSpec: null,
        catalogEntry,
    };
}

function createContributionRegistry(catalogEntry: ResolvedCatalogEntry): ResolvedContributionRegistry {
    const agent = createAgentContribution(catalogEntry);
    return {
        agents: [agent],
        actions: [],
        resources: [],
        uiViewsV2: [],
        uiRenderersV2: [],
        uiTranslationsV2: [],
        notifications: [],
        notificationChannels: [],
        events: [],
        executionRunProfiles: [],
        managedDependencies: [],
        requestInterceptors: [],
        scmHostingProviders: [],
        scmBackends: [],
        connectedAccountDescriptors: [],
        activationTargets: [],
                catalogEntriesById: {
            [AGENT_ID]: catalogEntry,
        },
        agentDefinitionsById: new Map([[AGENT_ID, agent]]),
        pluginDiagnosticsByPluginId: {},
    };
}

describe('engineRegistry Agent catalog-entry lookup', () => {
    it('builds the plugin exec installables registry from managedDependencies contributions', () => {
        const descriptor = InstallableDependencyDescriptorSchema.parse({
            id: 'acme-release-tool',
            key: 'acme-release-tool',
            kind: 'dep',
            version: '1',
            capabilityId: 'dep.acme-release-tool',
            display: { name: 'Acme Release Tool' },
            description: 'Acme release tool dependency',
            source: {
                kind: 'github_release_binary',
                repo: 'acme/release-tool',
                distTag: 'latest',
            },
            binary: {
                commands: ['acme-release-tool'],
                systemFirst: true,
                managedFallback: true,
            },
            defaultPolicy: {
                autoInstallWhenNeeded: false,
                autoUpdateMode: 'notify',
            },
            consent: {
                install: 'required',
                update: 'required',
            },
        });
        const contribution = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.plugin',
            manifestPath: '/plugins/acme/plugin.json',
            daemonEntryPath: '/plugins/acme/daemon.mjs',
            definition: descriptor,
        } satisfies ResolvedInstallableContribution;
        const contributes = {
            ...createContributionRegistry(createAgentCatalogEntry()),
            managedDependencies: [contribution],
        };

        const installablesRegistry = createPluginExecInstallablesRegistry(contributes);

        expect(installablesRegistry?.descriptorsByKey['acme-release-tool']).toMatchObject({
            owner: {
                provenance: 'external_plugin',
                pluginId: 'acme.plugin',
                },
            descriptor: {
                key: 'acme-release-tool',
                capabilityId: 'dep.acme-release-tool',
            },
        });
    });

    it('does not coerce declarative managed-dependency requests into executable installable descriptors', () => {
        const contribution = {
            provenance: 'first_party',
            source: { kind: 'bundled' },
            pluginId: 'happier.agent.codex',
            definition: {
                id: 'codex-acp',
                title: 'Codex ACP adapter',
                sources: [{ kind: 'vendorRecipe', recipeId: 'codex-acp' }],
                executable: 'codex-acp',
            },
        } satisfies ResolvedInstallableContribution;
        const contributes = {
            ...createContributionRegistry(createAgentCatalogEntry()),
            managedDependencies: [contribution],
        };

        expect(createPluginExecInstallablesRegistry(contributes)).toBeUndefined();
    });
});
