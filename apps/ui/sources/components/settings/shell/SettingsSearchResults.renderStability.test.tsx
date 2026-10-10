import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { SettingsPageSearchResult } from '@/components/settings/catalog/types';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';

const nativeText = vi.hoisted(() => ({ retainedRenders: 0 }));
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
});
