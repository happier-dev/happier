import * as React from 'react';
import { act } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import { StyleSheet } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { storage } from '@/sync/domains/state/storage';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';
import type { PersonalizeFlow } from './usePersonalizeFlow';
import { WorkspaceNavigationContext, type WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { createWorkspaceState } from '@/components/appShell/workspace/workspaceState';

const boundary = vi.hoisted(() => ({ width: 1440, height: 940, notificationGranted: false, requestNotificationPermission: vi.fn(), setTheme: vi.fn() }));
// OS notification permission is an external boundary; the diagnostics hook and step remain real.
vi.mock('@tauri-apps/plugin-notification', () => ({
    isPermissionGranted: async () => boundary.notificationGranted,
    requestPermission: async () => { boundary.requestNotificationPermission(); boundary.notificationGranted = true; return 'granted'; },
    sendNotification: vi.fn(),
}));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ useWindowDimensions: () => ({ width: boundary.width, height: boundary.height, scale: 1, fontScale: 1 }) });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({ runtime: { setTheme: boundary.setTheme } });
});
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock({ settleTimingCallbacks: true });
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ params: () => ({ page: 'tools' }) }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
// The vendor Markdown SDK is a boundary; the route still renders real transcript samples below it.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: (value: string) => [{ text: value }],
}));
vi.mock('expo-status-bar', () => ({ setStatusBarStyle: vi.fn() }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn(async () => {}) }));

const { PersonalizeRouteScreen } = await import('./PersonalizeRouteScreen');
const { PersonalizeStepBody } = await import('./PersonalizeStepBody');
const { usePersonalizeSetupItem } = await import('./usePersonalizeSetupItem');
const { Modal } = await import('@/modal');
const { ModalCardFrame } = await import('@/modal/components/card/ModalCardFrame');

// Measure the host's horizontal layout inputs, excluding tile-internal padding.
function leadingInset(node: ReactTestInstance, boundary: ReactTestInstance): number {
    let inset = 0;
    let current: ReactTestInstance | null = node;
    while (current && current !== boundary) {
        if (typeof current.type === 'string') {
            const style = StyleSheet.flatten(current.props.style) ?? {};
            inset += Number(style.marginLeft ?? style.marginHorizontal ?? 0)
                + Number(style.paddingLeft ?? style.paddingHorizontal ?? 0);
        }
        current = current.parent;
    }
    return inset;
}

function workspace(phone: boolean): WorkspaceNavigationContextValue {
    return {
        active: true,
        state: createWorkspaceState({ id: 'personalize', target: { kind: 'personalize', params: {} }, pinned: false, preview: true }),
        phone: phone ? { catalog: [], onTab: true, openHref: () => true, activateTab: () => {}, closeTab: () => {} } : null,
        canGoBack: false, canGoForward: false, openHref: () => true,
        activateTab: () => {}, closeTab: () => {}, closeTabs: () => {}, dispatch: () => {},
        navigationForTab: () => { throw new Error('Unexpected tab navigation'); },
        registerBackStep: () => () => {}, back: () => {}, forward: () => {},
    };
}

function route(phone: boolean) {
    return <WorkspaceNavigationContext.Provider value={workspace(phone)}><PersonalizeRouteScreen /></WorkspaceNavigationContext.Provider>;
}

afterEach(() => { standardCleanup(); boundary.width = 1440; boundary.height = 940; boundary.notificationGranted = false;
    boundary.requestNotificationPermission.mockClear(); vi.mocked(Modal.show).mockClear();
    boundary.setTheme.mockClear();
    setReducedMotionPreferenceOverride(null); vi.unstubAllGlobals(); });
