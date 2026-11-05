// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { ScrollView, Text } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup, type RenderScreenResult } from '@/dev/testkit';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { NavigationPlacementCustomizer, NavigationPlacementCustomizerView } from './NavigationPlacementCustomizer';
import { resolveNavigationPlacements, type NavigationPlacementPreferences } from '@/sync/domains/settings/mobileSurfacePinning';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { storage } from '@/sync/domains/state/storage';
import { settingsParse } from '@/sync/domains/settings/settings';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';

const pointer = vi.hoisted(() => ({ coarse: false }));
vi.mock('@/utils/platform/webMobileHeuristics', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/platform/webMobileHeuristics')>(),
    isCoarsePrimaryPointerEnvironment: () => pointer.coarse,
    isHoverCapablePrimaryPointer: () => !pointer.coarse,
}));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native-gesture-handler', async () => (await import('@/dev/testkit/mocks/gestureHandler')).createGestureHandlerMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
installDisconnectedServerSocketBoundary();
vi.mock('@/utils/web/reactDomCjs', () => ({
    // ReactTestRenderer cannot mount a DOM portal; the reorder owner remains real.
    requireReactDOM: () => ({ createPortal: (children: React.ReactNode) => children }),
}));
afterEach(async () => { pointer.coarse = false; await standardCleanup(); });

const items = [{ id: 'home', title: 'Home' }, { id: 'plugin:example:review', title: 'Review' }, { id: 'settings', title: 'Settings' }];
const scope = { serverId: 'home-a', accountId: 'account-a' };
async function mount() {
    // Controlled presentation boundary captures device-local saves; all controls and model are real.
    let preferences: NavigationPlacementPreferences = { orderedIds: [], placements: {} };
    function Fixture() {
        const [value, setValue] = React.useState(preferences);
        return <NavigationPlacementCustomizerView surfaceId="appRail" items={items} preferences={value} scope={scope}
            showHeader={false} onChange={next => { preferences = next; setValue(next); }} />;
    }
    const screen = await renderScreen(<Fixture />);
    await act(async () => {
        for (const [index, item] of items.entries()) {
            const row = screen.findAllByType('View').find(node => typeof node.props.onLayout === 'function'
                && node.props.testID !== 'navigation-placement-customizer.reorder'
                && node.findAll(child => child.props.testID === `navigation-placement-customizer.move:${item.id}`).length > 0);
            row?.props.onLayout({ nativeEvent: { layout: { x: 0, y: index * 64, width: 600, height: 64 } } });
        }
    });
    return { screen, get preferences() { return preferences; } };
}
async function key(screen: RenderScreenResult, key: string) {
    await act(async () => {
        const grip = screen.findHostByTestId('navigation-placement-customizer.move:home');
        if (!grip) throw new Error('Missing accessible reorder grip');
        grip.props.onKeyDown({ key, preventDefault() {}, stopPropagation() {} });
    });
}

