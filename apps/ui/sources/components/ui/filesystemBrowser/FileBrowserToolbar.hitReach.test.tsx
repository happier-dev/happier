import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { hitAreaOverlap, readHitArea } from '@/dev/testkit/harness/hitFrameReach';
import { HappierUiPlatformProvider } from '@happier-dev/plugin-ui/environment';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

import { FileBrowserToolbar, FileBrowserToolbarIconButton } from './FileBrowserToolbar';

describe('FileBrowserToolbar action hit areas', () => {
    // 34 px actions sit 8 px apart: unbounded, each reaches 5 px sideways and neighbours overlap by 2.
    it('splits the toolbar action gap between neighbouring actions', async () => {
        const screen = await renderScreen(
            <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
                <FileBrowserToolbar searchValue="" onSearchValueChange={() => {}}>
                    <FileBrowserToolbarIconButton testID="one" accessibilityLabel="One" onPress={() => {}}>{null}</FileBrowserToolbarIconButton>
                    <FileBrowserToolbarIconButton testID="two" accessibilityLabel="Two" onPress={() => {}}>{null}</FileBrowserToolbarIconButton>
                </FileBrowserToolbar>
            </HappierUiPlatformProvider>,
        );
        const one = readHitArea(screen.findByTestId('one')!);
        const two = readHitArea(screen.findByTestId('two')!);
        expect(hitAreaOverlap(one, two, { axis: 'horizontal', gap: 8 })).toBe(0);
        expect(one.drawn).toEqual({ width: 34, height: 34 });
        expect(one.height).toBe(44);
    });
});
