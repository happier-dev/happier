import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SystemTaskEvent } from '@happier-dev/protocol/system/tasks/spec';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import type { SystemTaskRunState } from './types';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { installSignedOutAuthForTest } from '@/dev/testkit/fixtures/signedOutAuth';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
beforeEach(async () => { await home.reset(); });
afterEach(async () => { await home.reset(); });

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

vi.mock('@/utils/platform/desktopHost', async importOriginal => ({
    ...await importOriginal<typeof import('@/utils/platform/desktopHost')>(),
    isDesktopHost: isDesktopHostMock,
    desktopHostKind: () => isDesktopHostMock() ? 'tauri' : null,
    invokeDesktopHost: invokeDesktopHostMock,
}));

vi.mock('@tauri-apps/api/path', () => ({
    homeDir: async () => '/home/test',
    join: async (...parts: string[]) => parts.join('/'),
}));

function textUnder(node: { children: ReadonlyArray<unknown> } | null): string {
    if (!node) return '';
    return node.children.map((child) => typeof child === 'string'
        ? child
        : textUnder(child as { children: ReadonlyArray<unknown> })).join('');
}

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

// Load the real graph during collection, after boundary installation, rather than inside a test's action budget.
const { SystemTaskProgressCard } = await import('./SystemTaskProgressCard');

describe('SystemTaskProgressCard checklist rendering', () => {
    it('renders checklist rows for observed steps and tags earlier ones as done', async () => {
        isDesktopHostMock.mockReturnValue(false);

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

        const prepareRow = screen.findByTestId('system-task-progress-checklist-step-row-prepare');
        expect(prepareRow).not.toBeNull();
        if (!prepareRow) {
            throw new Error('Missing prepare checklist row');
        }
        expect(textUnder(prepareRow)).toContain('settings.systemTaskStepPrepare');
        expect(textUnder(prepareRow)).toContain('Preparing task');

        const installRow = screen.findByTestId('system-task-progress-checklist-step-row-install.runtime');
        expect(installRow).not.toBeNull();
        if (!installRow) {
            throw new Error('Missing install checklist row');
        }
        expect(textUnder(installRow)).toContain('settings.systemTaskStepInstallRuntime');
        expect(textUnder(installRow)).toContain('Installing runtime');
    });

    it('supports a checklist-only variant without the verbose status rows', async () => {
        isDesktopHostMock.mockReturnValue(false);

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

        const checklistRow = screen.findByTestId('system-task-progress-checklist-step-row-install.runtime');
        expect(checklistRow).not.toBeNull();
    });

    it('falls back to the raw step id when no translation key is registered', async () => {
        isDesktopHostMock.mockReturnValue(false);

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

        const row = screen.findByTestId('system-task-progress-checklist-step-row-unknown.step.id');
        expect(row).not.toBeNull();
        if (!row) {
            throw new Error('Missing unknown step checklist row');
        }
        expect(textUnder(row)).toContain('unknown.step.id');
    });

    it('shows Open logs only on desktop and invokes the tauri command with an absolute path', async () => {
        await home.addHome({ name: 'Signed-out native draft', serverUrl: 'https://checklist-logs.fixture.test', accountId: null });
        isDesktopHostMock.mockReturnValue(true);
        invokeDesktopHostMock.mockResolvedValueOnce(undefined);
        const screen = await renderScreen(React.createElement(SystemTaskProgressCard, { snapshot: createSnapshot() }));

        await waitForHomeGovernance(() => expect(screen.findAllByTestId('system-task-progress-open-logs').some(node => node.props.disabled === false)).toBe(true));
        await screen.pressByTestIdAsync('system-task-progress-open-logs');

        expect(invokeDesktopHostMock).toHaveBeenCalledWith('system_tasks_open_log_path', {
            path: '/home/test/.happier/logs',
        });
    });

    it('allows the caller to omit the group title by passing title=null', async () => {
        isDesktopHostMock.mockReturnValue(false);

        const screen = await renderScreen(React.createElement(SystemTaskProgressCard, { snapshot: createSnapshot(), title: null }));
        const group = screen.tree.findByType('ItemGroup' as any);
        expect(group.props.title).toBeUndefined();
    });

    it.each(['https://login.tailscale.com/a/example', 'http://localhost:8080/approve'])('admits the explicit HTTP prompt before opening %s', async url => {
        isDesktopHostMock.mockReturnValue(false);
        openUrlMock.mockClear();
        const opened = vi.fn();
        vi.stubGlobal('open', opened);
        const restoreAuth = installSignedOutAuthForTest();
        const { storage } = await import('@/sync/domains/state/storageStore');
        const previousSettings = storage.getState().settings;
        storage.setState(state => ({ settings: { ...state.settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
            actions: { 'links.openExternal': { enabled: false } } }) } }));

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
                        url,
                    },
                }],
            }),
        }));

        try {
            expect(screen.findByTestId('system-task-progress-prompt-action')?.props.title).toBe('common.open');
            await screen.pressByTestIdAsync('system-task-progress-prompt-action');
            expect(openUrlMock).not.toHaveBeenCalled();
            expect(opened).not.toHaveBeenCalled();
            storage.setState(state => ({ settings: { ...state.settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1 }) } }));
            await screen.pressByTestIdAsync('system-task-progress-prompt-action');
            expect(opened).toHaveBeenCalledExactlyOnceWith(url, '_blank', 'noopener,noreferrer');
            expect(openUrlMock).not.toHaveBeenCalled();
        } finally {
            await screen.unmount();
            storage.setState({ settings: previousSettings });
            restoreAuth();
            vi.unstubAllGlobals();
        }
    });

    it('keeps an explicit non-HTTP prompt on its platform path', async () => {
        isDesktopHostMock.mockReturnValue(false);
        openUrlMock.mockClear();
        const restoreAuth = installSignedOutAuthForTest();
        const { storage } = await import('@/sync/domains/state/storageStore');
        const previousSettings = storage.getState().settings;
        storage.setState(state => ({ settings: { ...state.settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
            actions: { 'links.openExternal': { enabled: false } } }) } }));
        const screen = await renderScreen(<SystemTaskProgressCard snapshot={createSnapshot({ awaitingInput: true,
            events: [{ protocolVersion: 1, taskId: 'task_1', tsMs: 100, type: 'prompt',
                data: { kind: 'needsUserAction.openUrl', url: 'tailscale://login' } }] })} />);
        try {
            await screen.pressByTestIdAsync('system-task-progress-prompt-action');
            expect(openUrlMock).toHaveBeenCalledExactlyOnceWith('tailscale://login');
        } finally {
            await screen.unmount();
            storage.setState({ settings: previousSettings });
            restoreAuth();
        }
    });

    it('uses the tailscale-specific install label for install prompts', async () => {
        isDesktopHostMock.mockReturnValue(false);

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
