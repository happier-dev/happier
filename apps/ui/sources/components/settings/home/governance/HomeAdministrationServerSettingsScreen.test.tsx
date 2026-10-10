import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HomeSettingEntryV1, HomeSettingsProjectionV1 } from '@happier-dev/protocol/home/governance';

/**
 * Imported from their own testkit modules rather than the `@/dev/testkit` barrel, for the reason
 * `HomeAdministrationTeamsScreen.test.tsx` gives: the barrel binds the real transports before the
 * Home boundaries are installed.
 */
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import {
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
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});

installSettingsViewCommonModuleMocks({
    router: async () => ({
        useRouter: () => ({ push: vi.fn(), back: vi.fn(), setParams: vi.fn() }),
        useNavigation: () => ({ setOptions: vi.fn(), addListener: vi.fn(() => () => {}) }),
        useLocalSearchParams: () => ({}),
    }),
});

// Only the network and the device credential store are replaced; the Action executor, strict
// schemas, the registry codec and the page's row logic are the production ones.
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

const GOVERNANCE_PATH = '/v1/home/governance/get';
const SETTINGS_GET = '/v1/home/settings/get';
const SETTINGS_SET = '/v1/home/settings/set';

type RenderedNode = Readonly<{ children: ReadonlyArray<RenderedNode | string> | null }>;

function textUnder(node: RenderedNode | null): string {
    if (!node?.children) return '';
    return node.children.map((child) => (typeof child === 'string' ? child : textUnder(child))).join('|');
}

/** Registry-declared entries as a current Home projects them (with their declaration). */
const metricsPort = (overrides?: Partial<HomeSettingEntryV1>): HomeSettingEntryV1 => homeSettingEntryFixture('METRICS_PORT', {
    value: 9090,
    apply: 'restart',
    declaration: { type: 'int', section: 'server', group: 'monitoring', default: 9090, bounds: { min: 0, max: 65535 } },
    applied: { value: 9090, pending: false },
    ...overrides,
});
const listenPort = (): HomeSettingEntryV1 => homeSettingEntryFixture('PORT', {
    value: 3005,
    apply: 'restart',
    declaration: { type: 'int', section: 'server', group: 'process', default: 3005, bounds: { min: 1, max: 65535 } },
    applied: { value: 3005, pending: false },
});
const metricsEnabled = (): HomeSettingEntryV1 => homeSettingEntryFixture('HAPPIER_SELF_HOST_LOG_DIR', {
    value: null,
    declaration: { type: 'string', section: 'server', group: 'logging' },
});
const authDiagnostics = (): HomeSettingEntryV1 => homeSettingEntryFixture('HAPPIER_AUTH_DECORATOR_DIAGNOSTIC_LOGS', {
    value: false,
    declaration: { type: 'boolean', section: 'server', group: 'logging', default: false },
});
const redisUrl = (overrides?: Partial<HomeSettingEntryV1>): HomeSettingEntryV1 => homeSettingEntryFixture('REDIS_URL', {
    value: null,
    apply: 'restart',
    secretSet: false,
    declaration: { type: 'string', section: 'server', group: 'sockets' },
    applied: { value: null, pending: false },
    ...overrides,
});
const presenceTick = (): HomeSettingEntryV1 => homeSettingEntryFixture('HAPPIER_PRESENCE_TIMEOUT_TICK_MS', {
    value: 1000,
    apply: 'restart',
    declaration: { type: 'int', section: 'server', group: 'presence', default: 1000, bounds: { min: 1 } },
    applied: { value: 1000, pending: false },
});
const databaseUrl = (): HomeSettingEntryV1 => homeSettingEntryFixture('DATABASE_URL', {
    value: null,
    source: 'deployment',
    fixed: true,
    editable: 'bootstrap',
    apply: 'restart',
    secretSet: true,
    readOnlyReason: 'Read before the database opens.',
    declaration: { type: 'string', section: 'server', group: 'database', readOnlyReason: 'before_database' },
});
const emailHost = (): HomeSettingEntryV1 => homeSettingEntryFixture('HAPPIER_AUTH_EMAIL_SMTP_HOST', {
    value: 'smtp.example.com',
    source: 'home',
    declaration: { type: 'string', section: 'email' },
});

