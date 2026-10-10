import * as React from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installConnectionStatusControlCommonModuleMocks } from './connectionStatusControlTestHelpers';


(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

const connectionHealthMock = vi.hoisted(() => ({
    current: {
        kind: 'no_machine',
        tone: 'attention',
        color: '#ff9900',
        isPulsing: false,
        statusLabelKey: 'status.actionRequired',
        machineLabelKey: 'newSession.noMachinesFound',
    } as Record<string, unknown>,
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
                        disconnected: '#999999',
                        error: '#ff0000',
                        default: '#999999',
                    },
                    state: {
                        success: { foreground: '#00ff00', background: '#002200', border: '#005500' },
                        warning: { foreground: '#ff9900', background: '#332000', border: '#664000' },
                        danger: { foreground: '#ff0000', background: '#330000', border: '#660000' },
                        info: { foreground: '#007aff', background: '#001f33', border: '#004f80' },
                        neutral: { foreground: '#666666', background: '#111111', border: '#222222' },
                    },
                    surface: {
                        base: '#000000',
                        inset: '#111111',
                        pressedOverlay: '#222222',
                    },
                    border: {
                        default: '#222222',
                        strong: '#444444',
                    },
                    text: {
                        primary: '#111111',
                        secondary: '#666666',
                    },
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
            useSettings: () => ({}),
            useSettingMutable: () => [null, vi.fn()],
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { replace: vi.fn(), push: vi.fn() },
        }).module;
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: 'StatusDot',
}));

vi.mock('@/components/ui/popover', () => ({
    Popover: () => null,
    PopoverScope: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/sync/domains/server/serverConfig', () => ({
    getServerUrl: () => 'https://cloud.example.test',
}));

const profilesMock = vi.hoisted(() => ({
    current: [{ id: 'srv-1', name: 'Happier Cloud', serverUrl: 'https://cloud.example.test' }] as Array<Record<string, unknown>>,
}));

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => ({
    // The Home name rule (`readServerProfileHomeName`) stays real; only the stored profiles are fixtures.
    ...await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>(),
    areServerProfileIdentifiersEquivalent: (left: unknown, right: unknown) => String(left ?? '').trim() === String(right ?? '').trim(),
    getActiveServerHomeCarrier: () => null,
    getActiveServerId: () => 'srv-1',
    getDeviceDefaultServerId: () => 'srv-1',
    loadHomeViewState: () => null,
    listServerProfiles: () => profilesMock.current,
    resolveServerProfileScopeId: (profile: { id: string; serverIdentityId?: string | null }) => profile.serverIdentityId ?? profile.id,
    setActiveServerId: vi.fn(),
}));

vi.mock('@/hooks/server/useServerProfilesGeneration', () => ({
    useServerProfilesGeneration: () => 1,
}));

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => ({
        serverId: 'srv-1',
        serverUrl: 'https://cloud.example.test',
        runtimeOrigin: 'http://127.0.0.1:4312',
        carrier: 'iroh',
        generation: 1,
    }),
}));

vi.mock('@/hooks/server/useHomeViewSelectionSettings', () => ({
    useHomeViewSelectionSettingsMutable: () => ({
        serverSelectionGroups: [],
        serverSelectionActiveTargetKind: 'server',
        serverSelectionActiveTargetId: 'srv-1',
        setHomeViewSelectionSettings: vi.fn(),
    }),
}));

vi.mock('@/components/settings/server/hooks/useServerAuthStatusByServerId', () => ({
    useServerAuthStatusByServerId: () => ({ 'srv-1': 'signedIn' }),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: true, refreshFromActiveServer: vi.fn(async () => {}) }),
}));

vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return await createTokenStorageModuleMock({
        importOriginal,
        tokenStorage: {
            getCredentialsForServerUrl: vi.fn(async () => ({ token: 't', secret: 's' })),
        },
    });
});

vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    switchConnectionToActiveServer: vi.fn(async () => {}),
    getAppliedActiveServerId: () => 'srv-1',
    subscribeAppliedActiveServer: () => () => undefined,
}));

