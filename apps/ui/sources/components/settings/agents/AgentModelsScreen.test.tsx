import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderErrorV1 } from '@happier-dev/protocol';
import { RPC_METHODS, type DaemonProviderModelProjectionResponseV1 } from '@happier-dev/protocol/rpc';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
    ProviderConnectionsCatalogV1Schema, ProviderConnectionsRowMutationV1Schema,
    sealProviderConnectionsContentV1, openProviderConnectionsContentV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { PROVIDER_MODEL_SETTINGS_ACTION_ID_BY_OPERATION_V1 } from '@happier-dev/protocol/providers/providerActionsV1';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';

import {
    createProviderModelProjectionFixture,
    createProviderModelProjectionGroupFixture,
    createProviderSettingsHarness,
    createProviderSettingsAccountHarness,
    installProviderSettingsRpcBoundary,
} from '@/dev/testkit/harness/providerSettingsHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { buildCustomProviderTemplate, createCustomProviderDraft } from '@/providers/authoring/state';
import { PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE } from '@/dev/testkit/fixtures/pluginProviderDaemonProjection';
import { clearDaemonMergedProjectionCacheForTests, loadDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';

const mocks = vi.hoisted(() => ({
    mutate: vi.fn(),
    refresh: vi.fn(async () => {}),
    projectionRequestCount: 0,
    projection: {
        data: null as Extract<DaemonProviderModelProjectionResponseV1, { status: 'success' }> | null,
        loading: false,
        error: null as null | ReturnType<typeof createProviderErrorV1>,
    },
}));
const providerHarness = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(providerHarness);
const account = createProviderSettingsAccountHarness();
let serverId = '';

const routerPush = vi.hoisted(() => vi.fn());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    pathname: '/settings/agents/codex/models', router: { push: routerPush },
}).module);

// The models are one section of the page's virtualized list; the recycler renders every row here.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original: await importOriginal<Record<string, unknown>>() }).module;
});

// Warm the real Sync module after the transport leaves are installed, not inside a test hook's budget.
await loadSyncSingletonForTests();

