import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

import { DaemonContributionRegistryProjectionDescribeResponseSchema, PluginProjectionV2Schema} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { AcpBackendDefinitionV1Schema } from '@happier-dev/protocol/acp/catalog/settingsV1';
import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';
import { clearDaemonMergedProjectionCacheForTests } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { createDeferred, createMachineFixture, renderInCollectionLayout, standardCleanup } from '@/dev/testkit';
import { PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE } from '@/dev/testkit/fixtures/pluginProviderDaemonProjection';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness, installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { resetAcpCatalogEngineForTests } from '@/sync/engine/settings/acpCatalogEngine';
import { resetAcpCatalogSnapshotsForTests } from '@/sync/store/settings/acpCatalogSnapshot';
import { clearActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';
import { resetSessionSettingsEntryState, sessionSettingsEntryState } from '../sessionSettingsEntryTestHelpers';

await vi.hoisted(async () => {
    const { installSessionSettingsEntryModuleMocks } = await import('../sessionSettingsEntryTestHelpers');
installSessionSettingsEntryModuleMocks();
});
vi.doUnmock('@/sync/domains/state/storage');
vi.doUnmock('@/hooks/server/useFeatureEnabled');
const account = createProviderSettingsAccountHarness();
const daemon = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(daemon);
await loadSyncSingletonForTests();
const Screen = (await import('@/app/(app)/settings/agents')).default;

const machine = (id = 'machine-1') => createMachineFixture({ id, activeAt: Date.now() });
const projectionReply = vi.fn<() => Promise<unknown>>();

function qualifiedProjection() {
    const agent = PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.agentsById['acme.review.provider'];
    return PluginProjectionV2Schema.parse({ ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
        agentsById: { 'acme.review/provider': { ...agent, id: 'acme.review/provider' } },
    });
}

function answerAcp(serverId: string, definitions: ReturnType<typeof AcpBackendDefinitionV1Schema.parse>[] = []) {
    account.home.answer(serverId, ACP_CATALOG_ROWS_ROUTE_V1, { body: AcpCatalogRowReadResponseV1Schema.parse({
        status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, definitions } },
    }) });
}

async function restore(machines = [machine()]) {
    await account.restore({ machines, serverIdentityId: 'srv_agent_index', settings: { backendEnabledByTargetKey: {} } });
    answerAcp(account.serverId);
    await account.selectMachine(account.serverId, null, MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.agents);
}

async function peer(name: string, machineId: string) {
    const serverId = await account.addHome({ name, serverUrl: `https://agent-${name}.fixture.test`,
        serverIdentityId: `srv_agent_${name}`, accountId: 'account-a', active: false });
    await account.publishMachines(serverId, [machine(machineId)]);
    answerAcp(serverId);
    return `srv_agent_${name}`;
}

async function select(serverId: string, machineId: string) {
    await act(async () => { await account.selectMachine(serverId, machineId, MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.agents); });
}

function projectionRequests() {
    return daemon.state.requests.filter(request => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
}

/** Inspect the real identity mark, not a fabricated catalog entry. */
function readIdentityIcon(icon: React.ReactElement<{ children?: React.ReactNode }> | undefined) {
    return React.Children.toArray(icon?.props.children).find(child =>
        React.isValidElement(child) && child.type === AgentCatalogIdentityIcon);
}

beforeEach(async () => {
    daemon.reset();
    projectionReply.mockReset();
    projectionReply.mockResolvedValue(qualifiedProjection());
    daemon.intercept(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, async () =>
        DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection: await projectionReply() }));
    clearActiveUnsavedChangesGuard();
    await restore();
});

afterEach(async () => {
    standardCleanup();
    clearDaemonMergedProjectionCacheForTests();
    resetAcpCatalogEngineForTests();
    resetAcpCatalogSnapshotsForTests();
    await account.reset();
    resetSessionSettingsEntryState();
    clearActiveUnsavedChangesGuard();
});

