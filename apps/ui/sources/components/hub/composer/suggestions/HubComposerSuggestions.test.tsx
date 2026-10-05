import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { HubComposerSuggestions } from './HubComposerSuggestions';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
    });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
// The HTTP capability probe is unavailable; the actual feature owner therefore excludes automation.
vi.mock('@/sync/api/capabilities/serverFeaturesClient', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/api/capabilities/serverFeaturesClient')>(),
    getServerFeaturesSnapshot: async () => ({ status: 'error', reason: 'network' }),
    observeAuthenticatedServerFeaturesFresh: async () => ({ status: 'error', reason: 'network' }),
}));

describe('HubComposerSuggestions', () => {
    it('allows phone suggestions to swipe and fill a prompt, and disables swiping when the column fits', async () => {
        storage.setState({ isDataReady: true, sessionListRowsByServerId: {} });
        const onFill = vi.fn();
        const screen = await renderScreen(<HubComposerSuggestions onFill={onFill} />);

        expect(screen.findByTestId('hub-composer.suggestion.starter:fixTest')).not.toBeNull();
        const strip = screen.findByTestId('hub-composer.suggestions-scroll')!;
        expect(strip).not.toBeNull();
        expect(strip.props.horizontal).toBe(true);
        expect(strip.props.scrollEnabled).toBe(true);
        await pressTestInstanceAsync(screen.findByTestId('hub-composer.suggestion.starter:fixTest'), 'fix-test');
        expect(onFill).toHaveBeenCalledWith({ prompt: 'homeComposer.starter.fixTest', placement: null });

        await act(async () => {
            screen.findByTestId('hub-composer.suggestions')!.props.onLayout({
                nativeEvent: { layout: { width: 900, height: 100, x: 0, y: 0 } },
            });
        });
        expect(screen.findByTestId('hub-composer.suggestions-scroll')!.props.scrollEnabled).toBe(false);
        await pressTestInstanceAsync(screen.findByTestId('hub-composer.suggestion.starter:explain'), 'explain');
        expect(onFill).toHaveBeenLastCalledWith({ prompt: 'homeComposer.starter.explain', placement: null });
        await screen.unmount();
    });
});
