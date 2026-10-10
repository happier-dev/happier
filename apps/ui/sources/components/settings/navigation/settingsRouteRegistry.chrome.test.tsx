import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSettingsStackScreenDefinitions, shouldShowSettingsParentBackButton } from './settingsRouteRegistry';

import {
    clearActiveUnsavedChangesGuard,
    setActiveUnsavedChangesGuard,
} from '@/utils/navigation/runGuardedNavigation';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pathnameState = vi.hoisted(() => ({ value: '/settings' }));
const navigateSpy = vi.hoisted(() => vi.fn());
const dismissToSpy = vi.hoisted(() => vi.fn());

// Minimal, self-contained mocks so the registry module imports without the shared testkit.
vi.mock('expo-router', () => ({
    usePathname: () => pathnameState.value,
    useLocalSearchParams: () => ({}),
    useRouter: () => ({ navigate: navigateSpy, dismissTo: dismissToSpy, back: () => {} }),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

const identity = (key: string): string => key;

afterEach(() => {
    pathnameState.value = '/settings';
    navigateSpy.mockReset();
    dismissToSpy.mockReset();
    clearActiveUnsavedChangesGuard();
});

describe('getSettingsStackScreenDefinitions', () => {
    it('removes the navigator header entirely in modal mode', async () => {
        const defs = getSettingsStackScreenDefinitions(identity, { isModalPresentation: true });

        for (const name of ['index', 'appearance', 'appearance/themes']) {
            const def = defs.find((d) => d.name === name);
            expect(def?.options.headerShown).toBe(false);
            expect(def?.options.headerTitle).toBeUndefined();
            expect(def?.options.headerLeft).toBeUndefined();
            expect(def?.options.headerRight).toBeUndefined();
        }
    });

    it('keeps a titled header with a back button in full-screen (phone) mode', async () => {
        const defs = getSettingsStackScreenDefinitions(identity);

        const appearance = defs.find((d) => d.name === 'appearance');
        expect(appearance?.options.headerShown).not.toBe(false);
        expect(appearance?.options.headerTitle).toBe('settings.appearance');
        expect(appearance?.options.headerLeft).toBeTypeOf('function');
        expect(appearance?.options.headerRight).toBeUndefined();

        // The index keeps its title but has no within-settings back button.
        const index = defs.find((d) => d.name === 'index');
        expect(index?.options.headerLeft).toBeUndefined();
    });

    it('keeps the current phone settings screen when header Back encounters dirty active work', async () => {
        pathnameState.value = '/settings/providers/new';
        const requestDecision = vi.fn(async () => 'keepEditing' as const);
        setActiveUnsavedChangesGuard({
            isDirtyRef: { current: true },
            requestDecision,
            tag: 'SettingsParentBackButton.test',
        });
        const definition = getSettingsStackScreenDefinitions(identity, { navigator: 'providers' })
            .find((candidate) => candidate.name === 'new');
        const headerLeft = definition?.options.headerLeft;
        expect(headerLeft).toBeTypeOf('function');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = create(React.createElement(
                headerLeft as React.ElementType,
                { tintColor: '#111111' },
            ));
        });
        const back = tree.root.findAll((node) => (
            node.props?.accessibilityLabel === 'common.back' && typeof node.props?.onPress === 'function'
        ))[0];
        expect(back).toBeTruthy();

        await act(async () => {
            back.props.onPress();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(requestDecision).toHaveBeenCalledTimes(1);
        expect(navigateSpy).not.toHaveBeenCalled();
        expect(dismissToSpy).not.toHaveBeenCalled();
    });
});

describe('settings header Back', () => {
    it('returns to the parent screen already in the stack rather than stacking a new one', async () => {
        // Phone: Settings (with a search query) → a search result → header Back must land on that
        // same Settings screen, query and all, as browser Back does.
        pathnameState.value = '/settings/appearance';
        const headerLeft = getSettingsStackScreenDefinitions(identity)
            .find((candidate) => candidate.name === 'appearance')?.options.headerLeft;
        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = create(React.createElement(headerLeft as React.ElementType, { tintColor: '#111111' }));
        });
        const back = tree.root.findAll((node) => (
            node.props?.accessibilityLabel === 'common.back' && typeof node.props?.onPress === 'function'
        ))[0];
        await act(async () => {
            back.props.onPress();
        });

        expect(dismissToSpy).toHaveBeenCalledWith('/settings');
        expect(navigateSpy).not.toHaveBeenCalled();
    });
});

describe('shouldShowSettingsParentBackButton', () => {
    it('never shows on the settings index (no parent)', async () => {
        expect(shouldShowSettingsParentBackButton({ pathname: '/settings', hideOnTopLevel: true })).toBe(false);
        expect(shouldShowSettingsParentBackButton({ pathname: '/settings', hideOnTopLevel: false })).toBe(false);
    });

    it('hides top-level categories in modal mode but keeps them in full-screen mode', async () => {
        expect(shouldShowSettingsParentBackButton({ pathname: '/settings/appearance', hideOnTopLevel: true })).toBe(false);
        expect(shouldShowSettingsParentBackButton({ pathname: '/settings/appearance', hideOnTopLevel: false })).toBe(true);
    });

    it('always shows on deeper sub-screens (the rail does not list them)', async () => {
        expect(shouldShowSettingsParentBackButton({ pathname: '/settings/appearance/themes', hideOnTopLevel: true })).toBe(true);
        expect(shouldShowSettingsParentBackButton({ pathname: '/settings/connected-services/abc', hideOnTopLevel: true })).toBe(true);
    });
});
