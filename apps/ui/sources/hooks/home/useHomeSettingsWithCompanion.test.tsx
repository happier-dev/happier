import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Imported from their own testkit modules rather than the `@/dev/testkit` barrel: the barrel binds
 * the real transports before the Home boundaries are installed.
 */
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { homeReachabilityFixture, homeSettingsProjectionFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import {
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';

import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});

installSettingsViewCommonModuleMocks({
    storage: 'real',
    router: async () => ({
        useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
        useNavigation: () => ({ setOptions: vi.fn() }),
        useLocalSearchParams: () => ({}),
    }),
});

// Only the network and the device credential store are replaced; the Action executor and the
// hook's read lifecycle are the production ones.
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { resetServerFeaturesClientForTests } = await import("@/sync/api/capabilities/serverFeaturesClient");
const { HomeConsoleShell } = await import('@/components/settings/home/governance/HomeConsoleNavigation');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const { resetHomeSettingsEngineForTests } = await import('@/sync/engine/home/governance/homeSettingsEngine');
const { resetHomeSettingsSnapshotsForTests, getHomeSettingsSnapshot, subscribeHomeSettingsSnapshots } = await import('@/sync/store/home/governance/homeSettingsSnapshots');

const SETTINGS_GET = '/v1/home/settings/get';

beforeEach(async () => {
    resetHomeSettingsEngineForTests();
    resetHomeSettingsSnapshotsForTests();
    resetServerFeaturesClientForTests();
    await harness.reset();
});

afterEach(() => {
    standardCleanup();
});

