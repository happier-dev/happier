import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const updateStatusState = vi.hoisted(() => ({
    tone: 'warning' as 'success' | 'warning' | 'accent',
}));

const itemSpy = vi.hoisted(() => ({
    lastProps: null as Record<string, unknown> | null,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                state: {
                    success: { foreground: '#00aa00' },
                    warning: { foreground: '#ffaa00' },
                    danger: { foreground: '#dd0000' },
                },
                accent: {
                    indigo: '#4444ff',
                },
            },
        },
    });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => {
        itemSpy.lastProps = props;
        return React.createElement('Item', props);
    },
}));

vi.mock('@/updates/useAppUpdateStatus', () => ({
    useAppUpdateStatus: () => ({
        model: {
            visible: true,
            kind: 'ota',
            tone: updateStatusState.tone,
            iconName: 'warning-outline',
            label: 'Update available',
            message: 'Install the update',
            actionLabel: 'Install',
            actionDisabled: false,
            dismissLabel: 'Dismiss',
        },
        runPrimaryAction: vi.fn(async () => {}),
        dismiss: vi.fn(),
    }),
}));

describe('AppUpdateStatusItemBanner', () => {
    afterEach(() => {
        itemSpy.lastProps = null;
        standardCleanup();
    });

    it('uses the warning foreground tone for warning banners', async () => {
        const { AppUpdateStatusItemBanner } = await import('./AppUpdateStatusItemBanner');

        await renderScreen(<AppUpdateStatusItemBanner />);
        const icon = itemSpy.lastProps?.icon as React.ReactElement<{ color?: string }> | undefined;

        expect(itemSpy.lastProps?.titleStyle).toEqual({ color: '#ffaa00' });
        expect(itemSpy.lastProps?.subtitleStyle).toEqual({ color: '#ffaa00' });
        expect(icon?.props.color).toBe('#ffaa00');
    });
});
