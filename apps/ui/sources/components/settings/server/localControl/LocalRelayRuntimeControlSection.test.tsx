import * as React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installMachinesSettingsCommonModuleMocks } from '@/components/settings/machines/machinesSettingsTestHelpers';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

installMachinesSettingsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Platform: {
                OS: 'web',
                select: (options: Record<string, unknown>) => options?.web ?? options?.default,
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    accent: {
                        blue: 'blue',
                        orange: 'orange',
                        indigo: 'indigo',
                    },
                },
            },
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, title, footer }: { children?: React.ReactNode; title?: React.ReactNode; footer?: React.ReactNode }) =>
        React.createElement(
            'Group',
            { title, footer },
            typeof title === 'string' || typeof title === 'number'
                ? React.createElement('Text', null, String(title))
                : title ?? null,
            children,
        ),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => {
        const title = (props as any).title;
        const subtitle = (props as any).subtitle;
        const subtitleTestID = (props as any).subtitleTestID;
        const subtitleAccessory = (props as any).subtitleAccessory;
        return React.createElement(
            'Item',
            props,
            title != null ? React.createElement('Text', null, String(title)) : null,
            typeof subtitle === 'string' || typeof subtitle === 'number'
                ? React.createElement('Text', { testID: subtitleTestID }, String(subtitle))
                : subtitle ?? null,
            subtitleAccessory ?? null,
        );
    },
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: Record<string, unknown>) => React.createElement('RoundButton', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
    TextInput: (props: Record<string, unknown>) => React.createElement('TextInput', props),
}));

