import * as React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { createExpoRouterMock, renderScreen } from '@/dev/testkit';
import { installMachinesSettingsCommonModuleMocks } from '@/components/settings/machines/machinesSettingsTestHelpers';

const openExternalUrlSpy = vi.hoisted(() => vi.fn(async (_url: string) => true));
const setClipboardStringSafeSpy = vi.hoisted(() => vi.fn(async (_value: string) => true));
const modalAlertSpy = vi.hoisted(() => vi.fn());
const setActiveServerShareableUrlSpy = vi.hoisted(() => vi.fn());
const expoRouterMock = createExpoRouterMock({
    router: {
        push: vi.fn(),
        replace: vi.fn(),
    },
});

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
        return createModalModuleMock({
            spies: {
                alert: modalAlertSpy,
            },
        }).module;
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

vi.mock('expo-router', () => expoRouterMock.module);

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: 'server-1',
        serverUrl: 'https://relay.example.test',
        activeShareableServerUrl: null,
        generation: 0,
    }),
    setActiveShareableServerUrl: (value: string | null) => setActiveServerShareableUrlSpy(value),
}));

vi.mock('@/utils/url/openExternalUrl', () => ({
    openExternalUrl: (url: string) => openExternalUrlSpy(url),
}));

vi.mock('@/utils/ui/clipboard', () => ({
    setClipboardStringSafe: (value: string) => setClipboardStringSafeSpy(value),
}));

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

