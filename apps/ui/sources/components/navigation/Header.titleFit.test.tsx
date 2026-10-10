import * as React from 'react';
import type { NativeStackHeaderProps } from '@react-navigation/native-stack';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

describe('stack navigation title fit', () => {
    afterEach(standardCleanup);

    it.each(['title', 'headerTitle'] as const)('keeps %s to one accessible line beside route actions', async titleKey => {
        const { createHeader } = await import('./Header');
        const title = 'Add a profile with a long descriptive name';
        const header = createHeader({
            route: { key: 'profile-draft', name: 'settings/profiles/new' },
            options: { [titleKey]: title, headerRight: () => React.createElement('RouteActions') },
            // The SDK transport is not invoked by this no-back-button header.
            navigation: {} as NativeStackHeaderProps['navigation'],
        });
        if (header === null) throw new Error('Expected a header for the profile route');
        const screen = await renderScreen(header);
        const text = screen.root.findAll(node => node.props.children === title && node.props.numberOfLines === 1);
        expect(text.length).toBeGreaterThan(0);
        expect(text.some(node => node.props.ellipsizeMode === 'tail')).toBe(true);
        expect(screen.root.findAllByType('RouteActions')).toHaveLength(1);
    });
});