describe('PluginAgentSettingsIndexScreen', () => {
    it('carries exact Machine declaration compatibility into Models and retains it until refresh settles', async () => {
        const { BUNDLED_CANONICAL_AGENT_DECLARATIONS } = await import('@/agents/registry/generatedBundledPluginEntries');
        const { readAccountProviderDeclarations } = await import('@/providers/catalog/accountProviderDeclarations');
        const claude = BUNDLED_CANONICAL_AGENT_DECLARATIONS.claude;
        if (!claude) throw new Error('Bundled Claude declaration is required by this fixture');
        const declarations = readAccountProviderDeclarations({ kind: 'account' });
        const deepseek = declarations.find(row => row.definition.id === 'deepseek')!;
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            agentsById: { claude: { id: 'claude', identity: claude.identity, title: claude.cli?.displayName,
                isBuiltIn: true, providerRequirements: claude.providerRequirements } },
            familiesById: { providers: { family: 'providers', entriesById: Object.fromEntries(declarations.map(row =>
                [row.contributionKey, { id: row.contributionKey, pluginId: row.contributionKey.split('/')[0],
                    sourceKind: 'bundled', provenance: row.provenance, definition: row.definition }])) } },
        });
        projectionReply.mockResolvedValue(projection);
        await select(account.serverId, 'machine-1');
        const screen = await renderInCollectionLayout(<Screen />, 'split');
        await vi.waitFor(() => expect(screen.findHostByTestId(`settings-agents-home.models.provider.${deepseek.contributionKey}`)).not.toBeNull());
        expect(projectionRequests()).toHaveLength(1);
        expect(projectionRequests()[0]).toMatchObject({ machineId: 'machine-1', serverId: 'srv_agent_index' });

        const refreshed = createDeferred<unknown>();
        projectionReply.mockImplementation(() => refreshed.promise);
        const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjectionRevision');
        await act(async () => { publishMachineContributionRegistryProjectionInvalidation({ machineId: 'machine-1', serverId: account.serverId }, 'authority'); });
        await vi.waitFor(() => expect(projectionRequests().length).toBeGreaterThan(1));
        expect(screen.findHostByTestId(`settings-agents-home.models.provider.${deepseek.contributionKey}`)).not.toBeNull();
        await act(async () => { refreshed.resolve(PluginProjectionV2Schema.parse({ ...projection, generation: 2, familiesById: {} })); });
        await vi.waitFor(() => expect(screen.findHostByTestId(`settings-agents-home.models.provider.${deepseek.contributionKey}`)).toBeNull());
    });

    it('offers only declaration-compatible Providers for the admitted Agents without Machine probes', async () => {
        await restore([]);
        const screen = await renderInCollectionLayout(<Screen />, 'split');
        const { readAccountProviderDeclarations, readAccountAgentProviderDeclarations } = await import('@/providers/catalog/accountProviderDeclarations');
        const declarations = readAccountProviderDeclarations({ kind: 'account' });
        const deepseek = declarations.find(row => row.definition.id === 'deepseek')!;
        const { projectProviderDeclarationDetail } = await import('@/providers/catalog/providerDeclarationDetail');
        const agents = readAccountAgentProviderDeclarations({ kind: 'account' });
        const worksWith = projectProviderDeclarationDetail(deepseek, agents).worksWith;
        expect(worksWith.some(agent => agent.agentTargetKey === 'agent:happier.agent.claude/claude')).toBe(true);
        expect(worksWith.some(agent => agent.agentTargetKey === 'agent:happier.agent.codex/codex')).toBe(false);
        await vi.waitFor(() => expect(screen.findHostByTestId(`settings-agents-home.models.provider.${deepseek.contributionKey}`)).not.toBeNull());
        const { newProviderRoute } = await import('@/components/settings/providers/collection/providerCollectionModel');
        await screen.pressByTestIdAsync(`settings-agents-home.models.provider.${deepseek.contributionKey}`);
        expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenCalledWith(newProviderRoute(deepseek.contributionKey));
        expect(daemon.state.requests).toEqual([]);
    });

    it('lands the wide root on the Agents home beside the column, not a second copy of its list (S30 §6.2)', async () => {
        const screen = await renderInCollectionLayout(<Screen />, 'split');
        await vi.waitFor(() => expect(screen.findHostByTestId('settings-agents-home')).not.toBeNull());
        expect(screen.findAllByType('Redirect')).toHaveLength(0);
        // The home carries the page's one primary Add and its Machine; the agents themselves stay in the column.
        expect(screen.findHostByTestId('settings-agents-home.add')).not.toBeNull();
        expect(screen.findHostByTestId('settings-agents-collection.page.list')).toBeNull();
        expect(screen.findHostByTestId('settings-agents-collection.row.acme.review/provider')).toBeNull();
        await screen.pressByTestIdAsync('settings-agents-home.models.providers');
        expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenCalledWith('/(app)/settings/providers');
        await vi.waitFor(() => expect(projectionRequests()).toEqual(expect.arrayContaining([expect.objectContaining({ machineId: 'machine-1', serverId: 'srv_agent_index' })])));
        expect(projectionRequests().some(request => request.machineId !== 'machine-1' || request.serverId !== 'srv_agent_index')).toBe(false);
    });

    it('renders merged provider rows from the descriptor projection without relying on built-in registry lists', async () => {
        const screen = await renderSettingsView(<Screen />);
        await vi.waitFor(() => expect(screen.findRowByTitle('Acme Review Provider')).toBeTruthy());
        expect(projectionRequests()).toEqual(expect.arrayContaining([expect.objectContaining({ machineId: 'machine-1', serverId: 'srv_agent_index' })]));
        expect(screen.findRowByTitle('Acme Review Provider')?.props.subtitle).toBeUndefined();
        const icon = readIdentityIcon(screen.findRowByTitle('Acme Review Provider')?.props.icon);
        expect(React.isValidElement<{ entry: unknown }>(icon) && icon.props.entry).toMatchObject({
            qualifiedId: 'acme.review/provider', identity: { pluginId: 'acme.review', localId: 'provider' },
        });
        await act(async () => { screen.pressRowByTitle('Acme Review Provider'); });
        await vi.waitFor(() => expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenCalledWith('/(app)/settings/agents/provider?pluginId=acme.review'));
    });

    it('refetches daemon provider projection data when the canonical target changes for the same machine', async () => {
        const x = await peer('x', 'machine-1');
        const y = await peer('y', 'machine-1');
        await select(x, 'machine-1');
        await renderSettingsView(<Screen />);
        await vi.waitFor(() => expect(projectionRequests()).toEqual(expect.arrayContaining([expect.objectContaining({ serverId: x, machineId: 'machine-1' })])));
        daemon.state.requests.length = 0;
        await select(y, 'machine-1');
        await vi.waitFor(() => expect(projectionRequests()).toEqual(expect.arrayContaining([expect.objectContaining({ serverId: y, machineId: 'machine-1' })])));
    });

    it('does not leak the previous projection across targets while the new canonical-target projection loads', async () => {
        const x = await peer('x', 'machine-1');
        const y = await peer('y', 'machine-2');
        await select(x, 'machine-1');
        const screen = await renderSettingsView(<Screen />);
        await vi.waitFor(() => expect(screen.findRowByTitle('Acme Review Provider')).toBeTruthy());
        const reload = createDeferred<unknown>();
        projectionReply.mockImplementation(() => reload.promise);
        await select(y, 'machine-2');
        await vi.waitFor(() => expect(projectionRequests()).toEqual(expect.arrayContaining([expect.objectContaining({ serverId: y, machineId: 'machine-2' })])));
        expect(screen.findRowByTitle('Acme Review Provider')).toBeNull();
        await act(async () => { reload.resolve(qualifiedProjection()); });
        await vi.waitFor(() => expect(screen.findRowByTitle('Acme Review Provider')).toBeTruthy());
    });

    it('uses the exact canonical Administration target instead of an active-server or global-machine fallback', async () => {
        const selected = await peer('selected', 'machine-selected');
        await peer('other', 'machine-other');
        await select(selected, 'machine-selected');
        daemon.state.requests.length = 0;
        await renderSettingsView(<Screen />);
        await vi.waitFor(() => expect(projectionRequests()).toEqual(expect.arrayContaining([expect.objectContaining({ serverId: selected, machineId: 'machine-selected' })])));
        expect(projectionRequests().some(request => request.machineId === 'machine-other' || request.serverId === account.serverId)).toBe(false);
    });

    it('lists projected plugin agents even when they do not expose a built-in runtime carrier', async () => {
        const projection = qualifiedProjection();
        const { catalogAgentId: _catalogAgentId, ...headless } = projection.agentsById['acme.review/provider'];
        projectionReply.mockResolvedValue(PluginProjectionV2Schema.parse({ ...projection, agentsById: {
            'acme.review/provider': { ...headless, title: 'Acme Headless Provider' },
        } }));
        const screen = await renderSettingsView(<Screen />);
        await vi.waitFor(() => expect(screen.findRowByTitle('Acme Headless Provider')).toBeTruthy());
        const icon = readIdentityIcon(screen.findRowByTitle('Acme Headless Provider')?.props.icon);
        expect(React.isValidElement<{ entry: unknown }>(icon) && icon.props.entry).toMatchObject({
            qualifiedId: 'acme.review/provider', catalogAgentId: null,
        });
    });

    it('keeps canonical bundled agents available without a Machine projection', async () => {
        await account.reset();
        await restore([]);
        const screen = await renderSettingsView(<Screen />);
        const { getAgentCore } = await import('@/agents/catalog/catalog');
        const { t } = await import('@/text');
        const codex = getAgentCore('codex');
        if (!codex) throw new Error('Expected the bundled Codex Agent catalog entry');
        const codexTitle = t(codex.displayNameKey);
        await vi.waitFor(() => expect(screen.findRowByTitle(codexTitle)).toBeTruthy());
        const icon = readIdentityIcon(screen.findRowByTitle(codexTitle)?.props.icon);
        expect(React.isValidElement<{ entry: unknown }>(icon) && icon.props.entry).toMatchObject({ catalogAgentId: 'codex' });
        expect(screen.findRowByTitle('Acme Review Provider')).toBeNull();
        expect(screen.findRowByTitle('settingsAgents.notAvailable')).toBeNull();
        expect(projectionRequests()).toEqual([]);
    });

    it('lists custom ACP agents as their own group and opens the definition editor', async () => {
        await restore([]);
        answerAcp(account.serverId, [AcpBackendDefinitionV1Schema.parse({ id: 'acp-1', name: 'my-acp', title: 'My ACP agent',
            launch: { kind: 'command', command: 'my-acp', args: ['--stdio'] }, createdAt: 1, updatedAt: 1 })]);
        const screen = await renderSettingsView(<Screen />);
        await vi.waitFor(() => expect(screen.findRowByTitle('My ACP agent')).toBeTruthy());
        expect(screen.findRowByTitle('settingsAgents.notAvailable')).toBeNull();
        expect(screen.findGroup('settingsAgents.collection.customAgents')).toBeTruthy();
        expect(screen.findRowByTitle('My ACP agent')?.props.subtitle).toBe('my-acp --stdio');
        await act(async () => { screen.pressRowByTitle('My ACP agent'); });
        await vi.waitFor(() => expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenCalledWith('/(app)/settings/agents/custom/acp-1'));
    });

    it('offers adding an ACP agent or asking an agent to add one, and sends askers without a machine to machine setup', async () => {
        await restore([]);
        const screen = await renderSettingsView(<Screen />);
        const menu = screen.findAll(node => node.props?.testID === 'settings-agents-collection.addMenu' && typeof node.props.onSelect === 'function')[0];
        expect(menu?.props.items.map((item: { id: string }) => item.id)).toEqual(['browse', 'acp', 'askAgent']);
        await act(async () => { menu?.props.onSelect('acp'); });
        await vi.waitFor(() => expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenCalledWith('/(app)/settings/agents/custom'));
        expect(menu?.props.items.find((item: { id: string }) => item.id === 'askAgent').subtitle).toBe('settingsAgents.authoring.needsMachine');
        await act(async () => { menu?.props.onSelect('askAgent'); });
        await vi.waitFor(() => expect(sessionSettingsEntryState.routerPushSpy).toHaveBeenCalledWith('/settings/machines/add'));
    });
    it("a phone's page is the rail's own list under its title: compact rows without chevrons and the count beside the title (lab sfcols:agentsP)", async () => {
        const screen = await renderSettingsView(<Screen />);
        await vi.waitFor(() => expect(screen.findRowByTitle('Acme Review Provider')).toBeTruthy());
        const row = screen.findRowByTitle('Acme Review Provider')!;
        expect(row.props.density).toBe('compact');
        expect(row.props.showChevron).toBe(false);
        const header = screen.findAll(node => node.props?.testID === 'settings.agents.index.header' && node.props.titleAccessory !== undefined)[0];
        expect(header?.props.titleAccessory).toBeTruthy();
    });
});
