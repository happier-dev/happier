import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams';
import { ConnectedAccountPurposeTargetChooser } from '@happier-dev/plugin-ui/components';
import { PluginUiHostPresentationScope } from '@happier-dev/plugin-ui/advanced';
import { projectHappierUiEnvironment } from '@happier-dev/plugin-ui/environment';
import { createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import { renderScreen, standardCleanup, teamSummaryFixture } from '@/dev/testkit';
import { teamCredentialDisplayNameFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { SelectionList } from '@/components/ui/selectionList';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { ModalProvider } = await import('@/modal');
const { createPluginUiPrivatePresentationHost } = await import('./pluginUiPrivatePresentationHost');
afterEach(async () => { standardCleanup(); await home.reset(); });

it('offers and selects the entitled Team resource through the public chooser in its explicit execution scope', async () => {
    const serverId = await home.addHome({ name: 'Review Home', serverUrl: 'https://public-review-team.example.test',
        accountId: 'recipient', teamsEnabled: true, credentialResourcesEnabled: true });
    const service = { pluginId: 'com.acme.review', localId: 'account' };
    const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({ id: 'shared-review', teamId: 'team-review',
        displayName: teamCredentialDisplayNameFixture('Shared review account'), resourceRevision: 1,
        readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: false,
        directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed', providerModels: [],
        connectedServiceSelections: [{ source: 'team_resource', resourceId: 'shared-review', deliveryMode: 'brokered' }],
        sourcePresentation: { kind: 'connected_service', service } });
    home.answer(serverId, '/v1/teams/list', { body: { items: [teamSummaryFixture({ id: 'team-review' })], nextCursor: null } });
    home.answer(serverId, '/v1/teams/credential-resources/entitled/discover', { body: { resources: [resource], nextCursor: null, failures: [] } });
    const onChange = vi.fn();
    const screen = await renderScreen(<ModalProvider><PluginUiHostPresentationScope
        environment={projectHappierUiEnvironment(createSurfaceContextFixture())}
        presentationHost={createPluginUiPrivatePresentationHost(undefined)}>
        <ConnectedAccountPurposeTargetChooser testID="public-team-account" localizedTextPluginId="com.acme.review"
            declaration={{ purpose: 'review', service }} value={null} onChange={onChange}
            teamCredentialScope={{ serverId }} teamResourcesOnly />
    </PluginUiHostPresentationScope></ModalProvider>);
    await screen.pressByTestIdAsync('public-team-account');
    await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Shared review account'));
    const list = screen.findByType(SelectionList);
    const option = list.props.rootStep.sections.flatMap((section: { options: readonly { id: string; label: string }[] }) => section.options)
        .find((row: { label: string }) => row.label === 'Shared review account');
    if (!option) throw new Error('Expected the entitled Team resource');
    await act(async () => { list.props.onSelect(option.id, option); });
    expect(onChange).toHaveBeenCalledWith(null, { teamId: 'team-review',
        selection: { source: 'team_resource', resourceId: 'shared-review', deliveryMode: 'brokered' } });
});
