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
    featureDecisionFixture,
    homeFeatureSwitchEntryFixture,
    homeFeatureSwitchKey,
    homeGovernanceProjectionFixture,
    homeSettingEntryFixture,
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
// schemas, the protocol's dependency edges and the page's row logic are the production ones.
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
// Collect the screen after installing its boundaries, so cold module loading is not part of a case's deadline.
const { HomeAdministrationFeaturesScreen } = await import('./HomeAdministrationFeaturesScreen');
const { resetServerFeaturesClientForTests } = await import("@/sync/api/capabilities/serverFeaturesClient");
const { resetHomeSettingsEngineForTests } = await import('@/sync/engine/home/governance/homeSettingsEngine');
const { resetHomeSettingsSnapshotsForTests } = await import('@/sync/store/home/governance/homeSettingsSnapshots');

const GOVERNANCE_PATH = '/v1/home/governance/get';
const SETTINGS_GET = '/v1/home/settings/get';
const SETTINGS_SET = '/v1/home/settings/set';

type RenderedNode = Readonly<{ children: ReadonlyArray<RenderedNode | string> }>;

function textUnder(node: RenderedNode | null): string {
    if (!node) return '';
    return node.children.map((child) => (typeof child === 'string' ? child : textUnder(child))).join('|');
}

/**
 * A Home where Workflows is on; Voice is fixed by the deployment; Search is left out of this
 * build; Machine pools is off on this Home and Ephemeral runners wait on Machines; Session
 * handoff and Session folders (the Advanced "sessions" family) are on, and Pet sync is
 * the lone member of its family, so it is listed under "Other".
 */
