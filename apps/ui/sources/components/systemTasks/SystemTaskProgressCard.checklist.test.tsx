import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';

import type { SystemTaskEvent } from '@happier-dev/protocol';

import { renderScreen } from '@/dev/testkit';
import type { SystemTaskRunState } from './types';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

const isDesktopHostMock = vi.hoisted(() => vi.fn(() => false));
const invokeDesktopHostMock = vi.hoisted(() => vi.fn(async () => undefined));
const openUrlMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown> & { children?: React.ReactNode }) => React.createElement('Item', props, props.children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: Record<string, unknown> & { children?: React.ReactNode }) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        Linking: {
            openURL: openUrlMock,
        },
    });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                success: 'success',
                warningCritical: 'warningCritical',
                textTertiary: 'textTertiary',
                accent: {
                    blue: 'accentBlue',
                },
            },
        },
    });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: isDesktopHostMock,
    invokeDesktopHost: invokeDesktopHostMock,
}));

vi.mock('@tauri-apps/api/path', () => ({
    homeDir: async () => '/home/test',
    join: async (...parts: string[]) => parts.join('/'),
}));

function createSnapshot(overrides: Partial<SystemTaskRunState> = {}): SystemTaskRunState {
    return {
        taskId: 'task_1',
        status: 'running',
        currentStepId: 'install.runtime',
        latestMessage: 'Installing runtime',
        awaitingInput: false,
        cancelRequested: false,
        events: [],
        result: null,
        ...overrides,
    };
}

