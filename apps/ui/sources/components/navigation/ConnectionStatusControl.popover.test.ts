import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installConnectionStatusControlCommonModuleMocks } from './connectionStatusControlTestHelpers';


(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

type PopoverCaptureProps = {
    open?: boolean;
    portal?: {
        web?: boolean;
        native?: boolean;
        matchAnchorWidth?: boolean;
    };
    children?: ((params: { maxHeight: number }) => React.ReactNode) | React.ReactNode;
};

type ActionLike = { label?: unknown };
type ActionListSectionProps = {
    actions?: ActionLike[];
};

const capture = vi.hoisted(() => ({
    popoverProps: null as PopoverCaptureProps | null,
    actionSections: [] as ActionListSectionProps[],
    reset() {
        this.popoverProps = null;
        this.actionSections = [];
    },
}));

const authMocks = vi.hoisted(() => ({
    refreshFromActiveServer: vi.fn(async () => {}),
}));

const connectionMocks = vi.hoisted(() => ({
    switchConnectionToActiveServer: vi.fn(async (_params?: unknown) => null),
}));

const modalMocks = vi.hoisted(() => ({
    confirm: vi.fn(async () => true),
}));

const tokenStorageMock = vi.hoisted(() => ({
    getCredentialsForServerUrl: vi.fn<(serverUrl: string) => Promise<{ token: string; secret: string } | null>>(
        async () => ({ token: 'scoped-token', secret: 'scoped-secret' })
    ),
}));

const routerMocks = vi.hoisted(() => ({
    push: vi.fn(),
    replace: vi.fn(),
}));

const settingsState = vi.hoisted(() => ({
    serverSelectionGroups: [] as Array<{ id: string; name: string; serverIds: string[]; presentation: 'grouped' | 'flat-with-badge' }>,
    serverSelectionActiveTargetKind: null as 'server' | 'group' | null,
    serverSelectionActiveTargetId: null as string | null,
}));

installConnectionStatusControlCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: (options: { web?: unknown; default?: unknown; ios?: unknown; android?: unknown }) =>
                    options.web ?? options.default ?? options.ios ?? options.android,
            },
            View: 'View',
            Text: 'Text',
            Pressable: 'Pressable',
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    status: {
                        connected: '#00ff00',
                        connecting: '#ffcc00',
                        actionRequired: '#ff9900',
                        disconnected: '#ff0000',
                        error: '#ff0000',
                        default: '#999999',
                    },
                    text: '#111111',
                    textSecondary: '#666666',
                },
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSocketStatus: () => ({ status: 'connected' }),
            useSyncError: () => null,
            useLastSyncAt: () => null,
            useSettingMutable: (key: keyof typeof settingsState) => [
                settingsState[key],
                (value: unknown) => {
                    (settingsState as Record<string, unknown>)[String(key)] = value;
                },
            ],
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                confirm: modalMocks.confirm,
            },
        }).module;
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { push: routerMocks.push, replace: routerMocks.replace },
        }).module;
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: 'StatusDot',
}));

vi.mock('@/components/ui/lists/ActionListSection', () => ({
    ActionListSection: (props: ActionListSectionProps) => {
        capture.actionSections.push(props);
        return null;
    },
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: (props: { children?: React.ReactNode }) =>
        React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/ui/popover', () => ({
    Popover: (props: PopoverCaptureProps) => {
        capture.popoverProps = props;
        if (!props.open) return null;
        return React.createElement(
            React.Fragment,
            null,
            typeof props.children === 'function' ? props.children({ maxHeight: 520 }) : props.children,
        );
    },
    PopoverScope: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: true, refreshFromActiveServer: authMocks.refreshFromActiveServer }),
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: tokenStorageMock,
}));

vi.mock('@/sync/sync', () => ({
    sync: { retryNow: vi.fn() },
}));

vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    switchConnectionToActiveServer: connectionMocks.switchConnectionToActiveServer,
}));

vi.mock('@/components/navigation/connectionStatus/useConnectionHealth', () => ({
    useConnectionHealth: () => ({
        kind: 'no_machine',
        color: '#ff9900',
        isPulsing: false,
        statusLabelKey: 'status.actionRequired',
        machineLabelKey: 'newSession.noMachinesFound',
    }),
}));

function getActionLabels(): string[] {
    return capture.actionSections.flatMap((section) =>
        (section.actions ?? []).flatMap((action) => {
            if (!action || typeof action !== 'object') return [];
            const label = action.label;
            return typeof label === 'string' ? [label] : [];
        }),
    );
}

