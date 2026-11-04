import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { Text } from '@/components/ui/text/Text';
import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';
import { ItemRevealContext } from './ItemRevealContext';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';

installUiListsCommonModuleMocks();
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

afterEach(() => {
    standardCleanup();
    setReducedMotionPreferenceOverride(null);
});
const { CountedDisclosureItem } = await import('./CountedDisclosureItem');

it('preserves reveal intent, permits closing afterwards, and opens only for a new enclosing request', async () => {
    setReducedMotionPreferenceOverride(true);
    const surface = (request: string | null, count = 11) => (
        <ItemRevealContext.Provider value={request}>
            <CountedDisclosureItem testID="quiet" title="Offline" count={count}>
                <Text>Quiet machine details</Text>
            </CountedDisclosureItem>
        </ItemRevealContext.Provider>
    );
    const screen = await renderScreen(surface(null));
    const header = () => screen.findAllByTestId('quiet.header').find((node) => typeof node.type === 'string' && typeof node.props.onPress === 'function')!;
    expect(header().props.accessibilityState.expanded).toBe(false);
    expect(screen.getTextContent()).not.toContain('Quiet machine details');
    await act(async () => { screen.update(surface('first')); });
    expect(header().props.accessibilityState.expanded).toBe(true);
    expect(screen.getTextContent()).toContain('Quiet machine details');
    await act(async () => { header().props.onPress(); });
    expect(header().props.accessibilityState.expanded).toBe(false);
    await act(async () => { screen.update(surface('first', 12)); });
    expect(header().props.accessibilityState.expanded).toBe(false);
    await act(async () => { screen.update(surface('second', 12)); });
    expect(header().props.accessibilityState.expanded).toBe(true);
});