describe('navigation placement customization', () => {
    it('offers Automatic only for an auto default and clears that override without touching other choices', async () => {
        let preferences: NavigationPlacementPreferences = { orderedIds: ['services'], placements: { services: 'hidden', info: 'hidden' } };
        function Fixture() {
            const [value, setValue] = React.useState(preferences);
            return <NavigationPlacementCustomizerView surfaceId="sessionRail" items={[
                { id: 'services', title: 'Services', defaultPlacement: 'auto', hasContent: true },
                { id: 'info', title: 'Info', defaultPlacement: 'pinned', allowedPlacements: ['pinned', 'overflow'] },
            ]} preferences={value} showHeader={false} onChange={next => { preferences = next; setValue(next); }} />;
        }
        const screen = await renderScreen(<Fixture />);
        // A placement the item cannot take stays in the row's segments, disabled, so every row lines up.
        const forbidden = screen.findHostByTestId('navigation-placement-customizer.placement:info:hidden');
        expect(forbidden?.props.accessibilityState?.disabled).toBe(true);
        expect(screen.findHostByTestId('navigation-placement-customizer.placement:info:auto')).toBeNull();
        await act(async () => { screen.findHostByTestId('navigation-placement-customizer.placement:services:auto')!.props.onPress(); });
        expect(preferences.placements).toEqual({ info: 'hidden' });
        expect(preferences.orderedIds).toEqual(['services']);
        expect(resolveNavigationPlacements([{ id: 'services', defaultPlacement: 'auto', hasContent: true }], preferences).effectivePlacements.services).toBe('pinned');
    });
    it('keeps the live preview outside the scrolling catalog so opening at a group never scrolls it away', async () => {
        const screen = await renderScreen(<NavigationPlacementCustomizerView surfaceId="composer" preferences={{ orderedIds: [], placements: {} }} showHeader={false} scope={scope}
            items={[{ id: 'engine', title: 'Model', group: 'Session' }, { id: 'machine', title: 'Machine', group: 'New session' }]}
            activeGroup="New session" renderPreview={() => <Text testID="composer-preview-picture">Preview</Text>} onChange={() => {}} />);
        const scroller = screen.findAllByType(ScrollView)[0]!;
        expect(scroller.findAll(node => node.props.testID === 'composer-preview-picture')).toHaveLength(0);
        expect(screen.findHostByTestId('composer-preview-picture')).not.toBeNull();
        // The catalog is what scrolls; both groups stay listed under it.
        expect(scroller.findAll(node => node.props.testID === 'navigation-placement-customizer.group:New session').length).toBeGreaterThan(0);
    });

    it('shows one Done on touch: the card footer closes the editor and the list adds no Organize toggle', async () => {
        pointer.coarse = true;
        const screen = await renderScreen(<NavigationPlacementCustomizerView surfaceId="composer" preferences={{ orderedIds: [], placements: {} }} showHeader={false} scope={scope}
            items={[{ id: 'engine', title: 'Model', group: 'Session' }, { id: 'goal', title: 'Goal', group: 'Session' }]} onChange={() => {}} />);
        expect(screen.findHostByTestId('navigation-placement-customizer.reorder.organize')).toBeNull();
        // Touch still gets the grips: the editor arranges from the start.
        expect(screen.findHostByTestId('navigation-placement-customizer.move:engine')).not.toBeNull();
    });

    it('lists each context group under its own heading, keeps one identity per item, and moves only within a group', async () => {
        // A saved order that interleaves the groups must not reorder the group headings.
        let preferences: NavigationPlacementPreferences = { orderedIds: ['workflowInputs', 'machine', 'engine', 'goal'], placements: {} };
        function Fixture() {
            const [value, setValue] = React.useState(preferences);
            return <NavigationPlacementCustomizerView surfaceId="composer" preferences={value} showHeader={false} scope={scope}
                items={[
                    { id: 'engine', title: 'Model', group: 'Session' },
                    { id: 'goal', title: 'Goal', group: 'Session' },
                    { id: 'machine', title: 'Machine', group: 'New session' },
                    { id: 'workflowInputs', title: 'Inputs', group: 'Workflow' },
                ]}
                fixedItems={[{ id: 'stop', title: 'Stop' }]}
                onChange={next => { preferences = next; setValue(next); }} />;
        }
        const screen = await renderScreen(<Fixture />);
        const groups = screen.findAllByType(ItemGroup);
        const idsIn = (group: (typeof groups)[number]) => group.findAll(node => typeof node.type === 'string'
            && typeof node.props.testID === 'string' && node.props.testID.startsWith('navigation-placement-customizer.move:'))
            .map(node => (node.props.testID as string).split('move:')[1]);
        expect(groups.map(group => group.props.title)).toEqual(['Session', 'New session', 'Workflow', undefined]);
        expect(groups.map(idsIn)).toEqual([['engine', 'goal'], ['machine'], ['workflowInputs'], []]);
        // Stop is listed once, after the context groups, outside reorder and placement.
        expect(groups[3]!.findAll(node => node.props.testID === 'navigation-placement-customizer.fixed:stop').length).toBeGreaterThan(0);
        // Reorder identity stays the item id: a move inside a group writes one canonical order.
        const rows = screen.findAllByType('View').filter(node => typeof node.props.onLayout === 'function' && node.props.testID !== 'navigation-placement-customizer.reorder');
        await act(async () => {
            for (const [index, id] of ['engine', 'goal', 'machine', 'workflowInputs'].entries()) {
                rows.find(node => node.findAll(child => child.props.testID === `navigation-placement-customizer.move:${id}`).length > 0
                    && node.findAll(child => typeof child.props.testID === 'string' && child.props.testID.includes('.move:')).length === 1)
                    ?.props.onLayout({ nativeEvent: { layout: { x: 0, y: index * 64, width: 600, height: 64 } } });
            }
        });
        const press = async (id: string, keyName: string) => { await act(async () => {
            screen.findHostByTestId(`navigation-placement-customizer.move:${id}`)!.props.onKeyDown({ key: keyName, preventDefault() {}, stopPropagation() {} });
        }); };
        // The last row of a group cannot step into the next group: nothing is written.
        for (const keyName of [' ', 'ArrowDown', 'Enter', 'Escape']) await press('goal', keyName);
        expect(preferences.orderedIds).toEqual(['workflowInputs', 'machine', 'engine', 'goal']);
        for (const keyName of [' ', 'ArrowUp', 'Enter']) await press('goal', keyName);
        expect(preferences.orderedIds.filter(id => ['engine', 'goal'].includes(id))).toEqual(['goal', 'engine']);
        expect(preferences.orderedIds).toEqual(expect.arrayContaining(['machine', 'workflowInputs']));
    });
    it('selects the legal default for a forbidden saved choice and lists a fixed control outside placement', async () => {
        let preferences: NavigationPlacementPreferences = { orderedIds: [], placements: { permission: 'hidden' } };
        function Fixture() {
            const [value, setValue] = React.useState(preferences);
            return <NavigationPlacementCustomizerView surfaceId="composer" preferences={value} showHeader={false} scope={scope}
                items={[{ id: 'permission', title: 'Permissions', defaultPlacement: 'pinned', allowedPlacements: ['pinned', 'overflow'], placementNote: 'Always reachable' }]}
                fixedItems={[{ id: 'stop', title: 'Stop', placementNote: 'Shown while a turn runs' }]}
                onChange={next => { preferences = next; setValue(next); }} />;
        }
        const screen = await renderScreen(<Fixture />);
        // The saved Hidden stays saved; the row shows what the composer actually does with it.
        expect(screen.findHostByTestId('navigation-placement-customizer.placement:permission:pinned')?.props.accessibilityState?.checked).toBe(true);
        expect(screen.findHostByTestId('navigation-placement-customizer.placement:permission:hidden')?.props.accessibilityState?.disabled).toBe(true);
        expect(preferences.placements.permission).toBe('hidden');
        // Stop is listed, never reorderable or placeable.
        expect(screen.findHostByTestId('navigation-placement-customizer.fixed:stop')).not.toBeNull();
        expect(screen.findHostByTestId('navigation-placement-customizer.move:stop')).toBeNull();
        expect(screen.findHostByTestId('navigation-placement-customizer.placement:stop:pinned')).toBeNull();
    });
    it('shows a reserved primary destination with the shared locked affordance, still reorderable, not disabled segments', async () => {
        function Fixture() {
            const [value, setValue] = React.useState<NavigationPlacementPreferences>({ orderedIds: [], placements: {} });
            return <NavigationPlacementCustomizerView surfaceId="appRail" preferences={value} showHeader={false} scope={scope}
                items={[{ id: 'overview', title: 'Overview', icon: 'list', defaultPlacement: 'pinned', allowedPlacements: ['pinned'] },
                    { id: 'code', title: 'Code', icon: 'code' }]}
                onChange={next => { setValue(next); }} />;
        }
        const screen = await renderScreen(<Fixture />);
        // One presentation for a reserved primary: the row anatomy of its siblings plus the lock (as Session's Chat).
        expect(screen.findHostByTestId('navigation-placement-customizer.move:overview')).not.toBeNull();
        expect(screen.findHostByTestId('navigation-placement-customizer.locked:overview')).not.toBeNull();
        expect(screen.findHostByTestId('navigation-placement-customizer.placement:overview:hidden')).toBeNull();
        expect(screen.findHostByTestId('navigation-placement-customizer.placement:code:hidden')).not.toBeNull();
    });
    it('persists a phone placement edit through the enabled settings Action', async () => {
        const locks = installWebLockManagerMock();
        let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;
        try {
            account = await createSecretSettingsTestHarness({ settings: settingsParse({}) });
            const screen = await renderScreen(<NavigationPlacementCustomizer surfaceId="phoneLauncher" items={items} onClose={() => {}} />);
            for (const placement of ['hidden', 'pinned'] as const) {
                await act(async () => { await screen.findHostByTestId(`navigation-placement-customizer.placement:home:${placement}`)!.props.onPress(); });
                await vi.waitFor(() => expect(storage.getState().localSettings.navigationSurfacePlacementsV1.phoneLauncher?.placements.home).toBe(placement));
            }
        } finally { standardCleanup(); await account?.dispose(); locks.restore(); }
    });
    it('refuses a phone placement edit when the canonical settings Action is disabled', async () => {
        const locks = installWebLockManagerMock();
        let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;
        try {
            account = await createSecretSettingsTestHarness({ settings: settingsParse({ actionsSettingsV1: normalizeActionsSettingsV1({
                v: 1, actions: { 'settings.set': { enabled: false } },
            }) }) });
            const before = storage.getState().localSettings.navigationSurfacePlacementsV1;
            const screen = await renderScreen(<NavigationPlacementCustomizer surfaceId="phoneLauncher" items={items} onClose={() => {}} />);
            await act(async () => { screen.findHostByTestId('navigation-placement-customizer.placement:home:hidden')!.props.onPress(); });
            expect(storage.getState().localSettings.navigationSurfacePlacementsV1).toEqual(before);
        } finally { standardCleanup(); await account?.dispose(); locks.restore(); }
    });
    it('resets only this rail through settings.set, restoring automatic defaults without touching another surface', async () => {
        const locks = installWebLockManagerMock();
        let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;
        try {
            account = await createSecretSettingsTestHarness({ settings: settingsParse({}) });
            const otherSurface = { orderedIds: ['home'], placements: { home: 'hidden' as const } };
            storage.getState().applyLocalSettings({ navigationSurfacePlacementsV1: {
                appRail: otherSurface,
                sessionRail: { orderedIds: ['services', 'info'], placements: { services: 'hidden', info: 'overflow' } },
            } }, { persist: false });
            type Chrome = Parameters<NonNullable<React.ComponentProps<typeof NavigationPlacementCustomizer>['setChrome']>>[0];
            const chrome: { current?: Chrome } = {};
            const screen = await renderScreen(<NavigationPlacementCustomizer surfaceId="sessionRail" items={[
                { id: 'info', title: 'Info', defaultPlacement: 'pinned', allowedPlacements: ['pinned', 'overflow'] },
                { id: 'services', title: 'Services', defaultPlacement: 'auto', hasContent: true },
            ]} setChrome={value => { chrome.current = value; }} onClose={() => {}} />);
            expect(chrome.current?.kind).toBe('card');
            const footer = await renderScreen(<>{chrome.current?.kind === 'card' ? chrome.current.footer : null}</>);
            await act(async () => { footer.findHostByTestId('navigation-placement-customizer.reset')!.props.onPress(); });
            await vi.waitFor(() => expect(storage.getState().localSettings.navigationSurfacePlacementsV1.sessionRail).toEqual({ orderedIds: [], placements: {} }));
            expect(storage.getState().localSettings.navigationSurfacePlacementsV1.appRail).toEqual(otherSurface);
            expect(screen.findHostByTestId('navigation-placement-customizer.placement:services:auto')?.props.accessibilityState?.checked).toBe(true);
        } finally { standardCleanup(); await account?.dispose(); locks.restore(); }
    });
    it('lets a plugin-qualified item move between pinned, More and hidden without losing its identity', async () => {
        const fixture = await mount();
        for (const placement of ['overflow', 'hidden', 'pinned'] as const) {
            await act(async () => {
                fixture.screen.findHostByTestId(`navigation-placement-customizer.placement:plugin:example:review:${placement}`)!.props.onPress();
            });
            expect(resolveNavigationPlacements(items, fixture.preferences)[placement].map(item => item.id)).toContain('plugin:example:review');
        }
    });
    it('reorders through the shared accessible carry owner while preserving placement choices', async () => {
        const fixture = await mount();
        await act(async () => { fixture.screen.findHostByTestId('navigation-placement-customizer.placement:settings:hidden')!.props.onPress(); });
        await key(fixture.screen, ' ');
        await key(fixture.screen, 'ArrowDown');
        await key(fixture.screen, 'Enter');
        expect(resolveNavigationPlacements(items, fixture.preferences).ordered.map(item => item.id)).toEqual(['plugin:example:review', 'home', 'settings']);
        expect(fixture.preferences.placements.settings).toBe('hidden');
    });
});