function serverProjection(overrides?: Partial<HomeSettingsProjectionV1>): HomeSettingsProjectionV1 {
    return homeSettingsProjectionFixture({
        revision: 7,
        startedAt: '2026-09-27T08:00:00.000Z',
        entries: [listenPort(), metricsPort(), metricsEnabled(), authDiagnostics(), redisUrl(), presenceTick(), databaseUrl(), emailHost()],
        ...overrides,
    });
}

async function addHome(): Promise<string> {
    const home = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example' });
    harness.answer(home, GOVERNANCE_PATH, { body: homeGovernanceProjectionFixture() });
    return home;
}

async function renderServerSettings(serverId: string) {
    const { HomeAdministrationServerSettingsScreen } = await import('./HomeAdministrationServerSettingsScreen');
    const { resetHomeGovernanceEngineForTests } = await import('@/sync/engine/home/governance/homeGovernanceEngine');
    resetHomeGovernanceEngineForTests();
    const screen = await renderScreen(<HomeAdministrationServerSettingsScreen serverId={serverId} />);
    await waitForHomeGovernance(() => {
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-server-setting:METRICS_PORT');
    });
    return screen;
}

async function typeAndLeave(screen: Awaited<ReturnType<typeof renderServerSettings>>, testID: string, text: string) {
    await act(async () => {
        screen.findByTestId(testID)?.props.onChangeText(text);
    });
    await act(async () => {
        screen.findByTestId(testID)?.props.onBlur();
    });
}

beforeEach(async () => {
    const { resetHomeGovernanceSnapshotsForTests } = await import('@/sync/store/home/governance/homeGovernanceSnapshots');
    resetHomeGovernanceSnapshotsForTests();
    resetServerFeaturesClientForTests();
    await harness.reset();
});

afterEach(() => {
    standardCleanup();
});

