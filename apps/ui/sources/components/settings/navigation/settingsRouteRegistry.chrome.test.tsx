import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Text } from '@/components/ui/text/Text';
import { DefaultBackButton } from '@/components/navigation/Header';
import { getSettingsStackScreenDefinitions, shouldShowSettingsParentBackButton } from './settingsRouteRegistry';

import {
    clearActiveUnsavedChangesGuard,
    setActiveUnsavedChangesGuard,
} from '@/utils/navigation/runGuardedNavigation';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pathnameState = vi.hoisted(() => ({ value: '/settings' }));
const paramsState = vi.hoisted(() => ({
    category: undefined as string | undefined,
    settingsReturn: undefined as string | undefined,
    draftId: undefined as string | undefined,
}));
const historyState = vi.hoisted(() => ({ canGoBack: true }));
const backSpy = vi.hoisted(() => vi.fn());
const navigateSpy = vi.hoisted(() => vi.fn());
const dismissToSpy = vi.hoisted(() => vi.fn());

// Minimal, self-contained mocks so the registry module imports without the shared testkit.
vi.mock('expo-router', () => ({
    usePathname: () => pathnameState.value,
    useLocalSearchParams: () => paramsState,
    useRouter: () => ({ navigate: navigateSpy, dismissTo: dismissToSpy, back: backSpy, canGoBack: () => historyState.canGoBack }),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

const identity = (key: string): string => key;

afterEach(() => {
    pathnameState.value = '/settings';
    paramsState.category = undefined;
    paramsState.settingsReturn = undefined;
    paramsState.draftId = undefined;
    historyState.canGoBack = true;
    backSpy.mockReset();
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
        expect(appearance?.options.headerTitle).toBe('');
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
    it('returns an Add subflow to its invoking composer through history', async () => {
        pathnameState.value = '/settings/machines/add';
        paramsState.draftId = 'original-composer';
        const headerLeft = getSettingsStackScreenDefinitions(identity, { navigator: 'machines' })
            .find((candidate) => candidate.name === 'add')?.options.headerLeft;
        let tree!: ReactTestRenderer;
        await act(async () => { tree = create(React.createElement(headerLeft as React.ElementType, { tintColor: '#111111' })); });
        try {
            const back = tree.root.findAll((node) => node.props?.accessibilityLabel === 'common.back' && typeof node.props?.onPress === 'function')[0];
            await act(async () => { back.props.onPress(); });
            expect(backSpy).toHaveBeenCalledOnce();
            expect(dismissToSpy).not.toHaveBeenCalled();
        } finally { await act(async () => { tree.unmount(); }); }
    });
    it.each([true, false])('returns to the invoking page for a repair open when history exists (%s)', async (canGoBack) => {
        pathnameState.value = '/settings/plugins/happier.scm.github/settings';
        paramsState.settingsReturn = '1';
        historyState.canGoBack = canGoBack;
        const headerLeft = getSettingsStackScreenDefinitions(identity)
            .find((candidate) => candidate.name === 'plugins/[pluginId]/[pageId]')?.options.headerLeft;
        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = create(React.createElement(headerLeft as React.ElementType, { tintColor: '#111111' }));
        });
        const back = tree.root.findAll((node) => (
            node.props?.accessibilityLabel === 'common.back' && typeof node.props?.onPress === 'function'
        ))[0];
        await act(async () => { back.props.onPress(); });
        if (canGoBack) {
            expect(backSpy).toHaveBeenCalledOnce();
            expect(dismissToSpy).not.toHaveBeenCalled();
        } else {
            expect(backSpy).not.toHaveBeenCalled();
            expect(dismissToSpy).toHaveBeenCalledWith('/settings/plugins/happier.scm.github');
        }
        await act(async () => { tree.unmount(); });
    });

    it('leaves the focused Defaults category before leaving Defaults', async () => {
        pathnameState.value = '/settings/machines/defaults';
        paramsState.category = 'local';
        const headerLeft = getSettingsStackScreenDefinitions(identity, { navigator: 'machines' })
            .find((candidate) => candidate.name === 'defaults')?.options.headerLeft;
        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = create(React.createElement(headerLeft as React.ElementType, { tintColor: '#111111' }));
        });
        const back = tree.root.findAll((node) => (
            node.props?.accessibilityLabel === 'common.back' && typeof node.props?.onPress === 'function'
        ))[0];
        await act(async () => { back.props.onPress(); });
        expect(dismissToSpy).toHaveBeenCalledWith('/settings/machines/defaults');
        expect(navigateSpy).not.toHaveBeenCalled();
        await act(async () => { tree.unmount(); });
    });

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

describe('a page that heads itself on a phone', () => {
    async function renderBackLabels(pathname: string, name: string): Promise<{ title: unknown; labels: string[] }> {
        pathnameState.value = pathname;
        const definition = getSettingsStackScreenDefinitions(identity).find((candidate) => candidate.name === name);
        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = create(React.createElement(definition?.options.headerLeft as React.ElementType, { tintColor: '#111111' }));
        });
        const labels = tree.root.findAllByType(Text).flatMap((node) => node.props.children as string);
        await act(async () => { tree.unmount(); });
        return { title: definition?.options.headerTitle, labels };
    }

    it('leaves the bar untitled and names the parent beside Back, so its large title is the only title', async () => {
        const skills = await renderBackLabels('/settings/skills', 'skills');
        expect(skills.title).toBe('');
        expect(skills.labels).toEqual(['settings.title']);
    });

    it('lets the Machines index head itself, as its lab does: Back names Settings over the page title', async () => {
        const machines = await renderBackLabels('/settings/machines', 'machines');
        expect(machines.title).toBe('');
        expect(machines.labels).toEqual(['settings.title']);
    });

    // One rule for every subpage (owner 11-05): the bar names the parent, the page names itself.
    it.each([
        ['/settings/appearance', 'appearance', 'settings.title'],
        ['/settings/features', 'features', 'settings.title'],
        ['/settings/account/security', 'account/security', 'settings.account'],
    ])('names the parent in the bar and leaves %s to name itself', async (pathname, name, parent) => {
        const page = await renderBackLabels(pathname, name);
        expect(page.title).toBe('');
        expect(page.labels).toEqual([parent]);
    });

    // One Back on a phone (NATIVE-SWEEP L8): iPhone's bar stands the app's Back as its own item, without the
    // glass background UIKit otherwise shares across bar items, and it is the same Back the other bars draw.
    it('stands the same Back in the iPhone bar without a shared glass background', async () => {
        pathnameState.value = '/settings/appearance';
        const definition = getSettingsStackScreenDefinitions(identity).find((candidate) => candidate.name === 'appearance');
        const items = definition?.options.unstable_headerLeftItems?.({ tintColor: '#111111', canGoBack: true }) ?? [];
        expect(items).toHaveLength(1);
        const item = items[0]!;
        expect(item.type).toBe('custom');
        if (item.type !== 'custom') return;
        expect(item.hidesSharedBackground).toBe(true);
        let tree!: ReactTestRenderer;
        await act(async () => { tree = create(item.element); });
        try {
            expect(tree.root.findAllByType(DefaultBackButton)).toHaveLength(1);
            expect(tree.root.findAllByType(Text).flatMap((node) => node.props.children as string)).toEqual(['settings.title']);
        } finally { await act(async () => { tree.unmount(); }); }
    });

    it('keeps the Settings hub titled by the bar: it is not a subpage', async () => {
        const hub = getSettingsStackScreenDefinitions(identity).find((candidate) => candidate.name === 'index');
        expect(hub?.options.headerTitle).toBe('settings.title');
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
