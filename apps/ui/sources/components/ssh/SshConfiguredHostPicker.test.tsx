import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { act } from 'react-test-renderer';

import { flushHookEffects, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { createManualSystemTaskRunner } from '@/dev/testkit/harness/manualSystemTaskRunner';
import { SelectableRow } from '@/components/ui/lists/SelectableRow';

import type { SshConfiguredHostSuggestion } from './filterConfiguredSshHostSuggestions';
import { useConfiguredSshHostSuggestions } from './useConfiguredSshHostSuggestions';

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

function ConfiguredHostPickerDiscovery(props: Readonly<{
    runner: ReturnType<typeof createManualSystemTaskRunner>['runner'];
}>) {
    const { refresh, ...state } = useConfiguredSshHostSuggestions({ runner: props.runner });
    return <SshConfiguredHostPicker
        testID="ssh-suggestions"
        {...state}
        onRefresh={refresh}
        onSelectSuggestion={() => {}}
    />;
}

describe('SshConfiguredHostPicker', () => {
    it('does not claim an empty inventory while the native bridge is still starting discovery', async () => {
        const harness = createManualSystemTaskRunner();
        let finishStart!: (taskId: string) => void;
        const starting = new Promise<string>((resolve) => { finishStart = resolve; });
        harness.bridge.start.mockReturnValueOnce(starting);
        const screen = await renderScreen(<ConfiguredHostPickerDiscovery runner={harness.runner} />);
        try {
            expect(screen.getTextContent()).toContain('settings.sshConfiguredHostPickerLoadingTitle');
            expect(screen.getTextContent()).not.toContain('settings.sshConfiguredHostPickerEmptyTitle');
        } finally {
            await act(async () => { finishStart('personal-home-task-1'); });
            await screen.unmount();
        }
    });

    it('claims an empty inventory only after discovery successfully returns no hosts', async () => {
        const harness = createManualSystemTaskRunner();
        const screen = await renderScreen(<ConfiguredHostPickerDiscovery runner={harness.runner} />);
        expect(screen.getTextContent()).toContain('settings.sshConfiguredHostPickerLoadingTitle');
        expect(screen.getTextContent()).not.toContain('settings.sshConfiguredHostPickerEmptyTitle');

        await act(async () => {
            harness.emitResult('personal-home-task-1', {
                protocolVersion: 1,
                taskId: 'personal-home-task-1',
                ok: true,
                data: [],
            });
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.getTextContent()).toContain('settings.sshConfiguredHostPickerEmptyTitle');
        expect(screen.getTextContent()).not.toContain('settings.sshConfiguredHostPickerErrorTitle');
        await screen.unmount();
    });

    it('keeps hosts during native refresh startup and settles a start rejection visibly', async () => {
        const harness = createManualSystemTaskRunner();
        const screen = await renderScreen(<ConfiguredHostPickerDiscovery runner={harness.runner} />);
        await act(async () => {
            harness.emitResult('personal-home-task-1', {
                protocolVersion: 1,
                taskId: 'personal-home-task-1',
                ok: true,
                data: suggestions,
            });
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        let finishStart!: (taskId: string) => void;
        let failStart!: (error: Error) => void;
        const starting = new Promise<string>((resolve, reject) => {
            finishStart = resolve;
            failStart = reject;
        });
        harness.bridge.start.mockReturnValueOnce(starting);
        await screen.pressByTestIdAsync('ssh-suggestions-refresh');
        try {
            expect(screen.findByTestId('ssh-suggestions-trigger')).toBeTruthy();
            expect(screen.getTextContent()).toContain('settings.sshConfiguredHostPickerRefreshingSubtitle');
            expect(screen.getTextContent()).not.toContain('settings.sshConfiguredHostPickerEmptyTitle');

            await act(async () => { failStart(new Error('Native SSH discovery could not start.')); });
            await flushHookEffects({ cycles: 2, turns: 2 });

            expect(screen.findByTestId('ssh-suggestions-trigger')).toBeTruthy();
            expect(screen.getTextContent()).toContain('Native SSH discovery could not start.');
            expect(screen.getTextContent()).not.toContain('settings.sshConfiguredHostPickerRefreshingSubtitle');
            expect(screen.getTextContent()).not.toContain('settings.sshConfiguredHostPickerEmptyTitle');
        } finally {
            await act(async () => { finishStart('personal-home-task-2'); });
            await screen.unmount();
        }
    });

    it('shows a published discovery failure without claiming no hosts and allows recovery', async () => {
        const harness = createManualSystemTaskRunner();
        const screen = await renderScreen(<ConfiguredHostPickerDiscovery runner={harness.runner} />);

        await act(async () => {
            harness.emitResult('personal-home-task-1', {
                protocolVersion: 1,
                taskId: 'personal-home-task-1',
                ok: false,
                error: { code: 'system_task_failed', message: 'Could not read SSH config.' },
            });
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.getTextContent()).toContain('settings.sshConfiguredHostPickerErrorTitle');
        expect(screen.getTextContent()).toContain('Could not read SSH config.');
        expect(screen.getTextContent()).not.toContain('settings.sshConfiguredHostPickerLoadingTitle');
        expect(screen.getTextContent()).not.toContain('settings.sshConfiguredHostPickerEmptyTitle');

        await screen.pressByTestIdAsync('ssh-suggestions-refresh');
        await act(async () => {
            harness.emitResult('personal-home-task-2', {
                protocolVersion: 1,
                taskId: 'personal-home-task-2',
                ok: true,
                data: [],
            });
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.getTextContent()).toContain('settings.sshConfiguredHostPickerEmptyTitle');
        expect(screen.getTextContent()).not.toContain('settings.sshConfiguredHostPickerErrorTitle');
        await screen.unmount();
    });

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
