import * as React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installMachinesSettingsCommonModuleMocks } from '@/components/settings/machines/machinesSettingsTestHelpers';

type WizardPrimaryState = {
    onPress: (() => void) | (() => Promise<void>);
    disabled: boolean;
} | null;

const setActiveServerShareableUrlSpy = vi.hoisted(() => vi.fn());
const setServerProfileShareableUrlSpy = vi.hoisted(() => vi.fn());

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
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    textSecondary: 'gray',
                    surface: 'surface',
                    overlay: {
                        scrimWizard: 'scrimWizard',
                    },
                },
            },
        });
    },
});

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: 'server-1',
        serverUrl: 'https://relay.example.test',
        activeShareableServerUrl: null,
        generation: 0,
    }),
    setActiveShareableServerUrl: (value: string | null, options?: { validatedAgainstServerUrl?: string | null }) =>
        setActiveServerShareableUrlSpy(value, options),
    setServerProfileShareableUrl: (
        serverProfileId: string,
        value: string | null,
        options?: { validatedAgainstServerUrl?: string | null },
    ) => setServerProfileShareableUrlSpy(serverProfileId, value, options),
}));

function createRunnerHarness() {
    return import('@/components/systemTasks/createSystemTaskRunner').then(async ({ createSystemTaskRunner }) => {
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');
        let nextTaskId = 1;
        const listeners = new Map<string, {
            onEvent: (payload: unknown) => void;
            onResult: (payload: unknown) => void;
        }>();
        const startedSpecs: unknown[] = [];

        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    SystemTaskSpecSchema.parse(spec);
                    startedSpecs.push(spec);
                    const kind = typeof (spec as { kind?: unknown })?.kind === 'string'
                        ? String((spec as { kind: string }).kind)
                        : 'unknown';
                    return `task_${nextTaskId++}:${kind}`;
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

        return {
            listeners,
            runner,
            startedSpecs,
        };
    });
}

