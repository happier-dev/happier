import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
    TeamCredentialProviderModelSelectionV1Schema,
    TeamCredentialResourceCatalogEntryV1Schema,
    type TeamCredentialResourceCatalogEntryV1,
} from '@happier-dev/protocol/teams';
import type { RunnerActivationClient } from '@/sync/api/ephemeralRunner/runnerActivationClient';
import { InstalledPluginCapabilityEntryV1Schema } from '@happier-dev/protocol/capabilities';
import { BUILT_IN_REGISTRY_SOURCES_V1, createRegistryHostV1, RegistryFetchErrorV1, type RegistrySourceDescriptorV1, type RegistryRemoteSourceDescriptorV1 } from '@happier-dev/protocol/registries';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { installPromptRegistriesCommonModuleMocks } from '@/components/settings/prompts/registries/promptRegistriesScreenTestHelpers';
import { createPlainMachineReadHttpResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { DEFAULT_CURATED_MARKETPLACE_SOURCE_URL, deriveMarketplaceSourceId } from '@happier-dev/protocol/marketplace/marketplaceSourceRegistryV1';
import { ExpectedMarketplaceListingV1Schema } from '@happier-dev/protocol/marketplace/internal';
import { MarketplaceIndexSourceSnapshotV1Schema } from '@happier-dev/protocol/marketplace/marketplaceIndexV1';

import { createTemporaryComputerCreatorDependencies } from './temporaryComputerCreatorDependencies';

installPromptRegistriesCommonModuleMocks({ storage: original => original() });
vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
const { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
installDisconnectedServerSocketBoundary();
// Collect the real execution graph before the test's lifecycle begins. The
// composed test exercises requests, not the bundler's cold module transform.
const { useMountedActionExecution } = await import('@/components/approvals/useMountedActionExecution');
const { createPlainPromptLibraryCatalogHomeFixture } = await import('@/dev/testkit/harness/promptLibraryCatalogBoundary');
await Promise.all([import('@/auth/storage/tokenStorage'), import('@/sync/domains/state/storage'),
    import('@/utils/system/runtimeFetch'), import('@/sync/runtime/orchestration/appliedActiveServerRuntime')]);

const AGENT_TARGET_KEY = 'agent:happier.agent.codex/codex';

/** `codex` declares a managed CLI install recipe; `antigravity` deliberately does not. */
const MANAGED_INSTALL_AGENT = { pluginId: 'happier.agent.codex', localId: 'codex' } as const;
const VENDOR_GUIDE_ONLY_AGENT = { pluginId: 'happier.agent.antigravity', localId: 'antigravity' } as const;

const BROKER_BINDING = {
    v: 1,
    resourceId: 'resource-1',
    brokerMachineId: 'broker-1',
    revision: 7,
    application: {
        agentTargetKey: AGENT_TARGET_KEY,
        implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' },
        endpointTemplateId: 'responses',
        protocol: 'openai-responses',
    },
    sourceRevision: 'source-revision-1',
} as const;
const DISPLAY_FACTS = { v: 1, homeId: 'srv-runner', homeName: 'Acme Home', requesterId: 'account-a', requesterName: 'Alice', teamId: 'team-1', teamName: 'Platform' } as const;

function catalogEntry(overrides: Readonly<{
    id?: string;
    mayBroker?: boolean;
    availability?: 'available' | 'policy_denied';
    resourceRevision?: number;
    deliveryMode?: 'brokered' | 'direct';
}> = {}): TeamCredentialResourceCatalogEntryV1 {
    const id = overrides.id ?? 'resource-1';
    return TeamCredentialResourceCatalogEntryV1Schema.parse({
        id,
        teamId: 'team-1',
        displayName: 'Shared Codex',
        resourceRevision: overrides.resourceRevision ?? 7,
        readiness: { kind: 'available' },
        recoveryAction: null,
        mayBroker: overrides.mayBroker ?? true,
        mayReceiveDirect: false,
        directMaterialState: 'never_delivered',
        sessionUsePolicy: 'personal_allowed',
        providerModels: [{
            selection: {
                kind: 'team_credential_provider_model',
                resourceId: id,
                teamId: 'team-1',
                expectedResourceRevision: overrides.resourceRevision ?? 7,
                agentTargetKey: AGENT_TARGET_KEY,
                modelId: 'gpt-5',
                deliveryMode: overrides.deliveryMode ?? 'brokered',
            },
            descriptor: { id: 'gpt-5', name: 'GPT-5' },
            application: {
                agentTargetKey: AGENT_TARGET_KEY,
                implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' },
                endpointTemplateId: 'responses',
                protocol: 'openai_responses',
            },
            sourceRevision: 'source-revision-1',
            availability: overrides.availability ?? 'available',
        }],
        sourcePresentation: {
            kind: 'provider',
            provider: { identity: { pluginId: 'happier.provider.openai', localId: 'openai' }, definitionRevision: 1 },
        },
    });
}

function selection(revision = 7, deliveryMode: 'brokered' | 'direct' = 'brokered', resourceId = 'resource-1') {
    return TeamCredentialProviderModelSelectionV1Schema.parse({
        kind: 'team_credential_provider_model',
        resourceId,
        teamId: 'team-1',
        expectedResourceRevision: revision,
        agentTargetKey: AGENT_TARGET_KEY,
        modelId: 'gpt-5',
        deliveryMode,
    });
}

const EXTERNAL_AGENT = { pluginId: 'acme.reviewed-external', localId: 'assistant' } as const;
const EXTERNAL_AGENT_TARGET_KEY = 'agent:acme.reviewed-external/assistant';

/** Catalog facts shared by the registry adapters and the strict install projector. */
function marketplaceListing(overrides: Readonly<{ sourceKind?: 'curated' | 'community-npm' | 'user' }> = {}) {
    const sourceKind = overrides.sourceKind ?? 'community-npm';
    return {
        pluginId: EXTERNAL_AGENT.pluginId,
        publisher: { id: 'acme', displayName: 'Acme' },
        display: { title: 'Reviewed External', description: null },
        distribution: {
            kind: 'npm',
            registryOrigin: 'https://registry.npmjs.org',
            packageName: '@acme/reviewed-external',
            version: '1.2.3',
            integrity: `sha512-${'A'.repeat(86)}==`,
        },
        manifestDigest: `sha256:${'b'.repeat(64)}`,
        compatibility: { platforms: ['linux', 'darwin'] },
        summary: { contributions: ['agent'], requiredHostAccess: [], optionalHostAccess: [], executableRealms: ['daemon'] },
        review: { status: sourceKind === 'curated' ? 'approved' : 'unreviewed', reviewedAt: sourceKind === 'curated' ? '2026-01-02T03:04:05.000Z' : null },
        updatePolicy: 'pinned',
        categories: [],
        media: [],
        links: {},
        source: {
            id: sourceKind === 'community-npm' ? 'marketplace:community-npm' : 'acme-catalog',
            title: 'Acme',
            kind: sourceKind,
            sourceUrl: 'https://registry.npmjs.org/',
        },
        artifactAccess: { state: 'available', registryProfileId: null },
    };
}

function compose(params: Readonly<{
    serverId?: string | null;
    resources?: readonly TeamCredentialResourceCatalogEntryV1[];
    currentKeys?: ReadonlySet<string>;
    selected?: ReturnType<typeof selection> | null;
    agentCatalogMachineId?: string | null;
    projectedAgentsById?: Readonly<Record<string, unknown>>;
    installedPluginPackagesById?: Readonly<Record<string, unknown>>;
    registryActionExecution?: Parameters<typeof createTemporaryComputerCreatorDependencies>[0]['registryActionExecution'];
    readInstalledPlugins?: Parameters<typeof createTemporaryComputerCreatorDependencies>[0]['readInstalledPlugins'];
}> = {}) {
    return createTemporaryComputerCreatorDependencies({
        teamCredentialServerId: params.serverId === undefined ? 'srv-runner' : params.serverId,
        teamCredentialResources: params.resources ?? [catalogEntry()],
        teamCredentialResourceStatusByKey: new Map([...(params.currentKeys ?? ['team-1:resource-1'])].map(key => [key, { kind: 'current' as const }])),
        selectedTeamCredentialModel: params.selected ?? null,
        agentCatalogMachineId: params.agentCatalogMachineId === undefined ? 'machine-1' : params.agentCatalogMachineId,
        projectedAgentsById: (params.projectedAgentsById ?? {}) as never,
        installedPluginPackagesById: (params.installedPluginPackagesById ?? {}) as never,
        ...(params.registryActionExecution ? { registryActionExecution: params.registryActionExecution } : {}),
        ...(params.readInstalledPlugins ? { readInstalledPlugins: params.readInstalledPlugins } : {}),
    });
}

/**
 * The broker resolution route is a genuine Home boundary. Everything beneath it —
 * catalog matching, currentness and the produced binding — stays real.
 */
function resolutionClient(response: unknown) {
    const resolveCredentialSelection = vi.fn(async () => response);
    return {
        client: { resolveCredentialSelection } as unknown as RunnerActivationClient,
        resolveCredentialSelection,
    };
}

const preparedAuthoring = {
    authoring: {
        primaryTeamId: 'team-1',
        access: { grants: [{ subject: { kind: 'team', teamId: 'team-1' }, accessLevel: 'edit', canApprovePermissions: false }] },
    },
    // Only the fields this producer reads are populated; the full reviewed
    // manifest is built by its own protocol owner.
} as unknown as Parameters<
    ReturnType<typeof compose>['dependencies']['resolveCredentialSelectionBinding']
>[0]['preparedAuthoring'];

const projection = { activationId: 'activation-1' } as unknown as Parameters<
    ReturnType<typeof compose>['dependencies']['resolveCredentialSelectionBinding']
>[0]['projection'];

describe('createTemporaryComputerCreatorDependencies', () => {
    it('admits an Agent only when it can be installed unattended and a current brokerable model exists', () => {
        const composed = compose();

        expect(composed.dependencies.isAuthoringCompatible({
            backendTargetKey: AGENT_TARGET_KEY,
            agentTarget: { kind: 'agent', identity: MANAGED_INSTALL_AGENT },
        })).toBe(true);
        expect(composed.readGaps()).toEqual([]);
    });

    it('separates destination eligibility from exact selected-model launch readiness', () => {
        const withoutSelection = compose({ selected: null });
        const staleSelection = compose({ resources: [catalogEntry({ resourceRevision: 8 })], selected: selection(7) });
        const exactSelection = compose({ selected: selection() });
        const authoring = {
            backendTargetKey: AGENT_TARGET_KEY,
            agentTarget: { kind: 'agent', identity: MANAGED_INSTALL_AGENT },
        } as const;

        expect(withoutSelection.dependencies.isAuthoringCompatible(authoring)).toBe(true);
        expect(withoutSelection.dependencies.isLaunchReady(authoring)).toBe(false);
        expect(withoutSelection.readGaps()).toContain('team_credential_model_unselected');

        expect(staleSelection.dependencies.isAuthoringCompatible(authoring)).toBe(true);
        expect(staleSelection.dependencies.isLaunchReady(authoring)).toBe(false);
        expect(staleSelection.readGaps()).toContain('team_credential_resource_unavailable');

        expect(exactSelection.dependencies.isLaunchReady(authoring)).toBe(true);
    });

    it('withdraws launch readiness when the selected model belongs to another Agent', () => {
        const selected = TeamCredentialProviderModelSelectionV1Schema.parse({
            ...selection(),
            agentTargetKey: 'agent:happier.agent.opencode/opencode',
        });
        const composed = compose({ selected });

        expect(composed.dependencies.isLaunchReady({
            backendTargetKey: AGENT_TARGET_KEY,
            agentTarget: { kind: 'agent', identity: MANAGED_INSTALL_AGENT },
        })).toBe(false);
        expect(composed.readGaps()).toContain('team_credential_resource_unavailable');
    });

    it('does not reinterpret a direct Provider selection as brokered Runner authority', async () => {
        const directSelection = selection(7, 'direct');
        const composed = compose({
            resources: [catalogEntry({ deliveryMode: 'direct' })],
            selected: directSelection,
        });
        const authoring = {
            backendTargetKey: AGENT_TARGET_KEY,
            agentTarget: { kind: 'agent', identity: MANAGED_INSTALL_AGENT },
        } as const;
        const { client, resolveCredentialSelection } = resolutionClient({
            status: 'resolved',
            credentialSelectionBinding: BROKER_BINDING,
            displayFacts: DISPLAY_FACTS,
        });

        expect(composed.dependencies.isAuthoringCompatible(authoring)).toBe(false);
        expect(composed.dependencies.isLaunchReady(authoring)).toBe(false);
        await expect(composed.dependencies.resolveCredentialSelectionBinding({
            projection,
            preparedAuthoring,
            submittedTeamCredentialModel: directSelection,
            client,
            signal: new AbortController().signal,
        })).resolves.toBeNull();
        expect(resolveCredentialSelection).not.toHaveBeenCalled();
        expect(composed.readGaps()).toContain('team_credential_resource_unavailable');
    });

    it('withdraws launch readiness when the selected model is no longer in the current resource', () => {
        const selected = TeamCredentialProviderModelSelectionV1Schema.parse({
            ...selection(),
            modelId: 'removed-model',
        });
        const composed = compose({ selected });

        expect(composed.dependencies.isLaunchReady({
            backendTargetKey: AGENT_TARGET_KEY,
            agentTarget: { kind: 'agent', identity: MANAGED_INSTALL_AGENT },
        })).toBe(false);
        expect(composed.readGaps()).toContain('team_credential_resource_unavailable');
    });

    it('produces no decision at all without the exact Home the catalog belongs to', async () => {
        // The entitled catalog, its currentness and the selected model are all
        // Home-scoped facts. Answering without the Home they were read for would
        // let one Home's resource/revision be frozen into another Home's
        // activation, which the endpoint could never broker.
        const composed = compose({ serverId: null, selected: selection() });
        const authoring = {
            backendTargetKey: AGENT_TARGET_KEY,
            agentTarget: { kind: 'agent', identity: MANAGED_INSTALL_AGENT },
        } as const;
        const { client, resolveCredentialSelection } = resolutionClient({
            status: 'resolved',
            credentialSelectionBinding: BROKER_BINDING,
            displayFacts: DISPLAY_FACTS,
        });

        expect(composed.dependencies.isAuthoringCompatible(authoring)).toBe(false);
        expect(composed.dependencies.isLaunchReady(authoring)).toBe(false);
        await expect(composed.dependencies.resolveCredentialSelectionBinding({
            projection,
            preparedAuthoring,
            submittedTeamCredentialModel: selection(),
            client,
            signal: new AbortController().signal,
        })).resolves.toBeNull();
        expect(resolveCredentialSelection).not.toHaveBeenCalled();
        expect(composed.readGaps()).toContain('broker_selection_unavailable');
    });

    it('fails closed for an Agent with no managed install recipe', () => {
        const composed = compose();

        expect(composed.dependencies.isAuthoringCompatible({
            backendTargetKey: AGENT_TARGET_KEY,
            agentTarget: { kind: 'agent', identity: VENDOR_GUIDE_ONLY_AGENT },
        })).toBe(false);
        expect(composed.readGaps()).toContain('agent_managed_install_undeclared');
    });

    it('fails closed when the only brokerable resource row is stale', () => {
        const composed = compose({ currentKeys: new Set() });

        expect(composed.dependencies.isAuthoringCompatible({
            backendTargetKey: AGENT_TARGET_KEY,
            agentTarget: { kind: 'agent', identity: MANAGED_INSTALL_AGENT },
        })).toBe(false);
        expect(composed.readGaps()).toContain('team_credential_resource_unavailable');
    });

    it('fails closed when the resource cannot broker for this Account', () => {
        const composed = compose({ resources: [catalogEntry({ mayBroker: false })] });

        expect(composed.dependencies.isAuthoringCompatible({
            backendTargetKey: AGENT_TARGET_KEY,
            agentTarget: { kind: 'agent', identity: MANAGED_INSTALL_AGENT },
        })).toBe(false);
        expect(composed.readGaps()).toContain('team_credential_resource_unavailable');
    });

    it('resolves the credential selection binding through the Home rather than inventing a broker', async () => {
        const composed = compose({ selected: selection() });
        const { client, resolveCredentialSelection } = resolutionClient({
            status: 'resolved',
            credentialSelectionBinding: BROKER_BINDING,
            displayFacts: DISPLAY_FACTS,
        });

        await expect(composed.dependencies.resolveCredentialSelectionBinding({
            projection,
            preparedAuthoring,
            submittedTeamCredentialModel: selection(),
            client,
            signal: new AbortController().signal,
        })).resolves.toEqual({
            binding: BROKER_BINDING,
            reviewedProviderModel: catalogEntry().providerModels[0],
            displayFacts: DISPLAY_FACTS,
        });
        expect(resolveCredentialSelection).toHaveBeenCalledTimes(1);
        expect(composed.readGaps()).not.toContain('broker_selection_unavailable');
    });

    it('reviews the frozen submitted Team model, never the composer\'s current choice', async () => {
        // Package prepared with resource A; the composer now shows resource B for
        // the same Agent and model. Review must bind A, exactly as submitted.
        const submittedA = selection(7, 'brokered', 'resource-1');
        const composed = compose({
            resources: [catalogEntry({ id: 'resource-1' }), catalogEntry({ id: 'resource-2' })],
            currentKeys: new Set(['team-1:resource-1', 'team-1:resource-2']),
            selected: selection(7, 'brokered', 'resource-2'),
        });
        const { client, resolveCredentialSelection } = resolutionClient({
            status: 'resolved',
            credentialSelectionBinding: BROKER_BINDING,
            displayFacts: DISPLAY_FACTS,
        });

        await expect(composed.dependencies.resolveCredentialSelectionBinding({
            projection,
            preparedAuthoring,
            submittedTeamCredentialModel: submittedA,
            client,
            signal: new AbortController().signal,
        })).resolves.toMatchObject({ reviewedProviderModel: { selection: { resourceId: 'resource-1' } } });
        expect(resolveCredentialSelection).toHaveBeenCalledWith(
            'activation-1',
            expect.objectContaining({ selection: expect.objectContaining({ resourceId: 'resource-1' }) }),
            expect.any(AbortSignal),
        );
    });

    it('reports the submitted Team model unavailable instead of substituting the current one', async () => {
        // A was revoked from the catalog after Send; B is current and selected.
        const composed = compose({
            resources: [catalogEntry({ id: 'resource-2' })],
            currentKeys: new Set(['team-1:resource-2']),
            selected: selection(7, 'brokered', 'resource-2'),
        });
        const { client, resolveCredentialSelection } = resolutionClient({
            status: 'resolved',
            credentialSelectionBinding: BROKER_BINDING,
            displayFacts: DISPLAY_FACTS,
        });

        await expect(composed.dependencies.resolveCredentialSelectionBinding({
            projection,
            preparedAuthoring,
            submittedTeamCredentialModel: selection(7, 'brokered', 'resource-1'),
            client,
            signal: new AbortController().signal,
        })).resolves.toBeNull();
        expect(resolveCredentialSelection).not.toHaveBeenCalled();
        expect(composed.readGaps()).toContain('team_credential_resource_unavailable');
    });

    it('reports an unresolvable broker instead of falling back to a guessed binding', async () => {
        const composed = compose({ selected: selection() });
        const { client } = resolutionClient({ status: 'unavailable', reason: 'broker_unavailable' });

        await expect(composed.dependencies.resolveCredentialSelectionBinding({
            projection,
            preparedAuthoring,
            submittedTeamCredentialModel: selection(),
            client,
            signal: new AbortController().signal,
        })).resolves.toBeNull();
        expect(composed.readGaps()).toContain('broker_selection_unavailable');
    });

    it('reports an unselected credential model without contacting the Home', async () => {
        const composed = compose({ selected: null });
        const { client, resolveCredentialSelection } = resolutionClient({
            status: 'resolved',
            credentialSelectionBinding: BROKER_BINDING,
            displayFacts: DISPLAY_FACTS,
        });

        await expect(composed.dependencies.resolveCredentialSelectionBinding({
            projection,
            preparedAuthoring,
            submittedTeamCredentialModel: null,
            client,
            signal: new AbortController().signal,
        })).resolves.toBeNull();
        expect(resolveCredentialSelection).not.toHaveBeenCalled();
        expect(composed.readGaps()).toContain('team_credential_model_unselected');
    });

    it('refuses a selection whose revision no longer matches the catalog', async () => {
        const composed = compose({ resources: [catalogEntry({ resourceRevision: 8 })], selected: selection(7) });
        const { client, resolveCredentialSelection } = resolutionClient({
            status: 'resolved',
            credentialSelectionBinding: BROKER_BINDING,
            displayFacts: DISPLAY_FACTS,
        });

        await expect(composed.dependencies.resolveCredentialSelectionBinding({
            projection,
            preparedAuthoring,
            submittedTeamCredentialModel: selection(7),
            client,
            signal: new AbortController().signal,
        })).resolves.toBeNull();
        expect(resolveCredentialSelection).not.toHaveBeenCalled();
        expect(composed.readGaps()).toContain('team_credential_resource_unavailable');
    });

    it('derives a retry-stable tag and reviewed initial access without starting runtime work', async () => {
        const composed = compose({ selected: selection() });
        const custody = {
            binding: { activationId: 'activation-1' },
            launchManifest: {
                credentialSelectionBinding: BROKER_BINDING,
                reviewedProviderModel: catalogEntry().providerModels[0],
            },
            preparedAuthoring: {
                authoring: {
                    access: {
                        grants: [{
                            subject: { kind: 'team', teamId: 'team-1' },
                            accessLevel: 'edit',
                            canApprovePermissions: false,
                        }],
                    },
                },
            },
        } as unknown as Parameters<
            ReturnType<typeof compose>['dependencies']['resolveMaterializationInput']
        >[0]['custody'];

        const first = await composed.dependencies.resolveMaterializationInput({ projection, custody });
        const second = await composed.dependencies.resolveMaterializationInput({ projection, custody });

        expect(first?.tag).toBe('temporary-computer:activation-1');
        expect(second?.tag).toBe(first?.tag);
        expect(first?.agentState).toBeNull();
        expect(first?.initialAccess).toEqual({
            grants: [{
                subject: { kind: 'team', teamId: 'team-1' },
                accessLevel: 'edit',
                canApprovePermissions: false,
            }],
        });
        expect(first?.teamCredentialBindings).toEqual([{
            v: 1,
            slot: { kind: 'provider_model' },
            resourceId: 'resource-1',
            expectedResourceRevision: 7,
            deliveryMode: 'brokered',
            teamId: 'team-1',
        }]);
    });

    it('omits initial access entirely when authoring granted nobody', async () => {
        const composed = compose();
        const custody = {
            binding: { activationId: 'activation-2' },
            launchManifest: {
                credentialSelectionBinding: BROKER_BINDING,
                reviewedProviderModel: catalogEntry().providerModels[0],
            },
            preparedAuthoring: { authoring: { access: null } },
        } as unknown as Parameters<
            ReturnType<typeof compose>['dependencies']['resolveMaterializationInput']
        >[0]['custody'];

        const input = await composed.dependencies.resolveMaterializationInput({ projection, custody });

        expect(input).not.toHaveProperty('initialAccess');
        expect(input?.teamCredentialBindings).toEqual([{
            v: 1,
            slot: { kind: 'provider_model' },
            resourceId: 'resource-1',
            expectedResourceRevision: 7,
            deliveryMode: 'brokered',
            teamId: 'team-1',
        }]);
        expect(input?.tag).toBe('temporary-computer:activation-2');
    });

    it('fails materialization closed when sealed review custody contains a direct route', async () => {
        const composed = compose();
        const custody = {
            binding: { activationId: 'activation-3' },
            launchManifest: {
                credentialSelectionBinding: BROKER_BINDING,
                reviewedProviderModel: catalogEntry({ deliveryMode: 'direct' }).providerModels[0],
            },
            preparedAuthoring: { authoring: { access: null } },
        } as unknown as Parameters<
            ReturnType<typeof compose>['dependencies']['resolveMaterializationInput']
        >[0]['custody'];

        await expect(composed.dependencies.resolveMaterializationInput({ projection, custody }))
            .resolves.toBeNull();
    });
});

describe('createTemporaryComputerCreatorDependencies external Agent acquisition', () => {
    const projectedExternalAgent = {
        id: 'assistant',
        identity: EXTERNAL_AGENT,
        providerOwnedEnvironmentKeys: [],
        cli: { install: { managed: { kind: 'managed_package' } } },
    };
    const externalCatalogEntry = () => TeamCredentialResourceCatalogEntryV1Schema.parse({
        ...catalogEntry(),
        providerModels: [{
            ...catalogEntry().providerModels[0],
            selection: { ...catalogEntry().providerModels[0]!.selection, agentTargetKey: EXTERNAL_AGENT_TARGET_KEY },
            application: { ...catalogEntry().providerModels[0]!.application, agentTargetKey: EXTERNAL_AGENT_TARGET_KEY },
        }],
    });

    it('admits an externally installed Agent that declares a managed CLI install and came from npm', () => {
        const composed = compose({
            resources: [externalCatalogEntry()],
            projectedAgentsById: { assistant: projectedExternalAgent },
            installedPluginPackagesById: {
                'acme.reviewed-external': {
                    id: 'acme.reviewed-external',
                    displayName: 'Reviewed External',
                    version: '1.2.3',
                    enabled: true,
                    source: { kind: 'package', locator: '@acme/reviewed-external' },
                },
            },
        });

        expect(composed.dependencies.isAuthoringCompatible({
            backendTargetKey: EXTERNAL_AGENT_TARGET_KEY,
            agentTarget: { kind: 'agent', identity: EXTERNAL_AGENT },
        })).toBe(true);
        expect(composed.readGaps()).toEqual([]);
    });

    it.each(['path', 'archive'] as const)(
        'refuses an externally installed Agent installed from a %s, which has no marketplace listing',
        (sourceKind) => {
            const composed = compose({
                resources: [externalCatalogEntry()],
                projectedAgentsById: { assistant: projectedExternalAgent },
                installedPluginPackagesById: {
                    'acme.reviewed-external': {
                        id: 'acme.reviewed-external',
                        displayName: 'Reviewed External',
                        version: '1.2.3',
                        enabled: true,
                        source: { kind: sourceKind, locator: '/home/alice/plugins/reviewed-external' },
                    },
                },
            });

            expect(composed.dependencies.isAuthoringCompatible({
                backendTargetKey: EXTERNAL_AGENT_TARGET_KEY,
                agentTarget: { kind: 'agent', identity: EXTERNAL_AGENT },
            })).toBe(false);
            expect(composed.readGaps()).toContain('agent_plugin_distribution_unacquirable');
        },
    );

    const installedProjection = {
        id: EXTERNAL_AGENT.pluginId, displayName: 'Reviewed External', version: '1.2.3', enabled: true,
        immutableGenerationId: 'generation-installed', source: { kind: 'package', locator: '@acme/reviewed-external' },
    };
    function registryAcquisition(overrides: Readonly<{ missing?: boolean; changedIntegrity?: boolean; duplicate?: boolean; retired?: boolean; staleGeneration?: boolean; reviewRefused?: 'withdrawn' | 'blocked' }> = {}) {
        const privateOrigin = 'https://npm.acme.example.test';
        const urls = ['https://public-catalog.example/index.json', overrides.reviewRefused ? DEFAULT_CURATED_MARKETPLACE_SOURCE_URL : 'https://private-catalog.example/index.json',
            ...(overrides.duplicate ? ['https://duplicate-catalog.example/index.json'] : [])];
        const sources: readonly RegistryRemoteSourceDescriptorV1[] = urls.map(url => ({ id: deriveMarketplaceSourceId(url), title: url,
            format: 'happier-catalog', kinds: ['plugin'], url, enabled: true, addedAt: 0, origin: { kind: 'user' }, removable: true,
            npmRegistryProfileId: 'creator_private_profile' }));
        const http = vi.fn(async (url: string) => {
            const source = sources.find(source => source.url === url)!;
            const { source: _source, artifactAccess: _access, ...entry } = marketplaceListing({ sourceKind: 'user' });
            return { ok: true as const, fetchedAt: 1, value: MarketplaceIndexSourceSnapshotV1Schema.parse({
                source: { id: source.id, title: source.title, kind: url === DEFAULT_CURATED_MARKETPLACE_SOURCE_URL ? 'curated' : 'user', sourceUrl: source.url },
                freshness: { state: 'fresh', fetchedAtMs: 1 }, diagnostics: [], entries: overrides.missing ? [] : [{ ...entry,
                    ...(url === DEFAULT_CURATED_MARKETPLACE_SOURCE_URL ? { review: { status: overrides.reviewRefused, reviewedAt: '2026-07-13T00:00:00.000Z' } } : {}),
                    distribution: { ...entry.distribution, registryOrigin: url === urls[0] ? 'https://registry.npmjs.org' : privateOrigin,
                        ...(overrides.changedIntegrity ? { integrity: `sha512-${Buffer.alloc(64, 2).toString('base64')}` } : {}) } }],
            }) };
        });
        const host = createRegistryHostV1({ host: 'node', readSources: async () => sources,
            http: { getJson: http, getText: async () => { throw new Error('unused'); }, getBytes: async () => { throw new Error('unused'); } } });
        const scope = { serverId: 'srv-runner', accountId: 'account-a' };
        const execute: NonNullable<Parameters<typeof compose>[0]>['registryActionExecution'] = {
            scope, isCurrent: () => !overrides.retired,
            execute: async (actionId, input, options) => {
                options?.signal?.throwIfAborted();
                if (actionId !== 'registries.sources.list' && actionId !== 'registries.items.read') throw new Error('Unexpected Action');
                try { return { ok: true, result: await host.execute(actionId, input) }; }
                catch (error) { if (error instanceof RegistryFetchErrorV1) return { ok: false, errorCode: error.status.state, error: error.status.state }; throw error; }
            },
        };
        const inventory = InstalledPluginCapabilityEntryV1Schema.parse({
            pluginId: EXTERNAL_AGENT.pluginId, desiredGeneration: 'generation-installed', appliedGeneration: overrides.staleGeneration ? 'generation-newer' : 'generation-installed',
            admittedIntegrity: marketplaceListing().distribution.integrity, title: 'Reviewed External', description: null,
            version: '1.2.3', enabled: true, source: installedProjection.source,
            install: { mode: 'managed', manifestVersion: '2', trust: { pluginId: EXTERNAL_AGENT.pluginId, state: 'trusted', approvedAtMs: 1,
                distribution: { kind: 'npm', registryOrigin: privateOrigin, packageName: '@acme/reviewed-external', registryProfileId: 'creator_private_profile' } } },
            compatibility: { status: 'compatible', diagnostics: [] }, diagnostics: [],
        });
        return { registryActionExecution: execute, readInstalledPlugins: async () => [inventory], http, privateOrigin, sources };
    }

    it('uses the installed private distribution and frozen version rather than the public package with the same name and version', async () => {
        const acquisition = registryAcquisition();
        const composed = compose({
            resources: [externalCatalogEntry()],
            projectedAgentsById: { assistant: projectedExternalAgent },
            installedPluginPackagesById: {
                'acme.reviewed-external': {
                    ...installedProjection,
                },
            },
            ...acquisition,
        });

        const resolved = await composed.dependencies.resolveAgentPluginDistribution({
            agentTarget: { kind: 'agent', identity: EXTERNAL_AGENT },
            signal: new AbortController().signal,
        });

        expect(ExpectedMarketplaceListingV1Schema.parse(resolved)).toMatchObject({ registryOrigin: acquisition.privateOrigin });
        expect(resolved).toMatchObject({
            pluginId: 'acme.reviewed-external',
            packageName: '@acme/reviewed-external',
            version: '1.2.3',
            source: { kind: 'user', id: acquisition.sources[1]!.id },
        });
        expect(resolved).not.toHaveProperty('registryProfileId');
    });

    it.each([{ missing: true }, { changedIntegrity: true }, { duplicate: true }, { retired: true }, { staleGeneration: true },
        { reviewRefused: 'withdrawn' }, { reviewRefused: 'blocked' }] as const)('fails closed for unavailable or ambiguous exact acquisition: %j', async (override) => {
        const acquisition = registryAcquisition(override);
        const composed = compose({
            resources: [externalCatalogEntry()],
            projectedAgentsById: { assistant: projectedExternalAgent },
            installedPluginPackagesById: {
                'acme.reviewed-external': {
                    ...installedProjection,
                },
            },
            ...acquisition,
        });

        await expect(composed.dependencies.resolveAgentPluginDistribution({
            agentTarget: { kind: 'agent', identity: EXTERNAL_AGENT },
            signal: new AbortController().signal,
        })).resolves.toBeNull();
        expect(composed.readGaps()).toContain('agent_plugin_distribution_unacquirable');
    });

    it('preserves cancellation after the Machine inventory answers without disclosing a registry commitment', async () => {
        const acquisition = registryAcquisition();
        const cancellation = new AbortController();
        const composed = compose({ resources: [externalCatalogEntry()], projectedAgentsById: { assistant: projectedExternalAgent },
            installedPluginPackagesById: { [EXTERNAL_AGENT.pluginId]: installedProjection }, ...acquisition,
            readInstalledPlugins: async () => { const inventory = await acquisition.readInstalledPlugins(); cancellation.abort(); return inventory; },
        });
        await expect(composed.dependencies.resolveAgentPluginDistribution({ agentTarget: { kind: 'agent', identity: EXTERNAL_AGENT },
            signal: cancellation.signal })).rejects.toMatchObject({ name: 'AbortError' });
        expect(acquisition.http).not.toHaveBeenCalled();
    });

    it('acquires nothing for a bundled Agent the Runner artifact already carries', async () => {
        const acquisition = registryAcquisition();
        const readInstalledPlugins = vi.fn(acquisition.readInstalledPlugins);
        const composed = compose({ ...acquisition, readInstalledPlugins });

        await expect(composed.dependencies.resolveAgentPluginDistribution({
            agentTarget: { kind: 'agent', identity: MANAGED_INSTALL_AGENT },
            signal: new AbortController().signal,
        })).resolves.toBeNull();
        expect(readInstalledPlugins).not.toHaveBeenCalled();
        expect(acquisition.http).not.toHaveBeenCalled();
        expect(composed.readGaps()).toEqual([]);
    });

    it('composes the default Machine inventory transport and mounted qualified registry Actions into a strict sealed commitment', async () => {
        let phase = 'create Account catalog fixture';
        onTestFinished(() => { if (phase !== 'finished') throw new Error(`Creator composition did not finish: ${phase}`); });
        const acquisition = registryAcquisition();
        const serverUrl = 'https://creator-registry-wiring.test';
        const sourceUrl = `${serverUrl}/catalog.json`;
        const sourceId = deriveMarketplaceSourceId(sourceUrl);
        const { value } = await acquisition.http(acquisition.sources[1]!.url);
        const snapshot = { ...value, source: { ...value.source, id: sourceId, sourceUrl } };
        installDisconnectedServerSocketBoundary(socket => {
            configureConnectedServerSocketBoundary(socket);
            socket.timeout = vi.fn<typeof socket.timeout>(() => socket);
            socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, request: unknown) => {
                if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
                expect(request).toMatchObject({ method: 'machine-1:capabilities.detect',
                    params: { requests: [{ id: 'tool.plugins' }], bypassCache: true } });
                return { ok: true, result: { protocolVersion: 1, results: { 'tool.plugins': { ok: true, checkedAt: 1,
                    data: { installedPlugins: await acquisition.readInstalledPlugins() } } } } };
            });
        });
        const fixture = await createPlainPromptLibraryCatalogHomeFixture(serverUrl, { key: 'registry-sources', value: {
            v: 2, disabledSourceIds: BUILT_IN_REGISTRY_SOURCES_V1.map(source => source.id),
            sources: [{ id: sourceId, title: 'Private catalog', format: 'happier-catalog', kinds: ['plugin'], url: sourceUrl,
                enabled: true, addedAt: 0, npmRegistryProfileId: 'creator_private_profile' }],
        } }, 'updated', { handleRequest: async (path, init) => path === '/catalog.json' ? Response.json(snapshot)
            : createPlainMachineReadHttpResponseFixture(path, init) });
        onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
        phase = 'hydrate Account settings';
        await fixture.hydrateAccountSettings();
        const scope = { serverId: fixture.home.id, accountId: 'artifact-account' };
        const { refreshPromptLibraryCatalog } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
        phase = 'hydrate registry source catalog';
        await refreshPromptLibraryCatalog(scope);
        phase = 'mount qualified Action execution';
        const mounted = await renderHook(() => useMountedActionExecution(scope));
        await vi.waitFor(() => expect(mounted.getCurrent().ready).toBe(true));
        const composed = compose({ serverId: scope.serverId, resources: [externalCatalogEntry()],
            projectedAgentsById: { assistant: projectedExternalAgent },
            installedPluginPackagesById: { [EXTERNAL_AGENT.pluginId]: installedProjection },
            registryActionExecution: { scope, execute: mounted.getCurrent().execute, isCurrent: mounted.getCurrent().isCurrent },
        });
        phase = 'read Machine inventory and registry listing';
        const resolved = await composed.dependencies.resolveAgentPluginDistribution({ agentTarget: { kind: 'agent', identity: EXTERNAL_AGENT },
            signal: new AbortController().signal });
        expect(ExpectedMarketplaceListingV1Schema.parse(resolved)).toMatchObject({ source: { id: sourceId }, registryOrigin: acquisition.privateOrigin,
            version: installedProjection.version, integrity: marketplaceListing().distribution.integrity });
        expect(resolved).not.toHaveProperty('registryProfileId');
        expect(fixture.mutations).toEqual([]);
        phase = 'finished';
    });
});
