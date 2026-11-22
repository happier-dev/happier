import * as React from 'react';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { ConnectedAccountUiProjectionEntryV1Schema } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import { CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1, CONNECTED_PRESENTATION_ROWS_ROUTE_V1,
    ConnectedAcknowledgementsRowReadResponseV1Schema, ConnectedPresentationRowReadResponseV1Schema } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ProjectSessionDefaultsV1Schema, type ProjectSessionDefaultsV1 } from '@happier-dev/protocol/projects/projectSessionDefaultsV1';
import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness, installBundledProviderDeclarationsRpcBoundary,
    installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

// test-policy-boundary: Generated packaged artwork is a build artifact; this test exercises the authored catalog.
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', () => ({
    BUNDLED_PLUGIN_UI_APP_ARTIFACTS: Object.freeze([]), BUNDLED_PLUGIN_UI_APP_DECLARATIONS: Object.freeze([]),
    BUNDLED_PLUGIN_BRAND_MARKS: Object.freeze([]), BUNDLED_PLUGIN_PACKAGED_RESOURCES: Object.freeze([]),
}));
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
// test-policy-boundary: Substitute Metro's deferred module loading only; the real catalog Action still executes.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
installSettingsViewCommonModuleMocks({ storage: 'real', text: () => vi.importActual('@/text'), modal: async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module });
const account = createProviderSettingsAccountHarness();
const rpc = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(rpc);
const disposeLoader = await installRealActionExecutorModuleLoader();
afterAll(disposeLoader);
const { ModalProvider, Modal } = await import('@/modal');
const { AppShellPluginUiProjectionProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
const { ProjectSessionDefaultsSection } = await import('./TeamMemberDefaultsSection');
const { getConnectedAccountAuthentication, getConnectedServiceRegistrySnapshot } = await import('@/sync/domains/connectedServices/connectedServiceRegistry');

const service = { pluginId: 'happier.agent.muse', localId: 'muse-account' };
const agentTargetKey = 'agent:happier.agent.muse/muse';
const accountRef = { service, accountId: 'ca_f8c33cae-11ca-4b8c-a886-a92d7598b965' };
const target = { kind: 'account' as const, account: accountRef };
const descriptor = ConnectedAccountUiProjectionEntryV1Schema.parse({
    id: service.localId, serviceId: service.localId, pluginId: service.pluginId,
    provenance: 'first_party', sourceKind: 'bundled', title: 'Muse', capabilities: ['usage'], diagnostics: [],
    availability: { state: 'available', reason: 'ready' },
    authentication: { defaultModeId: 'device', modes: [{ id: 'device', kind: 'oauthDeviceCode', scopes: [],
        outcomeReconciliation: 'none', browserReachability: 'unreachable' }] },
});

beforeEach(() => {
    rpc.reset();
    installBundledProviderDeclarationsRpcBoundary(rpc);
    const bundled = rpc.state.interceptors.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)!;
    rpc.intercept(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, async (request, next) => {
        const response = DaemonContributionRegistryProjectionDescribeResponseSchema.parse(await bundled(request, next));
        const projection = response.projection;
        return { ...response, projection: { ...projection, familiesById: { ...projection.familiesById,
            connectedAccounts: { family: 'connectedAccounts', entriesById: { [`${service.pluginId}/${service.localId}`]: descriptor } },
        } } };
    });
});
afterEach(async () => {
    await React.act(async () => { Modal.hideAll(); });
    await standardCleanup();
    await account.reset();
});

