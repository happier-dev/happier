import * as React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installMachinesSettingsCommonModuleMocks } from '@/components/settings/machines/machinesSettingsTestHelpers';

type WizardPrimaryState = {
    disabled: boolean;
    onPress: (() => void) | (() => Promise<void>);
} | null;

function readWizardPrimary(state: WizardPrimaryState): Exclude<WizardPrimaryState, null> {
    if (!state) {
        throw new Error('expected wizard primary action');
    }
    return state;
}

const setActiveServerShareableUrlSpy = vi.hoisted(() => vi.fn());
const setServerProfileShareableUrlSpy = vi.hoisted(() => vi.fn());
const openExternalUrlSpy = vi.hoisted(() => vi.fn(
    async (_url: string, _options?: Readonly<{ platformOS?: string }>) => true,
));

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
                    accent: {
                        blue: 'blue',
                    },
                    success: 'success',
                    warningCritical: 'warningCritical',
                    textSecondary: 'gray',
                    textTertiary: 'textTertiary',
                    divider: 'divider',
                    surface: 'surface',
                    text: 'text',
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
    setActiveShareableServerUrl: (value: string | null) => setActiveServerShareableUrlSpy(value),
    setServerProfileShareableUrl: (
        serverProfileId: string,
        value: string | null,
        options?: { validatedAgainstServerUrl?: string | null },
    ) => setServerProfileShareableUrlSpy(serverProfileId, value, options),
}));

