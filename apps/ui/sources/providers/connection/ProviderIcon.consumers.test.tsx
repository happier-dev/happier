import * as React from 'react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS} from '@happier-dev/protocol/rpc/methods';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, ProviderConnectionsCatalogV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsHarness, createProviderSettingsAccountHarness, installProviderSettingsRpcBoundary,
    createProviderConnectionViewFixture, createProviderConnectionsDescribeFixture } from '@/dev/testkit/harness/providerSettingsHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

// The app/Expo asset inventory is the package boundary; every consumer and mark presenter is real.
const bundledBrands = vi.hoisted(() => [] as Readonly<{ pluginId: string; resourceId: string; releaseVersion: string;
    displayName: string; digest: string; bytes: Uint8Array; monochrome: boolean }>[]);
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', () => ({
    BUNDLED_PLUGIN_UI_APP_ARTIFACTS: [], BUNDLED_PLUGIN_UI_APP_DECLARATIONS: [], BUNDLED_PLUGIN_BRAND_MARKS: bundledBrands,
}));
// Exercise the real page through its recycler boundary, without importing unrelated Agent settings screens.
vi.mock('@legendapp/list/react-native', async original =>
    (await import('@/dev/testkit/mocks/legendList')).createCapturingLegendListMock({ original: await original<Record<string, unknown>>() }).module);
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));
bundledBrands.push({ pluginId: 'happier.provider.deepseek', resourceId: 'brand-icon', releaseVersion: '0.0.0',
    displayName: 'DeepSeek', digest: '', monochrome: true,
    bytes: new Uint8Array(readFileSync(new URL('../../../../../packages/plugins/deepseek/assets/brand.png', import.meta.url))) });
const rpc = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { renderSelectionListAccessory } = await import('@/components/ui/selectionList');
const { ProviderIcon } = await import('./ProviderIcon');
const { Icon } = await import('@/components/ui/icons/Icon');
const { SessionModelSourceBrowseHandoffContext } = await import('@/components/sessions/modelPicker/SessionModelSourceBrowseHandoff');
const { useSessionRouteSourceSections } = await import('@/components/sessions/new/components/useSessionRouteSourceSections');
const { UsageWorkProviderMark } = await import('@/components/settings/usage/widgets/UsageWorkProviderMark');
const { loadDaemonMergedProjectionCacheEntry, clearDaemonMergedProjectionCacheForTests } =
    await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const contributionKey = 'happier.provider.deepseek/deepseek';
const agentTargetKey = 'agent:happier.agent.codex/codex';
let serverId = '';

beforeEach(async () => {
    rpc.reset();
    clearDaemonMergedProjectionCacheForTests();
    const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
        connections: [{ v: 1, id: 'pc_a', source: { kind: 'contribution', contributionKey },
            role: 'default', displayName: 'DeepSeek', displayNameMode: 'automatic', revision: 1, createdAt: 1, updatedAt: 1 }] });
    serverId = (await account.restore({ serverIdentityId: 'srv_provider_mark_consumers', catalog, machines: rpc.state.machines,
        waivedActions: ['providers.connections.describe'] })).serverId;
});
afterEach(async () => { standardCleanup(); await account.reset(); });

describe('packaged Provider marks through admitted consumers', () => {
    it('renders packaged Provider artwork in Agent Models from the admitted Account source', async () => {
        const { AgentModelsScreen } = await import('@/components/settings/agents/AgentModelsScreen');
        const screen = await renderScreen(<AgentModelsScreen agentTargetKey="agent:happier.agent.claude/claude" runtimeAgentId={null} />);
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('DeepSeek'));
        expect(screen.findAllByType('Image').some(node => node.props.source?.uri?.startsWith('data:image/png;base64,'))).toBe(true);
    });
    it('renders the packaged mark in the session Runs through source section', async () => {
        rpc.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, async () => createProviderConnectionsDescribeFixture({
            connections: [createProviderConnectionViewFixture({ contributionKey, icon: 'cube', providerName: 'DeepSeek' })],
        }));
        const sources = { machineId: 'machine-a', serverId, agentTargetKey,
            shownSources: [{ connectionId: 'pc_a', rows: [{}] }], hiddenSources: [] };
        function Probe() {
            const sections = useSessionRouteSourceSections(sources);
            return <>{sections.flatMap(section => section.kind === 'static' ? section.options.map(option =>
                <React.Fragment key={option.id}>{renderSelectionListAccessory(option.icon)}</React.Fragment>) : [])}</>;
        }
        const screen = await renderScreen(<SessionModelSourceBrowseHandoffContext.Provider value={{ request: null, browse: () => {} }}>
            <Probe />
        </SessionModelSourceBrowseHandoffContext.Provider>);
        await waitForHomeGovernance(() => expect(screen.findAllByType(ProviderIcon)).toHaveLength(1));
        expect(screen.findAllByType('Image').some(node => node.props.source?.uri?.startsWith('data:image/png;base64,'))).toBe(true);
    });

    it('renders the gateway source glyph resolved by the connection owner', async () => {
        const gatewayKey = 'happier.provider.cliproxyapi/cliproxyapi';
        rpc.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, async () => createProviderConnectionsDescribeFixture({
            connections: [createProviderConnectionViewFixture({ connectionId: 'pc_gateway', contributionKey: gatewayKey,
                icon: 'cloud', deployment: { kind: 'managedLocal', targetMachineId: null, effects: null } })],
        }));
        const sources = { machineId: 'machine-a', serverId, agentTargetKey,
            shownSources: [{ connectionId: 'pc_gateway', rows: [{}] }], hiddenSources: [] };
        function Probe() {
            const sections = useSessionRouteSourceSections(sources);
            return <>{sections.flatMap(section => section.kind === 'static' ? section.options.map(option =>
                <React.Fragment key={option.id}>{renderSelectionListAccessory(option.icon)}</React.Fragment>) : [])}</>;
        }
        const screen = await renderScreen(<SessionModelSourceBrowseHandoffContext.Provider value={{ request: null, browse: () => {} }}>
            <Probe />
        </SessionModelSourceBrowseHandoffContext.Provider>);
        await waitForHomeGovernance(() => expect(rpc.state.requests.some(request =>
            request.method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE)).toBe(true));
        await waitForHomeGovernance(() => expect(screen.findAllByType(Icon)).toHaveLength(1));
        expect(screen.findAllByType(Icon).map(node => node.props.name)).toContain('cloud');
        expect(screen.findAllByType(Icon).map(node => node.props.name)).not.toContain('path');
    });

    it('renders the packaged Usage mark from the admitted projection identity without a definition or another read', async () => {
        // This is the current producer shape: providerProjectionFamily emits id/pluginId, without a definition.
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 7, familiesById: {
            providers: { family: 'providers', entriesById: { [contributionKey]: { id: contributionKey, pluginId: 'happier.provider.deepseek' } } },
        } });
        rpc.intercept(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, async () => ({ protocolVersion: 1, projection }));
        expect((await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId: 'machine-a', serverId }))?.kind).toBe('ready');
        const reads = rpc.state.requests.length;
        const screen = await renderScreen(<UsageWorkProviderMark providerId={contributionKey} machineId="machine-a" serverId={serverId} />);
        expect(screen.findAllByType('Image').some(node => node.props.source?.uri?.startsWith('data:image/png;base64,'))).toBe(true);
        expect(rpc.state.requests).toHaveLength(reads);
        const unknown = await renderScreen(<UsageWorkProviderMark providerId="unidentified" machineId="machine-a" serverId={serverId} />);
        expect(unknown.findAllByType('Image')).toHaveLength(0);
    });
});
