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
    maxWidthCap?: number;
    children?: ((params: { maxHeight: number }) => React.ReactNode) | React.ReactNode;
};

type ActionLike = { id?: unknown; label?: unknown; onPress?: () => void };
type ActionListSectionProps = {
    actions?: ActionLike[];
};

type DropdownMenuCaptureProps = {
    items?: Array<{ id?: string; title?: string; subtitle?: string }>;
    selectedId?: string | null;
    matchTriggerWidth?: boolean;
    maxWidthCap?: number;
    overlayStyle?: unknown;
    itemTrigger?: { title?: string; subtitle?: string };
    onSelect?: (itemId: string) => void;
};

const capture = vi.hoisted(() => ({
    popoverProps: null as PopoverCaptureProps | null,
    actionSections: [] as ActionListSectionProps[],
    dropdownMenuProps: [] as DropdownMenuCaptureProps[],
    reset() {
        this.popoverProps = null;
        this.actionSections = [];
        this.dropdownMenuProps = [];
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

const syncMocks = vi.hoisted(() => ({
    retryNow: vi.fn(),
}));

const settingsState = vi.hoisted(() => ({
    serverSelectionGroups: [] as Array<{ id: string; name: string; serverIds: string[]; presentation: 'grouped' | 'flat-with-badge' }>,
    serverSelectionActiveTargetKind: null as 'server' | 'group' | null,
    serverSelectionActiveTargetId: null as string | null,
}));

const connectionState = vi.hoisted(() => ({
    socketStatus: 'connected' as 'connected' | 'connecting' | 'disconnected' | 'error',
    syncError: null as null | { message: string; retryable?: boolean; kind?: string; at?: number },
    lastSyncAt: null as number | null,
}));

const connectionHealthState = vi.hoisted(() => ({
    kind: 'no_machine' as
        | 'healthy'
        | 'connecting'
        | 'server_error'
        | 'server_unreachable'
        | 'auth_required'
        | 'no_machine'
        | 'machine_offline'
        | 'machine_not_ready',
    color: '#ff9900',
    isPulsing: false,
    statusLabelKey: 'status.actionRequired',
    machineLabelKey: 'newSession.noMachinesFound',
    endpointStatus: 'online' as 'idle' | 'offline' | 'connecting' | 'online' | 'auth_failed' | 'shutting_down',
    machineCount: 0,
    onlineCount: 0,
    hasUnknownMachines: false,
    primaryMachineLabel: null as string | null,
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
                    surface: '#000000',
                    surfaceHigh: '#111111',
                    divider: '#222222',
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
            useSocketStatus: () => ({ status: connectionState.socketStatus }),
            useSyncError: () => connectionState.syncError,
            useLastSyncAt: () => connectionState.lastSyncAt,
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

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: DropdownMenuCaptureProps) => {
        capture.dropdownMenuProps.push(props);
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
    sync: { retryNow: syncMocks.retryNow },
}));

vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    switchConnectionToActiveServer: connectionMocks.switchConnectionToActiveServer,
}));

vi.mock('@/components/navigation/connectionStatus/useConnectionHealth', () => ({
    useConnectionHealth: () => connectionHealthState,
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

function getActions(): ActionLike[] {
    return capture.actionSections.flatMap((section) => section.actions ?? []);
}

function findAction(id: string): ActionLike | undefined {
    return getActions().find((action) => action.id === id);
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
    syncMocks.retryNow.mockReset();
    tokenStorageMock.getCredentialsForServerUrl.mockReset();
    tokenStorageMock.getCredentialsForServerUrl.mockResolvedValue({ token: 'scoped-token', secret: 'scoped-secret' });
    routerMocks.push.mockReset();
    routerMocks.replace.mockReset();
    settingsState.serverSelectionGroups = [];
    settingsState.serverSelectionActiveTargetKind = null;
    settingsState.serverSelectionActiveTargetId = null;
    connectionState.socketStatus = 'connected';
    connectionState.syncError = null;
    connectionState.lastSyncAt = null;
    connectionHealthState.kind = 'no_machine';
    connectionHealthState.color = '#ff9900';
    connectionHealthState.isPulsing = false;
    connectionHealthState.statusLabelKey = 'status.actionRequired';
    connectionHealthState.machineLabelKey = 'newSession.noMachinesFound';
    connectionHealthState.endpointStatus = 'online';
    connectionHealthState.machineCount = 0;
    connectionHealthState.onlineCount = 0;
    connectionHealthState.hasUnknownMachines = false;
    connectionHealthState.primaryMachineLabel = null;
});

describe('ConnectionStatusControl (native popover config)', () => {
    it('does not mount the closed popover shell until the trigger opens it', async () => {
        const ConnectionStatusControl = await importConnectionStatusControl();
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));

        expect(capture.popoverProps).toBeNull();

        const trigger = screen.findByProps({ accessibilityRole: 'button' });
        await act(async () => {
            await pressTestInstanceAsync(trigger);
        });

        expect(capture.popoverProps?.open).toBe(true);
    });

    it('toggles the popover when pressing the trigger twice', async () => {
        const ConnectionStatusControl = await importConnectionStatusControl();
        let tree: renderer.ReactTestRenderer | undefined;
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
        tree = screen.tree;

        expect(capture.popoverProps).toBeNull();

        const trigger = screen.findByProps({ accessibilityRole: 'button' });
        await act(async () => {
            await pressTestInstanceAsync(trigger);
        });

        expect(capture.popoverProps?.open).toBe(true);

        capture.popoverProps = null;
        await act(async () => {
            await pressTestInstanceAsync(trigger);
        });

        expect(capture.popoverProps).toBeNull();

        await act(async () => {
            tree?.unmount();
        });
    });

    it('enables a native portal so the menu is not width-constrained to the trigger', async () => {
        const ConnectionStatusControl = await importConnectionStatusControl();
        let tree: renderer.ReactTestRenderer | undefined;
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
        tree = screen.tree;

        const trigger = screen.findByProps({ accessibilityRole: 'button' });
        await act(async () => {
            await pressTestInstanceAsync(trigger);
        });

        expect(capture.popoverProps).toBeTruthy();
        expect(capture.popoverProps?.portal?.web).toBe(true);
        expect(capture.popoverProps?.portal?.native).toBe(true);
        expect(capture.popoverProps?.portal?.matchAnchorWidth).toBe(false);

        await act(async () => {
            tree?.unmount();
        });
    });

    it('uses a wider screen-capped popover width for the sidebar connection details', async () => {
        const ConnectionStatusControl = await importConnectionStatusControl();
        let tree: renderer.ReactTestRenderer | undefined;
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
        tree = screen.tree;

        const trigger = screen.findByProps({ accessibilityRole: 'button' });
        await act(async () => {
            await pressTestInstanceAsync(trigger);
        });

        expect(capture.popoverProps?.maxWidthCap).toBeGreaterThan(400);

        await act(async () => {
            tree?.unmount();
        });
    });

    it('shows server, realtime, and machines rows in the popover', async () => {
        const ConnectionStatusControl = await importConnectionStatusControl();
        let tree: renderer.ReactTestRenderer | undefined;
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
        tree = screen.tree;

        const trigger = screen.findByProps({ accessibilityRole: 'button' });
        await act(async () => {
            await pressTestInstanceAsync(trigger);
        });

        expect(tree!.root.findAllByProps({ testID: 'connection-popover-relay' }).length).toBeGreaterThan(0);
        expect(tree!.root.findAllByProps({ testID: 'connection-popover-realtime' }).length).toBeGreaterThan(0);
        expect(tree!.root.findAllByProps({ testID: 'connection-popover-machines' }).length).toBeGreaterThan(0);
    });

    it('places an icon-only retry action next to the relay status badge when the server is unreachable', async () => {
        connectionHealthState.kind = 'server_unreachable';
        connectionHealthState.color = '#ff0000';
        connectionHealthState.statusLabelKey = 'status.disconnected';
        connectionHealthState.machineLabelKey = 'status.unknown';
        connectionHealthState.endpointStatus = 'offline';

        const ConnectionStatusControl = await importConnectionStatusControl();
        let tree: renderer.ReactTestRenderer | undefined;
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
        tree = screen.tree;

        const trigger = screen.findByProps({ accessibilityRole: 'button' });
        await act(async () => {
            await pressTestInstanceAsync(trigger);
        });

        const retryButton = screen.findByTestId('connection-popover-relay-retry');
        expect(retryButton).toBeTruthy();

        await act(async () => {
            await pressTestInstanceAsync(retryButton);
        });

        expect(syncMocks.retryNow).toHaveBeenCalledTimes(1);

        await act(async () => {
            tree?.unmount();
        });
    });

    it('renders relay switching with a dropdown only when there are more than two targets', async () => {
        const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        const scope = `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        try {
            vi.resetModules();
            const profiles = await import('@/sync/domains/server/serverProfiles');
            const local = profiles.upsertServerProfile({ serverUrl: 'https://local.example.test', name: 'Local' });
            const company = profiles.upsertServerProfile({ serverUrl: 'https://company.example.test', name: 'Company' });
            profiles.setActiveServerId(local.id, { scope: 'device' });
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

            await vi.waitFor(() => {
                expect(tokenStorageMock.getCredentialsForServerUrl).toHaveBeenCalledWith('https://local.example.test', { serverId: local.id });
                expect(tokenStorageMock.getCredentialsForServerUrl).toHaveBeenCalledWith('https://company.example.test', { serverId: company.id });
            });

            const trigger = screen.findByProps({ accessibilityRole: 'button' });
            await act(async () => {
                await pressTestInstanceAsync(trigger);
            });

            const latestDropdown = capture.dropdownMenuProps.at(-1);
            const dropdownTitles = (latestDropdown?.items ?? []).map((item) => item.title);
            const actionLabels = getActionLabels();

            expect(dropdownTitles.some((title) => String(title).toLowerCase().includes('company'))).toBe(true);
            expect(dropdownTitles.some((title) => String(title).toLowerCase().includes('dev group'))).toBe(true);
            expect(latestDropdown?.items?.some((item) => item.id === 'connection-popover-manage-relay')).toBe(false);
            expect(latestDropdown?.selectedId).toBeTruthy();
            expect(latestDropdown?.itemTrigger).toMatchObject({
                title: expect.stringContaining('Local'),
                subtitle: expect.stringContaining('local.example.test'),
            });
            expect(latestDropdown?.overlayStyle).toBeUndefined();
            expect(actionLabels.some((label) => label.toLowerCase().includes('company'))).toBe(false);
            expect(actionLabels.some((label) => label.toLowerCase().includes('dev group'))).toBe(false);

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

    it('opens relay settings from the relay section gear action', async () => {
        const ConnectionStatusControl = await importConnectionStatusControl();

        let tree: renderer.ReactTestRenderer | undefined;
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
        tree = screen.tree;

        const trigger = screen.findByProps({ accessibilityRole: 'button' });
        await act(async () => {
            await pressTestInstanceAsync(trigger);
        });

        const settingsButton = screen.findByProps({ testID: 'connection-popover-relay-settings' });
        expect(settingsButton).toBeTruthy();

        await act(async () => {
            await pressTestInstanceAsync(settingsButton);
        });

        expect(routerMocks.push).toHaveBeenCalledWith('/settings/server');

        await act(async () => {
            tree?.unmount();
        });
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
            expect(capture.dropdownMenuProps).toHaveLength(0);
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
            const company = profiles.upsertServerProfile({ serverUrl: 'https://company.example.test', name: 'Company' });
            const ConnectionStatusControl = await importConnectionStatusControl();

            let tree: renderer.ReactTestRenderer | undefined;
            const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
            tree = screen.tree;

            const trigger = screen.findByProps({ accessibilityRole: 'button' });
            await act(async () => {
                await pressTestInstanceAsync(trigger);
            });

            const companyItem = findAction(`target-use-server-${company.id}`);
            expect(companyItem).toBeTruthy();

            await act(async () => {
                companyItem?.onPress?.();
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

    it('uses stable server identity ids for relay switch actions', async () => {
        const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        const scope = `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        try {
            vi.resetModules();
            const profiles = await import('@/sync/domains/server/serverProfiles');
            const company = profiles.upsertServerProfile({ serverUrl: 'https://company.example.test', name: 'Company' });
            profiles.setServerProfileIdentityForUrl(company.serverUrl, 'srv_identity_company');
            const ConnectionStatusControl = await importConnectionStatusControl();

            let tree: renderer.ReactTestRenderer | undefined;
            const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
            tree = screen.tree;

            const trigger = screen.findByProps({ accessibilityRole: 'button' });
            await act(async () => {
                await pressTestInstanceAsync(trigger);
            });

            const companyItem = findAction('target-use-server-srv_identity_company');
            expect(companyItem).toBeTruthy();

            await act(async () => {
                companyItem?.onPress?.();
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

    it('selects the active server row when saved target settings point at a previous server', async () => {
        const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        const scope = `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        try {
            vi.resetModules();
            const profiles = await import('@/sync/domains/server/serverProfiles');
            const company = profiles.upsertServerProfile({ serverUrl: 'https://company.example.test', name: 'Company' });
            const defaultServer = profiles.listServerProfiles().find((profile) => profile.id !== company.id);
            expect(defaultServer).toBeTruthy();
            profiles.setActiveServerId(company.id, { scope: 'device' });
            settingsState.serverSelectionActiveTargetKind = 'server';
            settingsState.serverSelectionActiveTargetId = defaultServer!.id;

            const ConnectionStatusControl = await importConnectionStatusControl();

            let tree: renderer.ReactTestRenderer | undefined;
            const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
            tree = screen.tree;

            const trigger = screen.findByProps({ accessibilityRole: 'button' });
            await act(async () => {
                await pressTestInstanceAsync(trigger);
            });

            expect(findAction(`target-use-server-${defaultServer!.id}`)).toBeTruthy();
            expect(findAction(`target-use-server-${company.id}`)).toBeTruthy();

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
            const company = profiles.upsertServerProfile({ serverUrl: 'https://company.example.test', name: 'Company' });
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

            const companyItem = findAction(`target-use-server-${company.id}`);
            expect(companyItem).toBeTruthy();

            await act(async () => {
                companyItem?.onPress?.();
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

            const latestDropdown = capture.dropdownMenuProps.at(-1);
            const groupItem = latestDropdown?.items?.find((item) => item.id === 'target-use-group-grp-one');
            expect(groupItem).toBeTruthy();

            await act(async () => {
                latestDropdown?.onSelect?.(groupItem?.id ?? '');
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
                getActions().flatMap((action) => typeof action.id === 'string' ? [action.id] : []),
            );
            expect(Array.from(actionIds).some((id) => id.startsWith('server-use-') && id.endsWith('-tab'))).toBe(false);
            expect(Array.from(actionIds).some((id) => id.startsWith('server-use-') && id.endsWith('-device'))).toBe(false);
            expect(Array.from(actionIds).some((id) => id.startsWith('target-use-server-'))).toBe(true);
            expect(Array.from(actionIds).some((id) => id === 'server-switch-tab')).toBe(false);
            expect(Array.from(actionIds).some((id) => id === 'server-switch-device')).toBe(false);
            expect(actionIds.has('connection-popover-manage-relay')).toBe(false);

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

    it('shows a retry CTA and sanitized error text inside the popover for retryable connection failures', async () => {
        connectionState.syncError = { message: 'xhr poll error', retryable: true, kind: 'unknown', at: Date.now() };

        const ConnectionStatusControl = await importConnectionStatusControl();
        let tree: renderer.ReactTestRenderer | undefined;
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
        tree = screen.tree;

        const trigger = screen.findByProps({ accessibilityRole: 'button' });
        await act(async () => {
            await pressTestInstanceAsync(trigger);
        });

        const joined = screen.getTextContent();
        expect(joined).toContain('Connection error');
        expect(joined).not.toContain('xhr poll error');
        expect(joined).toContain('common.retry');

        await act(async () => {
            tree?.unmount();
        });
    });

    it('shows a restore-account CTA inside the popover for auth failures', async () => {
        connectionState.syncError = { message: 'Forbidden', retryable: false, kind: 'auth', at: Date.now() };

        const ConnectionStatusControl = await importConnectionStatusControl();
        let tree: renderer.ReactTestRenderer | undefined;
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
        tree = screen.tree;

        const trigger = screen.findByProps({ accessibilityRole: 'button' });
        await act(async () => {
            await pressTestInstanceAsync(trigger);
        });

        expect(screen.getTextContent()).toContain('connect.restoreAccount');

        await act(async () => {
            tree?.unmount();
        });
    });

    it('does not show relay unknown when endpoint connectivity is idle but the connection is otherwise healthy', async () => {
        connectionHealthState.kind = 'healthy';
        connectionHealthState.color = '#00ff00';
        connectionHealthState.statusLabelKey = 'status.connected';
        connectionHealthState.machineLabelKey = 'status.online';
        connectionHealthState.endpointStatus = 'idle';
        connectionHealthState.machineCount = 1;
        connectionHealthState.onlineCount = 1;
        connectionHealthState.primaryMachineLabel = 'mbp';
        connectionState.socketStatus = 'connected';

        const ConnectionStatusControl = await importConnectionStatusControl();
        let tree: renderer.ReactTestRenderer | undefined;
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));
        tree = screen.tree;

        const trigger = screen.findByProps({ accessibilityRole: 'button' });
        await act(async () => {
            await pressTestInstanceAsync(trigger);
        });

        const joined = screen.getTextContent();
        expect(joined).not.toContain('status.unknown');
        expect(joined.match(/status\.connected/g)?.length ?? 0).toBeGreaterThanOrEqual(2);

        await act(async () => {
            tree?.unmount();
        });
    });
});