async function importConnectionStatusControl() {
    const module = await import('./ConnectionStatusControl');
    return module.ConnectionStatusControl;
}

afterEach(() => {
    capture.reset();
    authMocks.refreshFromActiveServer.mockClear();
    connectionMocks.switchConnectionToActiveServer.mockClear();
    modalMocks.confirm.mockReset();
    tokenStorageMock.getCredentialsForServerUrl.mockReset();
    tokenStorageMock.getCredentialsForServerUrl.mockResolvedValue({ token: 'scoped-token', secret: 'scoped-secret' });
    routerMocks.push.mockReset();
    routerMocks.replace.mockReset();
    settingsState.serverSelectionGroups = [];
    settingsState.serverSelectionActiveTargetKind = null;
    settingsState.serverSelectionActiveTargetId = null;
});

describe('ConnectionStatusControl (native popover config)', () => {
    it('toggles the popover when pressing the trigger twice', async () => {
        const ConnectionStatusControl = await importConnectionStatusControl();
        let tree: renderer.ReactTestRenderer | undefined;
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
        tree = screen.tree;

        expect(capture.popoverProps?.open).toBe(false);

        const trigger = screen.findByProps({ accessibilityRole: 'button' });
        await act(async () => {
            await pressTestInstanceAsync(trigger);
        });

        expect(capture.popoverProps?.open).toBe(true);

        await act(async () => {
            await pressTestInstanceAsync(trigger);
        });

        expect(capture.popoverProps?.open).toBe(false);

        await act(async () => {
            tree?.unmount();
        });
    });

    it('enables a native portal so the menu is not width-constrained to the trigger', async () => {
        const ConnectionStatusControl = await importConnectionStatusControl();
        let tree: renderer.ReactTestRenderer | undefined;
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
        tree = screen.tree;

        expect(capture.popoverProps).toBeTruthy();
        expect(capture.popoverProps?.portal?.web).toBe(true);
        expect(capture.popoverProps?.portal?.native).toBe(true);
        expect(capture.popoverProps?.portal?.matchAnchorWidth).toBe(false);

        await act(async () => {
            tree?.unmount();
        });
    });

    it('shows readiness and machines rows in the popover', async () => {
        const ConnectionStatusControl = await importConnectionStatusControl();
        let tree: renderer.ReactTestRenderer | undefined;
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
        tree = screen.tree;

        const trigger = screen.findByProps({ accessibilityRole: 'button' });
        await act(async () => {
            await pressTestInstanceAsync(trigger);
        });

        const textNodes = tree!.findAllByType('Text' as any);
        const allText = textNodes
            .map((node: any) => String(node.props.children ?? ''))
            .join('\n');

        expect(allText).toContain('profile.status');
        expect(allText).toContain('status.actionRequired');
        expect(allText).toContain('settings.machines');
        expect(allText).toContain('newSession.noMachinesFound');
    });

    it('includes server and group target actions when configured', async () => {
        const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        const scope = `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        try {
            vi.resetModules();
            const profiles = await import('@/sync/domains/server/serverProfiles');
            const local = profiles.upsertServerProfile({ serverUrl: 'https://local.example.test', name: 'Local' });
            const company = profiles.upsertServerProfile({ serverUrl: 'https://company.example.test', name: 'Company' });
            settingsState.serverSelectionGroups = [
                {
                    id: 'grp-dev',
                    name: 'Dev Group',
                    serverIds: [local.id, company.id],
                    presentation: 'grouped',
                },
            ];
            const ConnectionStatusControl = await importConnectionStatusControl();

            let tree: renderer.ReactTestRenderer | undefined;
            const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
            tree = screen.tree;

            const trigger = screen.findByProps({ accessibilityRole: 'button' });
            await act(async () => {
                await pressTestInstanceAsync(trigger);
            });

            const actionLabels = getActionLabels();
            expect(actionLabels.some((label) => label.toLowerCase().includes('company'))).toBe(true);
            expect(actionLabels.some((label) => label.toLowerCase().includes('dev group'))).toBe(true);
            expect(actionLabels.some((label) => label.includes('server.makeDefaultOnDevice'))).toBe(false);
            expect(actionLabels.some((label) => label.toLowerCase().includes('manage servers'))).toBe(false);
            expect(actionLabels.some((label) => label.includes('common.retry'))).toBe(false);
            expect(actionLabels.some((label) => label.includes('settings.account'))).toBe(false);

            await act(async () => {
                tree?.unmount();
            });
        } finally {
            if (previousScope === undefined) {
                delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
            } else {
                process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
            }
        }
    });

    it('shows the active server target row even when there is only one saved server', async () => {
        const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        const scope = `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        try {
            vi.resetModules();
            const profiles = await import('@/sync/domains/server/serverProfiles');
            const local = profiles.upsertServerProfile({ serverUrl: 'https://local.example.test', name: 'Local' });
            profiles.setActiveServerId(local.id, { scope: 'device' });

            const ConnectionStatusControl = await importConnectionStatusControl();

            let tree: renderer.ReactTestRenderer | undefined;
            const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
            tree = screen.tree;

            const trigger = screen.findByProps({ accessibilityRole: 'button' });
            await act(async () => {
                await pressTestInstanceAsync(trigger);
            });

            const actionLabels = getActionLabels();
            expect(actionLabels.some((label) => label.toLowerCase().includes('local'))).toBe(true);

            await act(async () => {
                tree?.unmount();
            });
        } finally {
            if (previousScope === undefined) {
                delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
            } else {
                process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
            }
        }
    });

    it('switches server without reload by using runtime switch handlers', async () => {
        const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        const scope = `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        try {
            vi.resetModules();
            const profiles = await import('@/sync/domains/server/serverProfiles');
            const local = profiles.upsertServerProfile({ serverUrl: 'https://local.example.test', name: 'Local' });
            const company = profiles.upsertServerProfile({ serverUrl: 'https://company.example.test', name: 'Company' });
            profiles.setActiveServerId(local.id, { scope: 'device' });
            const ConnectionStatusControl = await importConnectionStatusControl();

            let tree: renderer.ReactTestRenderer | undefined;
            const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
            tree = screen.tree;

            const trigger = screen.findByProps({ accessibilityRole: 'button' });
            await act(async () => {
                await pressTestInstanceAsync(trigger);
            });

            const switchAction = capture.actionSections
                .flatMap((section) => section.actions ?? [])
                .find((action) => action && typeof action === 'object' && (action as any).id === `target-use-server-${company.id}`) as
                | { onPress?: () => void }
                | undefined;

            expect(switchAction).toBeTruthy();

            await act(async () => {
                switchAction?.onPress?.();
            });

            expect(connectionMocks.switchConnectionToActiveServer).toHaveBeenCalledTimes(1);
            expect(authMocks.refreshFromActiveServer).toHaveBeenCalledTimes(1);

            await act(async () => {
                tree?.unmount();
            });
        } finally {
            if (previousScope === undefined) {
                delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
            } else {
                process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
            }
        }
    });

    it('requires confirmation before switching to a signed-out server target', async () => {
        const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        const scope = `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        try {
            vi.resetModules();
            const profiles = await import('@/sync/domains/server/serverProfiles');
            const local = profiles.upsertServerProfile({ serverUrl: 'https://local.example.test', name: 'Local' });
            const company = profiles.upsertServerProfile({ serverUrl: 'https://company.example.test', name: 'Company' });
            profiles.setActiveServerId(local.id, { scope: 'device' });
            tokenStorageMock.getCredentialsForServerUrl.mockImplementation(async (...args: unknown[]) => {
                const url = String(args[0] ?? '');
                if (url.includes('company.example.test')) return null;
                return { token: 'scoped-token', secret: 'scoped-secret' };
            });
            modalMocks.confirm.mockResolvedValue(false);

            const ConnectionStatusControl = await importConnectionStatusControl();

            let tree: renderer.ReactTestRenderer | undefined;
            const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
            tree = screen.tree;

            const trigger = screen.findByProps({ accessibilityRole: 'button' });
            await act(async () => {
                await pressTestInstanceAsync(trigger);
            });

            const switchAction = capture.actionSections
                .flatMap((section) => section.actions ?? [])
                .find((action) => action && typeof action === 'object' && (action as any).id === `target-use-server-${company.id}`) as
                | { onPress?: () => void }
                | undefined;

            expect(switchAction).toBeTruthy();

            await act(async () => {
                switchAction?.onPress?.();
            });

            expect(modalMocks.confirm).toHaveBeenCalledTimes(1);
            expect(connectionMocks.switchConnectionToActiveServer).not.toHaveBeenCalled();
            expect(authMocks.refreshFromActiveServer).not.toHaveBeenCalled();
            expect(routerMocks.replace).not.toHaveBeenCalled();

            await act(async () => {
                tree?.unmount();
            });
        } finally {
            if (previousScope === undefined) {
                delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
            } else {
                process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
            }
        }
    });

    it('does not update target settings when cancelling a signed-out group switch', async () => {
        const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        const scope = `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        try {
            vi.resetModules();
            const profiles = await import('@/sync/domains/server/serverProfiles');
            const local = profiles.upsertServerProfile({ serverUrl: 'https://local.example.test', name: 'Local' });
            const company = profiles.upsertServerProfile({ serverUrl: 'https://company.example.test', name: 'Company' });
            profiles.setActiveServerId(local.id, { scope: 'device' });

            settingsState.serverSelectionActiveTargetKind = 'server';
            settingsState.serverSelectionActiveTargetId = local.id;
            settingsState.serverSelectionGroups = [
                {
                    id: 'grp-one',
                    name: 'One',
                    serverIds: [company.id],
                    presentation: 'grouped',
                },
            ];

            tokenStorageMock.getCredentialsForServerUrl.mockImplementation(async (...args: unknown[]) => {
                const url = String(args[0] ?? '');
                if (url.includes('company.example.test')) return null;
                return { token: 'scoped-token', secret: 'scoped-secret' };
            });
            modalMocks.confirm.mockResolvedValue(false);

            const ConnectionStatusControl = await importConnectionStatusControl();

            let tree: renderer.ReactTestRenderer | undefined;
            const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
            tree = screen.tree;

            const trigger = screen.findByProps({ accessibilityRole: 'button' });
            await act(async () => {
                await pressTestInstanceAsync(trigger);
            });

            const groupAction = capture.actionSections
                .flatMap((section) => section.actions ?? [])
                .find((action) => action && typeof action === 'object' && (action as any).id === 'target-use-group-grp-one') as
                | { onPress?: () => void }
                | undefined;

            expect(groupAction).toBeTruthy();

            await act(async () => {
                groupAction?.onPress?.();
            });

            expect(modalMocks.confirm).toHaveBeenCalledTimes(1);
            expect(settingsState.serverSelectionActiveTargetKind).toBe('server');
            expect(settingsState.serverSelectionActiveTargetId).toBe(local.id);
            expect(connectionMocks.switchConnectionToActiveServer).not.toHaveBeenCalled();
            expect(authMocks.refreshFromActiveServer).not.toHaveBeenCalled();

            await act(async () => {
                tree?.unmount();
            });
        } finally {
            if (previousScope === undefined) {
                delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
            } else {
                process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
            }
        }
    });

    it('uses target action ids and does not expose legacy scope toggles', async () => {
        const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        const scope = `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        try {
            vi.resetModules();
            const { Platform } = await import('react-native');
            const previousPlatform = Platform.OS;
            (Platform as any).OS = 'web';
            const profiles = await import('@/sync/domains/server/serverProfiles');
            profiles.upsertServerProfile({ serverUrl: 'https://local.example.test', name: 'Local' });
            profiles.upsertServerProfile({ serverUrl: 'https://company.example.test', name: 'Company' });
            const ConnectionStatusControl = await importConnectionStatusControl();

            let tree: renderer.ReactTestRenderer | undefined;
            const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
            tree = screen.tree;

            const trigger = screen.findByProps({ accessibilityRole: 'button' });
            await act(async () => {
                await pressTestInstanceAsync(trigger);
            });

            const actionIds = new Set(
                capture.actionSections.flatMap((section) =>
                    (section.actions ?? []).flatMap((action) => {
                        if (!action || typeof action !== 'object') return [];
                        const id = (action as { id?: unknown }).id;
                        return typeof id === 'string' ? [id] : [];
                    }),
                ),
            );
            expect(Array.from(actionIds).some((id) => id.startsWith('server-use-') && id.endsWith('-tab'))).toBe(false);
            expect(Array.from(actionIds).some((id) => id.startsWith('server-use-') && id.endsWith('-device'))).toBe(false);
            expect(Array.from(actionIds).some((id) => id.startsWith('target-use-server-'))).toBe(true);
            expect(Array.from(actionIds).some((id) => id === 'server-switch-tab')).toBe(false);
            expect(Array.from(actionIds).some((id) => id === 'server-switch-device')).toBe(false);

            (Platform as any).OS = previousPlatform;

            await act(async () => {
                tree?.unmount();
            });
        } finally {
            if (previousScope === undefined) {
                delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
            } else {
                process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
            }
        }
    });
});
