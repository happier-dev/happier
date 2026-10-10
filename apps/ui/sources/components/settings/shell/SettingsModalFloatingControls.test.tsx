import * as React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { SettingsModalFloatingControls } from './SettingsModalFloatingControls';

import {
    clearActiveUnsavedChangesGuard,
    setActiveUnsavedChangesGuard,
} from '@/utils/navigation/runGuardedNavigation';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const pathnameState = vi.hoisted(() => ({ value: '/settings/appearance' }));
const paramsState = vi.hoisted(() => ({ value: {} as Record<string, string> }));
const navigateSpy = vi.hoisted(() => vi.fn());
const dismissToSpy = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', () => ({
    usePathname: () => pathnameState.value,
    useLocalSearchParams: () => paramsState.value,
    useRouter: () => ({ navigate: navigateSpy, dismissTo: dismissToSpy, back: () => {} }),
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());

function findByTestId(root: ReactTestInstance, testID: string): ReactTestInstance | null {
    return root.findAll((node) => node.props?.testID === testID)[0] ?? null;
}

async function renderControls(): Promise<ReactTestRenderer> {
    let tree!: ReactTestRenderer;
    await act(async () => {
        tree = create(React.createElement(SettingsModalFloatingControls));
    });
    return tree;
}

describe('SettingsModalFloatingControls', () => {
    beforeEach(() => {
        pathnameState.value = '/settings/appearance';
        paramsState.value = {};
        navigateSpy.mockReset();
        dismissToSpy.mockReset();
        clearActiveUnsavedChangesGuard();
    });

    afterEach(() => clearActiveUnsavedChangesGuard());

    it('renders nothing on top-level categories (reachable from the rail)', async () => {
        pathnameState.value = '/settings/appearance';
        const tree = await renderControls();
        expect(findByTestId(tree.root, 'settings-modal-back')).toBeNull();
    });

    it('shows a back button on sub-screens that returns to the parent', async () => {
        pathnameState.value = '/settings/appearance/themes';
        const tree = await renderControls();
        const back = findByTestId(tree.root, 'settings-modal-back');
        expect(back).toBeTruthy();

        act(() => {
            (back!.props.onPress as () => void)();
        });

        expect(dismissToSpy).toHaveBeenCalledWith('/settings/appearance');
    });

    it('returns a nested search result to the retained Settings search rather than its structural parent', async () => {
        pathnameState.value = '/settings/session/runtime';
        paramsState.value = { setting: 'session.runtime.sessionName', settingsSearch: '1' };
        const tree = await renderControls();
        const back = findByTestId(tree.root, 'settings-modal-back');
        expect(back).toBeTruthy();
        act(() => back!.props.onPress());
        expect(dismissToSpy).toHaveBeenCalledWith('/settings');
    });

    it('keeps the current settings screen when its active unsaved-changes guard chooses keep editing', async () => {
        pathnameState.value = '/settings/providers/new';
        const requestDecision = vi.fn(async () => 'keepEditing' as const);
        setActiveUnsavedChangesGuard({
            isDirtyRef: { current: true },
            requestDecision,
            tag: 'SettingsModalFloatingControls.test',
        });
        const tree = await renderControls();
        const back = findByTestId(tree.root, 'settings-modal-back');
        expect(back).toBeTruthy();

        await act(async () => {
            (back!.props.onPress as () => void)();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(requestDecision).toHaveBeenCalledTimes(1);
        expect(navigateSpy).not.toHaveBeenCalled();
        expect(dismissToSpy).not.toHaveBeenCalled();
    });

    it('moves the back control into a list-detail section that hosts it, and hides it where the list is beside the detail', async () => {
        const { SettingsFloatingControlsHost } = await import('./SettingsModalFloatingControls');
        const render = (split: boolean) => React.createElement(
            SettingsFloatingControlsHost,
            {
                enabled: true,
                children: React.createElement('View', { testID: 'detail-pane' },
                    React.createElement(SettingsFloatingControlsHost, {
                        enabled: split,
                        collectionRootPathname: '/settings/agents',
                        children: null,
                    })),
            },
        );

        // The route mock is not reactive, so each route renders a fresh tree.
        const renderAt = async (pathname: string, split: boolean) => {
            pathnameState.value = pathname;
            let tree!: ReactTestRenderer;
            await act(async () => {
                tree = create(render(split));
            });
            return tree;
        };

        // The agent list is beside the detail: no back control over it, and none in the pane.
        expect(findByTestId((await renderAt('/settings/agents/claude', true)).root, 'settings-modal-back')).toBeNull();

        const deeper = await renderAt('/settings/agents/claude/models', true);
        const paneBack = findByTestId(deeper.root, 'settings-modal-back');
        expect(paneBack).toBeTruthy();
        expect(findByTestId(deeper.root, 'detail-pane')?.findAll((node) => node === paneBack)).toHaveLength(1);

        // Stacked: the section does not host the control, so the shell shows it.
        expect(findByTestId((await renderAt('/settings/agents/claude', false)).root, 'settings-modal-back')).toBeTruthy();
    });

    it('never renders a close icon (the modal dismisses via backdrop/gesture)', async () => {
        pathnameState.value = '/settings/appearance/themes';
        const tree = await renderControls();
        expect(findByTestId(tree.root, 'settings-modal-close')).toBeNull();
    });
});
