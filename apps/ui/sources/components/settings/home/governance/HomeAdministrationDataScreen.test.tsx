import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HomeSettingsProjectionV1 } from '@happier-dev/protocol/home/governance';

/**
 * Imported from their own testkit modules rather than the `@/dev/testkit` barrel, for the reason
 * `HomeAdministrationTeamsScreen.test.tsx` gives: the barrel binds the real transports before the
 * Home boundaries are installed.
 */
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import {
    homeGovernanceProjectionFixture,
    homeRetentionDomainEntriesFixture,
    homeRetentionGlobalEntriesFixture,
    homeSettingsProjectionFixture,
} from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import {
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { collectRenderedTestIds } from '@/dev/testkit/render/collectRenderedTestIds';
import { renderScreen } from '@/dev/testkit/render/renderScreen';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});

installSettingsViewCommonModuleMocks({
    storage: 'real',
    router: async () => ({
        useRouter: () => ({ push: vi.fn(), back: vi.fn(), setParams: vi.fn() }),
        useNavigation: () => ({ setOptions: vi.fn() }),
        useLocalSearchParams: () => ({}),
    }),
});

// Only the network and the device credential store are replaced; the Action executor, strict
// schemas, the registry codec and the page's retention logic are the production ones.
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { resetServerFeaturesClientForTests } = await import("@/sync/api/capabilities/serverFeaturesClient");
const { resetHomeSettingsEngineForTests } = await import('@/sync/engine/home/governance/homeSettingsEngine');
const { resetHomeSettingsSnapshotsForTests } = await import('@/sync/store/home/governance/homeSettingsSnapshots');
const { HomeAdministrationDataScreen } = await import('./HomeAdministrationDataScreen');
const { resetHomeGovernanceEngineForTests } = await import('@/sync/engine/home/governance/homeGovernanceEngine');

const GOVERNANCE_PATH = '/v1/home/governance/get';
const SETTINGS_GET = '/v1/home/settings/get';
const SETTINGS_SET = '/v1/home/settings/set';
const DRY_RUN = '/v1/home/retention/dry-run';
const SESSIONS_MODE = 'HAPPIER_SERVER_RETENTION__SESSIONS__MODE';
const SESSIONS_DAYS = 'HAPPIER_SERVER_RETENTION__SESSIONS__INACTIVITY_DAYS';

type RenderedNode = Readonly<{ children: ReadonlyArray<RenderedNode | string> }>;

function textUnder(node: RenderedNode | null): string {
    if (!node) return '';
    return node.children.map((child) => (typeof child === 'string' ? child : textUnder(child))).join('|');
}

/** Sessions keep forever (the default); usage events delete after 365 days; one system domain. */
function dataProjection(overrides?: Partial<HomeSettingsProjectionV1>): HomeSettingsProjectionV1 {
    return homeSettingsProjectionFixture({
        revision: 5,
        entries: [
            ...homeRetentionGlobalEntriesFixture({ enabled: { value: true, source: 'home' } }),
            ...homeRetentionDomainEntriesFixture({ domain: 'sessions', envName: 'SESSIONS', group: 'user', deleteMode: 'delete_inactive' }),
            ...homeRetentionDomainEntriesFixture({
                domain: 'usageEvents',
                envName: 'USAGE_EVENTS',
                group: 'user',
                mode: { value: 'delete_older_than', source: 'home' },
                days: { value: 365, source: 'home' },
            }),
            ...homeRetentionDomainEntriesFixture({ domain: 'accountChanges', envName: 'ACCOUNT_CHANGES', group: 'system' }),
        ],
        ...overrides,
    });
}

async function addHome(options?: Readonly<{ admin?: boolean }>): Promise<string> {
    const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example' });
    const projection = homeGovernanceProjectionFixture();
    harness.answer(home, GOVERNANCE_PATH, {
        body: options?.admin
            ? {
                ...projection,
                viewer: { ...projection.viewer, homeRole: 'admin' },
                capabilities: { ...projection.capabilities, manageHomeSettings: false },
            }
            : projection,
    });
    return home;
}

async function renderData(serverId: string) {
    resetHomeGovernanceEngineForTests();
    const screen = await renderScreen(<HomeAdministrationDataScreen serverId={serverId} />);
    await waitForHomeGovernance(() => {
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-retention:sessions');
    });
    return screen;
}

beforeEach(async () => {
    resetHomeSettingsEngineForTests();
    resetHomeSettingsSnapshotsForTests();
    const { resetHomeGovernanceSnapshotsForTests } = await import('@/sync/store/home/governance/homeGovernanceSnapshots');
    resetHomeGovernanceSnapshotsForTests();
    resetServerFeaturesClientForTests();
    await harness.reset();
});

afterEach(() => {
    standardCleanup();
});