describe('SystemTaskProgressCard checklist rendering', () => {
    it('renders checklist rows for observed steps and tags earlier ones as done', async () => {
        isDesktopHostMock.mockReturnValue(false);
        const { SystemTaskProgressCard } = await import('./SystemTaskProgressCard');

        const events: readonly SystemTaskEvent[] = [
            {
                protocolVersion: 1,
                taskId: 'task_1',
                tsMs: 100,
                type: 'started',
                stepId: 'prepare',
                message: 'Preparing task',
            },
            {
                protocolVersion: 1,
                taskId: 'task_1',
                tsMs: 200,
                type: 'progress',
                stepId: 'install.runtime',
                message: 'Installing runtime',
            },
        ];

        const screen = await renderScreen(
            React.createElement(SystemTaskProgressCard, {
                snapshot: createSnapshot({
                    currentStepId: 'install.runtime',
                    latestMessage: 'Installing runtime',
                    events,
                }),
            }),
        );

        const prepareRow = screen.findByTestId('system-task-progress-checklist-step-done-prepare');
        expect(prepareRow).not.toBeNull();
        if (!prepareRow) {
            throw new Error('Missing prepare checklist row');
        }
        expect(prepareRow.props.title).toBe('settings.systemTaskStepPrepare');
        expect(prepareRow.props.subtitle).toBe('Preparing task');

        const installRow = screen.findByTestId('system-task-progress-checklist-step-active-install-runtime');
        expect(installRow).not.toBeNull();
        if (!installRow) {
            throw new Error('Missing install checklist row');
        }
        expect(installRow.props.title).toBe('settings.systemTaskStepInstallRuntime');
        expect(installRow.props.subtitle).toBe('Installing runtime');
    });

    it('supports a checklist-only variant without the verbose status rows', async () => {
        isDesktopHostMock.mockReturnValue(false);
        const { SystemTaskProgressCard } = await import('./SystemTaskProgressCard');

        const events: readonly SystemTaskEvent[] = [
            {
                protocolVersion: 1,
                taskId: 'task_1',
                tsMs: 100,
                type: 'started',
                stepId: 'prepare',
                message: 'Preparing task',
            },
            {
                protocolVersion: 1,
                taskId: 'task_1',
                tsMs: 200,
                type: 'progress',
                stepId: 'install.runtime',
                message: 'Installing runtime',
            },
        ];

        const screen = await renderScreen(
            React.createElement(SystemTaskProgressCard, {
                snapshot: createSnapshot({ events }),
                variant: 'checklistOnly',
            }),
        );

        expect(screen.findByTestId('system-task-progress-status-running')).toBeNull();
        expect(screen.findByTestId('system-task-step-label')).toBeNull();
        expect(screen.findByTestId('system-task-message')).toBeNull();

        const checklistRow = screen.findByTestId('system-task-progress-checklist-step-active-install-runtime');
        expect(checklistRow).not.toBeNull();
    });

    it('falls back to the raw step id when no translation key is registered', async () => {
        isDesktopHostMock.mockReturnValue(false);
        const { SystemTaskProgressCard } = await import('./SystemTaskProgressCard');

        const events: readonly SystemTaskEvent[] = [
            {
                protocolVersion: 1,
                taskId: 'task_1',
                tsMs: 100,
                type: 'progress',
                stepId: 'unknown.step.id',
                message: 'Doing something',
            },
        ];

        const screen = await renderScreen(
            React.createElement(SystemTaskProgressCard, {
                snapshot: createSnapshot({
                    currentStepId: 'unknown.step.id',
                    latestMessage: 'Doing something',
                    events,
                }),
                variant: 'checklistOnly',
            }),
        );

        const row = screen.findByTestId('system-task-progress-checklist-step-active-unknown-step-id');
        expect(row).not.toBeNull();
        if (!row) {
            throw new Error('Missing unknown step checklist row');
        }
        expect(row.props.title).toBe('unknown.step.id');
    });

    it('shows Open logs only on desktop and invokes the tauri command with an absolute path', async () => {
        isDesktopHostMock.mockReturnValue(true);
        invokeDesktopHostMock.mockResolvedValueOnce(undefined);
        const { SystemTaskProgressCard } = await import('./SystemTaskProgressCard');
        const screen = await renderScreen(React.createElement(SystemTaskProgressCard, { snapshot: createSnapshot() }));

        await screen.pressByTestIdAsync('system-task-progress-open-logs');

        expect(invokeDesktopHostMock).toHaveBeenCalledWith('system_tasks_open_log_path', {
            path: '/home/test/.happier/logs',
        });
    });

    it('allows the caller to omit the group title by passing title=null', async () => {
        isDesktopHostMock.mockReturnValue(false);
        const { SystemTaskProgressCard } = await import('./SystemTaskProgressCard');

        const screen = await renderScreen(React.createElement(SystemTaskProgressCard, { snapshot: createSnapshot(), title: null }));
        const group = screen.tree.findByType('ItemGroup' as any);
        expect(group.props.title).toBeUndefined();
    });

    it('renders an open action for URL prompts and opens the provided URL', async () => {
        isDesktopHostMock.mockReturnValue(false);
        openUrlMock.mockResolvedValueOnce(undefined);
        const { SystemTaskProgressCard } = await import('./SystemTaskProgressCard');

        const screen = await renderScreen(React.createElement(SystemTaskProgressCard, {
            snapshot: createSnapshot({
                awaitingInput: true,
                events: [{
                    protocolVersion: 1,
                    taskId: 'task_1',
                    tsMs: 100,
                    type: 'prompt',
                    stepId: 'tailscale.login',
                    message: 'Complete sign-in',
                    data: {
                        kind: 'needsUserAction.openUrl',
                        url: 'https://login.tailscale.com/a/example',
                    },
                }],
            }),
        }));

        const action = screen.findByTestId('system-task-progress-prompt-action');
        expect(action?.props?.title).toBe('common.open');

        await screen.pressByTestIdAsync('system-task-progress-prompt-action');

        expect(openUrlMock).toHaveBeenCalledWith('https://login.tailscale.com/a/example');
    });

    it('uses the tailscale-specific install label for install prompts', async () => {
        isDesktopHostMock.mockReturnValue(false);
        const { SystemTaskProgressCard } = await import('./SystemTaskProgressCard');

        const screen = await renderScreen(React.createElement(SystemTaskProgressCard, {
            snapshot: createSnapshot({
                awaitingInput: true,
                events: [{
                    protocolVersion: 1,
                    taskId: 'task_1',
                    tsMs: 100,
                    type: 'prompt',
                    stepId: 'tailscale.install',
                    message: 'Install Tailscale',
                    data: {
                        kind: 'tailscaleInstall',
                        url: 'https://tailscale.com/docs/install/linux',
                    },
                }],
            }),
        }));

        expect(screen.findByTestId('system-task-progress-prompt-action')?.props?.title).toBe('settings.localTailscale.openInstallAction');
    });
});
