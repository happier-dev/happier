import * as React from 'react';
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import {
    clearActiveUnsavedChangesGuard,
    setActiveUnsavedChangesGuard,
} from '@/utils/navigation/runGuardedNavigation';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const pathnameState = vi.hoisted(() => ({ value: '/settings/appearance' }));
const navigateSpy = vi.hoisted(() => vi.fn());

const theme = { colors: { chrome: { header: { foreground: '#111111' } } } };

vi.mock('react-native', () => ({
    Platform: { OS: 'web', select: (o: any) => (o && 'default' in o ? o.default : undefined) },
    Pressable: 'Pressable',
    View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: any) => (typeof styles === 'function' ? styles(theme) : styles) },
    useUnistyles: () => ({ theme }),
}));
vi.mock('expo-router', () => ({
    usePathname: () => pathnameState.value,
    useRouter: () => ({ navigate: navigateSpy, back: () => {} }),
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));

function findByTestId(root: ReactTestInstance, testID: string): ReactTestInstance | null {
    return root.findAll((node) => node.props?.testID === testID)[0] ?? null;
}

async function renderControls(): Promise<ReactTestRenderer> {
    const { SettingsModalFloatingControls } = await import('./SettingsModalFloatingControls');
    let tree!: ReactTestRenderer;
    await act(async () => {
        tree = create(React.createElement(SettingsModalFloatingControls));
    });
    return tree;
}

describe('SettingsModalFloatingControls', () => {
    beforeEach(() => {
        pathnameState.value = '/settings/appearance';
        navigateSpy.mockReset();
        clearActiveUnsavedChangesGuard();
    });

    afterEach(() => clearActiveUnsavedChangesGuard());

    it('renders nothing on top-level categories (reachable from the rail)', async () => {
        pathnameState.value = '/settings/appearance';
        const tree = await renderControls();
        expect(findByTestId(tree.root, 'settings-modal-back')).toBeNull();
    });

    it('shows a back button on sub-screens that navigates to the parent', async () => {
        pathnameState.value = '/settings/appearance/themes';
        const tree = await renderControls();
        const back = findByTestId(tree.root, 'settings-modal-back');
        expect(back).toBeTruthy();

        act(() => {
            (back!.props.onPress as () => void)();
        });

        expect(navigateSpy).toHaveBeenCalledWith('/settings/appearance');
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
    });

    it('never renders a close icon (the modal dismisses via backdrop/gesture)', async () => {
        pathnameState.value = '/settings/appearance/themes';
        const tree = await renderControls();
        expect(findByTestId(tree.root, 'settings-modal-close')).toBeNull();
    });
});