describe('AgentModelsScreen provider settings safety', () => {
    afterEach(async () => { standardCleanup(); await account.reset(); });
    beforeEach(async () => {
        providerHarness.reset();
        clearDaemonMergedProjectionCacheForTests();
        mocks.projection = { data: null, loading: false, error: null };
        mocks.projectionRequestCount = 0;
        mocks.mutate.mockReset();
        routerPush.mockReset();
        serverId = (await account.restore({ serverIdentityId: 'srv_agent_models', machines: providerHarness.state.machines,
            waivedActions: [...Object.values(PROVIDER_MODEL_SETTINGS_ACTION_ID_BY_OPERATION_V1), 'providers.models.load', 'providers.models.refresh'],
        })).serverId;
        await account.selectMachine(serverId, 'machine-a', 'agents');
        await account.home.selectHomes([serverId]);
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, async () => {
            mocks.projectionRequestCount += 1;
            if (mocks.projection.loading && !mocks.projection.data) return await new Promise<never>(() => undefined);
            if (mocks.projection.error) return { status: 'error', error: mocks.projection.error };
            return mocks.projection.data ?? createProviderModelProjectionFixture({ agentTargetKey: 'agent:happier.agent.codex/codex' });
        });
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_MODEL_SETTINGS_MUTATE, async (request, next) => (
            await mocks.mutate({ serverId: request.serverId, request: request.payload }) ?? await next()
        ));
    });

    it('uses the canonical Administration exact target instead of the active-server fallback', async () => {
        const selectedServerId = await account.addHome({ name: 'Selected Agent Home', serverUrl: 'https://agent-models-selected.test',
            accountId: 'account-a', serverIdentityId: 'srv_agent_models_selected', active: false });
        await account.publishMachines(selectedServerId, [{ ...providerHarness.state.machines[0]!, id: 'machine-selected' }]);
        await account.selectMachine(selectedServerId, 'machine-selected', 'agents');

        const { AgentModelsScreen } = await import('./AgentModelsScreen');
        const screen = await renderScreen(<AgentModelsScreen agentTargetKey="agent:happier.agent.codex/codex" runtimeAgentId={null} />);

        const { MachineAdministrationTargetSelector } = await import('@/components/settings/machines/MachineAdministrationTargetSelector');
        expect(screen.findByType(MachineAdministrationTargetSelector)).toBeTruthy();
        await waitForHomeGovernance(() => expect(providerHarness.state.requests.find(
            (request) => request.method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION,
        )).toBeDefined());
        const projectionRequest = providerHarness.state.requests.find(
            (request) => request.method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION,
        );
        expect(projectionRequest?.machineId).toBe('machine-selected');
        const { areServerProfileIdentifiersEquivalent } = await import('@/sync/domains/server/serverProfiles');
        expect(areServerProfileIdentifiersEquivalent(projectionRequest!.serverId, selectedServerId)).toBe(true);
        expect(areServerProfileIdentifiersEquivalent(projectionRequest!.serverId, serverId)).toBe(false);
    });

    it('renders projected rows supplied through the shared Provider RPC boundary and real manager', async () => {
        const { AgentModelsScreen } = await import('./AgentModelsScreen');
        const { ProviderModelManager } = await import('@/providers/models/ProviderModelManager');
        mocks.projection.data = createProviderModelProjectionFixture({
                groups: [createProviderModelProjectionGroupFixture({
                    rows: [{
                        ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: 'pc_a', modelId: 'boundary-model' },
                        descriptor: { id: 'boundary-model', name: 'Boundary agent model' },
                        sources: { manual: false, static: true, probe: false },
                        confidence: 'verified_static',
                        compatibility: {
                            result: { status: 'verified', selectedProtocol: 'openai-chat', evidence: { sourceUrls: ['https://example.com'], verifiedAt: '2026-07-14' } },
                            compatibilityFingerprint: 'compatibility:v1:boundary',
                            confirmed: true,
                        },
                        endpointHealth: 'available',
                        catalog: { stale: false },
                        loadState: 'loaded',
                        visibility: 'visible',
                    }],
                })],
            });
        const screen = await renderScreen(<AgentModelsScreen agentTargetKey="agent:happier.agent.codex/codex" runtimeAgentId={null} />);

        expect(screen.findByType(ProviderModelManager).props.groups[0].rows[0].descriptor.name)
            .toBe('Boundary agent model');
    });
    it('names a plugin Agent from its exact admitted catalog entry without another daemon read', async () => {
        providerHarness.intercept(RPC_METHODS.DAEMON_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, async () => ({
            supported: true,
            projection: PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
        }));
        const loaded = await loadDaemonMergedProjectionCacheEntry({ machineId: 'machine-a', serverId });
        expect(loaded?.kind).toBe('ready');
        const readsBefore = providerHarness.state.requests.filter(request => (
            request.method === RPC_METHODS.DAEMON_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
        )).length;
        const { AgentModelsScreen } = await import('./AgentModelsScreen');
        const screen = await renderScreen(<AgentModelsScreen
            agentTargetKey="agent:acme.review/provider"
            runtimeAgentId="provider"
        />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('agent-models')).not.toBeNull());
        expect(screen.getTextContent()).toContain('Acme Review Provider');
        expect(providerHarness.state.requests.filter(request => (
            request.method === RPC_METHODS.DAEMON_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
        ))).toHaveLength(readsBefore);
    });
    it('keeps Account models, source visibility and exact favorite/default markers available without a machine', async () => {
        const agentTargetKey = 'agent:happier.agent.codex/codex';
        const selection = { v: 1, ref: { agentTargetKey, providerConnectionId: 'pc_a', modelId: 'model-a' }, updatedAt: 1 };
        const catalog = ProviderConnectionsCatalogV1Schema.parse({
            ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_a', source: { kind: 'custom', template: buildCustomProviderTemplate({
                ...createCustomProviderDraft('openai-responses'), name: 'Account source', baseUrl: 'https://custom.example/v1',
                requiresApiKey: false, catalog: 'manual',
            }) }, role: 'named', displayName: 'My source', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 }],
            manualModelsByConnectionId: { pc_a: [
                { id: 'model-a', name: 'Account model', addedAt: 1 },
                { id: 'model-b', name: 'Account model B', addedAt: 1 },
            ] },
        });
        serverId = (await account.restore({ catalog, machines: [], settings: {
            providerDefaultModelSelectionsByAgentTargetKeyV1: { [agentTargetKey]: selection },
            favoriteModelSelectionsV1: [{ selection }],
        }, waivedActions: ['providers.defaults.set'] })).serverId;
        await account.home.selectHomes([serverId]);
        await account.selectMachine(serverId, null, 'agents');
        let settingsVersion = 1;
        account.home.answer(serverId, 'POST /v2/account/settings', { select: input => {
            const mutation = AccountSettingsV2UpdateRequestSchema.parse(input);
            expect(mutation.expectedVersion).toBe(settingsVersion);
            expect(mutation.content?.t).toBe('plain');
            settingsVersion += 1;
            account.home.answer(serverId, 'GET /v2/account/settings', { body: {
                version: settingsVersion, content: mutation.content,
            } });
            return { body: { success: true, version: settingsVersion } };
        } });
        const { AgentModelsScreen } = await import('./AgentModelsScreen');
        const screen = await renderScreen(<AgentModelsScreen agentTargetKey={agentTargetKey} runtimeAgentId="codex" />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('agent-models')).not.toBeNull());
        expect(screen.getTextContent()).toContain('Account model');
        expect(screen.getTextContent()).toContain('★');
        expect(screen.findByTestId('provider-model-manager.default')).not.toBeNull();
        expect(screen.findByTestId('agent-models-source-visibility:pc_a')).not.toBeNull();
        expect(providerHarness.state.requests).toEqual([]);
        const defaultControl = screen.findAllByTestId('provider-model-manager.set-default')
            .find(node => typeof node.props.onPress === 'function'
                && node.props.accessibilityLabel?.includes('Account model B'));
        expect(defaultControl).toBeDefined();
        await act(async () => { await defaultControl?.props.onPress(); });
        const { storage } = await import('@/sync/domains/state/storage');
        await waitForHomeGovernance(() => expect(storage.getState().settings
            .providerDefaultModelSelectionsByAgentTargetKeyV1[agentTargetKey]?.ref).toEqual({
                agentTargetKey, providerConnectionId: 'pc_a', modelId: 'model-b',
            }));
        expect(providerHarness.state.requests).toEqual([]);
    });
    it.each(['plain', 'e2ee'] as const)('persists the %s custom source widget through admitted Account CAS', async mode => {
        const secret = new Uint8Array(32).fill(31);
        const material = mode === 'e2ee' ? { type: 'legacy' as const, secret } : null;
        let catalog = ProviderConnectionsCatalogV1Schema.parse({
            ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: ['pc_a', 'pc_b'].map(id => ({
                v: 1, id, source: id === 'pc_a' ? { kind: 'custom', template: buildCustomProviderTemplate({
                    ...createCustomProviderDraft('openai-chat'), name: 'Custom source', baseUrl: 'https://custom.example/v1',
                    requiresApiKey: false, catalog: 'manual',
                }) } : { kind: 'contribution', contributionKey: 'acme.plugin/acme' },
                role: 'named', displayName: id, displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1,
            })),
        });
        serverId = (await account.restore({ catalog, machines: providerHarness.state.machines,
            features: createRootLayoutFeaturesResponse({ features: { providers: { enabled: true } } }),
            ...(mode === 'e2ee' ? { e2eeSecret: secret } : {}),
        })).serverId;
        await account.home.selectHomes([serverId]);
        await account.selectMachine(serverId, 'machine-a', 'agents');
        let revision = 1;
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => ({ body: { status: 'present', revision, content: sealProviderConnectionsContentV1({ mode, material, catalog }) } }),
        });
        account.home.answer(serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: input => {
                const mutation = ProviderConnectionsRowMutationV1Schema.parse(input);
                expect(mutation.expectedRevision).toBe(revision);
                const opened = openProviderConnectionsContentV1({ mode, material, content: mutation.content });
                if (opened.status !== 'opened') throw new Error('Expected an admitted Account catalog');
                catalog = opened.catalog;
                revision += 1;
                return { body: { status: 'updated', revision, cursor: revision } };
            },
        });
        mocks.projection.data = createProviderModelProjectionFixture({ groups: ['pc_a', 'pc_b'].map(connectionId => (
            createProviderModelProjectionGroupFixture({ connectionId, rows: [{
                ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: connectionId, modelId: 'model-a' },
                descriptor: { id: 'model-a', name: 'Model A' }, sources: { manual: true, static: false, probe: false },
                confidence: 'manual', compatibility: { result: { status: 'verified', selectedProtocol: 'openai-chat',
                    evidence: { sourceUrls: ['https://example.com'], verifiedAt: '2026-07-14' } },
                    compatibilityFingerprint: 'compatibility:v1:source-visibility', confirmed: true },
                endpointHealth: 'available', catalog: { stale: false }, loadState: 'loaded', visibility: 'visible',
            }] })
        )) });
        const { AgentModelsScreen } = await import('./AgentModelsScreen');
        const screen = await renderScreen(<AgentModelsScreen agentTargetKey="agent:happier.agent.codex/codex" runtimeAgentId={null} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('agent-models')).not.toBeNull());
        const control = () => screen.findAllByTestId('agent-models-source-visibility:pc_a')
            .find(node => typeof node.props.onValueChange === 'function');
        expect(control()?.props.value).toBe(true);
        expect(screen.findByTestId('agent-models-source-visibility:pc_b')).toBeNull();
        await act(async () => { control()?.props.onValueChange(false); });
        await waitForHomeGovernance(() => expect(control()?.props.value).toBe(false));
        expect(catalog.modelPickerVisibilityByConnectionId).toEqual({ pc_a: false });
        expect(mocks.mutate).not.toHaveBeenCalled();
        if (mode === 'e2ee') {
            const withdrawnChoice = control()?.props.onValueChange;
            expect(typeof withdrawnChoice).toBe('function');
            const { TokenStorage } = await import('@/auth/storage/tokenStorage');
            const { getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
            const home = getServerProfileById(serverId)!;
            const credentials = await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId });
            if (!credentials) throw new Error('Expected the encrypted fixture credential');
            const rowWrites = () => account.home.requestsFor(PROVIDER_CONNECTIONS_ROWS_ROUTE_V1)
                .filter(request => ProviderConnectionsRowMutationV1Schema.safeParse(request.input).success);
            const writes = rowWrites().length;
            expect(writes).toBe(1);
            // Secure-store reads and its genuine mutation event both now report keyless
            // credentials; catalog admission and the mounted widget remain real.
            vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: credentials.token });
            await act(async () => {
                await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId }, { token: credentials.token });
            });
            expect(control()).toBeUndefined();
            expect(screen.findByTestId('agent-models')).toBeNull();
            expect(screen.getTextContent()).not.toContain('Model A');
            await act(async () => { withdrawnChoice?.(true); });
            expect(rowWrites()).toHaveLength(writes);
        }
    });
    it('retires the source error when Account B has no custom source leaf', async () => {
        const catalog = ProviderConnectionsCatalogV1Schema.parse({
            ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{
                v: 1, id: 'pc_a', source: { kind: 'custom', template: buildCustomProviderTemplate({
                    ...createCustomProviderDraft('openai-chat'), name: 'Custom source', baseUrl: 'https://custom.example/v1',
                    requiresApiKey: false, catalog: 'manual',
                }) },
                role: 'named', displayName: 'Custom source', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1,
            }],
        });
        account.home.answer(serverId, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, { body: {
            status: 'present', revision: 1, content: { t: 'plain', v: catalog },
        } });
        const { refreshProviderCatalog } = await import('@/sync/engine/settings/providerCatalogEngine');
        await refreshProviderCatalog({ serverId, accountId: 'account-a' });
        let writes = 0;
        account.home.answer(serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: input => {
                const mutation = ProviderConnectionsRowMutationV1Schema.parse(input);
                expect(mutation.expectedRevision).toBe(1);
                expect(mutation.content).toMatchObject({ t: 'plain', v: { modelPickerVisibilityByConnectionId: { pc_a: false } } });
                writes += 1;
                return { dispatchThenFail: true };
            },
        });
        mocks.projection.data = createProviderModelProjectionFixture({
            groups: [createProviderModelProjectionGroupFixture({ rows: [{
                ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: 'pc_a', modelId: 'model-a' },
                descriptor: { id: 'model-a', name: 'Model A' }, sources: { manual: true, static: false, probe: false },
                confidence: 'manual', compatibility: { result: { status: 'verified', selectedProtocol: 'openai-chat',
                    evidence: { sourceUrls: ['https://example.com'], verifiedAt: '2026-07-14' } },
                    compatibilityFingerprint: 'compatibility:v1:source-retirement', confirmed: true },
                endpointHealth: 'available', catalog: { stale: false }, loadState: 'loaded', visibility: 'visible',
            }] })],
        });
        const { AgentModelsScreen } = await import('./AgentModelsScreen');
        const screen = await renderScreen(<AgentModelsScreen agentTargetKey="agent:happier.agent.codex/codex" runtimeAgentId={null} />);
        const control = () => screen.findAllByTestId('agent-models-source-visibility:pc_a')
            .find(node => typeof node.props.onValueChange === 'function');
        await waitForHomeGovernance(() => expect(control()?.props.value).toBe(true));
        await act(async () => { control()!.props.onValueChange(false); });
        await waitForHomeGovernance(() => expect(screen.findByTestId('provider-error:provider_rpc_mutation_outcome_unknown')).not.toBeNull());
        expect(writes).toBe(1);

        await act(async () => {
            await account.restore({ accountId: 'account-b', catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
                machines: providerHarness.state.machines,
                waivedActions: [...Object.values(PROVIDER_MODEL_SETTINGS_ACTION_ID_BY_OPERATION_V1), 'providers.models.load', 'providers.models.refresh'],
            });
            // Publish the fixture Home's enabled Provider features after restoring B.
            await account.publishFeatures(serverId, createRootLayoutFeaturesResponse({ features: { providers: { enabled: true } } }));
            // Cold restoration also exposes the default saved Home. This page's feature
            // decision must use the test Home rather than a group containing that unserved Home.
            await account.home.selectHomes([serverId]);
            await account.selectMachine(serverId, 'machine-a', 'agents');
        });
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        expect(captureActiveServerAccountScopeLifetime()?.scope.accountId).toBe('account-b');
        await waitForHomeGovernance(() => expect(screen.findByTestId('agent-models')).not.toBeNull());
        expect(control()).toBeUndefined();
        expect(screen.findByTestId('provider-error:provider_rpc_mutation_outcome_unknown')).toBeNull();
        expect(writes).toBe(1);
    });
    it('renders the page anatomy: a page header with the machine chip, never the full-width machine group', async () => {
        const { AgentModelsScreen } = await import('./AgentModelsScreen');
        const { ProviderModelManager } = await import('@/providers/models/ProviderModelManager');
        const listed = await renderScreen(<AgentModelsScreen agentTargetKey="agent:happier.agent.codex/codex" runtimeAgentId={null} />);
        // The model list hosts the page: its header (rendered by the list) carries the machine chip.
        const host = listed.findByType(ProviderModelManager).props.page;
        expect(host?.header.props.actions.props.presentation).toBe('chip');
        const { MachineAdministrationTargetSelector } = await import('@/components/settings/machines/MachineAdministrationTargetSelector');
        expect(listed.findAllByType(MachineAdministrationTargetSelector)
            .filter((node) => node.props.presentation !== 'chip')).toHaveLength(0);

        await listed.unmount();
        await account.publishMachines(serverId, []);
        await account.selectMachine(serverId, null, 'agents');
        const noMachine = await renderScreen(<AgentModelsScreen agentTargetKey="agent:happier.agent.codex/codex" runtimeAgentId={null} />);
        expect(noMachine.findByTestId('settings.agents.models.header')).not.toBeNull();
        expect(noMachine.findAllByType(MachineAdministrationTargetSelector).map((node) => node.props.presentation))
            .toEqual(['chip']);
    });

    it('renders a read-only diagnostic for invalid Provider catalog content instead of a mutable default manager', async () => {
        account.home.answer(serverId, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, { body: {
            status: 'present', revision: 1, content: { t: 'plain', v: { v: 99, connections: [] } },
        } });
        const { refreshProviderCatalog } = await import('@/sync/engine/settings/providerCatalogEngine');
        await refreshProviderCatalog({ serverId, accountId: 'account-a' });
        const { AgentModelsScreen } = await import('./AgentModelsScreen');
        const screen = await renderScreen(
            <AgentModelsScreen agentTargetKey="agent:happier.agent.codex/codex" runtimeAgentId={null} />,
        );
        expect(screen.findByTestId('agent-models')).toBeNull();
        expect(screen.getTextContent()).toContain('Provider needs attention');
        expect(mocks.mutate).not.toHaveBeenCalled();
    });

    it('shows explicit first-load and structured failure states instead of an empty manager', async () => {
        const { AgentModelsScreen } = await import('./AgentModelsScreen');
        mocks.projection = { data: null, loading: true, error: null };
        const loading = await renderScreen(<AgentModelsScreen agentTargetKey="agent:happier.agent.codex/codex" runtimeAgentId={null} />);
        expect(loading.findByTestId('agent-models')).toBeNull();
        expect(loading.getTextContent()).toContain('Loading');
        await loading.unmount();

        mocks.projection = {
            data: null,
            loading: false,
            error: createProviderErrorV1('provider_endpoint_unreachable'),
        };
        const failed = await renderScreen(<AgentModelsScreen agentTargetKey="agent:happier.agent.codex/codex" runtimeAgentId={null} />);
        expect(failed.findByTestId('agent-models')).toBeNull();
        expect(failed.getTextContent()).toContain('Provider is unreachable');
    });

    it.each(['native visibility', 'agent reset', 'mixed bulk'] as const)(
        'reconciles a commit-then-reject %s once and reviews the current Agent Models surface',
        async (operation) => {
            const { AgentModelsScreen } = await import('./AgentModelsScreen');
            const { ProviderModelManager } = await import('@/providers/models/ProviderModelManager');
            mocks.projection.data = createProviderModelProjectionFixture({
                groups: [createProviderModelProjectionGroupFixture({
                    rows: [{
                        ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: 'pc_a', modelId: 'provider-model' },
                        descriptor: { id: 'provider-model', name: 'Provider model' },
                        sources: { manual: false, static: true, probe: false },
                        confidence: 'verified_static',
                        compatibility: {
                            result: {
                                status: 'verified', selectedProtocol: 'openai-chat',
                                evidence: { sourceUrls: ['https://example.com'], verifiedAt: '2026-07-14' },
                            },
                            compatibilityFingerprint: 'compatibility:v1:agent-review',
                            confirmed: true,
                        },
                        endpointHealth: 'available',
                        catalog: { stale: false },
                        loadState: 'loaded',
                        visibility: 'visible',
                    }],
                })],
            });
            mocks.mutate.mockRejectedValueOnce(new Error('acknowledgement lost after dispatch'));
            const screen = await renderScreen(
                <AgentModelsScreen agentTargetKey="agent:happier.agent.codex/codex" runtimeAgentId="claude" />,
            );
            expect(mocks.projectionRequestCount).toBe(1);
            const manager = screen.findByType(ProviderModelManager);

            await act(async () => {
                if (operation === 'native visibility') {
                    manager.props.onSetVisibility?.({
                        scope: 'agent', agentTargetKey: 'agent:happier.agent.codex/codex',
                        providerConnectionId: null, modelId: 'native-model',
                    }, true);
                } else if (operation === 'agent reset') {
                    manager.props.onResetVisibility?.();
                } else {
                    manager.props.onShowAll?.();
                }
                await vi.waitFor(() => expect(mocks.projectionRequestCount).toBe(2));
            });
            await act(async () => {
                await vi.waitFor(() => expect(
                    screen.findByTestId('provider-error:provider_rpc_mutation_outcome_unknown'),
                ).not.toBeNull());
            });

            expect(mocks.mutate).toHaveBeenCalledOnce();
            if (operation === 'mixed bulk') {
                const changes = mocks.mutate.mock.calls[0]?.[0].request.changes;
                expect(changes.some((change: { ref: { providerConnectionId: string | null } }) => change.ref.providerConnectionId === null)).toBe(true);
                expect(changes.some((change: { ref: { providerConnectionId: string | null } }) => change.ref.providerConnectionId === 'pc_a')).toBe(true);
            }
            const reviewAction = screen.findByTestId('provider-error-action:provider_rpc_mutation_outcome_unknown');
            expect(reviewAction).not.toBeNull();
            expect(screen.getTextContent()).not.toContain('Retry');
            expect(screen.findByType(ProviderModelManager)).toBeDefined();

            await act(async () => {
                await reviewAction?.props.onPress?.();
                await vi.waitFor(() => expect(mocks.projectionRequestCount).toBe(3));
            });
            expect(mocks.mutate).toHaveBeenCalledOnce();
            expect(routerPush).not.toHaveBeenCalled();
        },
    );

    it('reviews an ambiguous model load on Agent Models without retaining load replay', async () => {
        const { AgentModelsScreen } = await import('./AgentModelsScreen');
        const { ProviderModelManager } = await import('@/providers/models/ProviderModelManager');
        mocks.projection.data = createProviderModelProjectionFixture({
            groups: [createProviderModelProjectionGroupFixture({
                modelLoadAction: 'available',
                rows: [{
                    ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: 'pc_a', modelId: 'provider-model' },
                    descriptor: { id: 'provider-model', name: 'Provider model' },
                    sources: { manual: false, static: true, probe: false },
                    confidence: 'verified_static',
                    compatibility: {
                        result: {
                            status: 'verified', selectedProtocol: 'openai-chat',
                            evidence: { sourceUrls: ['https://example.com'], verifiedAt: '2026-07-14' },
                        },
                        compatibilityFingerprint: 'compatibility:v1:agent-load-review',
                        confirmed: true,
                    },
                    endpointHealth: 'available',
                    catalog: { stale: false },
                    loadState: 'unloaded',
                    visibility: 'visible',
                }],
            })],
        });
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_MODEL_LOAD, async () => {
            throw new Error('load acknowledgement lost while daemon work continues');
        });
        const screen = await renderScreen(
            <AgentModelsScreen agentTargetKey="agent:happier.agent.codex/codex" runtimeAgentId={null} />,
        );

        await act(async () => {
            screen.findByType(ProviderModelManager).props.onLoadModel?.('pc_a', 'provider-model');
            await vi.waitFor(() => expect(mocks.projectionRequestCount).toBe(2));
        });
        await act(async () => {
            await vi.waitFor(() => expect(
                screen.findByTestId('provider-error:provider_rpc_mutation_outcome_unknown'),
            ).not.toBeNull());
        });
        const reviewAction = screen.findByTestId('provider-error-action:provider_rpc_mutation_outcome_unknown');
        expect(reviewAction).not.toBeNull();
        expect(screen.getTextContent()).not.toContain('Retry');
        expect(screen.getTextContent()).not.toContain('Load model');
        expect(providerHarness.state.requests.filter(
            (request) => request.method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_LOAD,
        )).toHaveLength(1);

        await act(async () => {
            await reviewAction?.props.onPress?.();
            await vi.waitFor(() => expect(mocks.projectionRequestCount).toBe(3));
        });
        expect(providerHarness.state.requests.filter(
            (request) => request.method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_LOAD,
        )).toHaveLength(1);
        expect(routerPush).not.toHaveBeenCalled();
    });

    it('retries only projection refresh after an acknowledged settings mutation', async () => {
        const { AgentModelsScreen } = await import('./AgentModelsScreen');
        const { ProviderModelManager } = await import('@/providers/models/ProviderModelManager');
        mocks.projection.data = createProviderModelProjectionFixture({ agentTargetKey: 'agent:happier.agent.codex/codex' });
        const screen = await renderScreen(
            <AgentModelsScreen agentTargetKey="agent:happier.agent.codex/codex" runtimeAgentId={null} />,
        );
        mocks.projection.error = createProviderErrorV1('provider_endpoint_unavailable', {
            machineId: 'machine-a',
        });

        await act(async () => {
            screen.findByType(ProviderModelManager).props.onResetVisibility?.();
            await vi.waitFor(() => expect(mocks.projectionRequestCount).toBe(2));
        });
        await act(async () => {
            await vi.waitFor(() => expect(
                screen.findByTestId('provider-error-action:provider_endpoint_unavailable'),
            ).not.toBeNull());
        });
        expect(mocks.mutate).toHaveBeenCalledOnce();
        const retryRefreshAction = screen.findByTestId('provider-error-action:provider_endpoint_unavailable');
        expect(retryRefreshAction).not.toBeNull();

        await act(async () => {
            await retryRefreshAction?.props.onPress?.();
            await vi.waitFor(() => expect(mocks.projectionRequestCount).toBe(3));
        });
        expect(mocks.mutate).toHaveBeenCalledOnce();
    });
});
