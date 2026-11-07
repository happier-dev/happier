import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';
import { readHitFrameReach } from '@/dev/testkit/harness/hitFrameReach';
import { HappierUiPlatformProvider } from '@happier-dev/plugin-ui/environment';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/components/ui/popover', async (importOriginal) => {
    const { createInlinePopoverModuleMock } = await import('@/dev/testkit/mocks/popover');
    return createInlinePopoverModuleMock(importOriginal);
});

import { CollectionSpacesStrip } from './CollectionSpacesStrip';

describe('CollectionSpacesStrip', () => {
    it('omits switching and add controls when only the default view exists', async () => {
        const screen = await renderScreen(<CollectionSpacesStrip testIDPrefix="single-space" accessibilityLabel="Spaces"
            items={[{ id: 'all', name: 'All workflows', icon: { kind: 'icon', name: 'list' } }]}
            selectedId="all" onSelect={() => {}} addLabel="New space" onAdd={() => {}} />);
        expect(screen.findHostByTestId('single-space')).toBeNull();
        expect(screen.findHostByTestId('single-space-add')).toBeNull();
    });

    // The + sits between the list title above and the group labels below: its hit area leaves the strip's 4 px
    // insets to their own reach, and splits the 2 px gap to the last space tab, so no two hit areas overlap.
    it('keeps the new-space hit area out of the title above it and the tab beside it', async () => {
        const screen = await renderScreen(
            <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
                <CollectionSpacesStrip
                    testIDPrefix="spaces"
                    accessibilityLabel="Spaces"
                    items={[
                        { id: 'a', name: 'Mine', icon: { kind: 'icon', name: 'list' } },
                        { id: 'b', name: 'Release', icon: { kind: 'icon', name: 'list' } },
                    ]}
                    selectedId="a"
                    onSelect={() => {}}
                    addLabel="New space"
                    onAdd={() => {}}
                />
            </HappierUiPlatformProvider>,
        );
        const reach = readHitFrameReach(screen.findByTestId('spaces-add')!);
        expect(reach?.top).toBe(0);
        expect(reach?.left).toBe(1);
        expect(reach?.bottom).toBe(0);
    });

    // P6 §7.1: a strip tab's context menu / long-press exposes Edit; selecting stays the press.
    it('opens Edit for the long-pressed space without selecting it', async () => {
        const onSelect = vi.fn();
        const onEditSpace = vi.fn();
        const screen = await renderScreen(
            <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
                <CollectionSpacesStrip
                    testIDPrefix="spaces"
                    accessibilityLabel="Spaces"
                    items={[
                        { id: 'a', name: 'Mine', icon: { kind: 'icon', name: 'list' } },
                        { id: 'b', name: 'Release', icon: { kind: 'icon', name: 'list' } },
                    ]}
                    selectedId="a"
                    onSelect={onSelect}
                    addLabel="New space"
                    onEditSpace={onEditSpace}
                />
            </HappierUiPlatformProvider>,
        );
        expect(screen.findByTestId('spaces-menu-edit')).toBeNull();
        await act(async () => { screen.findHostByTestId('spaces:b')!.props.onLongPress(); });
        await screen.pressByTestIdAsync('spaces-menu-edit');
        // The menu runs its choice a frame after it closes.
        await vi.waitFor(() => expect(onEditSpace).toHaveBeenCalledWith('b'));
        expect(onSelect).not.toHaveBeenCalled();
        expect(screen.findByTestId('spaces-menu-edit')).toBeNull();
    });
});
