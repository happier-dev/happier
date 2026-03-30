import * as React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installMachinesSettingsCommonModuleMocks } from '@/components/settings/machines/machinesSettingsTestHelpers';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

const activeServerSnapshot = vi.hoisted(() => ({
    serverId: 'relay-example',
    serverUrl: 'https://relay.example.test',
    activeLocalRelayUrl: null as string | null,
    generation: 1,
}));

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
        React.createElement('Group', { title, footer }, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: Record<string, unknown>) => React.createElement('RoundButton', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
    TextInput: (props: Record<string, unknown>) => React.createElement('TextInput', props),
}));

vi.mock('@/sync/domains/server/serverProfiles', async () => {
    const actual = await vi.importActual<typeof import('@/sync/domains/server/serverProfiles')>('@/sync/domains/server/serverProfiles');
    return {
        ...actual,
        getActiveServerSnapshot: () => activeServerSnapshot,
    };
});

describe('LocalDaemonControlSection', () => {
    beforeEach(() => {
        activeServerSnapshot.serverId = 'relay-example';
        activeServerSnapshot.serverUrl = 'https://relay.example.test';
        activeServerSnapshot.activeLocalRelayUrl = null;
        activeServerSnapshot.generation = 1;
    });

    it('loads daemon status on mount and starts the local daemon service from the control row', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');

        let nextTaskId = 1;
        const listeners = new Map<string, {
            onEvent: (payload: unknown) => void;
            onResult: (payload: unknown) => void;
        }>();
        const starts: unknown[] = [];

        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    const parsed = SystemTaskSpecSchema.parse(spec);
                    starts.push(parsed);
                    return `task_${nextTaskId++}:${parsed.kind}`;
                },
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

        const { LocalDaemonControlSection } = await import('./LocalDaemonControlSection');
        const screen = await renderScreen(React.createElement(LocalDaemonControlSection, { runner }));

        expect(starts[0]).toMatchObject({
            kind: 'daemon.service.status.v1',
            params: {
                target: { kind: 'local' },
                surface: 'desktop.ui',
                mode: 'user',
            },
        });

        await renderer.act(async () => {
            listeners.get('task_1:daemon.service.status.v1')?.onResult({
                protocolVersion: 1,
                taskId: 'task_1:daemon.service.status.v1',
                ok: true,
                data: {
                    serviceInstalled: true,
                    daemonRunning: false,
                    needsAuth: false,
                    machineId: 'machine-local-1',
                },
            });
        });

        expect(screen.findByTestId('settings.localDaemonControl.status')?.props.subtitle).toBe('server.relayDrift.bannerNotRunningDescription');
        expect(screen.findByTestId('settings.localDaemonControl.machineId')?.props.subtitle).toBe('machine-local-1');

        await screen.pressByTestIdAsync('settings.localDaemonControl.start');

        expect(starts.some((entry) => (entry as { kind?: unknown }).kind === 'daemon.service.start.v1')).toBe(true);
    });

    it('starts the canonical background-service repair task against the active relay', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');

        let nextTaskId = 1;
        const starts: unknown[] = [];

        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    const parsed = SystemTaskSpecSchema.parse(spec);
                    starts.push(parsed);
                    return `task_${nextTaskId++}:${parsed.kind}`;
                },
                async subscribe() {
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { LocalDaemonControlSection } = await import('./LocalDaemonControlSection');
        const screen = await renderScreen(React.createElement(LocalDaemonControlSection, { runner }));

        await screen.pressByTestIdAsync('settings.localDaemonControl.repair');

        expect(starts).toContainEqual(expect.objectContaining({
            kind: 'relay.connectBackgroundService.v1',
            params: expect.objectContaining({
                activeRelayUrl: 'https://relay.example.test',
                activeWebappUrl: 'https://relay.example.test',
                activeLocalRelayUrl: null,
                surface: 'desktop.ui',
            }),
        }));
    });

    it('surfaces a recoverable status error without disabling daemon repair', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const startMock = vi.fn(async () => {
            throw new Error('daemon status request failed');
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

        const { LocalDaemonControlSection } = await import('./LocalDaemonControlSection');
        const screen = await renderScreen(React.createElement(LocalDaemonControlSection, { runner }));

        await renderer.act(async () => {});

        expect(startMock).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('settings.localDaemonControl.status')?.props.subtitle).toBe('machine.daemonStatus.unknown');
        expect(screen.findByProps({ subtitle: 'daemon status request failed' })).toBeTruthy();
        expect(screen.findByTestId('settings.localDaemonControl.repair')?.props.disabled).toBe(false);
    });
});