it.each(['personal-project', 'project'] as const)('uses the %s audience for the real credential chooser and preserves each personal edit', async scope => {
    const { serverId } = await account.restore({ accountId: 'admin', currentAccount: true,
        machines: [createMachineFixture({ id: 'machine-muse', activeAt: Date.now(), storageMode: 'plain' })],
        features: createRootLayoutFeaturesResponse({ features: { connectedServices: { enabled: true }, teams: { enabled: true },
            plugins: { enabled: true, ui: { enabled: true, reactNativeBundles: { enabled: true }, hostedWeb: { enabled: false } } } },
            capabilities: { connectedServices: { qualifiedAccounts: { protocolVersion: 4 }, credentialDelete: { revisionGuard: false } } } }),
        httpAnswers: {
            [`GET ${CONNECTED_PRESENTATION_ROWS_ROUTE_V1}`]: { body: ConnectedPresentationRowReadResponseV1Schema.parse({ status: 'absent' }) },
            [`GET ${CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1}`]: { body: ConnectedAcknowledgementsRowReadResponseV1Schema.parse({ status: 'absent' }) },
            '/v1/account/profile': { body: AccountProfileSchema.parse({ id: 'admin', connectedAccountsV4: [{
            ref: accountRef, status: 'connected', authenticationModeId: 'device', revisionSemantics: 'revisioned',
            credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa', configurationReady: true, configurationRevision: null,
            displayName: 'My Muse', scopes: [],
        }], connectedAccountGroupsV4: [] }) } },
    });
    const writes: Array<ProjectSessionDefaultsV1 | null> = [];
    function ProjectDefaultsHost() {
        const [defaults, setDefaults] = React.useState<ProjectSessionDefaultsV1>({
            defaultAgentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.muse', localId: 'muse' } },
        });
        return <AppShellPluginUiProjectionProvider><ModalProvider><ProjectSessionDefaultsSection
            testID="defaults" serverId={serverId} teamId="team-1" defaults={defaults} scope={scope} context={undefined}
            editable busy={false} save={async next => {
                const validated = next === null ? null : ProjectSessionDefaultsV1Schema.parse(next);
                writes.push(validated);
                setDefaults(validated ?? {});
            }} /></ModalProvider></AppShellPluginUiProjectionProvider>;
    }
    const screen = await renderScreen(<ProjectDefaultsHost />);
    const agent = () => screen.findAll(node => node.props.testID === 'defaults-agent:muse'
        && typeof node.props.onExpandedChange === 'function')[0];
    await waitForHomeGovernance(() => expect(agent()).toBeDefined());
    await React.act(async () => { agent()!.props.onExpandedChange(true); });
    const rowId = 'defaults-agent:muse:service:muse-native';
    // Unrelated Machine declarations can be incomplete; this exact bundled service is still usable.
    await waitForHomeGovernance(() => expect(getConnectedAccountAuthentication(service,
        getConnectedServiceRegistrySnapshot())?.defaultModeId).toBe('device'));
    await screen.pressByTestIdAsync(rowId);
    if (scope === 'project') {
        expect(screen.getTextContent()).not.toContain('My Muse');
        expect(writes).toEqual([]);
        return;
    }
    const option = () => screen.findAll(node => typeof node.props.testID === 'string'
        && node.props.testID.startsWith(`${rowId}:choice:`) && String(node.props.testID).includes(accountRef.accountId)
        && typeof node.props.onPress === 'function')[0];
    await waitForHomeGovernance(() => expect(option(), screen.getTextContent()).toBeDefined());
    await screen.pressByTestIdAsync(option()!.props.testID);
    await waitForHomeGovernance(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.connectedServicesByAgentTargetKey?.[agentTargetKey]).toEqual([{
        purpose: { consumer: { pluginId: 'happier.agent.muse', localId: 'muse' }, purpose: 'muse-native' }, service, target, teamResource: null,
    }]);
    await waitForHomeGovernance(() => expect(screen.findAll(node => node.props.testID === rowId
        && String(node.props.accessibilityLabel).includes('My Muse'))).not.toHaveLength(0));
    await screen.pressByTestIdAsync(rowId);
    await screen.pressByTestIdAsync(`${rowId}:choice:none`);
    await waitForHomeGovernance(() => expect(writes).toHaveLength(2));
    expect(writes[1]?.connectedServicesByAgentTargetKey).toBeUndefined();
    expect(writes[1]?.defaultAgentTarget).toEqual(writes[0]?.defaultAgentTarget);
});