describe('LocalRelayRuntimeControlSection', () => {
    it('surfaces a recoverable start error when starting a system task throws immediately', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const startMock = vi.fn(async () => {
            throw new Error('failed to start hsetup');
        });

        const runner = createSystemTaskRunner({
            bridge: {
                start: startMock,
                async subscribe() {
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { LocalRelayRuntimeControlSection } = await import('./LocalRelayRuntimeControlSection');
        const screen = await renderScreen(React.createElement(LocalRelayRuntimeControlSection, { runner }));

        await renderer.act(async () => {});

        expect(startMock).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('settings.localRelayRuntime.status')?.props.subtitle).toBe('settings.localRelayRuntime.statusChecking');
        expect(screen.findByProps({ subtitle: 'failed to start hsetup' })).toBeTruthy();
        expect(screen.findByTestId('settings.localRelayRuntime.installOrUpdate')?.props.disabled).toBe(false);
    });

    it('does not try to start local relay tasks when system tasks are unavailable', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const startMock = vi.fn(async () => {
            throw new Error('system_tasks_unavailable');
        });

        const runner = createSystemTaskRunner({
            mode: 'unavailable',
            bridge: {
                start: startMock,
                async subscribe() {
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { LocalRelayRuntimeControlSection } = await import('./LocalRelayRuntimeControlSection');
        const screen = await renderScreen(React.createElement(LocalRelayRuntimeControlSection, { runner }));

        expect(startMock).not.toHaveBeenCalled();
        expect(screen.findByTestId('settings.localRelayRuntime.status')?.props.subtitle).toBe('settings.systemTaskBridgeUnavailable');
        expect(screen.findByTestId('settings.localRelayRuntime.installOrUpdate')?.props.disabled).toBe(true);
        expect(screen.findByTestId('settings.localRelayRuntime.start')?.props.disabled).toBe(true);
        expect(screen.findByTestId('settings.localRelayRuntime.stop')?.props.disabled).toBe(true);
    });

    it('loads relay runtime status on mount and surfaces the latest local state', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');

        let nextTaskId = 1;
        const listeners = new Map<string, {
            onEvent: (payload: unknown) => void;
            onResult: (payload: unknown) => void;
        }>();
        const startMock = vi.fn(async (spec: unknown) => {
            const parsed = SystemTaskSpecSchema.parse(spec);
            return `task_${nextTaskId++}:${parsed.kind}`;
        });

        const runner = createSystemTaskRunner({
            bridge: {
                start: startMock,
                async subscribe(taskId, listenerSet) {
                    listeners.set(taskId, listenerSet);
                    return () => {
                        listeners.delete(taskId);
                    };
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { LocalRelayRuntimeControlSection } = await import('./LocalRelayRuntimeControlSection');
        const screen = await renderScreen(React.createElement(LocalRelayRuntimeControlSection, { runner }));

        expect(startMock).toHaveBeenCalledWith({
            protocolVersion: 1,
            kind: 'relay.runtime.status.v1',
            params: {
                target: { kind: 'local' },
                channel: 'stable',
                mode: 'user',
            },
        });

        await renderer.act(async () => {
            listeners.get('task_1:relay.runtime.status.v1')?.onResult({
                protocolVersion: 1,
                taskId: 'task_1:relay.runtime.status.v1',
                ok: true,
                data: {
                    installed: true,
                    version: '1.2.3',
                    relayUrl: 'http://127.0.0.1:3005',
                    healthy: true,
                    service: {
                        active: true,
                        enabled: true,
                    },
                },
            });
        });

        expect(screen.findByTestId('settings.localRelayRuntime.status')?.props.subtitle).toBe('settings.localRelayRuntime.statusRunningHealthy');
        expect(screen.findByTestId('settings.localRelayRuntime.relayUrl')?.props.subtitle).toBe('http://127.0.0.1:3005');
        expect(screen.findByTestId('settings.localRelayRuntime.start')?.props.disabled).toBe(true);
        expect(screen.findByTestId('settings.localRelayRuntime.stop')?.props.disabled).toBe(false);
    });

    it('starts install and stop tasks from the control rows and renders task progress', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');

        let nextTaskId = 1;
        const listeners = new Map<string, {
            onEvent: (payload: unknown) => void;
            onResult: (payload: unknown) => void;
        }>();
        const cancelMock = vi.fn(async (_taskId: string) => {});
        const startMock = vi.fn(async (spec: unknown) => {
            const parsed = SystemTaskSpecSchema.parse(spec);
            return `task_${nextTaskId++}:${parsed.kind}`;
        });

        const runner = createSystemTaskRunner({
            bridge: {
                start: startMock,
                async subscribe(taskId, listenerSet) {
                    listeners.set(taskId, listenerSet);
                    return () => {
                        listeners.delete(taskId);
                    };
                },
                async cancel(taskId) {
                    await cancelMock(taskId);
                },
                async respond() {},
            },
        });

        const { LocalRelayRuntimeControlSection } = await import('./LocalRelayRuntimeControlSection');
        const screen = await renderScreen(React.createElement(LocalRelayRuntimeControlSection, { runner }));

        await renderer.act(async () => {
            listeners.get('task_1:relay.runtime.status.v1')?.onResult({
                protocolVersion: 1,
                taskId: 'task_1:relay.runtime.status.v1',
                ok: true,
                data: {
                    installed: false,
                    version: null,
                    relayUrl: 'http://127.0.0.1:3005',
                    healthy: false,
                    service: {
                        active: false,
                        enabled: false,
                    },
                },
            });
        });

        await screen.pressByTestIdAsync('settings.localRelayRuntime.installOrUpdate');

        expect(startMock).toHaveBeenLastCalledWith({
            protocolVersion: 1,
            kind: 'relay.runtime.installOrUpdate.v1',
            params: {
                target: { kind: 'local' },
                channel: 'stable',
                mode: 'user',
            },
        });

        await renderer.act(async () => {
            listeners.get('task_2:relay.runtime.installOrUpdate.v1')?.onEvent({
                protocolVersion: 1,
                taskId: 'task_2:relay.runtime.installOrUpdate.v1',
                tsMs: 100,
                type: 'progress',
                stepId: 'relay.install',
                message: 'Installing relay runtime',
            });
        });

        expect(screen.findByTestId('system-task-progress-card')).toBeTruthy();
        expect(screen.findByTestId('system-task-step-label')?.props.children).toBe('settings.localRelayRuntime.progressStepInstall');
        await screen.pressByTestIdAsync('system-task-progress-cancel');
        expect(cancelMock).toHaveBeenCalledWith('task_2:relay.runtime.installOrUpdate.v1');

        await renderer.act(async () => {
            listeners.get('task_2:relay.runtime.installOrUpdate.v1')?.onResult({
                protocolVersion: 1,
                taskId: 'task_2:relay.runtime.installOrUpdate.v1',
                ok: true,
                data: {
                    relayUrl: 'http://127.0.0.1:3005',
                    mode: 'user',
                },
            });
        });

        expect(startMock).toHaveBeenLastCalledWith({
            protocolVersion: 1,
            kind: 'relay.runtime.status.v1',
            params: {
                target: { kind: 'local' },
                channel: 'stable',
                mode: 'user',
            },
        });
    });
});