describe('relay access wizard detail steps', () => {
    it('prefills the existing LAN URL and advances without rerunning configure when relay access is already configured', async () => {
        const { SYSTEM_TASK_PROTOCOL_VERSION } = await import('@happier-dev/protocol');
        const { RelayAccessLanUrlStep } = await import('./RelayAccessLanUrlStep');
        const harness = await createRunnerHarness();
        let primary: WizardPrimaryState = null;
        const onRequestAdvance = vi.fn();

        const screen = await renderScreen(
            React.createElement(RelayAccessLanUrlStep, {
                runner: harness.runner,
                upstreamUrl: 'http://127.0.0.1:3005/',
                serverProfileId: 'candidate-relay',
                onWizardPrimaryChange: (state) => {
                    primary = state as typeof primary;
                },
                onRequestAdvance,
            }),
        );

        await renderer.act(async () => {
            harness.listeners.get('task_1:relay.access.status.v1')?.onResult({
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId: 'task_1:relay.access.status.v1',
                ok: true,
                data: {
                    configured: true,
                    providerId: 'lan',
                    status: {
                        state: 'enabled',
                        shareUrl: 'https://relay.lan.example.test',
                        details: null,
                    },
                },
            });
        });
        await renderer.act(async () => {});

        expect(screen.findByTestId('relay-access-lan-url')?.props.value).toBe('https://relay.lan.example.test');
        expect((primary as WizardPrimaryState)?.disabled).toBe(false);

        await renderer.act(async () => {
            await primary?.onPress?.();
        });

        expect(harness.startedSpecs).toHaveLength(1);
        expect(onRequestAdvance).toHaveBeenCalledTimes(1);
    });

    it('persists the LAN share URL onto the candidate relay profile', async () => {
        setActiveServerShareableUrlSpy.mockClear();
        setServerProfileShareableUrlSpy.mockClear();

        const { SYSTEM_TASK_PROTOCOL_VERSION } = await import('@happier-dev/protocol');
        const { RelayAccessLanUrlStep } = await import('./RelayAccessLanUrlStep');
        const harness = await createRunnerHarness();
        let primary: WizardPrimaryState = null;

        const screen = await renderScreen(
            React.createElement(RelayAccessLanUrlStep, {
                runner: harness.runner,
                upstreamUrl: 'http://127.0.0.1:3005/',
                serverProfileId: 'candidate-relay',
                onWizardPrimaryChange: (state) => {
                    primary = state as typeof primary;
                },
            }),
        );

        await renderer.act(async () => {});

        await renderer.act(async () => {
            harness.listeners.get('task_1:relay.access.status.v1')?.onResult({
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId: 'task_1:relay.access.status.v1',
                ok: true,
                data: {
                    configured: false,
                    providerId: null,
                    status: {
                        state: 'disabled',
                        shareUrl: null,
                        details: null,
                    },
                },
            });
        });
        await renderer.act(async () => {});

        const input = screen.findByTestId('relay-access-lan-url');
        expect(input).toBeTruthy();
        await renderer.act(async () => {
            input?.props.onChangeText?.('https://relay.lan.example.test');
        });
        await renderer.act(async () => {});

        expect((primary as WizardPrimaryState)?.disabled).toBe(false);
        await renderer.act(async () => {
            await primary?.onPress?.();
        });

        expect(harness.startedSpecs[1]).toEqual({
            protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
            kind: 'relay.access.configure.v1',
            params: {
                target: { kind: 'local' },
                providerId: 'lan',
                config: {
                    providerId: 'lan',
                    url: 'https://relay.lan.example.test',
                },
                upstreamUrl: 'http://127.0.0.1:3005/',
            },
        });

        const taskId = 'task_2:relay.access.configure.v1';
        await renderer.act(async () => {
            harness.listeners.get(taskId)?.onResult({
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId,
                ok: true,
                data: {
                    configured: true,
                    providerId: 'lan',
                    status: {
                        state: 'enabled',
                        shareUrl: 'https://relay.lan.example.test',
                        details: null,
                    },
                },
            });
        });
        await renderer.act(async () => {});

        expect(setServerProfileShareableUrlSpy).toHaveBeenCalledWith('candidate-relay', 'https://relay.lan.example.test', {
            validatedAgainstServerUrl: 'http://127.0.0.1:3005/',
        });
        expect(setActiveServerShareableUrlSpy).not.toHaveBeenCalled();
    });

    it('advances after saving the LAN relay access URL', async () => {
        const { SYSTEM_TASK_PROTOCOL_VERSION } = await import('@happier-dev/protocol');
        const { RelayAccessLanUrlStep } = await import('./RelayAccessLanUrlStep');
        const harness = await createRunnerHarness();
        let primary: WizardPrimaryState = null;
        const onRequestAdvance = vi.fn();

        const screen = await renderScreen(
            React.createElement(RelayAccessLanUrlStep, {
                runner: harness.runner,
                upstreamUrl: 'http://127.0.0.1:3005/',
                serverProfileId: 'candidate-relay',
                onWizardPrimaryChange: (state) => {
                    primary = state as typeof primary;
                },
                onRequestAdvance,
            }),
        );

        await renderer.act(async () => {
            harness.listeners.get('task_1:relay.access.status.v1')?.onResult({
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId: 'task_1:relay.access.status.v1',
                ok: true,
                data: {
                    configured: false,
                    providerId: null,
                    status: {
                        state: 'disabled',
                        shareUrl: null,
                        details: null,
                    },
                },
            });
        });
        await renderer.act(async () => {});

        await renderer.act(async () => {
            screen.findByTestId('relay-access-lan-url')?.props.onChangeText?.('https://relay.lan.example.test');
        });
        await renderer.act(async () => {
            await primary?.onPress?.();
        });

        const taskId = 'task_2:relay.access.configure.v1';
        await renderer.act(async () => {
            harness.listeners.get(taskId)?.onResult({
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId,
                ok: true,
                data: {
                    configured: true,
                    providerId: 'lan',
                    status: {
                        state: 'enabled',
                        shareUrl: 'https://relay.lan.example.test',
                        details: null,
                    },
                },
            });
        });
        await renderer.act(async () => {});

        expect(onRequestAdvance).toHaveBeenCalledTimes(1);
    });

    it('prefills the existing Cloudflare hostname and advances without rerunning configure when relay access is already configured', async () => {
        const { SYSTEM_TASK_PROTOCOL_VERSION } = await import('@happier-dev/protocol');
        const { RelayAccessCloudflareNamedTunnelStep } = await import('./RelayAccessCloudflareNamedTunnelStep');
        const harness = await createRunnerHarness();
        let primary: WizardPrimaryState = null;
        const onRequestAdvance = vi.fn();

        const screen = await renderScreen(
            React.createElement(RelayAccessCloudflareNamedTunnelStep, {
                runner: harness.runner,
                upstreamUrl: 'http://127.0.0.1:3005/',
                serverProfileId: 'candidate-relay',
                onWizardPrimaryChange: (state) => {
                    primary = state as typeof primary;
                },
                onRequestAdvance,
            }),
        );

        await renderer.act(async () => {
            harness.listeners.get('task_1:relay.access.status.v1')?.onResult({
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId: 'task_1:relay.access.status.v1',
                ok: true,
                data: {
                    configured: true,
                    providerId: 'cloudflareNamed',
                    status: {
                        state: 'enabled',
                        shareUrl: 'https://relay.example.com',
                        details: {
                            managed: false,
                        },
                    },
                },
            });
        });
        await renderer.act(async () => {});

        expect(screen.findByTestId('relay-access-cloudflare-hostname')?.props.value).toBe('relay.example.com');
        expect(screen.findByTestId('relay-access-cloudflare-token')?.props.value).toBe('');
        expect((primary as WizardPrimaryState)?.disabled).toBe(false);

        await renderer.act(async () => {
            await primary?.onPress?.();
        });

        expect(harness.startedSpecs).toHaveLength(1);
        expect(onRequestAdvance).toHaveBeenCalledTimes(1);
    });

    it('persists the Cloudflare share URL onto the candidate relay profile', async () => {
        setActiveServerShareableUrlSpy.mockClear();
        setServerProfileShareableUrlSpy.mockClear();

        const { SYSTEM_TASK_PROTOCOL_VERSION } = await import('@happier-dev/protocol');
        const { RelayAccessCloudflareNamedTunnelStep } = await import('./RelayAccessCloudflareNamedTunnelStep');
        const harness = await createRunnerHarness();
        let primary: WizardPrimaryState = null;

        const screen = await renderScreen(
            React.createElement(RelayAccessCloudflareNamedTunnelStep, {
                runner: harness.runner,
                upstreamUrl: 'http://127.0.0.1:3005/',
                serverProfileId: 'candidate-relay',
                onWizardPrimaryChange: (state) => {
                    primary = state as typeof primary;
                },
            }),
        );

        await renderer.act(async () => {});

        await renderer.act(async () => {
            harness.listeners.get('task_1:relay.access.status.v1')?.onResult({
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId: 'task_1:relay.access.status.v1',
                ok: true,
                data: {
                    configured: false,
                    providerId: null,
                    status: {
                        state: 'disabled',
                        shareUrl: null,
                        details: null,
                    },
                },
            });
        });
        await renderer.act(async () => {});

        await renderer.act(async () => {
            screen.findByTestId('relay-access-cloudflare-hostname')?.props.onChangeText?.('relay.example.com');
            screen.findByTestId('relay-access-cloudflare-token')?.props.onChangeText?.('token-123');
        });
        await renderer.act(async () => {});

        expect((primary as WizardPrimaryState)?.disabled).toBe(false);
        await renderer.act(async () => {
            await primary?.onPress?.();
        });

        expect(harness.startedSpecs[1]).toEqual({
            protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
            kind: 'relay.access.configure.v1',
            params: {
                target: { kind: 'local' },
                providerId: 'cloudflareNamed',
                config: {
                    providerId: 'cloudflareNamed',
                    hostname: 'relay.example.com',
                    token: 'token-123',
                },
                upstreamUrl: 'http://127.0.0.1:3005/',
            },
        });

        const taskId = 'task_2:relay.access.configure.v1';
        await renderer.act(async () => {
            harness.listeners.get(taskId)?.onResult({
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId,
                ok: true,
                data: {
                    configured: true,
                    providerId: 'cloudflareNamed',
                    status: {
                        state: 'enabled',
                        shareUrl: 'https://relay.example.com',
                        details: null,
                    },
                },
            });
        });
        await renderer.act(async () => {});

        expect(setServerProfileShareableUrlSpy).toHaveBeenCalledWith('candidate-relay', 'https://relay.example.com', {
            validatedAgainstServerUrl: 'http://127.0.0.1:3005/',
        });
        expect(setActiveServerShareableUrlSpy).not.toHaveBeenCalled();
    });
});
