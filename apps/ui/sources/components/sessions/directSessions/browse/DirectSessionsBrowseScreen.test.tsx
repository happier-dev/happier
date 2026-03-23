import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const candidatesListSpy = vi.hoisted(() => vi.fn(async () => ({
    ok: true,
    candidates: [
        {
            remoteSessionId: 'codex-session-1',
            title: 'Existing Codex Session',
            updatedAtMs: 1_700_000_000_000,
            activity: 'running',
            details: {
                path: '/tmp/worktree',
                codexBackendMode: 'appServer',
                source: { kind: 'codexHome', home: 'user', homePath: '/tmp/custom-home' },
            },
        },
    ],
    nextCursor: null,
})));
const linkEnsureSpy = vi.hoisted(() => vi.fn(async () => ({
    ok: true,
    sessionId: 'happy-session-1',
    created: true,
})));
const routerPushSpy = vi.hoisted(() => vi.fn());
const modalAlertSpy = vi.hoisted(() => vi.fn());
const profileMock = vi.hoisted(() => ({
    connectedServicesV2: [
        {
            serviceId: 'openai-codex',
            profiles: [{ profileId: 'work', status: 'connected' }],
        },
    ],
}));
const settingsMock = vi.hoisted(() => ({
    connectedServicesProfileLabelByKey: {
        'openai-codex/work': 'Work Profile',
    },
}));
let machinesState = [
    { id: 'machine-1', active: true, metadata: { displayName: 'MacBook Pro', host: 'mbp.local' } },
    { id: 'machine-2', active: false, metadata: { displayName: 'Linux Box', host: 'linux.local' } },
];

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    View: 'View',
                    TextInput: 'TextInput',
                    ActivityIndicator: 'ActivityIndicator',
                    Pressable: 'Pressable',
                    ScrollView: 'ScrollView',
                }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                text: '#000',
                textSecondary: '#666',
                textTertiary: '#444',
                divider: '#ddd',
                surface: '#fff',
                surfaceHigh: '#f5f5f5',
                surfacePressedOverlay: '#eee',
                success: '#0f0',
                accent: { orange: '#f90' },
                modal: { border: '#ddd' },
                shadow: { color: '#000' },
                groupped: { background: '#fff' },
                header: { tint: '#000' },
            },
        },
    });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const routerMock = createExpoRouterMock({
        router: { push: routerPushSpy },
    });
    return routerMock.module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            alert: modalAlertSpy,
        },
    }).module;
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    useAllMachines: () => machinesState,
});
});

vi.mock('@/sync/store/hooks', () => ({
    useProfile: () => profileMock,
    useSettings: () => settingsMock,
    useLocalSetting: (key: string) => key === 'uiItemDensity' ? 'comfortable' : undefined,
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: (props: any) => React.createElement('ItemList', props, props.children),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, props.children),
}));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props, props.children),
}));
vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
    TextInput: (props: any) => React.createElement('TextInput', props, props.children),
}));
vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: 'StatusDot',
}));

vi.mock('@/sync/ops/machineDirectSessions', () => ({
    machineDirectSessionsCandidatesList: candidatesListSpy,
    machineDirectSessionLinkEnsure: linkEnsureSpy,
}));

const directSessionsBrowseScreenModulePromise = import('./DirectSessionsBrowseScreen');

type DropdownTriggerPresentation = Readonly<{
    title: string;
    subtitle?: string;
}>;

type DropdownMenuTestNode = Readonly<{
    props?: {
        itemRowProps?: {
            density?: unknown;
        };
        itemTrigger?: {
            itemProps?: {
                testID?: string;
                density?: unknown;
            };
            showSelectedDetail?: boolean;
            subtitleFormatter?: (presentation: DropdownTriggerPresentation) => string;
        };
        onSelect?: (value: string) => Promise<void> | void;
        selectedId?: string;
    };
}>;

function findDropdownMenuByTriggerTestId(
    screen: { findAllByType: (type: unknown) => DropdownMenuTestNode[] },
    testID: string,
): DropdownMenuTestNode | undefined {
    return screen.findAllByType('DropdownMenu').find((node) => node.props?.itemTrigger?.itemProps?.testID === testID);
}

