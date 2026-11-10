import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import { ProviderConnectionSecurityFingerprintV1Schema } from '@happier-dev/protocol/providers/fingerprints';

import { renderHook, renderScreen, standardCleanup, teamCapabilitiesFixture, teamCredentialSourceCandidateFixture, teamCredentialViewerFixture, teamSummaryFixture } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createProviderConnectionViewFixture, createProviderConnectionsDescribeFixture, createProviderSettingsAccountHarness, createProviderSettingsHarness, installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

const shownModals = vi.hoisted(() => [] as { chrome?: { testID?: string }; props?: Record<string, unknown> }[]);
// Only native navigation/modal ports, HTTP and daemon RPC are replaced. The
// Machine inventory, target selection, Home identity and source owners are real.
installSettingsViewCommonModuleMocks({
    storage: 'real',
    router: async () => ({
        useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
        useNavigation: () => ({ setOptions: vi.fn() }),
        useLocalSearchParams: () => ({}),
    }),
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: { show: config => {
            shownModals.push(config as (typeof shownModals)[number]);
            return 'modal-id';
        } } }).module;
    },
});

const daemon = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(daemon);
const account = createProviderSettingsAccountHarness();
// Load the real screen graph before the case deadline, as the adjacent Team
// suites do; module transformation is not part of the user-flow assertion.
const { TeamCredentialCreateScreen } = await import('./TeamCredentialCreateScreen');
const { useProviderSettingsTarget } = await import('@/providers/hooks/targetMachine');

afterEach(async () => {
    standardCleanup();
    daemon.reset();
    shownModals.length = 0;
    await account.reset();
});

it('offers the administered Provider when the Team uses the portable Home identity and its daemon uses the local profile id', async () => {
    const serverIdentityId = 'srv_team_provider_home_alias';
    const { serverId } = await account.restore({
        serverIdentityId,
        machines: [createMachineFixture({ id: 'machine-provider', activeAt: Date.now() })],
        features: createRootLayoutFeaturesResponse({
            capabilities: { serverIdentity: { serverIdentityId } },
            features: {
                providers: { enabled: true, externalApi: { enabled: true } },
                teams: { enabled: true, credentialResources: { enabled: true } },
            },
        }),
    });
    expect(serverId).not.toBe(serverIdentityId);
    await account.selectMachine(serverId, 'machine-provider');
    const target = await renderHook(() => useProviderSettingsTarget());
    await waitForHomeGovernance(() => {
        expect(target.getCurrent().selectedTargetServerMatchesActiveAccount).toBe(true);
        expect(target.getCurrent().machineRows).toHaveLength(1);
    });
    account.home.answer(serverId, '/v1/teams/get', { body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({}) }) });
    account.home.answer(serverId, '/v1/teams/credential-resources/list', { body: {
        resources: [], viewer: teamCredentialViewerFixture({ offerOwnCredential: true, manageCredentials: true }),
    } });
    account.home.answer(serverId, '/v1/teams/credential-resources/sources/list', { body: {
        candidates: [teamCredentialSourceCandidateFixture()], supportedKinds: ['connected_pool', 'provider_connection'],
        brokerPresentation: { selectedTarget: null, eligibleTargets: [], selectedPool: null, eligiblePools: [] },
    } });
    daemon.setResponse(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, createProviderConnectionsDescribeFixture({
        connections: [createProviderConnectionViewFixture({
            connectionId: 'pc_owned',
            teamCredentialSourceOffer: {
                connectionId: ProviderConnectionIdSchema.parse('pc_owned'),
                connectionSecurityFingerprint: ProviderConnectionSecurityFingerprintV1Schema.parse('connection-security:v1:owned'),
                credentialSlotId: 'apiKey', label: 'Owned local Provider',
            },
        })],
    }));

    const screen = await renderScreen(<TeamCredentialCreateScreen serverId={serverIdentityId} teamId="team-1" />);
    await waitForHomeGovernance(() => {
        expect(screen.findByTestId('team-credential-create-source')).toBeTruthy();
        expect(screen.findByTestId('team-credential-create-source')?.props.disabled).not.toBe(true);
    });
    await screen.pressByTestIdAsync('team-credential-create-source');
    const picker = shownModals.find(modal => modal.chrome?.testID === 'team-credential-source-picker:modal');
    const step = picker?.props?.rootStep as { sections: { options: { label: string }[] }[] } | undefined;
    expect(step?.sections.flatMap(section => section.options.map(option => option.label))).toContain('Owned local Provider');
});
