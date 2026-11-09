import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { SettingsPageSearchResult } from '@/components/settings/catalog/types';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';

const nativeText = vi.hoisted(() => ({ retainedRenders: 0 }));
// Cell render work at the recycler boundary: a cell redraws when its entry or the list's extraData changes.
const cells = vi.hoisted(() => ({ renders: 0 }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const React = await import('react');
    return createReactNativeWebMock({
        // Native text is the observable rendering boundary; all row/domain logic stays real.
        Text: (props: { children?: React.ReactNode }) => {
            if (props.children === 'Retained setting') nativeText.retainedRenders++;
            return React.createElement('NativeText', props);
        },
    });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

// Only the native recycler is substituted (jsdom has no viewport); result rows, windowing data and presentation stay real.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({
        original: await importOriginal<Record<string, unknown>>(),
        memoizeItems: true,
        onRenderItem: () => { cells.renders += 1; },
    }).module;
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => '/settings' }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

afterEach(standardCleanup);

describe('SettingsSearchResults retained rows', () => {
    it.each(['rail', 'page'] as const)('does not redraw unchanged %s rows when the query removes a neighbor', async (presentation) => {
        const { SettingsSearchResults } = await import('./SettingsSearchResults');
        const retained: SettingsPageSearchResult = {
            id: 'appearance', route: '/settings/appearance?setting=appearance.density',
            setting: { anchor: 'appearance.density', title: 'Retained setting', path: ['Appearance', 'Text'] },
        };
        const neighbor: SettingsPageSearchResult = {
            id: 'appearance', route: '/settings/appearance?setting=appearance.avatar',
            setting: { anchor: 'appearance.avatar', title: 'Other setting', path: ['Appearance'] },
        };
        const onOpen = vi.fn();
        const last = { ...neighbor, route: '/settings/appearance?setting=appearance.last', setting: { ...neighbor.setting!, anchor: 'appearance.last' } };
        const tree: never[] = [];
        const props = { presentation, tree, onOpen, testIDPrefix: 'results', emptyTestID: 'empty' };
        const renderResults = (results: SettingsPageSearchResult[]) => <ListPresentationProvider value={presentation === 'page' ? 'page' : 'grouped'}>
            <SettingsSearchResults {...props} results={results} />
        </ListPresentationProvider>;
        nativeText.retainedRenders = 0;
        const screen = await renderScreen(renderResults([retained, neighbor, last]));
        const initialRenders = nativeText.retainedRenders;
        expect(initialRenders).toBeGreaterThan(0);
        await act(async () => {
            screen.update(renderResults([structuredClone(retained), last]));
        });
        expect(nativeText.retainedRenders).toBe(initialRenders);
        await screen.pressByTestIdAsync('results.setting.appearance.density');
        expect(onOpen).toHaveBeenLastCalledWith(retained.route);
        const changed = { ...retained, route: '/settings/appearance?setting=appearance.textSize', setting: { ...retained.setting!, title: 'Changed setting' } };
        await act(async () => { screen.update(renderResults([changed, last])); });
        await screen.pressByTestIdAsync('results.setting.appearance.density');
        expect(onOpen).toHaveBeenLastCalledWith(changed.route);
    });

    it.each(['rail', 'page'] as const)('redraws only the %s cells whose result changed while the query narrows', async (presentation) => {
        const { SettingsSearchResults } = await import('./SettingsSearchResults');
        const setting = (anchor: string, title: string): SettingsPageSearchResult => ({
            id: 'appearance', route: `/settings/appearance?setting=${anchor}`,
            setting: { anchor, title, path: ['Appearance'] },
        });
        const results = Array.from({ length: 12 }, (_, index) => setting(`appearance.s${index}`, `Setting ${index}`));
        const page: SettingsPageSearchResult = { id: 'appearance', route: '/settings/appearance' };
        const props = { presentation, tree: [] as never[], onOpen: vi.fn(), testIDPrefix: 'results', emptyTestID: 'empty' };
        const renderResults = (next: SettingsPageSearchResult[]) => <ListPresentationProvider value={presentation === 'page' ? 'page' : 'grouped'}>
            <SettingsSearchResults {...props} results={next} />
        </ListPresentationProvider>;
        const screen = await renderScreen(renderResults([page, ...results]));
        cells.renders = 0;
        // The next keystroke: the catalog answers with fresh result objects; the last setting drops out
        // (every other result keeps its place, so only a changed entry could redraw its cell).
        await act(async () => {
            screen.update(renderResults(structuredClone([page, ...results.filter((_, index) => index !== 11)])));
        });
        // 2 labels + 1 page + 11 settings stay as they were: no cell redraws.
        expect(cells.renders).toBe(0);
        expect(screen.findByTestId('results.setting.appearance.s11')).toBeNull();
        expect(screen.findByTestId('results.setting.appearance.s10')).not.toBeNull();
        // A result whose shown facts change still redraws its own cell, and only it.
        const renamed = structuredClone([page, ...results.filter((_, index) => index !== 11)]);
        renamed[3] = setting('appearance.s2', 'Setting two');
        await act(async () => { screen.update(renderResults(renamed)); });
        expect(cells.renders).toBe(1);
        expect(screen.getTextContent()).toContain('Setting two');
    });
});