describe('LocalTailscaleSecureAccessSection', () => {
    it('copies the shareable private URL after secure access succeeds', async () => {
        setClipboardStringSafeSpy.mockClear();
        modalAlertSpy.mockClear();
        setActiveServerShareableUrlSpy.mockClear();
        expoRouterMock.spies.push.mockClear();

        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');

        let nextTaskId = 1;
        const listeners = new Map<string, {
            onEvent: (payload: unknown) => void;
            onResult: (payload: unknown) => void;
        }>();

        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    SystemTaskSpecSchema.parse(spec);
                    return `task_${nextTaskId++}:secureAccess.tailscale.v1`;
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

        const { LocalTailscaleSecureAccessSection } = await import('./LocalTailscaleSecureAccessSection');
        const screen = await renderScreen(React.createElement(LocalTailscaleSecureAccessSection, {
            runner,
            upstreamUrl: 'http://127.0.0.1:3005',
        }));

        await screen.pressByTestIdAsync('settings.localTailscale.enable');

        await renderer.act(async () => {
            listeners.get('task_1:secureAccess.tailscale.v1')?.onResult({
                protocolVersion: 1,
                taskId: 'task_1:secureAccess.tailscale.v1',
                ok: true,
                data: {
                    tailscaleInstalled: true,
                    tailscaleLoggedIn: true,
                    serveEnabled: true,
                    shareableHttpsUrl: 'https://relay.example.ts.net',
                    requiresApproval: null,
                },
            });
        });

        expect(setActiveServerShareableUrlSpy).toHaveBeenCalledWith('https://relay.example.ts.net');

        await screen.pressByTestIdAsync('settings.localTailscale.copyShareableUrl');

        expect(setClipboardStringSafeSpy).toHaveBeenCalledWith('https://relay.example.ts.net');
        expect(modalAlertSpy).toHaveBeenCalledWith('common.copied', 'items.copiedToClipboard');
        const addPhoneItem = screen.findByTestId('settings.localTailscale.addPhone');
        expect(addPhoneItem).toBeTruthy();
        expect(addPhoneItem?.props.onPress).toBeTypeOf('function');
    });

    it('surfaces a recoverable start error when starting secure access throws immediately', async () => {
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

        const { LocalTailscaleSecureAccessSection } = await import('./LocalTailscaleSecureAccessSection');
        const screen = await renderScreen(React.createElement(LocalTailscaleSecureAccessSection, {
            runner,
            upstreamUrl: 'http://127.0.0.1:3005',
        }));

        await screen.pressByTestIdAsync('settings.localTailscale.enable');
        await renderer.act(async () => {});

        expect(startMock).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('settings.localTailscale.status')?.props.subtitle).toBe('settings.localTailscale.statusIdle');
        expect(screen.findByTestId('settings.localTailscale.enable')?.props.disabled).toBe(false);
    });

    it('does not try to start secure access when system tasks are unavailable', async () => {
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

        const { LocalTailscaleSecureAccessSection } = await import('./LocalTailscaleSecureAccessSection');
        const screen = await renderScreen(React.createElement(LocalTailscaleSecureAccessSection, {
            runner,
            upstreamUrl: 'http://127.0.0.1:3005',
        }));

        expect(startMock).not.toHaveBeenCalled();
        expect(screen.findByTestId('settings.localTailscale.status')?.props.subtitle).toBe('settings.systemTaskBridgeUnavailable');
        expect(screen.findByTestId('settings.localTailscale.enable')?.props.disabled).toBe(true);
    });

    it('starts secure access with the local relay url and shows the returned shareable URL', async () => {
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

        const { LocalTailscaleSecureAccessSection } = await import('./LocalTailscaleSecureAccessSection');
        const screen = await renderScreen(React.createElement(LocalTailscaleSecureAccessSection, {
            runner,
            upstreamUrl: 'http://127.0.0.1:3005',
        }));

        await screen.pressByTestIdAsync('settings.localTailscale.enable');

        expect(startMock).toHaveBeenCalledWith({
            protocolVersion: 1,
            kind: 'secureAccess.tailscale.v1',
            params: {
                upstreamUrl: 'http://127.0.0.1:3005',
                servePath: '/',
                installPolicy: 'installIfMissing',
                loginPolicy: 'interactive',
                mode: 'normalUser',
            },
        });

        await renderer.act(async () => {
            listeners.get('task_1:secureAccess.tailscale.v1')?.onResult({
                protocolVersion: 1,
                taskId: 'task_1:secureAccess.tailscale.v1',
                ok: true,
                data: {
                    tailscaleInstalled: true,
                    tailscaleLoggedIn: true,
                    serveEnabled: true,
                    shareableHttpsUrl: 'https://relay.example.ts.net',
                    requiresApproval: null,
                },
            });
        });

        expect(screen.findByTestId('settings.localTailscale.status')?.props.subtitle).toBe('settings.localTailscale.statusReady');
        expect(screen.findByTestId('settings.localTailscale.shareableUrl')?.props.subtitle).toBe('https://relay.example.ts.net');
    });

    it('shows approval actions when Tailscale secure access needs user approval', async () => {
        openExternalUrlSpy.mockClear();

        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');

        let nextTaskId = 1;
        const listeners = new Map<string, {
            onEvent: (payload: unknown) => void;
            onResult: (payload: unknown) => void;
        }>();

        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    SystemTaskSpecSchema.parse(spec);
                    return `task_${nextTaskId++}:secureAccess.tailscale.v1`;
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

        const { LocalTailscaleSecureAccessSection } = await import('./LocalTailscaleSecureAccessSection');
        const screen = await renderScreen(React.createElement(LocalTailscaleSecureAccessSection, {
            runner,
            upstreamUrl: 'http://127.0.0.1:3005',
        }));

        await screen.pressByTestIdAsync('settings.localTailscale.enable');

        await renderer.act(async () => {
            listeners.get('task_1:secureAccess.tailscale.v1')?.onResult({
                protocolVersion: 1,
                taskId: 'task_1:secureAccess.tailscale.v1',
                ok: true,
                data: {
                    tailscaleInstalled: true,
                    tailscaleLoggedIn: true,
                    serveEnabled: false,
                    shareableHttpsUrl: null,
                    requiresApproval: {
                        url: 'https://login.tailscale.test/approve',
                    },
                },
            });
        });

        expect(screen.findByTestId('settings.localTailscale.approval')?.props.subtitle).toBe('settings.localTailscale.approvalSubtitle');

        await screen.pressByTestIdAsync('settings.localTailscale.openApproval');

        expect(openExternalUrlSpy).toHaveBeenCalledWith('https://login.tailscale.test/approve');
    });

    it('retries secure access instead of attempting a prompt response while approval is pending', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');

        let nextTaskId = 1;
        const listeners = new Map<string, {
            onEvent: (payload: unknown) => void;
            onResult: (payload: unknown) => void;
        }>();
        const startMock = vi.fn(async (spec: unknown) => {
            SystemTaskSpecSchema.parse(spec);
            return `task_${nextTaskId++}:secureAccess.tailscale.v1`;
        });
        const cancelMock = vi.fn(async (_taskId: string) => {});
        const respondMock = vi.fn(async (_taskId: string, _answer: unknown) => {
            throw new Error('respond should not be called for local Tailscale retries');
        });

        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    return await startMock(spec);
                },
                async subscribe(taskId, listenerSet) {
                    listeners.set(taskId, listenerSet);
                    return () => {
                        listeners.delete(taskId);
                    };
                },
                async cancel(taskId) {
                    await cancelMock(taskId);
                },
                async respond(taskId, answer) {
                    await respondMock(taskId, answer);
                },
            },
        });

        const { LocalTailscaleSecureAccessSection } = await import('./LocalTailscaleSecureAccessSection');
        const screen = await renderScreen(React.createElement(LocalTailscaleSecureAccessSection, {
            runner,
            upstreamUrl: 'http://127.0.0.1:3005',
        }));

        await screen.pressByTestIdAsync('settings.localTailscale.enable');

        await renderer.act(async () => {
            listeners.get('task_1:secureAccess.tailscale.v1')?.onEvent({
                protocolVersion: 1,
                taskId: 'task_1:secureAccess.tailscale.v1',
                tsMs: 100,
                type: 'prompt',
                stepId: 'serve enable',
                message: 'Approve Tailscale Serve in your tailnet',
                data: {
                    kind: 'tailscaleServeApproval',
                    url: 'https://login.tailscale.test/approve',
                },
            });
        });

        await screen.pressByTestIdAsync('settings.localTailscale.enable');

        expect(cancelMock).toHaveBeenCalledWith('task_1:secureAccess.tailscale.v1');
        expect(startMock).toHaveBeenCalledTimes(2);
        expect(respondMock).not.toHaveBeenCalled();
    });

    it('does not treat installer prompts as approval prompts', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');

        let nextTaskId = 1;
        const listeners = new Map<string, {
            onEvent: (payload: unknown) => void;
            onResult: (payload: unknown) => void;
        }>();

        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    SystemTaskSpecSchema.parse(spec);
                    return `task_${nextTaskId++}:secureAccess.tailscale.v1`;
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

        const { LocalTailscaleSecureAccessSection } = await import('./LocalTailscaleSecureAccessSection');
        const screen = await renderScreen(React.createElement(LocalTailscaleSecureAccessSection, {
            runner,
            upstreamUrl: 'http://127.0.0.1:3005',
        }));

        await screen.pressByTestIdAsync('settings.localTailscale.enable');

        await renderer.act(async () => {
            listeners.get('task_1:secureAccess.tailscale.v1')?.onEvent({
                protocolVersion: 1,
                taskId: 'task_1:secureAccess.tailscale.v1',
                tsMs: 100,
                type: 'prompt',
                stepId: 'install',
                message: 'Install Tailscale to continue',
                data: {
                    kind: 'tailscaleInstall',
                    platform: 'darwin',
                    url: 'https://tailscale.com/download/mac',
                },
            });
        });

        expect(screen.findByTestId('settings.localTailscale.approval')).toBeNull();
        expect(screen.findByTestId('settings.localTailscale.openApproval')).toBeNull();
    });

    it('wires cancel while a secure-access task is still running', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');

        let nextTaskId = 1;
        const listeners = new Map<string, {
            onEvent: (payload: unknown) => void;
            onResult: (payload: unknown) => void;
        }>();
        const cancelMock = vi.fn(async (_taskId: string) => {});

        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    SystemTaskSpecSchema.parse(spec);
                    return `task_${nextTaskId++}:secureAccess.tailscale.v1`;
                },
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

        const { LocalTailscaleSecureAccessSection } = await import('./LocalTailscaleSecureAccessSection');
        const screen = await renderScreen(React.createElement(LocalTailscaleSecureAccessSection, {
            runner,
            upstreamUrl: 'http://127.0.0.1:3005',
        }));

        await screen.pressByTestIdAsync('settings.localTailscale.enable');

        await renderer.act(async () => {
            listeners.get('task_1:secureAccess.tailscale.v1')?.onEvent({
                protocolVersion: 1,
                taskId: 'task_1:secureAccess.tailscale.v1',
                tsMs: 100,
                type: 'progress',
                stepId: 'login',
                message: 'Started interactive Tailscale sign-in',
            });
        });

        expect(screen.findByTestId('system-task-progress-card')).toBeTruthy();
        await screen.pressByTestIdAsync('system-task-progress-cancel');
        expect(cancelMock).toHaveBeenCalledWith('task_1:secureAccess.tailscale.v1');
    });

    it('clears stale secure-access state when the upstream relay becomes unavailable', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');

        let nextTaskId = 1;
        const listeners = new Map<string, {
            onEvent: (payload: unknown) => void;
            onResult: (payload: unknown) => void;
        }>();

        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    SystemTaskSpecSchema.parse(spec);
                    return `task_${nextTaskId++}:secureAccess.tailscale.v1`;
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

        const { LocalTailscaleSecureAccessSection } = await import('./LocalTailscaleSecureAccessSection');
        const screen = await renderScreen(React.createElement(LocalTailscaleSecureAccessSection, {
            runner,
            upstreamUrl: 'http://127.0.0.1:3005',
        }));

        await screen.pressByTestIdAsync('settings.localTailscale.enable');

        await renderer.act(async () => {
            listeners.get('task_1:secureAccess.tailscale.v1')?.onResult({
                protocolVersion: 1,
                taskId: 'task_1:secureAccess.tailscale.v1',
                ok: true,
                data: {
                    tailscaleInstalled: true,
                    tailscaleLoggedIn: true,
                    serveEnabled: true,
                    shareableHttpsUrl: 'https://relay.example.ts.net',
                    requiresApproval: null,
                },
            });
        });

        await renderer.act(async () => {
            screen.tree.update(React.createElement(LocalTailscaleSecureAccessSection, {
                runner,
                upstreamUrl: null,
            }));
        });

        expect(screen.findByTestId('settings.localTailscale.status')?.props.subtitle).toBe('settings.localTailscale.statusUnavailable');
        expect(screen.findByTestId('settings.localTailscale.shareableUrl')).toBeNull();
    });
});