function featuresProjection(overrides?: Partial<HomeSettingsProjectionV1>): HomeSettingsProjectionV1 {
    return homeSettingsProjectionFixture({
        revision: 7,
        entries: [
            homeFeatureSwitchEntryFixture('workflows'),
            homeFeatureSwitchEntryFixture('voice', { source: 'deployment', fixed: true }),
            homeFeatureSwitchEntryFixture('search'),
            homeFeatureSwitchEntryFixture('machines.pools', { value: false, source: 'home' }),
            homeFeatureSwitchEntryFixture('sessions.ephemeralRunner'),
            homeFeatureSwitchEntryFixture('sessions.handoff'),
            homeFeatureSwitchEntryFixture('sessions.folders'),
            homeFeatureSwitchEntryFixture('pets.sync'),
        ],
        featureDecisions: [
            featureDecisionFixture('workflows'),
            featureDecisionFixture('voice'),
            featureDecisionFixture('search', { state: 'disabled', blockedBy: 'build_policy', blockerCode: 'build_disabled' }),
            featureDecisionFixture('machines.pools', { state: 'disabled', blockedBy: 'server', blockerCode: 'feature_disabled' }),
            featureDecisionFixture('sessions.ephemeralRunner', {
                state: 'disabled',
                blockedBy: 'dependency',
                blockerCode: 'dependency_disabled',
                blockingDependencyId: 'machines',
            }),
            featureDecisionFixture('sessions.handoff'),
            featureDecisionFixture('sessions.folders'),
            featureDecisionFixture('pets.sync'),
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

async function renderFeatures(serverId: string) {
    const { resetHomeGovernanceEngineForTests } = await import('@/sync/engine/home/governance/homeGovernanceEngine');
    resetHomeGovernanceEngineForTests();
    const screen = await renderScreen(<HomeAdministrationFeaturesScreen serverId={serverId} />);
    await waitForHomeGovernance(() => {
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-feature:workflows');
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

describe('HomeAdministrationFeaturesScreen', () => {
    it('explains every row from the Home decisions: needs, fixed, not in this build and off for this Home', async () => {
        const home = await addHome();
        harness.answer(home, SETTINGS_GET, { body: featuresProjection() });

        const screen = await renderFeatures(home);
        const ids = collectRenderedTestIds(screen.tree.toJSON());

        // Common features come first, in the console's order, among what this Home projects.
        const common = ids.filter((id) => /^home-feature:[^.]+$|^home-feature:(sharing|machines|sessions|teams)\.[a-zA-Z]+$/.test(id));
        expect(common).toEqual([
            'home-feature:workflows',
            'home-feature:search',
            'home-feature:voice',
            'home-feature:machines.pools',
            'home-feature:sessions.ephemeralRunner',
        ]);

        // A feature waiting on another names it from the typed blocker, and cannot be switched.
        const runner = textUnder(screen.findByTestId('home-feature:sessions.ephemeralRunner'));
        expect(runner).toContain('homeGovernance.features.needs(feature=homeFeatures.machines.title)');
        expect(screen.findByTestId('home-feature:sessions.ephemeralRunner.switch')?.props.disabled).toBe(true);

        // A deployment-fixed key says so once and names its env key as a code chip, with no control.
        expect(textUnder(screen.findByTestId('home-feature:voice'))).toContain('homeGovernance.fixedByDeploymentLead');
        expect(textUnder(screen.findByTestId('home-feature:voice.fixed-key:0'))).toBe(homeFeatureSwitchKey('voice'));
        expect(textUnder(screen.findByTestId('home-feature:voice'))).not.toContain('homeGovernance.fixedByDeployment(');
        expect(screen.findByTestId('home-feature:voice.switch')).toBeNull();

        // A build that leaves the feature out says so, with no control.
        expect(textUnder(screen.findByTestId('home-feature:search'))).toContain('homeGovernance.features.notInBuild');
        expect(screen.findByTestId('home-feature:search.switch')).toBeNull();

        // Off because the owner turned it off, and still switchable back on.
        expect(textUnder(screen.findByTestId('home-feature:machines.pools'))).toContain('homeGovernance.features.offHome');
        expect(screen.findByTestId('home-feature:machines.pools.switch')?.props.disabled).toBe(false);

        // Advanced families are collapsed until opened.
        expect(ids).toContain('home-feature-family:sessions.header');
        expect(ids).toContain('home-feature-family:other.header');
        expect(ids).not.toContain('home-feature:sessions.handoff');
        await act(async () => {
            screen.pressByTestId('home-feature-family:sessions.header');
        });
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-feature:sessions.handoff');
    });

    it('stages a parent off with its dependents named inline under the row, and writes nothing until Save', async () => {
        const home = await addHome();
        harness.answer(home, SETTINGS_GET, { body: featuresProjection({
            entries: [
                homeFeatureSwitchEntryFixture('workflows'),
                homeFeatureSwitchEntryFixture('teams'),
                homeFeatureSwitchEntryFixture('teams.credentialResources'),
            ],
            featureDecisions: [
                featureDecisionFixture('workflows'),
                featureDecisionFixture('teams'),
                featureDecisionFixture('teams.credentialResources'),
            ],
        }) });
        harness.answer(home, SETTINGS_SET, {
            body: featuresProjection({
                revision: 8,
                entries: [
                    homeFeatureSwitchEntryFixture('workflows'),
                    homeFeatureSwitchEntryFixture('teams', { value: false, source: 'home' }),
                    homeFeatureSwitchEntryFixture('teams.credentialResources'),
                ],
                featureDecisions: [
                    featureDecisionFixture('workflows'),
                    featureDecisionFixture('teams', { state: 'disabled', blockedBy: 'server', blockerCode: 'feature_disabled' }),
                    featureDecisionFixture('teams.credentialResources', {
                        state: 'disabled',
                        blockedBy: 'dependency',
                        blockerCode: 'dependency_disabled',
                        blockingDependencyId: 'teams',
                    }),
                ],
            }),
        });
        const screen = await renderFeatures(home);
        const { Modal } = await import('@/modal');

        await act(async () => {
            screen.findByTestId('home-feature:teams.switch')?.props.onValueChange(false);
        });

        // The switch shows the staged value and the features that follow it are named under it.
        expect(screen.findByTestId('home-feature:teams.switch')?.props.value).toBe(false);
        const dependents = textUnder(screen.findByTestId('home-feature:teams.dependents'));
        expect(dependents).toContain('homeGovernance.features.dependentsTitle_one(feature=homeFeatures.teams.title)');
        expect(dependents).toContain('homeGovernance.features.dependentNeeds(feature=homeFeatures.teams.credentialResources.title,parent=homeFeatures.teams.title)');
        expect(Modal.confirm).not.toHaveBeenCalled();
        expect(harness.requestsFor(SETTINGS_SET)).toHaveLength(0);

        await act(async () => {
            await screen.pressByTestIdAsync('home-features-save');
        });
        await waitForHomeGovernance(() => expect(harness.requestsFor(SETTINGS_SET)).toHaveLength(1));
        expect(harness.requestsFor(SETTINGS_SET)[0]?.input).toEqual({
            expectedRevision: 7,
            values: { [homeFeatureSwitchKey('teams')]: false },
        });
        // The Home's answer is adopted: Team credentials says what it needs, and nothing is staged.
        await waitForHomeGovernance(() => {
            expect(textUnder(screen.findByTestId('home-feature:teams.credentialResources')))
                .toContain('homeGovernance.features.needs(feature=homeFeatures.teams.title)');
        });
        expect(screen.findByTestId('home-feature:teams.dependents')).toBeNull();
    });

    it('reverts every staged change on Discard without writing', async () => {
        const home = await addHome();
        harness.answer(home, SETTINGS_GET, { body: featuresProjection() });
        const screen = await renderFeatures(home);
        expect(screen.findByTestId('home-features-save')).toBeNull();

        await act(async () => {
            screen.findByTestId('home-feature:workflows.switch')?.props.onValueChange(false);
        });
        await act(async () => {
            screen.pressByTestId('home-features-discard');
        });
        // Discarding leaves nothing to save, so the row goes with the edit.
        expect(screen.findByTestId('home-features-save')).toBeNull();
        expect(screen.findByTestId('home-features-discard')).toBeNull();

        expect(screen.findByTestId('home-feature:workflows.switch')?.props.value).toBe(true);
        expect(screen.findByTestId('home-feature:workflows.dependents')).toBeNull();
        expect(harness.requestsFor(SETTINGS_SET)).toHaveLength(0);
    });

    it('shows a switch read only at start by its saved value, pending the restart, not by the running decision', async () => {
        const home = await addHome();
        harness.answer(home, SETTINGS_GET, {
            body: homeSettingsProjectionFixture({
                revision: 7,
                entries: [
                    homeFeatureSwitchEntryFixture('workflows'),
                    // Saved off, still running on until the next start; the last start ignored a bad value.
                    homeFeatureSwitchEntryFixture('search', {
                        value: false,
                        source: 'home',
                        apply: 'restart',
                        applied: { value: true, pending: true, ignoredReason: 'invalid_type' },
                    }),
                ],
                featureDecisions: [featureDecisionFixture('workflows'), featureDecisionFixture('search')],
            }),
        });

        const screen = await renderFeatures(home);
        const search = textUnder(screen.findByTestId('home-feature:search'));

        expect(search).toContain('homeGovernance.features.appliesAfterRestart');
        expect(search).toContain('homeGovernance.features.offAfterRestart');
        expect(search).toContain('homeGovernance.features.ignoredAtLastStart(reason=homeGovernance.features.ignoredInvalidType)');
        // The switch shows the saved value and stays switchable; the running decision does not override it.
        expect(screen.findByTestId('home-feature:search.switch')?.props.value).toBe(false);
        expect(screen.findByTestId('home-feature:search.switch')?.props.disabled).toBe(false);
    });

    it('says why a feature with no Home switch cannot be changed here, and offers no control', async () => {
        const home = await addHome();
        harness.answer(home, SETTINGS_GET, {
            body: featuresProjection({
                featureDecisions: [...(featuresProjection().featureDecisions ?? []), featureDecisionFixture('sharing.session')],
            }),
        });

        const screen = await renderFeatures(home);

        expect(textUnder(screen.findByTestId('home-feature:sharing.session'))).toContain('homeGovernance.features.noHomeSwitchOn');
        expect(screen.findByTestId('home-feature:sharing.session.switch')).toBeNull();
    });

    it('labels a limit row from its translated key label, never from the env key', async () => {
        const home = await addHome();
        const limitKey = 'HAPPIER_FEATURE_BUG_REPORTS__MAX_ARTIFACT_BYTES';
        harness.answer(home, SETTINGS_GET, {
            body: featuresProjection({
                entries: [
                    ...featuresProjection().entries,
                    homeFeatureSwitchEntryFixture('bugReports'),
                    homeSettingEntryFixture(limitKey, {
                        value: 1024,
                        declaration: { type: 'int', section: 'features', family: 'bugReports', featureId: 'bugReports', bounds: { min: 1024 } },
                    }),
                ],
                featureDecisions: [...(featuresProjection().featureDecisions ?? []), featureDecisionFixture('bugReports')],
            }),
        });

        const screen = await renderFeatures(home);
        await act(async () => {
            screen.pressByTestId('home-feature-family:bugReports.header');
        });

        const row = textUnder(screen.findByTestId(`home-feature-limit:${limitKey}`));
        expect(row).toContain(`homeFeatures.keys.${limitKey}.title`);
        expect(row).toContain(`homeFeatures.keys.${limitKey}.description`);
        expect(row).not.toContain('Max artifact bytes');
    });

    it('shows an admin every row read-only, with no switch', async () => {
        const home = await addHome({ admin: true });
        harness.answer(home, SETTINGS_GET, { body: featuresProjection() });

        const screen = await renderFeatures(home);
        const ids = collectRenderedTestIds(screen.tree.toJSON());

        expect(ids).toContain('home-features-admin-read-only');
        expect(ids.filter((id) => id.endsWith('.switch'))).toEqual([]);
        expect(textUnder(screen.findByTestId('home-feature:workflows'))).toContain('common.on');
    });
});