describe('DirectSessionsBrowseScreen', () => {
    beforeEach(() => {
        machinesState = [
            { id: 'machine-1', active: true, metadata: { displayName: 'MacBook Pro', host: 'mbp.local' } },
            { id: 'machine-2', active: false, metadata: { displayName: 'Linux Box', host: 'linux.local' } },
        ];
        candidatesListSpy.mockClear();
        linkEnsureSpy.mockClear();
        routerPushSpy.mockClear();
        modalAlertSpy.mockClear();
    });

    it('loads candidates for the default machine and provider', async () => {
        const { DirectSessionsBrowseScreen } = await directSessionsBrowseScreenModulePromise;
        const screen = await renderScreen(<DirectSessionsBrowseScreen />);

        await flushHookEffects();

        expect(candidatesListSpy).toHaveBeenCalledWith({
            machineId: 'machine-1',
            providerId: 'codex',
            source: { kind: 'codexHome', home: 'user' },
            limit: 50,
        });

        const machineDropdown = findDropdownMenuByTriggerTestId(screen, 'direct-session-machine-picker-trigger');
        const providerDropdown = findDropdownMenuByTriggerTestId(screen, 'direct-session-provider-picker-trigger');
        const sourceDropdown = findDropdownMenuByTriggerTestId(screen, 'direct-session-source-picker-trigger');

        expect(machineDropdown).toBeTruthy();
        expect(providerDropdown).toBeTruthy();
        expect(sourceDropdown).toBeTruthy();
        const itemGroups = screen.findAllByType('ItemGroup' as any);
        expect(itemGroups[0]?.props.title).toBe('directSessions.browseFiltersTitle');
        expect(machineDropdown?.props?.itemTrigger?.itemProps?.density).toBeUndefined();
        expect(providerDropdown?.props?.itemTrigger?.itemProps?.density).toBeUndefined();
        expect(sourceDropdown?.props?.itemTrigger?.itemProps?.density).toBeUndefined();
        expect(machineDropdown?.props?.itemTrigger?.showSelectedDetail).toBe(false);
        expect(providerDropdown?.props?.itemTrigger?.showSelectedDetail).toBe(false);
        expect(sourceDropdown?.props?.itemTrigger?.showSelectedDetail).toBe(false);
        expect(machineDropdown?.props?.itemRowProps?.density).toBeUndefined();
        expect(providerDropdown?.props?.itemRowProps?.density).toBeUndefined();
        expect(sourceDropdown?.props?.itemRowProps?.density).toBeUndefined();
        expect(typeof machineDropdown?.props?.itemTrigger?.subtitleFormatter).toBe('function');
        expect(typeof providerDropdown?.props?.itemTrigger?.subtitleFormatter).toBe('function');
        expect(typeof sourceDropdown?.props?.itemTrigger?.subtitleFormatter).toBe('function');
        expect(machineDropdown!.props?.itemTrigger?.subtitleFormatter?.({
            title: 'Leeroys-MacBook-Pro',
            subtitle: 'Active now',
        })).toBe('Leeroys-MacBook-Pro · Active now');
        expect(providerDropdown!.props?.itemTrigger?.subtitleFormatter?.({
            title: 'Codex',
            subtitle: undefined,
        })).toBe('Codex');
        expect(sourceDropdown!.props?.itemTrigger?.subtitleFormatter?.({
            title: 'My Codex home',
            subtitle: undefined,
        })).toBe('My Codex home');

        const candidateItem = screen.findByTestId('direct-session-candidate:codex-session-1');
        expect(candidateItem).toBeTruthy();
        expect(candidateItem?.props.title).toBe('Existing Codex Session');
        const candidateSubtitle = candidateItem?.props.subtitle;
        expect(React.isValidElement(candidateSubtitle)).toBe(true);
        const candidateSubtitleLines = React.Children.toArray((candidateSubtitle as any).props.children) as any[];
        expect(String(candidateSubtitleLines[0]?.props?.children)).toContain('directSessions.browseActivityRunningNow');
        expect(String(candidateSubtitleLines[2]?.props?.children)).toContain('/tmp/worktree');
        expect(candidateSubtitleLines.map((line) => String(line?.props?.children ?? '')).join('\n')).not.toContain('codex-session-1');
        expect(candidateItem?.props.density).toBeUndefined();
        expect(candidateItem?.props.rightElement).toBeTruthy();
        const badgeChildren = React.Children.toArray(candidateItem!.props.rightElement.props.children);
        const statusDot = badgeChildren.find((child: any) => child?.type === 'StatusDot');
        const badgeText = badgeChildren.find((child: any) => typeof child?.props?.children === 'string');
        expect(String((badgeText as any)?.props?.children)).toBe('directSessions.browseActivityRunning');
        expect((statusDot as any)?.props?.isPulsing).toBe(true);
    });

    it('shows last-seen metadata and a recent badge for recently active sessions', async () => {
        candidatesListSpy.mockResolvedValueOnce({
            ok: true,
            candidates: [
                {
                    remoteSessionId: 'claude-session-1',
                    title: 'Recent Claude Session',
                    updatedAtMs: 1_700_000_000_000,
                    activity: 'active_recently',
                    details: {
                        path: '/tmp/claude-project',
                        codexBackendMode: 'appServer',
                        source: { kind: 'codexHome', home: 'user', homePath: '/tmp/custom-home' },
                    },
                },
            ],
            nextCursor: null,
        } as any);
        const { DirectSessionsBrowseScreen } = await directSessionsBrowseScreenModulePromise;

        const screen = await renderScreen(<DirectSessionsBrowseScreen />);

        await flushHookEffects();

        const candidateItem = screen.findByTestId('direct-session-candidate:claude-session-1');
        expect(candidateItem).toBeTruthy();
        const candidateSubtitle = candidateItem?.props.subtitle;
        expect(React.isValidElement(candidateSubtitle)).toBe(true);
        const candidateSubtitleLines = React.Children.toArray((candidateSubtitle as any).props.children) as any[];
        expect(String(candidateSubtitleLines[0]?.props?.children)).toContain('ago');
        expect(String(candidateSubtitleLines[2]?.props?.children)).toContain('/tmp/claude-project');
        const badgeChildren = React.Children.toArray(candidateItem!.props.rightElement.props.children);
        const statusDot = badgeChildren.find((child: any) => child?.type === 'StatusDot');
        const badgeText = badgeChildren.find((child: any) => typeof child?.props?.children === 'string');
        expect(String((badgeText as any)?.props?.children)).toBe('directSessions.browseActivityRecent');
        expect((statusDot as any)?.props?.isPulsing).toBe(false);
    });

    it('prefers the first active machine over an earlier offline machine when loading candidates', async () => {
        machinesState = [
            { id: 'machine-offline', active: false, metadata: { displayName: 'Offline Mac', host: 'offline.local' } },
            { id: 'machine-active', active: true, metadata: { displayName: 'Active Mac', host: 'active.local' } },
        ];
        const { DirectSessionsBrowseScreen } = await directSessionsBrowseScreenModulePromise;

        const screen = await renderScreen(<DirectSessionsBrowseScreen />);

        await flushHookEffects();

        expect(candidatesListSpy).toHaveBeenCalledWith({
            machineId: 'machine-active',
            providerId: 'codex',
            source: { kind: 'codexHome', home: 'user' },
            limit: 50,
        });

        const machineDropdown = findDropdownMenuByTriggerTestId(screen, 'direct-session-machine-picker-trigger');
        expect(machineDropdown?.props?.selectedId).toBe('machine-active');
    });

    it('filters loaded candidates with the search field', async () => {
        candidatesListSpy.mockResolvedValueOnce({
            ok: true,
            candidates: [
                {
                    remoteSessionId: 'codex-session-1',
                    title: 'Refactor direct session UX',
                    updatedAtMs: 1_700_000_000_000,
                    activity: 'running',
                    details: { path: '/tmp/happier/dev', codexBackendMode: 'appServer', source: { kind: 'codexHome', home: 'user', homePath: '/tmp/custom-home' } },
                },
                {
                    remoteSessionId: 'codex-session-2',
                    title: 'Investigate opencode startup',
                    updatedAtMs: 1_700_000_000_000,
                    activity: 'idle',
                    details: { path: '/tmp/opencode', codexBackendMode: 'appServer', source: { kind: 'codexHome', home: 'user', homePath: '/tmp/custom-home' } },
                },
            ],
            nextCursor: null,
        });
        const { DirectSessionsBrowseScreen } = await directSessionsBrowseScreenModulePromise;

        const screen = await renderScreen(<DirectSessionsBrowseScreen />);

        await flushHookEffects();

        const searchInput = screen.findByTestId('direct-session-candidates-search-input');
        expect(searchInput).toBeTruthy();
        expect(searchInput!.props.placeholder).toBe('directSessions.browseSearchPlaceholder');

        await act(async () => {
            searchInput!.props.onChangeText('opencode');
        });

        const candidateItem = screen.findByTestId('direct-session-candidate:codex-session-2');
        expect(candidateItem).toBeTruthy();
        expect(candidateItem?.props.testID).toBe('direct-session-candidate:codex-session-2');
    });

    it('links the selected provider session and navigates to the Happier session', async () => {
        const { DirectSessionsBrowseScreen } = await directSessionsBrowseScreenModulePromise;
        const screen = await renderScreen(<DirectSessionsBrowseScreen />);

        await flushHookEffects();

        const candidateItem = screen.findByTestId('direct-session-candidate:codex-session-1');
        expect(candidateItem).toBeTruthy();

        await screen.pressByTestIdAsync('direct-session-candidate:codex-session-1');

        expect(linkEnsureSpy).toHaveBeenCalledWith({
            machineId: 'machine-1',
            providerId: 'codex',
            remoteSessionId: 'codex-session-1',
            titleHint: 'Existing Codex Session',
            directoryHint: '/tmp/worktree',
            codexBackendMode: 'appServer',
            source: { kind: 'codexHome', home: 'user', homePath: '/tmp/custom-home' },
        });
        expect(routerPushSpy).toHaveBeenCalledWith('/session/happy-session-1');
    });

    it('switches to the codex connected-service source before linking', async () => {
        const { DirectSessionsBrowseScreen } = await directSessionsBrowseScreenModulePromise;
        const screen = await renderScreen(<DirectSessionsBrowseScreen />);
        const tree = screen.tree;

        await flushHookEffects();
        candidatesListSpy.mockClear();

        const sourceDropdown = findDropdownMenuByTriggerTestId(screen, 'direct-session-source-picker-trigger');
        expect(sourceDropdown).toBeTruthy();

        await act(async () => {
            await sourceDropdown!.props?.onSelect?.('codex:connected-service:openai-codex:work');
        });

        candidatesListSpy.mockResolvedValueOnce({
            ok: true,
            candidates: [
                {
                    remoteSessionId: 'codex-session-1',
                    title: 'Existing Codex Session',
                    updatedAtMs: 1_700_000_000_000,
                    activity: 'running',
                    details: {
                        path: '/tmp/worktree',
                        codexBackendMode: 'appServer',
                        source: {
                            kind: 'codexHome',
                            home: 'connectedService',
                            connectedServiceId: 'openai-codex',
                            connectedServiceProfileId: 'work',
                            homePath: '/tmp/codex-work-home',
                        } as any,
                    },
                },
            ],
            nextCursor: null,
        });
        await act(async () => {
            tree.update(<DirectSessionsBrowseScreen />);
        });
        await flushHookEffects();

        expect(candidatesListSpy).toHaveBeenCalledWith({
            machineId: 'machine-1',
            providerId: 'codex',
            source: { kind: 'codexHome', home: 'connectedService', connectedServiceId: 'openai-codex', connectedServiceProfileId: 'work' },
            limit: 50,
        });

        const candidateItem = screen.findByTestId('direct-session-candidate:codex-session-1');
        expect(candidateItem).toBeTruthy();

        await screen.pressByTestIdAsync('direct-session-candidate:codex-session-1');

        expect(linkEnsureSpy).toHaveBeenCalledWith({
            machineId: 'machine-1',
            providerId: 'codex',
            remoteSessionId: 'codex-session-1',
            titleHint: 'Existing Codex Session',
            directoryHint: '/tmp/worktree',
            codexBackendMode: 'appServer',
            source: expect.objectContaining({ kind: 'codexHome', home: 'connectedService', connectedServiceId: 'openai-codex', connectedServiceProfileId: 'work' } as any),
        });
    });

    it('recovers when the selected machine disappears from the machine list', async () => {
        const { DirectSessionsBrowseScreen } = await directSessionsBrowseScreenModulePromise;
        const screen = await renderScreen(<DirectSessionsBrowseScreen />);
        const tree = screen.tree;

        await flushHookEffects();

        const machineDropdown = findDropdownMenuByTriggerTestId(screen, 'direct-session-machine-picker-trigger');

        await act(async () => {
            await machineDropdown!.props?.onSelect?.('machine-2');
        });

        expect(candidatesListSpy).toHaveBeenLastCalledWith({
            machineId: 'machine-2',
            providerId: 'codex',
            source: { kind: 'codexHome', home: 'user' },
            limit: 50,
        });

        candidatesListSpy.mockClear();
        machinesState = [{ id: 'machine-1', active: true, metadata: { displayName: 'MacBook Pro', host: 'mbp.local' } }];

        await act(async () => {
            tree.update(<DirectSessionsBrowseScreen key="rerendered" />);
        });
        await flushHookEffects();

        const rerenderedMachineDropdown = findDropdownMenuByTriggerTestId(screen, 'direct-session-machine-picker-trigger');

        expect(rerenderedMachineDropdown).toBeTruthy();
        expect(rerenderedMachineDropdown!.props?.selectedId).toBe('machine-1');
        expect(candidatesListSpy).toHaveBeenCalledWith({
            machineId: 'machine-1',
            providerId: 'codex',
            source: { kind: 'codexHome', home: 'user' },
            limit: 50,
        });
    });

    it('does not allow stale requests to overwrite newer candidate state after rapid filter changes', async () => {
        let slowResolve: ((value: any) => void) | null = null;
        const slowPromise = new Promise((resolve) => {
            slowResolve = resolve;
        });

        candidatesListSpy.mockResolvedValueOnce({
            ok: true,
            candidates: [
                {
                    remoteSessionId: 'initial-session-1',
                    title: 'Initial Session',
                    updatedAtMs: 1_700_000_000_000,
                    activity: 'running',
                    details: { path: '/tmp/initial', codexBackendMode: 'appServer', source: { kind: 'codexHome', home: 'user', homePath: '/tmp/custom-home' } },
                },
            ],
            nextCursor: null,
        });

        candidatesListSpy.mockImplementationOnce(async () => {
            await slowPromise;
            return {
                ok: true,
                candidates: [
                    {
                        remoteSessionId: 'stale-session-1',
                        title: 'Stale Session',
                        updatedAtMs: 1_700_000_000_000,
                        activity: 'idle',
                        details: { path: '/tmp/stale', codexBackendMode: 'appServer', source: { kind: 'codexHome', home: 'user', homePath: '/tmp/custom-home' } },
                    },
                ],
                nextCursor: null,
            };
        });
        const { DirectSessionsBrowseScreen } = await directSessionsBrowseScreenModulePromise;

        const screen = await renderScreen(<DirectSessionsBrowseScreen />);
        const tree = screen.tree;

        await flushHookEffects();

        const machineDropdown = findDropdownMenuByTriggerTestId(screen, 'direct-session-machine-picker-trigger');

        // Switch to machine-2 (this starts a slow request)
        await act(async () => {
            await machineDropdown!.props?.onSelect?.('machine-2');
        });

        // Immediately switch back to machine-1 (this completes quickly)
        candidatesListSpy.mockResolvedValueOnce({
            ok: true,
            candidates: [
                {
                    remoteSessionId: 'fresh-session-1',
                    title: 'Fresh Session',
                    updatedAtMs: 1_700_000_000_000,
                    activity: 'running',
                    details: { path: '/tmp/fresh', codexBackendMode: 'appServer', source: { kind: 'codexHome', home: 'user', homePath: '/tmp/custom-home' } },
                },
            ],
            nextCursor: null,
        });

        await act(async () => {
            await machineDropdown!.props?.onSelect?.('machine-1');
        });

        await flushHookEffects();

        // Now resolve the slow request from machine-2
        slowResolve!({
            ok: true,
            candidates: [
                {
                    remoteSessionId: 'stale-session-1',
                    title: 'Stale Session',
                    updatedAtMs: 1_700_000_000_000,
                    activity: 'idle',
                    details: { path: '/tmp/stale', codexBackendMode: 'appServer' },
                },
            ],
            nextCursor: null,
        });
        await flushHookEffects();

        // The displayed candidates should be from machine-1, not the stale machine-2 request
        const candidateItem = screen.findByTestId('direct-session-candidate:fresh-session-1');
        expect(candidateItem).toBeTruthy();
        expect(candidateItem?.props.title).toBe('Fresh Session');
        expect(candidateItem?.props.testID).toBe('direct-session-candidate:fresh-session-1');
    });
});