vi.mock('@/utils/url/openExternalUrl', () => ({
    openExternalUrl: (url: string, options?: Record<string, unknown>) => openExternalUrlSpy(url, options),
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

vi.mock('@/components/ui/lists/SelectableRow', () => ({
    SelectableRow: (props: Record<string, unknown>) => React.createElement('SelectableRow', props),
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: (props: Record<string, unknown>) => React.createElement('RoundButton', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
    TextInput: (props: Record<string, unknown>) => React.createElement('TextInput', props),
}));

describe('LocalRelayAccessControlSection', () => {
    it('labels relay providers as available to other devices in settings presentation', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');

        const runner = createSystemTaskRunner({
            bridge: {
                async start() {
                    return 'task_1:relay.access.status.v1';
                },
                async subscribe(_taskId, _listenerSet) {
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { LocalRelayAccessControlSection } = await import('./LocalRelayAccessControlSection');
        const screen = await renderScreen(
            React.createElement(LocalRelayAccessControlSection, {
                runner,
                upstreamUrl: 'http://127.0.0.1:3005',
            }),
        );

        expect(screen.findByTestId('settings.server.accessEndpoints.outwardScope')).toBeTruthy();
        expect(screen.findByTestId('settings.server.accessEndpoints.outwardScope')?.props.title).toBe(
            'settings.accessEndpoints.scope.availableToOtherDevices',
        );
    });

    it('does not render settings list chrome in wizard presentation', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');

        const runner = createSystemTaskRunner({
            bridge: {
                async start() {
                    return 'task_1:relay.access.status.v1';
                },
                async subscribe(_taskId, _listenerSet) {
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { LocalRelayAccessControlSection } = await import('./LocalRelayAccessControlSection');
        const screen = await renderScreen(
            React.createElement(LocalRelayAccessControlSection, {
                runner,
                upstreamUrl: 'http://127.0.0.1:3005',
                presentation: 'wizard',
            }),
        );

        const groups = screen.findAllByType('Group' as never);
        expect(groups.some((group: any) => group?.props?.title === 'settings.relayAccess.title')).toBe(false);
        expect(screen.findByTestId('settings.server.relayAccess.refresh')).toBeNull();
        expect(screen.findByTestId('settings.server.relayAccess.save')).toBeNull();
        expect(screen.findByTestId('settings.server.relayAccess.disable')).toBeNull();
    });

    it('uses the wizard chrome primary action to advance into provider details for LAN (no embedded fields)', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema, SYSTEM_TASK_PROTOCOL_VERSION } = await import('@happier-dev/protocol');

        const startedSpecs: unknown[] = [];
        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    SystemTaskSpecSchema.parse(spec);
                    startedSpecs.push(spec);
                    const kind = typeof (spec as any)?.kind === 'string' ? String((spec as any).kind) : 'unknown';
                    return `task_1:${kind}`;
                },
                async subscribe(_taskId, _listenerSet) {
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });

        let primary: { disabled: boolean; onPress: (() => void) | (() => Promise<void>) } | null = null;
        const requestDetails = vi.fn();

        const { LocalRelayAccessControlSection } = await import('./LocalRelayAccessControlSection');
        const screen = await renderScreen(
            React.createElement(LocalRelayAccessControlSection, {
                runner,
                upstreamUrl: 'http://127.0.0.1:3005',
                presentation: 'wizard',
                onWizardPrimaryChange: (state) => {
                    primary = state as any;
                },
                onWizardRequestProviderDetails: requestDetails,
            }),
        );

        await renderer.act(async () => {});

        expect(startedSpecs[0]).toEqual({
            protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
            kind: 'relay.access.status.v1',
            params: {
                target: { kind: 'local' },
            },
        });
        expect(screen.findByTestId('settings.server.relayAccess.refresh')).toBeNull();
        expect(screen.findByTestId('settings.server.relayAccess.save')).toBeNull();
        expect(screen.findByTestId('settings.server.relayAccess.disable')).toBeNull();
        expect(primary).toBeTruthy();

        await renderer.act(async () => {
            screen.findByTestId('settings.server.relayAccess.choice:lan')?.props.onPress?.();
        });

        await renderer.act(async () => {
            await (primary?.onPress as any)?.();
        });

        expect(screen.findByTestId('settings.server.relayAccess.lanUrl')).toBeNull();
        expect(screen.findByTestId('settings.server.relayAccess.cloudflareHostname')).toBeNull();
        expect(screen.findByTestId('settings.server.relayAccess.cloudflareToken')).toBeNull();
        expect(requestDetails).toHaveBeenCalledWith('lan');
        expect(startedSpecs).toHaveLength(1);
    });

    it('filters relay access providers when setup surface policy denies Tailscale and Cloudflare Tunnel', async () => {
        const previousDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = 'setup.relayAccess.allowTailscale,setup.relayAccess.allowCloudflareTunnel';
        try {
            const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');

            const runner = createSystemTaskRunner({
                bridge: {
                    async start() {
                        return 'task_1:relay.access.status.v1';
                    },
                    async subscribe(_taskId, _listenerSet) {
                        return () => {};
                    },
                    async cancel() {},
                    async respond() {},
                },
            });

            const { LocalRelayAccessControlSection } = await import('./LocalRelayAccessControlSection');
            const screen = await renderScreen(
                React.createElement(LocalRelayAccessControlSection, { runner, upstreamUrl: 'http://127.0.0.1:3005' }),
            );

            expect(screen.findByTestId('settings.server.relayAccess.choice:tailscaleServe')).toBeNull();
            expect(screen.findByTestId('settings.server.relayAccess.choice:tailscaleFunnel')).toBeNull();
            expect(screen.findByTestId('settings.server.relayAccess.choice:cloudflareNamed')).toBeNull();
        } finally {
            if (previousDeny === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
            else process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousDeny;
        }
    });

    it('shows Tailscale relay access providers for SSH targets alongside the other SSH-capable options', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');

        const runner = createSystemTaskRunner({
            bridge: {
                async start() {
                    return 'task_1:relay.access.status.v1';
                },
                async subscribe(_taskId, _listenerSet) {
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { LocalRelayAccessControlSection } = await import('./LocalRelayAccessControlSection');
        const screen = await renderScreen(
            React.createElement(LocalRelayAccessControlSection, {
                runner,
                target: {
                    kind: 'ssh',
                    ssh: {
                        target: 'dev@example.test',
                        auth: 'agent',
                    },
                },
                upstreamUrl: 'http://127.0.0.1:3005',
            }),
        );

        expect(screen.findByTestId('settings.server.relayAccess.choice:localOnly')).toBeTruthy();
        expect(screen.findByTestId('settings.server.relayAccess.choice:lan')).toBeTruthy();
        expect(screen.findByTestId('settings.server.relayAccess.choice:cloudflareNamed')).toBeTruthy();
        expect(screen.findByTestId('settings.server.relayAccess.choice:tailscaleServe')).toBeTruthy();
        expect(screen.findByTestId('settings.server.relayAccess.choice:tailscaleFunnel')).toBeTruthy();
    });

    it('advances the wizard after successful Tailscale secure access once the inline snapshot settles', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema, SYSTEM_TASK_PROTOCOL_VERSION } = await import('@happier-dev/protocol');

        let nextTaskId = 1;
        const listeners = new Map<string, {
            onEvent: (payload: unknown) => void;
            onResult: (payload: unknown) => void;
        }>();
        const startedSpecs: unknown[] = [];
        let primary: WizardPrimaryState = null;
        const onRequestAdvance = vi.fn();

        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    SystemTaskSpecSchema.parse(spec);
                    startedSpecs.push(spec);
                    const kind = typeof (spec as any)?.kind === 'string' ? String((spec as any).kind) : 'unknown';
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

        const { LocalRelayAccessControlSection } = await import('./LocalRelayAccessControlSection');
        await renderScreen(
            React.createElement(LocalRelayAccessControlSection, {
                runner,
                presentation: 'wizard',
                upstreamUrl: 'http://127.0.0.1:3005',
                forcedProviderId: 'tailscaleServe',
                showProviderChoices: false,
                allowWizardDetailsRedirect: false,
                onWizardPrimaryChange: (state) => {
                    primary = state as WizardPrimaryState;
                },
                onRequestAdvance,
            }),
        );
        await renderer.act(async () => {});

        await renderer.act(async () => {
            listeners.get('task_1:relay.access.status.v1')?.onResult({
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

        expect(primary).toBeTruthy();
        const currentPrimary = readWizardPrimary(primary);
        expect(currentPrimary.disabled).toBe(false);

        await renderer.act(async () => {
            await currentPrimary.onPress();
        });

        expect(startedSpecs[1]).toEqual({
            protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
            kind: 'secureAccess.tailscale.v1',
            params: {
                target: { kind: 'local' },
                upstreamUrl: 'http://127.0.0.1:3005',
                providerId: 'tailscaleServe',
                servePath: '/',
                installPolicy: 'installIfMissing',
                loginPolicy: 'interactive',
                mode: 'normalUser',
            },
        });
        expect(onRequestAdvance).toHaveBeenCalledTimes(0);

        await renderer.act(async () => {
            listeners.get('task_2:secureAccess.tailscale.v1')?.onResult({
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId: 'task_2:secureAccess.tailscale.v1',
                ok: true,
                data: {
                    tailscaleInstalled: true,
                    tailscaleLoggedIn: true,
                    serveEnabled: true,
                    shareableHttpsUrl: 'https://relay.tailnet.ts.net',
                    requiresApproval: null,
                },
            });
        });
        await renderer.act(async () => {});

        expect(onRequestAdvance).toHaveBeenCalledTimes(1);
    });

    it('runs relay.access.configure.v1 for LAN and updates the active shareable URL on success', async () => {
        setActiveServerShareableUrlSpy.mockClear();
        setServerProfileShareableUrlSpy.mockClear();

        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema, SYSTEM_TASK_PROTOCOL_VERSION } = await import('@happier-dev/protocol');

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
                    const kind = typeof (spec as any)?.kind === 'string' ? String((spec as any).kind) : 'unknown';
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

        const { LocalRelayAccessControlSection } = await import('./LocalRelayAccessControlSection');
        const screen = await renderScreen(React.createElement(LocalRelayAccessControlSection, { runner }));
        await renderer.act(async () => {});

        expect(startedSpecs[0]).toEqual({
            protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
            kind: 'relay.access.status.v1',
            params: {
                target: { kind: 'local' },
            },
        });

        const input = screen.findByTestId('settings.server.relayAccess.lanUrl');
        expect(input).toBeTruthy();
        await renderer.act(async () => {
            input?.props.onChangeText?.('https://relay.lan.example.test');
        });

        const save = screen.findByTestId('settings.server.relayAccess.save');
        expect(save).toBeTruthy();
        await renderer.act(async () => {
            await save?.props.onPress?.();
        });

        expect(startedSpecs).toHaveLength(2);
        expect(startedSpecs[1]).toEqual({
            protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
            kind: 'relay.access.configure.v1',
            params: {
                target: { kind: 'local' },
                providerId: 'lan',
                config: {
                    providerId: 'lan',
                    url: 'https://relay.lan.example.test',
                },
            },
        });

        const taskId = 'task_2:relay.access.configure.v1';
        await renderer.act(async () => {
            listeners.get(taskId)?.onResult({
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
        expect(setActiveServerShareableUrlSpy).toHaveBeenCalledWith('https://relay.lan.example.test');
        expect(setServerProfileShareableUrlSpy).not.toHaveBeenCalled();
    });

    it('persists a configured share URL onto the provided server profile without updating the active profile', async () => {
        setActiveServerShareableUrlSpy.mockClear();
        setServerProfileShareableUrlSpy.mockClear();

        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema, SYSTEM_TASK_PROTOCOL_VERSION } = await import('@happier-dev/protocol');

        let nextTaskId = 1;
        const listeners = new Map<string, {
            onEvent: (payload: unknown) => void;
            onResult: (payload: unknown) => void;
        }>();

        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    SystemTaskSpecSchema.parse(spec);
                    const kind = typeof (spec as any)?.kind === 'string' ? String((spec as any).kind) : 'unknown';
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

        const { LocalRelayAccessControlSection } = await import('./LocalRelayAccessControlSection');
        const screen = await renderScreen(
            React.createElement(LocalRelayAccessControlSection as any, {
                runner,
                upstreamUrl: 'http://127.0.0.1:3005/',
                serverProfileId: 'candidate-relay',
            }),
        );
        await renderer.act(async () => {});

        const input = screen.findByTestId('settings.server.relayAccess.lanUrl');
        expect(input).toBeTruthy();
        await renderer.act(async () => {
            input?.props.onChangeText?.('https://relay.lan.example.test');
        });

        const save = screen.findByTestId('settings.server.relayAccess.save');
        expect(save).toBeTruthy();
        await renderer.act(async () => {
            await save?.props.onPress?.();
        });

        const taskId = 'task_2:relay.access.configure.v1';
        await renderer.act(async () => {
            listeners.get(taskId)?.onResult({
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

        expect(setServerProfileShareableUrlSpy).toHaveBeenCalledWith('candidate-relay', 'https://relay.lan.example.test', {
            validatedAgainstServerUrl: 'http://127.0.0.1:3005/',
        });
        expect(setActiveServerShareableUrlSpy).not.toHaveBeenCalled();
    });

    it('runs secure access for Tailscale providers and includes upstreamUrl in the task spec', async () => {
        setActiveServerShareableUrlSpy.mockClear();

        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema, SYSTEM_TASK_PROTOCOL_VERSION } = await import('@happier-dev/protocol');

        let nextTaskId = 1;
        const startedSpecs: unknown[] = [];

        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    SystemTaskSpecSchema.parse(spec);
                    startedSpecs.push(spec);
                    const kind = typeof (spec as any)?.kind === 'string' ? String((spec as any).kind) : 'unknown';
                    return `task_${nextTaskId++}:${kind}`;
                },
                async subscribe() {
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { LocalRelayAccessControlSection } = await import('./LocalRelayAccessControlSection');
        const screen = await renderScreen(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test exercises forward-compatible prop surface
            React.createElement(LocalRelayAccessControlSection as any, { runner, upstreamUrl: 'http://127.0.0.1:3005' }),
        );
        await renderer.act(async () => {});

        const choice = screen.findByTestId('settings.server.relayAccess.choice:tailscaleServe');
        expect(choice).toBeTruthy();
        await renderer.act(async () => {
            choice?.props.onPress?.();
        });

        const save = screen.findByTestId('settings.server.relayAccess.save');
        expect(save).toBeTruthy();
        await renderer.act(async () => {
            await save?.props.onPress?.();
        });

        expect(startedSpecs).toHaveLength(2);
        expect(startedSpecs[1]).toEqual({
            protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
            kind: 'secureAccess.tailscale.v1',
            params: {
                target: { kind: 'local' },
                upstreamUrl: 'http://127.0.0.1:3005',
                providerId: 'tailscaleServe',
                servePath: '/',
                installPolicy: 'installIfMissing',
                loginPolicy: 'interactive',
                mode: 'normalUser',
            },
        });
    });

    it('supports Tailscale Funnel through the secure access system task spec', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema, SYSTEM_TASK_PROTOCOL_VERSION } = await import('@happier-dev/protocol');

        let nextTaskId = 1;
        const startedSpecs: unknown[] = [];

        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    SystemTaskSpecSchema.parse(spec);
                    startedSpecs.push(spec);
                    const kind = typeof (spec as any)?.kind === 'string' ? String((spec as any).kind) : 'unknown';
                    return `task_${nextTaskId++}:${kind}`;
                },
                async subscribe() {
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });

        const { LocalRelayAccessControlSection } = await import('./LocalRelayAccessControlSection');
        const screen = await renderScreen(
            React.createElement(LocalRelayAccessControlSection as any, {
                runner,
                upstreamUrl: 'http://127.0.0.1:3005',
            }),
        );
        await renderer.act(async () => {});

        const funnelChoice = screen.findByTestId('settings.server.relayAccess.choice:tailscaleFunnel');
        expect(funnelChoice).toBeTruthy();
        await renderer.act(async () => {
            funnelChoice?.props.onPress?.();
        });

        const save = screen.findByTestId('settings.server.relayAccess.save');
        expect(save).toBeTruthy();
        await renderer.act(async () => {
            await save?.props.onPress?.();
        });

        expect(startedSpecs).toHaveLength(2);
        expect(startedSpecs[1]).toEqual({
            protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
            kind: 'secureAccess.tailscale.v1',
            params: {
                target: { kind: 'local' },
                upstreamUrl: 'http://127.0.0.1:3005',
                providerId: 'tailscaleFunnel',
                servePath: '/',
                installPolicy: 'installIfMissing',
                loginPolicy: 'interactive',
                mode: 'normalUser',
            },
        });
    });

    it('renders actionable prompt UX for Tailscale secure-access prompts and opens the prompt URL', async () => {
        openExternalUrlSpy.mockClear();

        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema, SYSTEM_TASK_PROTOCOL_VERSION } = await import('@happier-dev/protocol');

        let nextTaskId = 1;
        const listeners = new Map<string, {
            onEvent: (payload: unknown) => void;
            onResult: (payload: unknown) => void;
        }>();

        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    SystemTaskSpecSchema.parse(spec);
                    const kind = typeof (spec as any)?.kind === 'string' ? String((spec as any).kind) : 'unknown';
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

        const { LocalRelayAccessControlSection } = await import('./LocalRelayAccessControlSection');
        const screen = await renderScreen(
            React.createElement(LocalRelayAccessControlSection as any, {
                runner,
                upstreamUrl: 'http://127.0.0.1:3005',
            }),
        );
        await renderer.act(async () => {});

        await renderer.act(async () => {
            listeners.get('task_1:relay.access.status.v1')?.onResult({
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
            screen.findByTestId('settings.server.relayAccess.choice:tailscaleServe')?.props.onPress?.();
        });
        await renderer.act(async () => {
            await screen.findByTestId('settings.server.relayAccess.save')?.props.onPress?.();
        });

        const actionTaskId = 'task_2:secureAccess.tailscale.v1';
        await renderer.act(async () => {
            listeners.get(actionTaskId)?.onEvent({
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId: actionTaskId,
                tsMs: 1,
                type: 'prompt',
                stepId: 'tailscale.login',
                message: 'Complete Tailscale sign-in to continue',
                data: {
                    kind: 'needsUserAction.openUrl',
                    url: 'https://login.tailscale.com/a/example',
                    usedQr: false,
                },
            });
            listeners.get(actionTaskId)?.onResult({
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId: actionTaskId,
                ok: false,
                error: {
                    code: 'prompt_required',
                    message: 'Complete Tailscale sign-in before enabling secure access.',
                },
            });
        });
        await renderer.act(async () => {});

        const promptCard = screen.findByTestId('settings.server.relayAccess.promptCard');
        expect(promptCard).toBeTruthy();

        await renderer.act(async () => {
            await screen.findByTestId('settings.server.relayAccess.promptCard-primary')?.props.onPress?.();
        });

        expect(openExternalUrlSpy).toHaveBeenCalledWith(
            'https://login.tailscale.com/a/example',
            { platformOS: 'web' },
        );
    });

    it('allows switching relay access providers after an existing configuration is loaded', async () => {
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema, SYSTEM_TASK_PROTOCOL_VERSION } = await import('@happier-dev/protocol');

        const listeners = new Map<string, {
            onEvent: (payload: unknown) => void;
            onResult: (payload: unknown) => void;
        }>();

        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    SystemTaskSpecSchema.parse(spec);
                    const kind = typeof (spec as any)?.kind === 'string' ? String((spec as any).kind) : 'unknown';
                    return `task_1:${kind}`;
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

        const { LocalRelayAccessControlSection } = await import('./LocalRelayAccessControlSection');
        const screen = await renderScreen(React.createElement(LocalRelayAccessControlSection, { runner }));
        await renderer.act(async () => {});

        const statusTaskId = 'task_1:relay.access.status.v1';
        await renderer.act(async () => {
            listeners.get(statusTaskId)?.onResult({
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId: statusTaskId,
                ok: true,
                data: {
                    configured: true,
                    providerId: 'localOnly',
                    status: {
                        state: 'enabled',
                        shareUrl: 'https://relay.localonly.example.test',
                        details: null,
                    },
                },
            });
        });

        expect(screen.findByTestId('settings.server.relayAccess.choice:localOnly')?.props.selected).toBe(true);
        expect(screen.findByTestId('settings.server.relayAccess.choice:lan')?.props.selected).toBe(false);
        expect(screen.findByTestId('settings.server.relayAccess.lanUrl')).toBeNull();

        const lanChoice = screen.findByTestId('settings.server.relayAccess.choice:lan');
        await renderer.act(async () => {
            lanChoice?.props.onPress?.();
        });

        expect(screen.findByTestId('settings.server.relayAccess.choice:localOnly')?.props.selected).toBe(false);
        expect(screen.findByTestId('settings.server.relayAccess.choice:lan')?.props.selected).toBe(true);
        expect(screen.findByTestId('settings.server.relayAccess.lanUrl')).toBeTruthy();
    });
});
