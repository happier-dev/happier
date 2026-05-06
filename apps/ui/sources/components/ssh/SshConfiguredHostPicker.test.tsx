import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import type { SshConfiguredHostSuggestion } from './filterConfiguredSshHostSuggestions';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Record<string, unknown>) => {
        const trigger = typeof props.trigger === 'function'
            ? props.trigger({
                toggle: () => (props.onOpenChange as (open: boolean) => void)?.(!props.open),
                selectedItem: null,
            })
            : null;
        return React.createElement('DropdownMenu', props, trigger);
    },
}));

vi.mock('@/components/ui/lists/SelectableRow', () => ({
    SelectableRow: (props: Record<string, unknown>) => React.createElement('SelectableRow', props),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

const suggestions: readonly SshConfiguredHostSuggestion[] = [
    {
        id: 'ssh-config:devbox',
        alias: 'devbox',
        hostname: '10.0.0.5',
        port: 2222,
        username: 'ubuntu',
        source: 'ssh-config',
    },
];

describe('SshConfiguredHostPicker', () => {
    it('passes selected suggestions to the caller without applying them itself', async () => {
        const onSelectSuggestion = vi.fn();
        const onRefresh = vi.fn();
        const { SshConfiguredHostPicker } = await import('./SshConfiguredHostPicker');
        const screen = await renderScreen(React.createElement(SshConfiguredHostPicker, {
            testID: 'ssh-suggestions',
            suggestions,
            loading: false,
            refreshing: false,
            unsupported: false,
            error: null,
            onRefresh,
            onSelectSuggestion,
        }));

        const menu = screen.findByType('DropdownMenu' as never) as unknown as {
            props: {
                items: Array<{ id: string; subtitle?: string }>;
                onSelect: (id: string) => void;
            };
        };

        expect(menu.props.items).toEqual([
            expect.objectContaining({
                id: 'ssh-config:devbox',
                subtitle: expect.stringContaining('settings.sshConfiguredHostPickerSourceSshConfig'),
            }),
        ]);

        menu.props.onSelect('ssh-config:devbox');
        expect(onSelectSuggestion).toHaveBeenCalledWith(suggestions[0]);
        expect(onRefresh).not.toHaveBeenCalled();
    });
});
