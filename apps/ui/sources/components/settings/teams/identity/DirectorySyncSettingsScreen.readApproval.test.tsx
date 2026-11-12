import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { teamCapabilitiesFixture, teamSummaryFixture } from '@/dev/testkit/fixtures/teamFixtures';
import {
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

const routeParams = vi.hoisted(() => ({ value: {} as Record<string, string> }));

// Platform view boundaries only; Team state, Actions, approval custody and the
// directory reader remain real through the Home's HTTP answers.
installSettingsViewCommonModuleMocks({
    storage: 'real',
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ navigation: { setOptions: () => undefined }, params: () => routeParams.value }).module;
    },
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { DirectorySyncSettingsScreen } = await import('./DirectorySyncSettingsScreen');
const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');

const SOURCE_PATH = '/v1/teams/team-1/directory-sources';
const SETUP_PATH = '/v1/teams/team-1/directory-source-setup-options';

beforeEach(async () => {
    const { Modal } = await import('@/modal');
    // Modal is the host boundary. Reuse this fixture's person-choice controller
    // for both ordinary confirmations and the real Action review dialog.
    vi.mocked(Modal.show).mockReset().mockImplementation(config => {
        if (config.chrome?.kind === 'card' && config.chrome.testID === 'actions.confirmation-review.modal') {
            const props = config.props as { onAnswer(confirmed: boolean): void };
            queueMicrotask(() => { void Modal.confirm('Action review', '').then(props.onAnswer); });
        }
        return 'action-review';
    });
    vi.mocked(Modal.confirm).mockReset().mockResolvedValue(true);
    standardCleanup();
    routeParams.value = {};
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
    await harness.reset();
});
afterEach(() => standardCleanup());

describe('Directory setup read approval', () => {
    it('reveals the setup section without reading options or starting WorkOS setup from a search link', async () => {
        const serverId = await harness.addHome({
            name: 'Searched Directory Home', serverUrl: 'https://directory-search.example',
            accountId: 'directory-admin', teamsEnabled: true,
        });
        harness.answer(serverId, '/v1/teams/get', { body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({ manageAuthentication: true }) }) });
        harness.answer(serverId, SOURCE_PATH, { body: { items: [], nextCursor: null } });
        harness.answer(serverId, SETUP_PATH, { body: { v: 1, items: [], nextCursor: null, complete: true } });
        routeParams.value = { setting: 'teams.directory.workosSetup' };
        const screen = await renderScreen(<DirectorySyncSettingsScreen serverId={serverId} teamId="team-1" />);

        await waitForHomeGovernance(() => expect(screen.findByTestId('team-directory-source-add')).not.toBeNull());
        await waitForHomeGovernance(() => expect(screen.findByTestId('setting-reveal.teams.directory.actions')).not.toBeNull());
        expect(screen.findByTestId('team-directory-setup-workos')).toBeNull();
        expect(harness.requestsFor(SETUP_PATH)).toHaveLength(0);
        expect(harness.requests.filter((request) => request.path.includes('/workos/'))).toHaveLength(0);
    });

    it('confirms Ask list and setup pages locally and retries a declined continuation without refetching prior pages', async () => {
        const serverId = await harness.addHome({
            name: 'Directory Home', serverUrl: 'https://directory-setup-approval.example',
            accountId: 'directory-admin', teamsEnabled: true,
        });
        harness.answer(serverId, '/v1/teams/get', { body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({ manageAuthentication: true }) }) });
        harness.answer(serverId, SOURCE_PATH, { body: { items: [], nextCursor: null } });
        harness.answer(serverId, SETUP_PATH, { body: {
            v: 1, items: [{ kind: 'github_organization', displayName: 'First org', githubAppInstallationId: 'install-1' }],
            nextCursor: 'setup-next', complete: false,
        } });
        harness.answer(serverId, `${SETUP_PATH}?cursor=setup-next`, { body: {
            v: 1, items: [{ kind: 'github_organization', displayName: 'Second org', githubAppInstallationId: 'install-2' }],
            nextCursor: null, complete: true,
        } });
        await harness.requireUiApproval(serverId, 'teams.directory.sources.list');
        const screen = await renderScreen(<DirectorySyncSettingsScreen serverId={serverId} teamId="team-1" />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-directory-source-add')).not.toBeNull());
        await harness.requireUiApproval(serverId, 'teams.directory.sourceSetup.list');
        await screen.pressByTestIdAsync('team-directory-source-add');
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-directory-setup-option:github_organization:install-1')).not.toBeNull());

        const { Modal } = await import('@/modal');
        vi.mocked(Modal.confirm).mockResolvedValueOnce(false);
        await screen.pressByTestIdAsync('team-directory-setup-load-more');
        expect(screen.findByTestId('team-directory-setup-option:github_organization:install-1')).not.toBeNull();
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-directory-setup-retry')).not.toBeNull());
        expect(harness.requestsFor(`${SETUP_PATH}?cursor=setup-next`)).toHaveLength(0);
        await screen.pressByTestIdAsync('team-directory-setup-retry');
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-directory-setup-option:github_organization:install-2')).not.toBeNull());
        expect(screen.findByTestId('team-directory-setup-option:github_organization:install-1')).not.toBeNull();
        expect(screen.findByTestId('team-directory-setup-load-more')).toBeNull();
        expect(harness.requestsFor(SOURCE_PATH)).toHaveLength(1);
        expect(harness.requestsFor(SETUP_PATH)).toHaveLength(1);
        expect(harness.requestsFor(`${SETUP_PATH}?cursor=setup-next`)).toHaveLength(1);
        expect(harness.artifacts(serverId).list()).toHaveLength(0);
        expect(Modal.confirm).toHaveBeenCalledTimes(4);
        await act(async () => screen.tree.unmount());
    });
});