describe('HomeAdministrationServerSettingsScreen', { timeout: 180_000 }, () => {
    it.each([
        { status: 500, reason: 'homeGovernance.unavailableBody' },
        { status: 200, reason: 'homeGovernance.unavailableBody' },
        { status: 404, reason: 'homeGovernance.unsupportedBody' },
    ])('presents a $status initial settings read failure without reporting a failed change', async ({ status, reason }) => {
        const home = await addHome();
        harness.answer(home, SETTINGS_GET, { status, body: { error: 'unrecognized_response' } });
        const { HomeAdministrationServerSettingsScreen } = await import('./HomeAdministrationServerSettingsScreen');
        const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
        const screen = await renderScreen(<HomeAdministrationServerSettingsScreen serverId={home} />);
        await waitForHomeGovernance(() => {
            expect(screen.findAllByType(SurfaceStateCard).find((node) => node.props.testID === 'home-server-settings-error')).toBeDefined();
        });
        const errorState = screen.findAllByType(SurfaceStateCard).find((node) => node.props.testID === 'home-server-settings-error')!;
        expect(errorState.props).toMatchObject({ kind: 'error', reason });
        harness.answer(home, SETTINGS_GET, { body: serverProjection() });
        await act(async () => { errorState.props.action.onPress(); });
        await waitForHomeGovernance(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-server-setting:METRICS_PORT'));
    });

    it('explains a failed initial read and retries it through one recovery action', async () => {
        const home = await addHome();
        harness.answer(home, SETTINGS_GET, { dispatchThenFail: true });
        const { HomeAdministrationServerSettingsScreen } = await import('./HomeAdministrationServerSettingsScreen');
        const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
        const screen = await renderScreen(<HomeAdministrationServerSettingsScreen serverId={home} />);
        await waitForHomeGovernance(() => {
            expect(screen.findAllByType(SurfaceStateCard).find((node) => node.props.testID === 'home-server-settings-error')?.props)
                .toMatchObject({ kind: 'error', reason: 'homeGovernance.reasonHomeUnreachable' });
        });
        const errorState = screen.findAllByType(SurfaceStateCard).find((node) => node.props.testID === 'home-server-settings-error')!;
        expect(errorState.props.action).toMatchObject({ testID: 'home-server-settings-retry' });
        harness.answer(home, SETTINGS_GET, { body: serverProjection() });
        await act(async () => { errorState.props.action.onPress(); });
        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-server-setting:METRICS_PORT');
            expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('home-server-settings-error');
        });
    });

    it('renders the registry keys no other page owns, and every bootstrap key read-only with its reason', async () => {
        const home = await addHome();
        harness.answer(home, SETTINGS_GET, { body: serverProjection() });
        const screen = await renderServerSettings(home);
        const ids = collectRenderedTestIds(screen.tree.toJSON());

        expect(ids).toContain('home-server-setting:PORT');
        expect(ids).toContain('home-server-setting:HAPPIER_AUTH_DECORATOR_DIAGNOSTIC_LOGS');
        // Presence lives in a closed "More" group until opened.
        expect(ids).toContain('home-server-settings-more:realtime');
        expect(ids).not.toContain('home-server-setting:HAPPIER_PRESENCE_TIMEOUT_TICK_MS');
        // Email keys belong to the Email page.
        expect(ids).not.toContain('home-server-setting:HAPPIER_AUTH_EMAIL_SMTP_HOST');

        const database = screen.findByTestId('home-server-setting:DATABASE_URL');
        expect(textUnder(database)).toContain('homeSettings.readOnly.before_database');
        expect(ids.filter((id) => /^home-server-setting:DATABASE_URL.*(input|switch|-set|-replace)$/.test(id))).toEqual([]);
    });

    it('says a deployment-fixed key through the shared fixed note, with the key as a chip and never as prose', async () => {
        const home = await addHome();
        const fixedPort = { ...listenPort(), value: 43250, source: 'deployment' as const, fixed: true };
        harness.answer(home, SETTINGS_GET, { body: serverProjection({ entries: [fixedPort, metricsPort()] }) });
        const screen = await renderServerSettings(home);

        expect(textUnder(screen.findByTestId('home-server-setting:PORT.fixed-key:0'))).toBe('PORT');
        expect(textUnder(screen.findByTestId('home-server-setting:PORT'))).not.toContain('homeGovernance.fixedByDeployment(');
        expect(screen.findByTestId('home-server-setting:PORT.input')).toBeNull();
    });

    it('states each row\'s facts on one line with the key as a chip, the default in words, and a number\'s unit', async () => {
        const home = await addHome();
        harness.answer(home, SETTINGS_GET, { body: serverProjection() });
        const screen = await renderServerSettings(home);

        expect(textUnder(screen.findByTestId('home-server-setting:METRICS_PORT.facts-key'))).toBe('METRICS_PORT');
        expect(textUnder(screen.findByTestId('home-server-setting:METRICS_PORT.facts'))).toContain('homeSettings.row.defaultValue(value=9090)');
        expect(screen.findByTestId('home-server-setting:METRICS_PORT.facts')?.props.numberOfLines).toBe(1);
        await act(async () => {
            screen.pressByTestId('home-server-settings-more:realtime.header');
        });
        expect(textUnder(screen.findByTestId('home-server-setting:HAPPIER_PRESENCE_TIMEOUT_TICK_MS')))
            .toContain('homeSettings.row.defaultValue(value=1000 homeSettings.units.ms)');
        // Nothing stored yet: a write-only value offers Set, not an open field.
        expect(screen.findByTestId('home-server-setting:REDIS_URL-set')).not.toBeNull();
        expect(screen.findByTestId('home-server-setting:REDIS_URL-input')).toBeNull();
    });

    it('shows no "Updating" note once the Home has answered', async () => {
        const home = await addHome();
        harness.answer(home, SETTINGS_GET, { body: serverProjection() });
        const screen = await renderServerSettings(home);

        await waitForHomeGovernance(() => {
            expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('home-admin-updating');
        });
    });

    it('saves a restart key when its field is left, and shows it pending after the Home answers', async () => {
        const home = await addHome();
        harness.answer(home, SETTINGS_GET, { body: serverProjection() });
        harness.answer(home, SETTINGS_SET, {
            body: serverProjection({
                revision: 8,
                entries: [listenPort(), metricsPort({ value: 9191, source: 'home', applied: { value: 9090, pending: true } }), databaseUrl()],
            }),
        });
        const screen = await renderServerSettings(home);

        await typeAndLeave(screen, 'home-server-setting:METRICS_PORT.input', '9191');

        await waitForHomeGovernance(() => {
            expect(harness.requestsFor(SETTINGS_SET).map((request) => request.input)).toEqual([
                { expectedRevision: 7, values: { METRICS_PORT: 9191 } },
            ]);
            expect(screen.findByTestId('home-server-setting:METRICS_PORT.pending')).not.toBeNull();
        });
        const row = textUnder(screen.findByTestId('home-server-setting:METRICS_PORT'));
        expect(row).toContain('homeSettings.row.appliesAfterRestart');
        expect(row).toContain('homeSettings.row.runningWith(value=9090)');
        expect(textUnder(screen.findByTestId('home-runtime-pending-restart'))).toContain('homeGovernance.runtime.pendingRestart(count=1)');
    });

    it('refuses an out-of-range value at the field, with its bounds, without writing', async () => {
        const home = await addHome();
        harness.answer(home, SETTINGS_GET, { body: serverProjection() });
        const screen = await renderServerSettings(home);

        await typeAndLeave(screen, 'home-server-setting:METRICS_PORT.input', '70000');

        expect(harness.requestsFor(SETTINGS_SET)).toHaveLength(0);
        expect(textUnder(screen.findByTestId('home-server-setting:METRICS_PORT.input.error')))
            .toBe('homeSettings.row.outOfBounds(bounds=homeGovernance.features.rangeBetween(min=0,max=65535))');
    });

    it('shows the Home\'s refusal on the row it names', async () => {
        const home = await addHome();
        harness.answer(home, SETTINGS_GET, { body: serverProjection() });
        harness.answer(home, SETTINGS_SET, {
            status: 400,
            body: { error: 'home_settings_invalid', key: 'HAPPIER_SELF_HOST_LOG_DIR', reason: 'invalid_type' },
        });
        const screen = await renderServerSettings(home);

        await typeAndLeave(screen, 'home-server-setting:HAPPIER_SELF_HOST_LOG_DIR.input', '/var/log/happier');

        await waitForHomeGovernance(() => {
            expect(textUnder(screen.findByTestId('home-server-setting:HAPPIER_SELF_HOST_LOG_DIR.input.error'))).toBe('homeSettings.row.invalid');
        });
    });

    it('applies a live switch at once', async () => {
        const home = await addHome();
        harness.answer(home, SETTINGS_GET, { body: serverProjection() });
        harness.answer(home, SETTINGS_SET, { body: serverProjection({ revision: 8 }) });
        const screen = await renderServerSettings(home);

        await act(async () => {
            screen.findByTestId('home-server-setting:HAPPIER_AUTH_DECORATOR_DIAGNOSTIC_LOGS.switch')?.props.onValueChange(true);
        });

        await waitForHomeGovernance(() => {
            expect(harness.requestsFor(SETTINGS_SET).map((request) => request.input)).toEqual([
                { expectedRevision: 7, values: { HAPPIER_AUTH_DECORATOR_DIAGNOSTIC_LOGS: true } },
            ]);
        });
    });

    it('stages a write-only value through blur and submit until explicit Save, then never shows it', async () => {
        const home = await addHome();
        harness.answer(home, SETTINGS_GET, { body: serverProjection() });
        harness.answer(home, SETTINGS_SET, { body: serverProjection({ revision: 8 }) });
        const screen = await renderServerSettings(home);
        await act(async () => {
            screen.pressByTestId('home-server-settings-more:realtime.header');
        });

        await act(async () => {
            screen.pressByTestId('home-server-setting:REDIS_URL-set');
        });
        await act(async () => {
            screen.changeTextByTestId('home-server-setting:REDIS_URL-input', 'redis://cache:6379');
        });
        await act(async () => {
            const input = screen.findByTestId('home-server-setting:REDIS_URL-input');
            input?.props.onBlur?.();
            input?.props.onSubmitEditing?.();
        });
        expect(harness.requestsFor(SETTINGS_SET)).toHaveLength(0);
        expect(screen.findByTestId('home-server-setting:REDIS_URL-input')?.props.value).toBe('redis://cache:6379');
        await act(async () => {
            screen.pressByTestId('home-server-setting:REDIS_URL-save');
        });

        await waitForHomeGovernance(() => {
            expect(harness.requestsFor(SETTINGS_SET).map((request) => request.input)).toEqual([
                { expectedRevision: 7, values: {}, secrets: { REDIS_URL: { replace: 'redis://cache:6379' } } },
            ]);
        });
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain('redis://cache:6379');
    });

    it('stages Clear for a saved secret until explicit Save and can keep it instead', async () => {
        const home = await addHome();
        harness.answer(home, SETTINGS_GET, { body: serverProjection({ entries: [metricsPort(), redisUrl({ secretSet: true })] }) });
        harness.answer(home, SETTINGS_SET, { body: serverProjection({ revision: 8 }) });
        const screen = await renderServerSettings(home);
        const { Item } = await import('@/components/ui/lists/Item');
        await act(async () => {
            screen.pressByTestId('home-server-settings-more:realtime.header');
        });
        await act(async () => {
            screen.pressByTestId('home-server-setting:REDIS_URL-clear');
        });
        expect(harness.requestsFor(SETTINGS_SET)).toHaveLength(0);
        await act(async () => {
            screen.pressByTestId('home-server-setting:REDIS_URL-keep');
        });
        expect(screen.findByTestId('home-server-setting:REDIS_URL-saved')).not.toBeNull();
        expect(screen.findAllByType(Item).find((node) => node.props.testID === 'home-server-setting:REDIS_URL')?.props.accessoryLayout)
            .toBe('adaptive');
        await act(async () => {
            screen.pressByTestId('home-server-setting:REDIS_URL-clear');
        });
        await act(async () => {
            screen.pressByTestId('home-server-setting:REDIS_URL-save');
        });
        await waitForHomeGovernance(() => {
            expect(harness.requestsFor(SETTINGS_SET).map((request) => request.input)).toEqual([
                { expectedRevision: 7, values: {}, secrets: { REDIS_URL: { clear: true } } },
            ]);
        });
    });

    it('discards pending changes through the Home, and offers no Restart now without an executor', async () => {
        const home = await addHome();
        const pending = serverProjection({
            entries: [listenPort(), metricsPort({ value: 9191, source: 'home', applied: { value: 9090, pending: true } }), databaseUrl()],
        });
        harness.answer(home, SETTINGS_GET, { body: pending });
        harness.answer(home, SETTINGS_SET, { body: serverProjection({ revision: 8 }) });
        const screen = await renderServerSettings(home);

        const banner = textUnder(screen.findByTestId('home-runtime-pending-restart'));
        expect(banner).not.toContain('homeGovernance.runtime.restartNow');
        await act(async () => {
            screen.pressByTestId('home-runtime-pending-restart.discard');
        });

        await waitForHomeGovernance(() => {
            expect(harness.requestsFor(SETTINGS_SET).map((request) => request.input)).toEqual([
                { expectedRevision: 7, values: {}, discardPendingRestart: true },
            ]);
            expect(screen.findByTestId('home-runtime-pending-restart')).toBeNull();
        });
    });

    it('says which setting the last start ignored, and why', async () => {
        const home = await addHome();
        harness.answer(home, SETTINGS_GET, {
            body: serverProjection({
                entries: [listenPort(), metricsPort({ value: 70000, source: 'home', applied: { value: 9090, pending: true, ignoredReason: 'out_of_bounds' } })],
            }),
        });
        const screen = await renderServerSettings(home);

        expect(textUnder(screen.findByTestId('home-server-settings-ignored'))).toContain('homeGovernance.features.ignoredOutOfBounds');
        expect(textUnder(screen.findByTestId('home-server-setting:METRICS_PORT'))).toContain('homeSettings.row.ignored');
    });
});
