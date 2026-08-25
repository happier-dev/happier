import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createExpoRouterMock, renderScreen, standardCleanup } from '@/dev/testkit';
import type { PendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent.shared';

const expoRouterMock = createExpoRouterMock({
    router: {
        push: vi.fn(),
        replace: vi.fn(),
    },
});
const relayDriftBannerMock = vi.hoisted(() => vi.fn());
const tauriDesktopState = vi.hoisted(() => ({ value: false }));
vi.mock('expo-router', () => expoRouterMock.module);
vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => tauriDesktopState.value,
}));

let isAuthenticated = false;
let activeServerSnapshot = {
    serverId: 'relay-1',
    serverUrl: 'https://relay.example.test/',
    generation: 1,
};
const activeServerListeners = new Set<() => void>();
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated,
    }),
}));

const setPendingSetupIntentMock = vi.fn<(value: PendingSetupIntent) => void>();
const getPendingSetupIntentMock = vi.fn<() => PendingSetupIntent | null>(() => null);
const clearPendingSetupIntentMock = vi.fn();
const upsertServerProfileMock = vi.fn((params: {
    serverUrl: string;
    name?: string;
    source?: string;
    replaceEquivalentStoredUrl?: boolean;
}) => ({
    id: `server:${params.serverUrl}`,
    serverUrl: params.serverUrl,
}));
type MockServerProfile = Readonly<{
    id: string;
    name: string;
    serverUrl: string;
    createdAt: number;
    updatedAt: number;
    lastUsedAt: number;
    serverIdentityId?: string | null;
}>;
function createMockServerProfile(
    overrides: Pick<MockServerProfile, 'id' | 'name' | 'serverUrl'> & Partial<MockServerProfile>,
): MockServerProfile {
    return {
        createdAt: 0,
        updatedAt: 0,
        lastUsedAt: 0,
        ...overrides,
    };
}
const listServerProfilesMock = vi.fn<() => MockServerProfile[]>(() => ([
    {
        id: 'relay-1',
        name: 'Relay One',
        serverUrl: 'https://relay.example.test',
        createdAt: 0,
        updatedAt: 0,
        lastUsedAt: 0,
    },
    {
        id: 'relay-2',
        name: 'Relay Two',
        serverUrl: 'https://second-relay.example.test',
        createdAt: 0,
        updatedAt: 0,
        lastUsedAt: 0,
    },
]));
const setActiveServerIdMock = vi.fn((id: string, _opts?: { scope: 'tab' | 'device' }) => {
    const nextProfile = listServerProfilesMock().find((profile) => profile.id === id);
    if (!nextProfile) {
        return;
    }
    activeServerSnapshot = {
        serverId: nextProfile.id,
        serverUrl: `${nextProfile.serverUrl}/`,
        generation: activeServerSnapshot.generation + 1,
    };
    for (const listener of activeServerListeners) {
        listener();
    }
});
vi.mock('@/sync/domains/pending/pendingSetupIntent', () => ({
    setPendingSetupIntent: (value: PendingSetupIntent) => setPendingSetupIntentMock(value),
    getPendingSetupIntent: () => getPendingSetupIntentMock(),
    clearPendingSetupIntent: () => clearPendingSetupIntentMock(),
}));
vi.mock('@/sync/domains/server/serverProfiles', () => ({
    upsertServerProfile: (params: {
        serverUrl: string;
        name?: string;
        source?: string;
        replaceEquivalentStoredUrl?: boolean;
    }) => upsertServerProfileMock(params),
    listServerProfiles: () => listServerProfilesMock(),
    resolveServerProfileScopeId: (profile: { id: string; serverIdentityId?: string | null }) => profile.serverIdentityId ?? profile.id,
    setActiveServerId: (id: string, opts: { scope: 'tab' | 'device' }) => setActiveServerIdMock(id, opts),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => activeServerSnapshot,
    setActiveServer: (params: { serverId: string; scope?: 'tab' | 'device' }) =>
        setActiveServerIdMock(params.serverId, { scope: params.scope ?? 'device' }),
    subscribeActiveServer: (listener: () => void) => {
        activeServerListeners.add(listener);
        return () => {
            activeServerListeners.delete(listener);
        };
    },
}));

