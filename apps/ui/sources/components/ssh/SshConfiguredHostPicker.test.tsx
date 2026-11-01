import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { SelectableRow } from '@/components/ui/lists/SelectableRow';

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

// Window measurement/portal boundary only; the menu and its controls remain real.
vi.mock('@/components/ui/popover/Popover', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

const { SshConfiguredHostPicker } = await import('./SshConfiguredHostPicker');

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

        await screen.pressByTestIdAsync('ssh-suggestions-trigger');
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('devbox'));
        expect(screen.getTextContent()).toContain('settings.sshConfiguredHostPickerSourceSshConfig');
        expect(screen.getTextContent()).toContain('ubuntu@10.0.0.5:2222');
        await pressTestInstanceAsync(screen.findAllByType(SelectableRow)
            .find((row) => row.props.title === 'devbox'), 'configured SSH host');
        await vi.waitFor(() => expect(onSelectSuggestion).toHaveBeenCalledWith(suggestions[0]));
        expect(onRefresh).not.toHaveBeenCalled();
        expect(screen.getTextContent()).not.toContain('devbox');
        await screen.pressByTestIdAsync('ssh-suggestions-refresh');
        expect(onRefresh).toHaveBeenCalledOnce();
        await screen.unmount();
    });
});
