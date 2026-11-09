import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { SettingsPageSearchResult } from '@/components/settings/catalog/types';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';

const VIEWPORT_ROWS = 12;
const legend = vi.hoisted(() => ({ state: null as null | { props: { data?: readonly unknown[] } | null } }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
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
// Only the native recycler is substituted; it mounts the first viewport rows of the data it is given.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    const boundary = createCapturingLegendListMock({
        original: await importOriginal<Record<string, unknown>>(),
        renderItemLimit: VIEWPORT_ROWS,
    });
    legend.state = boundary.state;
    return boundary.module;
});

afterEach(standardCleanup);

describe('SettingsSearchResults windowing', () => {
    it.each(['rail', 'page'] as const)('mounts only the viewport rows of a broad %s query', async (presentation) => {
        const { SettingsSearchResults } = await import('./SettingsSearchResults');
        const results: SettingsPageSearchResult[] = Array.from({ length: 842 }, (_, index) => ({
            id: 'appearance', route: `/settings/appearance?setting=row.${index}`,
            setting: { anchor: `row.${index}`, title: `Setting ${index}`, path: ['Appearance'] },
        }));
        const screen = await renderScreen(
            <ListPresentationProvider value={presentation === 'page' ? 'page' : 'grouped'}>
                <SettingsSearchResults results={results} tree={[]} presentation={presentation}
                    testIDPrefix="results" emptyTestID="empty" onOpen={vi.fn()} />
            </ListPresentationProvider>,
        );
        const mountedRows = screen.root.findAll((node) => typeof node.type === 'string'
            && typeof node.props.testID === 'string' && node.props.testID.startsWith('results.setting.')).length;
        expect(legend.state?.props?.data?.length).toBeGreaterThanOrEqual(842);
        expect(mountedRows).toBeGreaterThan(0);
        expect(mountedRows).toBeLessThanOrEqual(VIEWPORT_ROWS);
    });
});