describe('HomeAdministrationDataScreen', () => {
    it('waits for the days before deleting, then writes the mode and the days together', async () => {
        const home = await addHome();
        harness.answer(home, SETTINGS_GET, { body: dataProjection() });
        harness.answer(home, SETTINGS_SET, { body: dataProjection({ revision: 6 }) });

        const screen = await renderData(home);
        expect(screen.findByTestId('home-retention:sessions.days')).toBeNull();

        await act(async () => {
            screen.pressByTestId('home-retention:sessions.mode:delete');
        });
        // Choosing "Delete after" alone writes nothing: the Home refuses a deleting mode without days.
        expect(screen.findByTestId('home-retention:sessions.days')).not.toBeNull();
        expect(harness.requestsFor(SETTINGS_SET)).toHaveLength(0);

        await act(async () => {
            screen.changeTextByTestId('home-retention:sessions.days', '90');
        });
        await act(async () => {
            screen.findByTestId('home-retention:sessions.days')?.props.onSubmitEditing();
        });

        await waitForHomeGovernance(() => expect(harness.requestsFor(SETTINGS_SET)).toHaveLength(1));
        expect(harness.requestsFor(SETTINGS_SET)[0]?.input).toEqual({
            expectedRevision: 5,
            values: { [SESSIONS_MODE]: 'delete_inactive', [SESSIONS_DAYS]: 90 },
        });
    });

    it('keeps System records closed until opened, and shows each dry-run count under its row', async () => {
        const home = await addHome();
        harness.answer(home, SETTINGS_GET, { body: dataProjection() });
        harness.answer(home, DRY_RUN, {
            body: {
                ranAt: '2026-09-27T10:42:00.000Z',
                byDomain: {
                    sessions: { wouldDelete: 0, candidatesExamined: 0, stopReason: 'exhausted' },
                    usageEvents: { wouldDelete: 88, candidatesExamined: 88, stopReason: 'time_budget' },
                    accountChanges: { wouldDelete: 12, candidatesExamined: 12, stopReason: 'exhausted' },
                },
            },
        });

        const screen = await renderData(home);
        let ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).toContain('home-retention-system.header');
        expect(ids).not.toContain('home-retention:accountChanges');

        await act(async () => {
            await screen.pressByTestIdAsync('home-retention-dry-run.run');
        });

        await waitForHomeGovernance(() => {
            expect(textUnder(screen.findByTestId('home-retention:usageEvents')))
                .toContain('homeGovernance.data.wouldDelete(count=88,examined=88) · homeGovernance.data.stopTimeBudget');
        });
        expect(textUnder(screen.findByTestId('home-retention:sessions'))).toContain('homeGovernance.data.nothingToDelete');
        expect(textUnder(screen.findByTestId('home-retention-dry-run'))).toContain('homeGovernance.data.ranAt(');
        // A dry run opens the System records so their counts can be read.
        ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids).toContain('home-retention:accountChanges');
        expect(textUnder(screen.findByTestId('home-retention:accountChanges')))
            .toContain('homeGovernance.data.wouldDelete(count=12,examined=12)');
        expect(harness.requestsFor(SETTINGS_SET)).toHaveLength(0);
    });

    it('says a clean-up is running when the sweep holds the lock', async () => {
        const home = await addHome();
        harness.answer(home, SETTINGS_GET, { body: dataProjection() });
        harness.answer(home, DRY_RUN, { status: 409, body: { error: 'retention_sweep_in_progress' } });

        const screen = await renderData(home);
        await act(async () => {
            await screen.pressByTestIdAsync('home-retention-dry-run.run');
        });

        await waitForHomeGovernance(() => {
            expect(textUnder(screen.findByTestId('home-retention-dry-run'))).toContain('homeGovernance.data.sweepInProgress');
        });
    });

    it('says once that the deployment fixed a domain whose mode and days are both fixed', async () => {
        const home = await addHome();
        harness.answer(home, SETTINGS_GET, {
            body: dataProjection({
                entries: [
                    ...homeRetentionGlobalEntriesFixture(),
                    ...homeRetentionDomainEntriesFixture({
                        domain: 'sessionSidechainMessages',
                        envName: 'SESSION_SIDECHAIN_MESSAGES',
                        group: 'user',
                        mode: { value: 'delete_older_than', source: 'deployment', fixed: true },
                        days: { value: 7, source: 'deployment', fixed: true },
                    }),
                    ...homeRetentionDomainEntriesFixture({ domain: 'sessions', envName: 'SESSIONS', group: 'user', deleteMode: 'delete_inactive' }),
                ],
            }),
        });

        const screen = await renderData(home);
        const row = textUnder(screen.findByTestId('home-retention:sessionSidechainMessages'));

        // One lock line, at the row that owns it, naming the key as a code chip.
        expect(row.split('homeGovernance.fixedByDeploymentLead').length - 1).toBe(1);
        expect(textUnder(screen.findByTestId('home-retention:sessionSidechainMessages.fixed-key:0')))
            .toBe('HAPPIER_SERVER_RETENTION__SESSION_SIDECHAIN_MESSAGES__MODE');
        expect(row).not.toContain('homeGovernance.fixedByDeployment(');
        expect(screen.findByTestId('home-retention:sessionSidechainMessages.mode:keep')).toBeNull();
    });

    it('shows an admin the rules read-only, with no control and no dry run', async () => {
        const home = await addHome({ admin: true });
        harness.answer(home, SETTINGS_GET, { body: dataProjection() });

        const screen = await renderData(home);
        const ids = collectRenderedTestIds(screen.tree.toJSON());

        expect(ids).toContain('home-data-admin-read-only');
        expect(ids).not.toContain('home-retention-dry-run.run');
        expect(ids.filter((id) => id.includes('.mode:') || id.endsWith('.switch'))).toEqual([]);
        expect(textUnder(screen.findByTestId('home-retention:usageEvents')))
            .toContain('server.retention.deleteOlderThanDays(count=365)');
    });
});