vi.mock('@/sync/domains/server/serverConfig', () => ({
    validateServerUrl: (value: string) => ({ valid: value.trim().length > 0 }),
}));

vi.mock('@/components/navigation/shell/HomeHeader', () => ({
    HomeHeaderNotAuth: () => null,
}));

vi.mock('@/components/onboarding/unauthShell', async () => {
    const React = await import('react');
    return {
        UnauthenticatedSplitShell: (props: {
            children?: React.ReactNode;
            stepId: string;
            isWelcomeStep: boolean;
            allowMobileBrandHero?: boolean;
            onOpenRelayCustomFlow: () => void;
            onBrandHeroGetStarted: () => void;
            onBack?: () => void;
        }) =>
            React.createElement(
                'UnauthenticatedSplitShell',
                {
                    stepId: props.stepId,
                    isWelcomeStep: props.isWelcomeStep,
                    allowMobileBrandHero: props.allowMobileBrandHero,
                    hasBack: typeof props.onBack === 'function',
                    testID: `unauth-shell-route-${props.stepId}`,
                },
                props.children,
            ),
    };
});

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, title }: { children?: React.ReactNode; title?: React.ReactNode }) =>
        React.createElement('ItemGroup', { title }, children),
}));
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

vi.mock('@/components/settings/machines/MachineSetupFlowScreen', () => ({
    MachineSetupFlowScreen: (props: Record<string, unknown>) => React.createElement('MachineSetupFlowScreen', props),
}));
vi.mock('@/components/settings/server/localControl/LocalRelayRuntimeControlSection', () => ({
    LocalRelayRuntimeControlSection: (props: Record<string, unknown>) => React.createElement('LocalRelayRuntimeControlSection', props),
}));
vi.mock('@/components/settings/server/localControl/LocalTailscaleSecureAccessSection', () => ({
    LocalTailscaleSecureAccessSection: (props: Record<string, unknown>) => React.createElement('LocalTailscaleSecureAccessSection', props),
}));
vi.mock('@/components/settings/server/useRelayDriftBanner', () => ({
    useRelayDriftBanner: () => relayDriftBannerMock(),
}));
vi.mock('@/components/settings/server/RelayDriftActionCard', () => ({
    RelayDriftActionCard: (props: Record<string, unknown>) => React.createElement('RelayDriftActionCard', props),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

describe('/setup route', () => {
    beforeEach(() => {
        isAuthenticated = false;
        tauriDesktopState.value = true;
        activeServerSnapshot = {
            serverId: 'relay-1',
            serverUrl: 'https://relay.example.test/',
            generation: 1,
        };
        activeServerListeners.clear();
        getPendingSetupIntentMock.mockReset();
        getPendingSetupIntentMock.mockReturnValue(null);
        setPendingSetupIntentMock.mockReset();
        clearPendingSetupIntentMock.mockReset();
        upsertServerProfileMock.mockReset();
        listServerProfilesMock.mockReset();
        listServerProfilesMock.mockReturnValue([
            {
                id: 'relay-1',
                name: 'Relay One',
                serverUrl: 'https://relay.example.test',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
            },
            {
                id: 'relay-2',
                name: 'Relay Two',
                serverUrl: 'https://second-relay.example.test',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
            },
        ]);
        setActiveServerIdMock.mockReset();
        relayDriftBannerMock.mockReset();
        relayDriftBannerMock.mockReturnValue(null);
        expoRouterMock.state.router.setParams({ openCustom: undefined });
        expoRouterMock.spies.setParams.mockReset();
        expoRouterMock.spies.replace.mockReset();
        expoRouterMock.spies.push.mockReset();
    });

    afterEach(() => {
        standardCleanup();
    });

    function requireButton(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) {
        const button = screen.findByTestId(testID);
        if (!button) {
            throw new Error(`Unable to find button "${testID}"`);
        }
        return button;
    }

    it('hides the setup nested stack header so the unauth shell owns chrome', async () => {
        const SetupLayout = (await import('@/app/(app)/setup/_layout')).default;
        const screen = await renderScreen(React.createElement(SetupLayout));

        const indexScreen = screen.findAllByType('StackScreen' as never).find((entry) => entry.props.name === 'index');
        expect(indexScreen?.props.options).toEqual(expect.objectContaining({
            headerShown: false,
        }));
    });

    it('stores a pending setup intent and routes into auth when continue is pressed', async () => {
        const Screen = (await import('@/app/(app)/setup/index')).default;
        const screen = await renderScreen(React.createElement(Screen));

        const button = requireButton(screen, 'setup.continueToAuth');

        await act(async () => {
            const handler = button.props.action ?? button.props.onPress;
            await handler?.();
        });

        expect(setPendingSetupIntentMock).toHaveBeenCalledWith({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test',
        });
        expect(expoRouterMock.spies.replace).toHaveBeenCalledWith('/');
    });

    it('renders the pre-auth setup route inside the unauthenticated split shell without mobile hero', async () => {
        const Screen = (await import('@/app/(app)/setup/index')).default;
        const screen = await renderScreen(React.createElement(Screen));

        const shell = screen.findByTestId('unauth-shell-route-setup-pre-auth');
        expect(shell).toBeTruthy();
        expect(shell?.props.stepId).toBe('setup-pre-auth');
        expect(shell?.props.isWelcomeStep).toBe(false);
        expect(shell?.props.allowMobileBrandHero).toBe(false);
        expect(shell?.props.hasBack).toBe(true);
        expect(screen.findByTestId('setup.preAuth.intro')).toBeNull();
    });

    it('opens the custom relay form immediately when requested by the welcome footer entry', async () => {
        expoRouterMock.state.router.setParams({ openCustom: '1' });
        expoRouterMock.spies.setParams.mockReset();

        const Screen = (await import('@/app/(app)/setup/index')).default;
        const screen = await renderScreen(React.createElement(Screen));

        expect(screen.findByTestId('setup.customRelayUrl')).toBeTruthy();
        expect(screen.findByTestId('setup.customRelayName')).toBeTruthy();
        expect(screen.findByTestId('setup.addRelay')).toBeTruthy();
    });

    it('omits the active relay from saved relay choices because it is already shown as selected', async () => {
        const Screen = (await import('@/app/(app)/setup/index')).default;
        const screen = await renderScreen(React.createElement(Screen));

        expect(screen.findByTestId('setup.currentRelay')).toBeTruthy();
        expect(screen.findByTestId('setup.savedRelay.relay-1')).toBeNull();
        expect(screen.findByTestId('setup.savedRelay.relay-2')).toBeTruthy();
    });

    it('expands the custom relay fields directly inside the different-relay action group', async () => {
        expoRouterMock.state.router.setParams({ openCustom: '1' });
        const Screen = (await import('@/app/(app)/setup/index')).default;
        const screen = await renderScreen(React.createElement(Screen));

        const groups = screen.tree.findAllByType('ItemGroup' as never);
        const collectTestIds = (node: unknown): string[] => {
            if (!node || typeof node !== 'object') return [];
            const maybeNode = node as { props?: { testID?: string }; children?: unknown[] };
            return [
                ...(maybeNode.props?.testID ? [maybeNode.props.testID] : []),
                ...((maybeNode.children ?? []).flatMap(collectTestIds)),
            ];
        };

        const customRelayGroup = groups.find((group) => collectTestIds(group).includes('setup.changeRelay'));
        const customRelayIds = collectTestIds(customRelayGroup);
        const changeRelayRow = screen.findByTestId('setup.changeRelay');

        expect(customRelayIds).toContain('setup.customRelayUrl');
        expect(customRelayIds).toContain('setup.customRelayName');
        expect(customRelayIds).toContain('setup.addRelay');
        expect((changeRelayRow?.props.rightElement as { props?: { name?: string } } | undefined)?.props?.name).toBe('caret-down');
    });

    it('does not wrap the post-auth setup route in the unauthenticated split shell', async () => {
        isAuthenticated = true;
        const Screen = (await import('@/app/(app)/setup/index')).default;
        const screen = await renderScreen(React.createElement(Screen));

        expect(screen.findAllByType('UnauthenticatedSplitShell' as never)).toHaveLength(0);
        expect(screen.findByTestId('setup.postAuth')).toBeTruthy();
    });

    it('does not show local relay runtime controls before auth (setup remains relay-choice only)', async () => {
        const Screen = (await import('@/app/(app)/setup/index')).default;
        const screen = await renderScreen(React.createElement(Screen));

        expect(screen.findAllByType('LocalRelayRuntimeControlSection' as never)).toHaveLength(0);
        expect(screen.findByTestId('setup.continueWithLocalRelay')).toBeNull();
    });

    it('treats adding a custom relay like an onboarding relay choice and continues to auth', async () => {
        upsertServerProfileMock.mockImplementationOnce((params) => ({
            id: 'server-added',
            name: params.name ?? params.serverUrl,
            serverUrl: params.serverUrl,
        }));

        const Screen = (await import('@/app/(app)/setup/index')).default;
        const screen = await renderScreen(React.createElement(Screen));

        await screen.pressByTestIdAsync('setup.changeRelay');
        await act(async () => {
            screen.changeTextByTestId('setup.customRelayUrl', 'https://relay.custom.test/');
            screen.changeTextByTestId('setup.customRelayName', 'My Relay');
        });

        await screen.pressByTestIdAsync('setup.addRelay');

        expect(upsertServerProfileMock).toHaveBeenCalledWith({
            serverUrl: 'https://relay.custom.test',
            name: 'My Relay',
            source: 'manual',
            replaceEquivalentStoredUrl: true,
        });
        expect(setActiveServerIdMock).toHaveBeenCalledWith('server-added', { scope: 'device' });
        expect(setPendingSetupIntentMock).toHaveBeenCalledWith({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.custom.test',
        });
        expect(expoRouterMock.spies.replace).toHaveBeenCalledWith('/');
    });

    it('lets the user switch to another saved relay without leaving setup', async () => {
        const Screen = (await import('@/app/(app)/setup/index')).default;
        const screen = await renderScreen(React.createElement(Screen));

        const relayRows = screen.findAllByType('Item' as never);
        const targetRow = relayRows.find((entry) => entry.props.testID === 'setup.savedRelay.relay-2');
        if (!targetRow) {
            throw new Error('Expected saved relay row for relay-2');
        }

        await act(async () => {
            await targetRow.props.onPress?.();
        });

        const continueButton = requireButton(screen, 'setup.continueToAuth');
        await act(async () => {
            const handler = continueButton.props.action ?? continueButton.props.onPress;
            await handler?.();
        });

        expect(setActiveServerIdMock).toHaveBeenCalledWith('relay-2', { scope: 'device' });
        expect(setPendingSetupIntentMock).toHaveBeenCalledWith({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://second-relay.example.test',
        });
        expect(expoRouterMock.spies.push).not.toHaveBeenCalledWith('/settings/server');
    });

    it('activates saved identity-backed relays by canonical scope id', async () => {
        listServerProfilesMock.mockReturnValue([
            createMockServerProfile({
                id: 'relay-1',
                name: 'Relay One',
                serverUrl: 'https://relay.example.test',
            }),
            createMockServerProfile({
                id: 'localhost-18829',
                serverIdentityId: 'srv_identity_setup',
                name: 'Local Dev',
                serverUrl: 'https://local.example.test',
            }),
        ]);
        const Screen = (await import('@/app/(app)/setup/index')).default;
        const screen = await renderScreen(React.createElement(Screen));

        const relayRows = screen.findAllByType('Item' as never);
        const targetRow = relayRows.find((entry) => entry.props.testID === 'setup.savedRelay.localhost-18829');
        if (!targetRow) {
            throw new Error('Expected saved relay row for identity-backed profile');
        }

        await act(async () => {
            await targetRow.props.onPress?.();
        });

        expect(setActiveServerIdMock).toHaveBeenCalledWith('srv_identity_setup', { scope: 'device' });
    });

    it('keeps the continue path separate from secondary relay editing controls before auth', async () => {
        const Screen = (await import('@/app/(app)/setup/index')).default;
        const screen = await renderScreen(React.createElement(Screen));

        const groups = screen.tree.findAllByType('ItemGroup' as never);
        const idsInGroup = (group: any) => {
            const children = group?.children;
            const nodes = Array.isArray(children) ? children : children != null ? [children] : [];
            return nodes
                .flat()
                .map((child: any) => child?.props?.testID)
                .filter(Boolean);
        };

        const continueGroup = groups.find((group: any) => idsInGroup(group).includes('setup.continueToAuth'));
        const customRelayGroup = groups.find((group: any) => idsInGroup(group).includes('setup.changeRelay'));
        const discardGroup = groups.find((group: any) => idsInGroup(group).includes('setup.discard'));
        if (!continueGroup || !customRelayGroup || !discardGroup) {
            throw new Error('Expected setup action groups to render');
        }

        expect(idsInGroup(continueGroup)).toEqual(['setup.continueToAuth']);
        expect(idsInGroup(customRelayGroup)).toEqual(['setup.changeRelay']);
        expect(idsInGroup(discardGroup)).toEqual(['setup.discard']);
    });

    it('marks the first-launch onboarding as dismissed when discard is pressed', async () => {
        const Screen = (await import('@/app/(app)/setup/index')).default;
        const screen = await renderScreen(React.createElement(Screen));

        const button = requireButton(screen, 'setup.discard');

        await act(async () => {
            const handler = button.props.action ?? button.props.onPress;
            await handler?.();
        });

        expect(setPendingSetupIntentMock).toHaveBeenCalledWith({
            branch: 'thisComputer',
            phase: 'dismissed',
            relayUrl: 'https://relay.example.test',
        });
        expect(clearPendingSetupIntentMock).not.toHaveBeenCalled();
        expect(expoRouterMock.spies.replace).toHaveBeenCalledWith('/');
    });

    it('does not render local relay/tailscale controls before auth even on desktop', async () => {
        tauriDesktopState.value = true;
        const Screen = (await import('@/app/(app)/setup/index')).default;
        const screen = await renderScreen(React.createElement(Screen));

        expect(screen.findAllByType('LocalRelayRuntimeControlSection' as never)).toHaveLength(0);
        expect(screen.findAllByType('LocalTailscaleSecureAccessSection' as never)).toHaveLength(0);
        expect(screen.findByTestId('setup.continueWithLocalRelay')).toBeNull();
        expect(upsertServerProfileMock).not.toHaveBeenCalled();
    });

    it('marks setup as post-auth, auto-starts local setup, and clears the pending intent after local success', async () => {
        tauriDesktopState.value = true;
        isAuthenticated = true;
        getPendingSetupIntentMock.mockReturnValue({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test',
        });

        const Screen = (await import('@/app/(app)/setup/index')).default;
        const screen = await renderScreen(React.createElement(Screen));

        const machineSetupFlow = screen.findByType('MachineSetupFlowScreen' as never);
        expect(machineSetupFlow.props.autoStartLocalTask).toBe(true);
        expect(machineSetupFlow.props.embedded).toBe(true);

        const items = screen.findAllByType('Item' as never);
        const thisComputer = items.find((entry) => entry.props.testID === 'setup.summary.thisComputer');
        const nextAction = items.find((entry) => entry.props.testID === 'setup.summary.nextAction');

        expect(thisComputer?.props.subtitle).toBe('settings.machineSetupCurrentMachineSubtitle');
        expect(nextAction?.props.subtitle).toBe('settings.machineSetupStageConnect');

        await act(async () => {
            machineSetupFlow.props.onLocalSetupSucceeded?.('machine-1');
        });

        expect(setPendingSetupIntentMock).toHaveBeenCalledWith({
            branch: 'thisComputer',
            phase: 'post_auth',
            relayUrl: 'https://relay.example.test',
        });
        expect(clearPendingSetupIntentMock).toHaveBeenCalledTimes(1);
    });

    it('shows the web-safe post-auth summary when not running in Tauri', async () => {
        tauriDesktopState.value = false;
        isAuthenticated = true;
        getPendingSetupIntentMock.mockReturnValue({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test',
        });

        const Screen = (await import('@/app/(app)/setup/index')).default;
        const screen = await renderScreen(React.createElement(Screen));

        expect(screen.findByTestId('setup.postAuth')).toBeTruthy();
        expect(screen.findByTestId('setup.summary.activeRelay')).toBeTruthy();
        expect(screen.findByTestId('setup.summary.thisComputer')).toBeTruthy();
        expect(screen.findByTestId('setup.summary.nextAction')).toBeTruthy();
        expect(screen.findAllByType('MachineSetupFlowScreen' as never)).toHaveLength(0);
        expect(screen.findByTestId('setup.desktopOnlyNotice')).toBeNull();
    });

    it('resumes provider follow-up for a remote machine after relay adoption auth completes', async () => {
        tauriDesktopState.value = true;
        isAuthenticated = true;
        getPendingSetupIntentMock.mockReturnValue({
            branch: 'remoteMachine',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.remote.example.test',
            machineId: 'machine-remote-1',
        });

        const Screen = (await import('@/app/(app)/setup/index')).default;
        const screen = await renderScreen(React.createElement(Screen));

        const machineSetupFlow = screen.findByType('MachineSetupFlowScreen' as never);
        expect(machineSetupFlow.props.autoStartLocalTask).toBe(false);
        expect(machineSetupFlow.props.initialProviderMachineId).toBe('machine-remote-1');
        expect(machineSetupFlow.props.embedded).toBe(true);

        const items = screen.findAllByType('Item' as never);
        const activeRelay = items.find((entry) => entry.props.testID === 'setup.summary.activeRelay');
        const thisComputer = items.find((entry) => entry.props.testID === 'setup.summary.thisComputer');
        const nextAction = items.find((entry) => entry.props.testID === 'setup.summary.nextAction');

        expect(activeRelay?.props.subtitle).toBe('https://relay.example.test');
        expect(thisComputer?.props.subtitle).toBe('settings.machineSetupSshMachineSubtitle');
        expect(nextAction?.props.subtitle).toBe('settingsProviders.setup.startTitle');
        expect(setPendingSetupIntentMock).toHaveBeenCalledWith({
            branch: 'remoteMachine',
            phase: 'post_auth',
            relayUrl: 'https://relay.remote.example.test',
            machineId: 'machine-remote-1',
        });
    });

    it('lets the user discard the post-auth setup continuation explicitly', async () => {
        tauriDesktopState.value = true;
        isAuthenticated = true;
        getPendingSetupIntentMock.mockReturnValue({
            branch: 'thisComputer',
            phase: 'post_auth',
            relayUrl: 'https://relay.example.test',
        });

        const Screen = (await import('@/app/(app)/setup/index')).default;
        const screen = await renderScreen(React.createElement(Screen));

        const button = requireButton(screen, 'setup.postAuthDiscard');
        await act(async () => {
            const handler = button.props.action ?? button.props.onPress;
            await handler?.();
        });

        expect(clearPendingSetupIntentMock).toHaveBeenCalledTimes(1);
        expect(expoRouterMock.spies.replace).toHaveBeenCalledWith('/');
    });

    it('shows the post-auth readiness summary and relay repair surface when this computer drifts', async () => {
        tauriDesktopState.value = true;
        isAuthenticated = true;
        getPendingSetupIntentMock.mockReturnValue({
            branch: 'thisComputer',
            phase: 'post_auth',
            relayUrl: 'https://relay.example.test',
        });
        relayDriftBannerMock.mockReturnValue({
            kind: 'warning',
            title: 'Your background service is connected to a different Relay',
            description: 'App: relay-a · Background service: relay-b',
            actionLabel: 'Connect background service to this Relay',
            onPress: vi.fn(),
            isRepairStarting: false,
            repairTaskSnapshot: null,
            onCancelRepair: vi.fn(),
        });

        const Screen = (await import('@/app/(app)/setup/index')).default;
        const screen = await renderScreen(React.createElement(Screen));

        const items = screen.findAllByType('Item' as never);
        const activeRelay = items.find((entry) => entry.props.testID === 'setup.summary.activeRelay');
        const thisComputer = items.find((entry) => entry.props.testID === 'setup.summary.thisComputer');
        const nextAction = items.find((entry) => entry.props.testID === 'setup.summary.nextAction');

        expect(activeRelay?.props.subtitle).toBe('https://relay.example.test');
        expect(thisComputer?.props.subtitle).toBe('Your background service is connected to a different Relay');
        expect(nextAction?.props.subtitle).toBe('Connect background service to this Relay');
        expect(() => screen.findByType('RelayDriftActionCard' as never)).not.toThrow();
    });
});