vi.mock('@/sync/sync', () => ({
    sync: { retryNow: vi.fn() },
}));

vi.mock('@/sync/domains/server/selection/serverSelectionResolver', () => ({
    listServerSelectionTargets: () => [],
}));

vi.mock('@/sync/domains/server/selection/serverSelectionResolution', () => ({
    resolveActiveServerSelectionFromRawSettings: () => ({ activeTarget: { kind: 'server', id: 'srv-1' } }),
}));

vi.mock('@/sync/domains/server/url/serverUrlDisplay', () => ({
    toServerUrlDisplay: (value: string) => value,
}));

vi.mock('@/components/navigation/connectionStatus/useConnectionHealth', () => ({
    useActiveHomeConnectionHealth: () => connectionHealthMock.current,
    useConnectionHealth: () => connectionHealthMock.current,
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    return Object.assign({}, ...(Array.isArray(style) ? style : [style]).filter(Boolean));
}

// The first import transforms the control's whole module graph, which alone can take most of a
// test's timeout on a loaded host. Load it once up front so each test measures only its behaviour.
beforeAll(async () => {
    await import('./ConnectionStatusControl');
}, 240_000);

describe('ConnectionStatusControl (label)', () => {
    it.each([true, false])('names an unnamed Home through the Home label owner with profile available=%s, never by its raw address', async (withProfile) => {
        profilesMock.current = withProfile ? [{ id: 'srv-1', name: '127.0.0.1:53288', serverUrl: 'https://cloud.example.test' }] : [];
        try {
            const { ConnectionStatusControl } = await import('./ConnectionStatusControl');
            const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'header' }));
            const trigger = screen.findByProps({ accessibilityRole: 'button' });
            expect(trigger.props.accessibilityLabel).not.toContain('127.0.0.1');
            expect(trigger.props.accessibilityLabel).toContain('settingsAccount.thisHomeTitle');
            await screen.unmount();
        } finally {
            profilesMock.current = [{ id: 'srv-1', name: 'Happier Cloud', serverUrl: 'https://cloud.example.test' }];
        }
    });

    it('shows the active server name instead of a generic connection status label', async () => {
        const { ConnectionStatusControl } = await import('./ConnectionStatusControl');

        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'header' }));
        const joined = screen.getTextContent();
        expect(joined).toContain('Happier Cloud');
        expect(joined).not.toContain('status.connected');

        const trigger = screen.findByProps({ accessibilityRole: 'button' });
        expect(trigger.props.accessibilityLabel).toBe('Happier Cloud, connectionStatus.summary.connected');
        // Header activation navigates to the existing full-screen Homes surface;
        // only the desktop/sidebar trigger owns an expandable popover state.
        expect(trigger.props.accessibilityState).toBeUndefined();
        expect(flattenStyle(trigger.props.style).minHeight).toBeGreaterThanOrEqual(44);
    });

    // Under a tab title in the phone's 56px header, the status line keeps its 44px target but lays
    // out as one text line (the target reaches into the header's padding), so title and status fit:
    // at full height the block was 62px and pushed "Sessions" above the logo row.
    it('lays the header status line out as one text line while keeping a 44px target', async () => {
        const { ConnectionStatusControl } = await import('./ConnectionStatusControl');
        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'header' }));

        const style = flattenStyle(screen.findByProps({ accessibilityRole: 'button' }).props.style);
        const minHeight = Number(style.minHeight);
        expect(minHeight).toBeGreaterThanOrEqual(44);
        const laidOutHeight = minHeight + Number(style.marginTop ?? 0) + Number(style.marginBottom ?? 0);
        expect(laidOutHeight).toBeLessThanOrEqual(20);
    });

    it('uses a single-line tail ellipsis contract for long sidebar server labels', async () => {
        const { ConnectionStatusControl } = await import('./ConnectionStatusControl');

        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }));

        const trigger = screen.findByProps({ accessibilityRole: 'button' });
        const triggerStyle = flattenStyle(trigger.props.style);
        expect(triggerStyle).toMatchObject({
            flexShrink: 1,
            maxWidth: '100%',
            minWidth: 0,
        });
        expect(triggerStyle.minHeight).toBeGreaterThanOrEqual(24);
        expect(triggerStyle.marginTop).toBe(-6);
        expect(triggerStyle.marginBottom).toBe(-4);
        expect(trigger.props.hitSlop).toBeUndefined();
        expect(triggerStyle.width).toBeUndefined();

        const label = screen.findByType('Text' as any);
        expect(label).toBeTruthy();
        expect(label!.props.numberOfLines).toBe(1);
        expect(label!.props.ellipsizeMode).toBe('tail');
        expect(label!.props.style).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    flexGrow: 0,
                    flexShrink: 1,
                    minWidth: 0,
                }),
            ]),
        );
    });

    it('keeps machine-only attention in details instead of warning on a connected Home', async () => {
        connectionHealthMock.current = {
            kind: 'machine_not_ready',
            tone: 'attention',
            color: '#ff9900',
            isPulsing: false,
            statusLabelKey: 'status.actionRequired',
            machineLabelKey: 'status.online',
        };
        const { ConnectionStatusControl } = await import('./ConnectionStatusControl');
        const { Icon } = await import('@/components/ui/icons/Icon');

        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'header' }));

        const warningCue = screen.findAllByType(Icon).find((node) => node.props.name === 'warning');
        expect(screen.findByProps({ accessibilityRole: 'button' }).props.accessibilityLabel)
            .toBe('Happier Cloud, connectionStatus.summary.connected');
        expect(warningCue).toBeUndefined();
        expect(screen.findByType('StatusDot' as any).props.color).toBe('#00ff00');
    });

    it('shows a warning cue for a Home-level action requirement', async () => {
        connectionHealthMock.current = {
            kind: 'auth_required',
            tone: 'attention',
            color: '#ff9900',
            isPulsing: false,
            statusLabelKey: 'status.actionRequired',
            machineLabelKey: 'status.unknown',
        };
        const { ConnectionStatusControl } = await import('./ConnectionStatusControl');
        const { Icon } = await import('@/components/ui/icons/Icon');

        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'header' }));

        const warningCue = screen.findAllByType(Icon).find((node) => node.props.name === 'warning');
        expect(warningCue).toBeTruthy();
        expect(warningCue!.props.color).toBe('#ff9900');
    });

    it('shows a warning cue for a Home-level connection error', async () => {
        connectionHealthMock.current = {
            kind: 'server_error',
            tone: 'danger',
            color: '#ff0000',
            isPulsing: false,
            statusLabelKey: 'status.error',
            machineLabelKey: 'status.unknown',
        };
        const { ConnectionStatusControl } = await import('./ConnectionStatusControl');
        const { Icon } = await import('@/components/ui/icons/Icon');

        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'header' }));

        const trigger = screen.findByProps({ accessibilityRole: 'button' });
        const warningCue = screen.findAllByType(Icon).find((node) => node.props.name === 'warning');
        expect(trigger.props.accessibilityLabel).toBe('Happier Cloud, connectionStatus.summary.unavailable');
        expect(warningCue).toBeTruthy();
        expect(warningCue!.props.color).toBe('#ff0000');
    });

    it('keeps the healthy connected trigger quiet with no warning cue', async () => {
        connectionHealthMock.current = {
            kind: 'healthy',
            tone: 'positive',
            color: '#00ff00',
            isPulsing: false,
            statusLabelKey: 'status.connected',
            machineLabelKey: 'status.online',
        };
        const { ConnectionStatusControl } = await import('./ConnectionStatusControl');
        const { Icon } = await import('@/components/ui/icons/Icon');

        const screen = await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'header' }));

        const warningCue = screen.findAllByType(Icon).find((node) => node.props.name === 'warning');
        expect(warningCue).toBeUndefined();
        const dot = screen.findByType('StatusDot' as any);
        expect(dot.props.color).toBe('#00ff00');
    });
});