describe('useHomeSettingsWithCompanion', () => {
    it('keeps an accepted companion mutation when an older reload answers later', async () => {
        const { useHomeSettingsWithCompanion } = await import('./useHomeSettingsWithCompanion');
        const { getHomeReachability, setHomeIrohMode } = await import('@/sync/ops/home/homeGovernanceOperations');
        const serverId = await harness.addHome({ name: 'Home A', serverUrl: 'https://companion-adoption.example', accountId: 'account-admin' });
        const scope = { serverId, accountId: 'account-admin' };
        const reachPath = '/v1/home/reachability/get';
        const read = (current: typeof scope) => getHomeReachability({ scope: current });
        const original = homeReachabilityFixture();
        const accepted = homeReachabilityFixture({ iroh: { ...original.iroh, mode: 'disabled', state: 'retired', endpointId: null } });
        harness.answer(serverId, SETTINGS_GET, { body: homeSettingsProjectionFixture({ revision: 3 }) });
        harness.answer(serverId, reachPath, { body: original });
        const hook = await renderHook(() => useHomeSettingsWithCompanion(scope, true, read));
        await waitForHomeGovernance(() => expect(hook.getCurrent().companion?.iroh.mode).toBe('enabled'));
        const held = createDeferred<void>();
        harness.answer(serverId, reachPath, { body: original, respondAfter: held.promise });
        await act(async () => { await hook.getCurrent().reload(); });
        await waitForHomeGovernance(() => expect(harness.requestsFor(reachPath)).toHaveLength(2));
        expect(hook.getCurrent().companionLoading).toBe(true);
        harness.answer(serverId, '/v1/home/reachability/iroh/set', { body: accepted });
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.confirm).mockResolvedValueOnce(true);
        await act(async () => {
            const mutation = await setHomeIrohMode({ scope, mode: 'disabled' });
            expect(mutation).toMatchObject({ kind: 'succeeded' });
            if (mutation.kind === 'succeeded') hook.getCurrent().adoptCompanion(mutation.value);
        });
        expect(hook.getCurrent()).toMatchObject({ companion: { iroh: { mode: 'disabled' } }, companionLoading: false, companionFailure: null });
        await act(async () => { held.resolve(); });
        expect(hook.getCurrent()).toMatchObject({ companion: { iroh: { mode: 'disabled' } }, companionLoading: false, companionFailure: null });
        expect(harness.requestsFor(reachPath)).toHaveLength(2);
    });

    it('refreshes only a demanded companion when a sibling writer adopts settings', async () => {
        const { useHomeSettingsWithCompanion } = await import('./useHomeSettingsWithCompanion');
        const { useHomeSettings } = await import('./useHomeSettings');
        const { getHomeReachability } = await import('@/sync/ops/home/homeGovernanceOperations');
        const serverId = await harness.addHome({ name: 'Home A', serverUrl: 'https://settings-sibling-writer.example', accountId: 'account-admin' });
        const scope = { serverId, accountId: 'account-admin' };
        const reachPath = '/v1/home/reachability/get';
        const readReach = (scope: Readonly<{ serverId: string; accountId: string }>) => getHomeReachability({ scope });
        harness.answer(serverId, SETTINGS_GET, { body: homeSettingsProjectionFixture({ revision: 3 }) });
        harness.answer(serverId, reachPath, { body: homeReachabilityFixture({ publicAddress: { url: 'https://before.example', source: 'home' } }) });
        const hook = await renderHook(() => ({
            writer: useHomeSettings(scope, true),
            companion: useHomeSettingsWithCompanion(scope, true, readReach),
            disabled: useHomeSettingsWithCompanion(scope, false, readReach),
        }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().companion.companion?.publicAddress.url).toBe('https://before.example'));
        expect(harness.requestsFor(SETTINGS_GET)).toHaveLength(1);
        expect(harness.requestsFor(reachPath)).toHaveLength(1);
        const accepted = homeSettingsProjectionFixture({ revision: 4 });
        harness.answer(serverId, reachPath, { body: homeReachabilityFixture({ publicAddress: { url: 'https://after.example', source: 'home' } }) });
        await act(async () => { hook.getCurrent().writer.adoptSettings(accepted); });
        expect(harness.requestsFor(reachPath)).toHaveLength(2);
        await waitForHomeGovernance(() => expect(hook.getCurrent().companion.companion?.publicAddress.url).toBe('https://after.example'));
        expect(hook.getCurrent().companion.settings).toBe(accepted);
        expect(hook.getCurrent().disabled.companion).toBeNull();
        expect(harness.requestsFor(SETTINGS_GET)).toHaveLength(1);
        expect(harness.requestsFor(reachPath)).toHaveLength(2);
    });

    it('keeps a superseded registry answer stale until the deciding trailing read settles', async () => {
        const { useHomeSettingsWithCompanion } = await import('./useHomeSettingsWithCompanion');
        const serverId = await harness.addHome({ name: 'Home A', serverUrl: 'https://settings-wake-pending.example', accountId: 'account-admin' });
        const scope = { serverId, accountId: 'account-admin' };
        harness.answer(serverId, SETTINGS_GET, { body: homeSettingsProjectionFixture({ revision: 3 }) });
        const hook = await renderHook(() => useHomeSettingsWithCompanion<never>(scope, true, null));
        await waitForHomeGovernance(() => expect(hook.getCurrent().settings?.revision).toBe(3));
        const oldRead = createDeferred<void>();
        const currentRead = createDeferred<void>();
        harness.answer(serverId, SETTINGS_GET, { body: homeSettingsProjectionFixture({ revision: 4 }), respondAfter: oldRead.promise });
        let reload!: Promise<void>;
        await act(async () => { reload = hook.getCurrent().reload(); });
        await waitForHomeGovernance(() => expect(harness.requestsFor(SETTINGS_GET)).toHaveLength(2));
        const observations: ReturnType<typeof getHomeSettingsSnapshot>[] = [];
        const stop = subscribeHomeSettingsSnapshots(() => observations.push(getHomeSettingsSnapshot(scope)));
        harness.answer(serverId, SETTINGS_GET, { body: homeSettingsProjectionFixture({ revision: 5 }), respondAfter: currentRead.promise });
        await act(async () => { publishHomeAccountChange(serverId); });
        await act(async () => { oldRead.resolve(); });
        await waitForHomeGovernance(() => expect(harness.requestsFor(SETTINGS_GET)).toHaveLength(3));
        try {
            expect(observations.filter((snapshot) => snapshot?.settings?.revision === 4).every((snapshot) => snapshot?.stale)).toBe(true);
        } finally {
            stop();
            await act(async () => { currentRead.resolve(); await reload; });
        }
        expect(hook.getCurrent().settings?.revision).toBe(5);
        expect(getHomeSettingsSnapshot(scope)?.stale).toBe(false);
    });

    it('withdraws the retired credential projection and rejects its late registry answer', async () => {
        const { useHomeSettingsWithCompanion } = await import('./useHomeSettingsWithCompanion');
        const serverId = await harness.addHome({ name: 'Home A', serverUrl: 'https://settings-credential-retired.example', accountId: 'account-a' });
        const scope = { serverId, accountId: 'account-a' };
        harness.answer(serverId, SETTINGS_GET, { body: homeSettingsProjectionFixture({ revision: 3 }) });
        const hook = await renderHook(() => useHomeSettingsWithCompanion<never>(scope, true, null));
        await waitForHomeGovernance(() => expect(hook.getCurrent().settings?.revision).toBe(3));
        const pending = createDeferred<void>();
        harness.answer(serverId, SETTINGS_GET, { body: homeSettingsProjectionFixture({ revision: 4 }), respondAfter: pending.promise });
        let reload!: Promise<void>;
        await act(async () => { reload = hook.getCurrent().reload(); });
        await waitForHomeGovernance(() => expect(harness.requestsFor(SETTINGS_GET)).toHaveLength(2));
        try {
            await act(async () => { await harness.switchAccount(serverId, 'account-b'); });
            expect(hook.getCurrent().settings).toBeNull();
        } finally {
            await act(async () => { pending.resolve(); await reload; });
        }
        expect(hook.getCurrent().settings).toBeNull();
    });

    it('retains registry content on a transient failure and withdraws it after an authoritative refusal', async () => {
        const { useHomeSettingsWithCompanion } = await import('./useHomeSettingsWithCompanion');
        const serverId = await harness.addHome({ name: 'Home A', serverUrl: 'https://settings-refusal.example', accountId: 'account-admin' });
        const scope = { serverId, accountId: 'account-admin' };
        harness.answer(serverId, SETTINGS_GET, { body: homeSettingsProjectionFixture({ revision: 3 }) });
        const hook = await renderHook(() => useHomeSettingsWithCompanion<never>(scope, true, null));
        await waitForHomeGovernance(() => expect(hook.getCurrent().settings?.revision).toBe(3));
        const admitted = hook.getCurrent().settings;
        harness.answer(serverId, SETTINGS_GET, { status: 503, body: { error: 'temporarily_unavailable' } });
        await act(async () => { await hook.getCurrent().reload(); });
        expect(hook.getCurrent().settings).toBe(admitted);
        expect(hook.getCurrent().failure?.retryable).toBe(true);
        harness.answer(serverId, SETTINGS_GET, { status: 403, body: { error: 'home_governance_forbidden' } });
        await act(async () => { await hook.getCurrent().reload(); });
        expect(hook.getCurrent().failure?.kind).toBe('forbidden');
        expect(hook.getCurrent().settings).toBeNull();
    });

    it('loads settings only on demand, shares them across console pages, and refreshes on intent, wake, and console return', async () => {
        const { useHomeSettingsWithCompanion } = await import('./useHomeSettingsWithCompanion');
        const serverId = await harness.addHome({ name: 'Shared Home', serverUrl: 'https://shared-settings.example', accountId: 'account-admin' });
        const scope = { serverId, accountId: 'account-admin' };
        harness.answer(serverId, SETTINGS_GET, { body: homeSettingsProjectionFixture({ revision: 3 }) });
        let current!: ReturnType<typeof useHomeSettingsWithCompanion<never>>;
        function SettingsPage() {
            current = useHomeSettingsWithCompanion<never>(scope, true, null);
            return null;
        }
        const consolePage = (key?: string) => React.createElement(HomeConsoleShell, {
            serverId, rail: 'console', children: key ? React.createElement(SettingsPage, { key }) : null,
        });
        const screen = await renderScreen(consolePage());
        expect(harness.requestsFor(SETTINGS_GET)).toHaveLength(0);
        await screen.update(consolePage('features'));
        await waitForHomeGovernance(() => expect(current.settings?.revision).toBe(3));
        expect(harness.requestsFor(SETTINGS_GET)).toHaveLength(1);
        const admitted = current.settings;

        await screen.update(consolePage('server-settings'));
        await waitForHomeGovernance(() => expect(current.loading).toBe(false));
        expect(harness.requestsFor(SETTINGS_GET)).toHaveLength(1);
        expect(current.settings).toBe(admitted);

        await act(async () => { await current.reload(); });
        expect(harness.requestsFor(SETTINGS_GET)).toHaveLength(2);
        harness.answer(serverId, SETTINGS_GET, { body: homeSettingsProjectionFixture({ revision: 4 }) });
        await act(async () => { publishHomeAccountChange(serverId); });
        await waitForHomeGovernance(() => expect(current.settings?.revision).toBe(4));
        expect(harness.requestsFor(SETTINGS_GET)).toHaveLength(3);

        await screen.update(React.createElement(React.Fragment));
        await screen.update(consolePage('data'));
        await waitForHomeGovernance(() => expect(current.loading).toBe(false));
        expect(harness.requestsFor(SETTINGS_GET)).toHaveLength(4);
    });

    it('does not expose settings or companions from a previous Account or accept its pending answers', async () => {
        const { useHomeSettingsWithCompanion } = await import('./useHomeSettingsWithCompanion');
        const { getHomeReachability } = await import('@/sync/ops/home/homeGovernanceOperations');
        const serverId = await harness.addHome({ name: 'Home A', serverUrl: 'https://settings-account-switch.example', accountId: 'account-a' });
        let release!: () => void;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        const path = '/v1/home/reachability/get';
        const read = (scope: Readonly<{ serverId: string; accountId: string }>) => getHomeReachability({ scope });
        harness.answer(serverId, SETTINGS_GET, { body: homeSettingsProjectionFixture({ revision: 3 }), respondAfter: pending });
        harness.answer(serverId, path, { body: homeReachabilityFixture(), respondAfter: pending });
        const hook = await renderHook(
            (props: Readonly<{ accountId: string }>) => useHomeSettingsWithCompanion({ serverId, accountId: props.accountId }, true, read),
            { initialProps: { accountId: 'account-a' } },
        );
        await waitForHomeGovernance(() => expect(harness.requestsFor(SETTINGS_GET)).toHaveLength(1));
        await act(async () => { await harness.switchAccount(serverId, 'account-b'); });
        harness.answer(serverId, SETTINGS_GET, { body: homeSettingsProjectionFixture({ revision: 9 }) });
        const currentReach = homeReachabilityFixture({ publicAddress: { url: 'https://current-account.example', source: 'home' } });
        harness.answer(serverId, path, { body: currentReach });
        await hook.rerender({ accountId: 'account-b' });
        await waitForHomeGovernance(() => {
            expect(hook.getCurrent().settings?.revision).toBe(9);
            expect(hook.getCurrent().companion?.publicAddress.url).toBe('https://current-account.example');
        });
        await act(async () => { release(); });
        expect(hook.getCurrent().settings?.revision).toBe(9);
        expect(hook.getCurrent().companion?.publicAddress.url).toBe('https://current-account.example');
    });


    it('settles a failed companion independently, retaining the last answer through a failed refresh and recovering on Retry', async () => {
        const { useHomeSettingsWithCompanion } = await import('./useHomeSettingsWithCompanion');
        const { getHomeReachability } = await import('@/sync/ops/home/homeGovernanceOperations');
        const serverId = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'account-admin' });
        const scope = { serverId, accountId: 'account-admin' };
        const path = '/v1/home/reachability/get';
        const read = (current: typeof scope) => getHomeReachability({ scope: current });
        harness.answer(serverId, SETTINGS_GET, { body: homeSettingsProjectionFixture({ revision: 3 }) });
        harness.answer(serverId, path, { status: 503, body: { error: 'temporarily_unavailable' } });
        const hook = await renderHook(() => useHomeSettingsWithCompanion(scope, true, read));
        await waitForHomeGovernance(() => expect(hook.getCurrent().settings?.revision).toBe(3));
        expect(harness.requestsFor(path)).toHaveLength(1);
        expect(hook.getCurrent().companionFailure?.retryable).toBe(true);
        expect(hook.getCurrent().settings?.revision).toBe(3);
        expect(hook.getCurrent().companionLoading).toBe(false);
        expect(hook.getCurrent().companion).toBeNull();

        harness.answer(serverId, path, { body: homeReachabilityFixture() });
        await act(async () => hook.getCurrent().reload());
        await waitForHomeGovernance(() => expect(hook.getCurrent().companion?.iroh.mode).toBe('enabled'));
        harness.answer(serverId, path, { status: 503, body: { error: 'temporarily_unavailable' } });
        await act(async () => hook.getCurrent().adoptSettings(homeSettingsProjectionFixture({ revision: 4 })));
        await waitForHomeGovernance(() => expect(hook.getCurrent().companionFailure?.retryable).toBe(true));
        expect(hook.getCurrent().companion?.iroh.mode).toBe('enabled');
        expect(hook.getCurrent().settings?.revision).toBe(4);
        harness.answer(serverId, path, { body: homeReachabilityFixture() });
        await act(async () => hook.getCurrent().reload());
        await waitForHomeGovernance(() => expect(hook.getCurrent().companionFailure).toBeNull());
        expect(hook.getCurrent().companionLoading).toBe(false);
    });

    it('keeps a settled Home through an enabled flicker and a reload, so a page never falls back to loading', async () => {
        const { useHomeSettingsWithCompanion } = await import('./useHomeSettingsWithCompanion');
        const serverId = await harness.addHome({ name: 'Home A', serverUrl: 'https://home-a.example', accountId: 'account-admin' });
        const scope = { serverId, accountId: 'account-admin' };
        harness.answer(serverId, SETTINGS_GET, { body: homeSettingsProjectionFixture({ revision: 3 }) });

        const hook = await renderHook(
            (props: Readonly<{ enabled: boolean }>) => useHomeSettingsWithCompanion(scope, props.enabled, null),
            { initialProps: { enabled: true } },
        );
        await waitForHomeGovernance(() => expect(hook.getCurrent().settings?.revision).toBe(3));

        // A transient loss of the viewer's capability (or of the scope's readiness) is not a new Home.
        await hook.rerender({ enabled: false });
        expect(hook.getCurrent().settings?.revision).toBe(3);
        await hook.rerender({ enabled: true });
        expect(hook.getCurrent().settings?.revision).toBe(3);

        // A reload keeps the last answer on screen until the new one lands.
        let releaseRead!: () => void;
        const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
        harness.answer(serverId, SETTINGS_GET, { body: homeSettingsProjectionFixture({ revision: 4 }), respondAfter: readGate });
        let completed = false;
        let completion!: Promise<void>;
        await act(async () => {
            completion = Promise.resolve(hook.getCurrent().reload()).then(() => { completed = true; });
        });
        expect(hook.getCurrent().settings).not.toBeNull();
        expect(completed).toBe(false);
        await act(async () => {
            releaseRead();
            await completion;
        });
        expect(completed).toBe(true);
        expect(hook.getCurrent().settings?.revision).toBe(4);
    });
});
