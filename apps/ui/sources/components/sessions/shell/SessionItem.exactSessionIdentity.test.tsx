import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import {
    createModelBackedSessionItemTestComponent,
    type ModelBackedSessionItemTestProps,
} from './sessionItemRowViewModelTestFixture';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// The Copy debug information row action is a development affordance.
(globalThis as typeof globalThis & { __DEV__?: boolean }).__DEV__ = true;

type SessionItemProps = ModelBackedSessionItemTestProps;
type ContextMenuTestInstance = Readonly<{
    props: Readonly<{
        items?: readonly Readonly<{ id?: string }>[];
        onSelect?: (itemId: string) => void | Promise<void>;
    }>;
}>;

const DUPLICATE_SESSION_ID = 'sess_shared_id';

const openForkFlowSpy = vi.hoisted(() => vi.fn());
const copyDebugSpy = vi.hoisted(() => vi.fn(
    async (_information: Readonly<{ text: string; happierSessionLogPath: string | null }>) => true,
));

const themeColors = vi.hoisted(() => ({
    surface: '#fff',
    surfaceSelected: '#eee',
    divider: '#ddd',
    text: '#111',
    textSecondary: '#666',
    textLink: '#07f',
    input: { background: '#f0f0f0' },
    groupped: { background: '#f7f7f7' },
    status: { error: '#f00' },
    button: { primary: { tint: '#fff' } },
}));

installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({ Platform: { OS: 'ios' } });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({ theme: themeColors });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    },
    storage: async () => {
        const { createStorageModuleStub, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
        // The focused Home holds a DIFFERENT Session that happens to share the
        // row's Session ID. Home-local IDs never cross endpoints, so this is a
        // normal multi-Home collision rather than a corrupt cache.
        const focusedHomeSession = {
            id: DUPLICATE_SESSION_ID,
            seq: 9,
            createdAt: 1,
            updatedAt: 2,
            active: true,
            activeAt: 1,
            serverId: 'home-b',
            metadataLayoutVersion: 0,
            metadata: {
                machineId: 'machine-b',
                sessionLogPath: '/home-b/session.log',
                path: '/home-b/project',
            },
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 'online',
        };

        return createStorageModuleStub({
            storage: createStorageStoreMock({
                sessions: { [DUPLICATE_SESSION_ID]: focusedHomeSession } as never,
                machines: {
                    'machine-b': { id: 'machine-b', active: true, metadata: { host: 'home-b-host' } },
                } as never,
                machineListByServerId: {} as never,
                sessionListIndexByServerId: {} as never,
                sessionListRowsByServerId: {} as never,
            }),
            useHasUnreadMessages: () => false,
            useSession: () => null,
            useSessionListMeaningfulActivityAt: () => null,
            useProfile: () => ({
                id: 'u1',
                timestamp: 0,
                firstName: null,
                lastName: null,
                username: null,
                avatar: null,
                linkedProviders: [],
                connectedServices: [],
                connectedServicesV2: [],
                connectedServiceCredentialRevisionsV1: [],
                connectedAccountsV4: [],
                connectedAccountGroupsV4: [],
            }),
        });
    },
});

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Record<string, unknown>) => React.createElement('DropdownMenu', props),
}));
vi.mock('@/components/ui/forms/dropdown/ContextMenu', () => ({
    ContextMenu: (props: Record<string, unknown>) => React.createElement('ContextMenu', props),
}));
vi.mock('react-native-gesture-handler', () => ({
    Swipeable: (props: Record<string, unknown>) => React.createElement('Swipeable', props),
    GestureDetector: (props: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('GestureDetector', props, props.children),
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', Octicons: 'Octicons' }));
// Real `@/constants/Typography` is used: it depends only on the mocked
// `react-native` Platform, and the row corridor renders the meta type role
// at stylesheet-creation time (browser/frame/styles.ts), so a partial mock
// without `rowMeta` breaks module initialization.
vi.mock('@/components/ui/text/Text', () => ({ Text: 'Text', TextInput: 'TextInput' }));
vi.mock('@/utils/sessions/sessionUtils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/sessions/sessionUtils')>();
    return {
        ...actual,
        getSessionName: () => 'Session',
        getSessionSubtitle: () => 'Subtitle',
        getSessionAvatarId: () => 'avatar',
        getSessionStatus: () => ({ isConnected: true, statusText: '', statusColor: '#000', statusDotColor: '#0f0', isPulsing: false }),
        useSessionStatus: () => ({ isConnected: true, statusText: '', statusColor: '#000', statusDotColor: '#0f0', isPulsing: false }),
    };
});
vi.mock('@/components/ui/avatar/Avatar', () => ({ Avatar: 'Avatar' }));
vi.mock('@/agents/registry/AgentIcon', () => ({ AgentIcon: 'AgentIcon' }));
vi.mock('@/components/ui/status/StatusDot', () => ({ StatusDot: 'StatusDot' }));
vi.mock('@/components/ui/feedback/ActivitySpinner', () => ({ ActivitySpinner: 'ActivitySpinner' }));
vi.mock('@/components/sessions/pendingBadge', () => ({ formatPendingCountBadge: () => null }));
vi.mock('@/hooks/session/useNavigateToSession', () => ({ useNavigateToSession: () => vi.fn() }));
vi.mock('@/utils/platform/responsive', () => ({ useIsTablet: () => false }));
vi.mock('@/hooks/ui/useHappyAction', () => ({ useHappyAction: (fn: unknown) => [false, fn] }));
vi.mock('@/utils/time/formatShortRelativeTime', () => ({ formatShortRelativeTime: () => '1m' }));
vi.mock('./sessionPinIcons', () => ({
    PinIcon: (props: Record<string, unknown>) => React.createElement('PinIcon', props),
    PinSlashIcon: (props: Record<string, unknown>) => React.createElement('PinSlashIcon', props),
}));
vi.mock('./sessionTagIcons', () => ({
    TagIcon: (props: Record<string, unknown>) => React.createElement('TagIcon', props),
}));
vi.mock('@/sync/ops', async (importOriginal) => {
    const { createSyncOpsModuleMock } = await import('@/dev/testkit/mocks/syncOps');
    return createSyncOpsModuleMock({
        importOriginal,
        overrides: {
            sessionStopWithServerScope: vi.fn(async (sessionId: string) => ({ success: true, sessionId, stopped: true as const })),
            sessionArchiveWithServerScope: vi.fn(async () => ({ success: true })),
        },
    });
});
// System boundaries: the fork flow host and the clipboard writer.
vi.mock('@/components/sessions/fork/openSessionForkStrategyFlow', () => ({
    openSessionForkStrategyFlow: (input: unknown) => openForkFlowSpy(input),
}));
vi.mock('@/components/sessions/debug/sessionDebugClipboard', () => ({
    copySessionDebugInformationToClipboard: (
        information: Readonly<{ text: string; happierSessionLogPath: string | null }>,
    ) => copyDebugSpy(information),
}));

function createHomeARow(): SessionListRenderableSession {
    return {
        id: DUPLICATE_SESSION_ID,
        seq: 3,
        lastViewedSessionSeq: 2,
        latestTurnStatus: 'completed',
        createdAt: 1,
        updatedAt: 2,
        active: true,
        activeAt: 1,
        metadataLayoutVersion: 0,
        metadata: {
            machineId: 'machine-a',
            sessionLogPath: '/home-a/session.log',
            path: '/home-a/project',
        },
        metadataVersion: 1,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    } as unknown as SessionListRenderableSession;
}

async function renderSessionItem(props: SessionItemProps) {
    const { SessionItem } = await import('./SessionItem');
    const ModelBackedSessionItem = createModelBackedSessionItemTestComponent(SessionItem);
    return renderScreen(<ModelBackedSessionItem {...props} />);
}

function findContextMenuWithItem(
    screen: Awaited<ReturnType<typeof renderSessionItem>>,
    itemId: string,
): ContextMenuTestInstance | null {
    return screen.root.findAll((node) => String(node.type) === 'ContextMenu').find((node) => (
        Array.isArray((node as ContextMenuTestInstance).props.items)
        && (node as ContextMenuTestInstance).props.items?.some((item) => item.id === itemId)
    )) as ContextMenuTestInstance | undefined ?? null;
}

async function renderCollidingHomeARow() {
    return renderSessionItem({
        session: createHomeARow(),
        serverId: 'home-a',
        serverName: 'Home A',
        showServerBadge: true,
        selected: false,
        variant: 'default',
        compact: false,
        agentSwitchingEnabled: false,
        forkActionContext: { settings: null, replayEnabled: true, executionRunsEnabled: false },
        nativeContextMenuOpen: true,
        onNativeContextMenuOpenChange: vi.fn(),
    });
}

describe('SessionItem exact Home-qualified row actions', () => {
    afterEach(() => {
        openForkFlowSpy.mockReset();
        copyDebugSpy.mockReset();
        copyDebugSpy.mockImplementation(async () => true);
        standardCleanup();
    });

    it('forks the row’s own Home Session instead of the focused Home’s same-ID Session', async () => {
        const screen = await renderCollidingHomeARow();

        const contextMenu = findContextMenuWithItem(screen, 'session.fork');
        expect(contextMenu).not.toBeNull();
        await act(async () => {
            await contextMenu?.props.onSelect?.('session.fork');
        });
        await vi.waitFor(() => expect(openForkFlowSpy).toHaveBeenCalledTimes(1));

        const forkInput = openForkFlowSpy.mock.calls[0]?.[0] as Readonly<{
            sessionId: string;
            serverId: string | null;
            machineId: string | null;
            forkSupportSource: Readonly<{ metadata?: Readonly<{ sessionLogPath?: string }> | null }>;
        }>;
        expect(forkInput.sessionId).toBe(DUPLICATE_SESSION_ID);
        expect(forkInput.serverId).toBe('home-a');
        expect(forkInput.machineId).toBe('machine-a');
        expect(forkInput.forkSupportSource.metadata?.sessionLogPath).toBe('/home-a/session.log');

        await screen.unmount();
    });

    it('copies the row’s own Home debug metadata rather than the focused Home’s same-ID entity', async () => {
        const screen = await renderCollidingHomeARow();

        const contextMenu = findContextMenuWithItem(screen, 'session.copyDebugInformation');
        expect(contextMenu).not.toBeNull();
        await act(async () => {
            await contextMenu?.props.onSelect?.('session.copyDebugInformation');
        });
        await vi.waitFor(() => expect(copyDebugSpy).toHaveBeenCalledTimes(1));

        const information = copyDebugSpy.mock.calls[0]?.[0];
        expect(information?.happierSessionLogPath).toBe('/home-a/session.log');
        expect(information?.text).not.toContain('/home-b/session.log');

        await screen.unmount();
    });
});
