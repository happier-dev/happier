import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    collectRenderedTestIds,
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';

import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerPush = vi.hoisted(() => vi.fn());

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});

installSettingsViewCommonModuleMocks({
    router: async () => ({
        useRouter: () => ({ push: routerPush, replace: vi.fn(), back: vi.fn(), canGoBack: () => false }),
        useNavigation: () => ({ setOptions: vi.fn() }),
        useLocalSearchParams: () => ({}),
    }),
});

// Device boundaries the logo picker reaches at import; this form's policy link never uses them.
vi.mock('@/utils/files/nativePickImages', () => ({ nativePickImages: vi.fn() }));
vi.mock('expo-file-system', () => ({
    File: class {
        async bytes(): Promise<Uint8Array> { return new Uint8Array(); }
    },
}));

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

const ELIGIBILITY_PATH = '/v1/home/governance/eligibility/get';

async function renderCreate() {
    const { TeamCreateScreen } = await import('./TeamCreateScreen');
    return renderScreen(<TeamCreateScreen />);
}

beforeEach(async () => {
    const { resetHomeGovernanceEligibilitySnapshotsForTests } = await import(
        '@/sync/store/home/governance/homeGovernanceEligibilitySnapshots'
    );
    const { resetHomeGovernanceEligibilityEngineForTests } = await import(
        '@/sync/engine/home/governance/homeGovernanceEligibilityEngine'
    );
    resetHomeGovernanceEligibilitySnapshotsForTests();
    resetHomeGovernanceEligibilityEngineForTests();
    resetServerFeaturesClientForTests();
    await harness.reset();
    await harness.selectHomes([]);
    routerPush.mockReset();
});

afterEach(() => standardCleanup());

describe('TeamCreateScreen creation policy link', () => {
    it('lets an administrator of managed creation open the policy that would let everyone create Teams', async () => {
        const home = await harness.addHome({
            name: 'Studio', serverUrl: 'https://studio.example', accountId: 'admin-a', teamsEnabled: true,
        });
        await harness.selectHomes([home]);
        harness.answer(home, ELIGIBILITY_PATH, {
            body: { teamsEnabled: true, createTeam: true, createTeamForChosenAccount: true, teamCreationPolicy: 'managed_only' },
        });

        const screen = await renderCreate();
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-create-open-creation-policy'));
        await screen.pressByTestIdAsync('teams-create-open-creation-policy');

        expect(routerPush).toHaveBeenCalledWith(
            `/settings/home/${encodeURIComponent(home)}/teams?setting=homeAdministration.teamsPolicy.teamCreationPolicy`,
        );
    });

    it('offers no policy link to someone who creates Teams for themselves', async () => {
        const home = await harness.addHome({
            name: 'Studio', serverUrl: 'https://studio.example', accountId: 'member-a', teamsEnabled: true,
        });
        await harness.selectHomes([home]);
        harness.answer(home, ELIGIBILITY_PATH, {
            body: { teamsEnabled: true, createTeam: true, createTeamForChosenAccount: false, teamCreationPolicy: 'self_service' },
        });

        const screen = await renderCreate();
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-create-submit'));
        expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('teams-create-open-creation-policy');
    });

    it('names a single eligible Home on the header meta line instead of a one-row choice', async () => {
        const home = await harness.addHome({
            name: 'Studio', serverUrl: 'https://studio.example', accountId: 'member-a', teamsEnabled: true,
        });
        await harness.selectHomes([home]);
        harness.answer(home, ELIGIBILITY_PATH, {
            body: { teamsEnabled: true, createTeam: true, createTeamForChosenAccount: false, teamCreationPolicy: 'self_service' },
        });

        const screen = await renderCreate();
        await vi.waitFor(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('teams-create-submit'));
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(`teams-create-home:${home}`);
        expect(screen.getTextContent()).toContain('Studio');
        // A fact, not a control: no one-option radio group for the Home.
        const radioHome = screen.tree.root.findAll((node) => node.props.testID === `teams-create-home:${home}`
            && (node.props.accessibilityRole === 'radio' || node.props.role === 'radio'));
        expect(radioHome).toHaveLength(0);
    });
});