describe('Personalize responsive route', () => {
    it.each([false, true])('keeps choice groups flush with their already-inset narrative column (phone=%s)', async (phone) => {
        storage.setState({ settings: settingsDefaults, localSettings: localSettingsDefaults,
            settingsScope: { serverId: 'home-a', accountId: 'alice' } });
        setReducedMotionPreferenceOverride(true);
        boundary.width = phone ? 390 : 1440;
        const screen = await renderScreen(route(phone));
        const body = screen.root.findByType(PersonalizeStepBody);
        const tiles = screen.findHostByTestId(`${phone ? 'personalize-sheet' : 'personalize-flow'}-tools:activity_feed`)!;
        expect(tiles).not.toBeNull();
        expect(leadingInset(tiles, body)).toBe(0);
    });

    it.each([940, 600])('lets the Home Look sheet fit its modal height at viewport height %s', async (height) => {
        boundary.width = 390;
        boundary.height = height;
        storage.setState({ settings: settingsDefaults, localSettings: localSettingsDefaults,
            settingsScope: { serverId: 'home-a', accountId: 'alice' } });
        setReducedMotionPreferenceOverride(true);
        function CardProbe() {
            const item = usePersonalizeSetupItem({ hidden: new Set(), onDismiss: () => {} });
            return item?.renderTile({ open: () => {} }) ?? null;
        }
        const card = await renderScreen(<WorkspaceNavigationContext.Provider value={workspace(true)}><CardProbe /></WorkspaceNavigationContext.Provider>);
        await card.pressByTestIdAsync('hub-setup.personalize.action');
        const config = vi.mocked(Modal.show).mock.calls.at(-1)![0];
        const Content = config.component;
        const modal = await renderScreen(<ModalCardFrame {...config.chrome} presentation="sheet">
            <Content {...config.props} onClose={() => {}} />
        </ModalCardFrame>);
        await act(async () => {});
        const frame = modal.findHostByTestId('personalize-sheet.modal')!;
        const availableHeight = StyleSheet.flatten(frame.props.style).height;
        const sheet = modal.findHostByTestId('personalize-sheet')!;
        expect(sheet).not.toBeNull();
        // Every fixed-height ancestor must fit the canonical modal region. The old
        // opener requests 92% of the viewport even when the modal caps it at 760px.
        let current = sheet.parent;
        while (current && current !== frame) {
            if (typeof current.type === 'string') {
                const height = StyleSheet.flatten(current.props.style)?.height;
                if (typeof height === 'number') expect(height).toBeLessThanOrEqual(availableHeight);
            }
            current = current.parent;
        }
        const body = modal.findHostByTestId('personalize-sheet-config-body')!;
        const primary = modal.findHostByTestId('personalize-sheet-config-primary')!;
        expect(body.findAll(node => node === primary)).toHaveLength(0);
        expect(StyleSheet.flatten(primary.props.style).flexGrow ?? StyleSheet.flatten(primary.props.style).flex).toBe(1);
    });

    it('keeps an unsaved draft, page, starting style and summary return across both breakpoint directions', async () => {
        vi.stubGlobal('navigator', { userAgent: 'Mobile Android', maxTouchPoints: 1 });
        setReducedMotionPreferenceOverride(true);
        storage.setState({ settings: settingsDefaults, localSettings: localSettingsDefaults,
            settingsScope: { serverId: 'home-a', accountId: 'alice' } });
        const screen = await renderScreen(route(false));
        const flow = (): PersonalizeFlow => screen.root.findAllByType(PersonalizeStepBody).at(-1)!.props.flow;
        await act(async () => { flow().update({ toolChrome: 'cards' }); flow().setStyle('detail'); flow().open('summary'); });
        await act(async () => { flow().open('tools'); });
        for (const width of [390, 1440, 390]) {
            boundary.width = width;
            await act(async () => { screen.update(route(width === 390)); });
            expect(flow()).toMatchObject({ page: 'tools', style: 'detail', draft: { toolChrome: 'cards' } });
            expect(storage.getState().settings.toolViewTimelineChromeMode).toBe(settingsDefaults.toolViewTimelineChromeMode);
        }
        await act(async () => { flow().skip(); });
        expect(flow().page).toBe('summary');
    });

    it('commits the selected Light draft after resizing to phone and back and keeps it through Style', async () => {
        vi.stubGlobal('navigator', { userAgent: 'Desktop browser', maxTouchPoints: 0 });
        setReducedMotionPreferenceOverride(true);
        storage.setState({ settings: settingsDefaults, localSettings: { ...localSettingsDefaults, themePreference: 'dark' },
            settingsScope: { serverId: 'home-a', accountId: 'alice' } });
        const account = storage.getState().settings;
        const screen = await renderScreen(route(false));
        const flow = (): PersonalizeFlow => screen.root.findByType(PersonalizeStepBody).props.flow;
        await act(async () => { flow().open('look'); });
        await screen.pressByTestIdAsync('personalize-flow-theme:light');
        expect(flow().draft.theme).toBe('light');
        expect(storage.getState().localSettings.themePreference).toBe('dark');
        expect(boundary.setTheme).toHaveBeenLastCalledWith('light');

        for (const width of [390, 1440]) {
            boundary.width = width;
            await screen.update(route(width === 390));
            expect(flow()).toMatchObject({ page: 'look', draft: { theme: 'light' } });
            expect(storage.getState().localSettings.themePreference).toBe('dark');
        }
        await screen.pressByTestIdAsync('personalize-flow-config-primary');
        expect(flow()).toMatchObject({ page: 'style', draft: { theme: 'light' } });
        expect(storage.getState().localSettings.themePreference).toBe('light');
        expect(boundary.setTheme).toHaveBeenLastCalledWith('light');
        await screen.pressByTestIdAsync('personalize-flow-config-primary');
        expect(flow()).toMatchObject({ page: 'conversation', draft: { theme: 'light' } });
        expect(storage.getState().localSettings.themePreference).toBe('light');
        expect(boundary.setTheme).toHaveBeenLastCalledWith('light');
        expect(storage.getState().settings).toBe(account);
    });

    it('uses the shell phone layout in a narrow pointer browser, including the Home card entry', async () => {
        boundary.width = 390;
        vi.stubGlobal('navigator', { userAgent: 'Desktop browser', maxTouchPoints: 0 });
        storage.setState({ settings: settingsDefaults, localSettings: localSettingsDefaults,
            settingsScope: { serverId: 'home-a', accountId: 'alice' } });
        setReducedMotionPreferenceOverride(true);
        const screen = await renderScreen(route(true));
        expect(screen.findByTestId('personalize-sheet-stage')).not.toBeNull();
        expect(screen.findByTestId('personalize-sheet-back')).not.toBeNull();
        expect(screen.findByTestId('personalize-flow-heading')).toBeNull();
        let growsInPlace: boolean | undefined;
        function CardProbe() {
            const item = usePersonalizeSetupItem({ hidden: new Set(), onDismiss: () => {} });
            growsInPlace = Boolean(item?.renderPanel);
            return item?.renderTile({ open: () => { throw new Error('Phone card must not expand inline'); } }) ?? null;
        }
        const card = await renderScreen(<WorkspaceNavigationContext.Provider value={workspace(true)}><CardProbe /></WorkspaceNavigationContext.Provider>);
        expect(growsInPlace).toBe(false);
        await act(async () => { card.pressByTestId('hub-setup.personalize.action'); });
        expect(Modal.show).toHaveBeenCalledWith(expect.objectContaining({
            chrome: expect.objectContaining({ phonePresentation: 'sheet', testID: 'personalize-sheet.modal' }),
        }));
    });

    it('explains unsupported browser notifications without offering ineffective controls', async () => {
        storage.setState({ settings: settingsDefaults, localSettings: localSettingsDefaults,
            settingsScope: { serverId: 'home-a', accountId: 'alice' } });
        setReducedMotionPreferenceOverride(true);
        const screen = await renderScreen(route(false));
        await act(async () => { screen.root.findByType(PersonalizeStepBody).props.flow.open('notifications'); });
        expect(screen.findByTestId('personalize-flow-permission')).not.toBeNull();
        expect(screen.findByTestId('personalize-flow-needs-you')).toBeNull();
        expect(screen.findByTestId('personalize-flow-finished')).toBeNull();
        expect(screen.findByTestId('personalize-flow-preview')).toBeNull();
        expect(screen.findByTestId('personalize-flow-allow')).toBeNull();
    });

    it('keeps notification choices on a supported desktop and asks permission only from Allow', async () => {
        vi.stubGlobal('navigator', { userAgent: 'Tauri desktop', maxTouchPoints: 0 });
        storage.setState({ settings: settingsDefaults, localSettings: localSettingsDefaults,
            settingsScope: { serverId: 'home-a', accountId: 'alice' } });
        setReducedMotionPreferenceOverride(true);
        const screen = await renderScreen(route(false));
        await act(async () => { screen.root.findByType(PersonalizeStepBody).props.flow.open('notifications'); });
        expect(screen.findByTestId('personalize-flow-needs-you')).not.toBeNull();
        expect(screen.findByTestId('personalize-flow-preview')).not.toBeNull();
        expect(boundary.requestNotificationPermission).not.toHaveBeenCalled();
        await act(async () => { screen.pressByTestId('personalize-flow-allow'); });
        expect(boundary.notificationGranted).toBe(true);
        expect(screen.findByTestId('personalize-flow-allow')).toBeNull();
    });

    it('settles the review to one step and keeps its footnote outside the transition body', async () => {
        storage.setState({ settings: settingsDefaults, localSettings: localSettingsDefaults,
            settingsScope: { serverId: 'home-a', accountId: 'alice' } });
        setReducedMotionPreferenceOverride(true);
        const screen = await renderScreen(route(false));
        await act(async () => { screen.root.findByType(PersonalizeStepBody).props.flow.open('notifications'); });
        await act(async () => { screen.root.findByType(PersonalizeStepBody).props.flow.open('summary'); });
        expect(screen.root.findAllByType(PersonalizeStepBody)).toHaveLength(1);
        expect(screen.root.findByType(PersonalizeStepBody).props.flow.page).toBe('summary');
        expect(screen.findByTestId('personalize-flow-config-footer')).not.toBeNull();
        expect(screen.findByTestId('personalize-flow-needs-you')).toBeNull();
        expect(screen.findByTestId('personalize-flow-summary-notifications-change')).toBeNull();
        expect(screen.getTextContent()).toContain('personalize.scopeLook');
    });
});
