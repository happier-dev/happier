import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { SESSION_ACTION_SET_APPEARANCE_COLOR_ID } from '@/components/sessions/actions/sessionActionIds';
import { createSessionItemTestRowModel, installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type SessionItemProps = Omit<
    React.ComponentProps<(typeof import('./SessionItem'))['SessionItem']>,
    'rowModel'
> & {
    rowModel?: React.ComponentProps<(typeof import('./SessionItem'))['SessionItem']>['rowModel'];
};

vi.mock('react-native-reanimated', () => ({}));
installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'web' },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => key,
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useHasUnreadMessages: () => false,
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
                }),
                useSession: () => null,
            },
        });
    },
});
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));
vi.mock('react-native-gesture-handler', () => ({
    Swipeable: 'Swipeable',
}));
vi.mock('@/utils/sessions/sessionUtils', () => ({
    getSessionName: () => 'Session',
    getSessionSubtitle: () => 'Subtitle',
    getSessionAvatarId: () => 'avatar',
    useSessionStatus: () => ({
        isConnected: true,
        statusText: 'Connected',
        statusColor: '#000',
        statusDotColor: '#0f0',
        isPulsing: false,
    }),
}));
vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: 'Avatar',
}));
vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: 'AgentIcon',
}));
vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: 'StatusDot',
}));
vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: 'AgentIcon',
}));
vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => vi.fn(),
}));
vi.mock('@/utils/platform/responsive', () => ({
    useIsTablet: () => false,
}));
vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (_fn: unknown) => [false, vi.fn()],
}));
vi.mock('@/sync/ops', async (importOriginal) => {
    const { createSyncOpsModuleMock } = await import('@/dev/testkit/mocks/syncOps');
    return createSyncOpsModuleMock({
        importOriginal,
        overrides: {
            sessionStopWithServerScope: vi.fn(async () => ({ success: true })),
            sessionArchiveWithServerScope: vi.fn(async () => ({ success: true })),
        },
    });
});
vi.mock('./sessionPinIcons', () => ({
    PinIcon: (props: Record<string, unknown>) => React.createElement('PinIcon', props),
    PinSlashIcon: (props: Record<string, unknown>) => React.createElement('PinSlashIcon', props),
}));

describe('SessionItem colour', () => {
    function createSession(id: string) {
        return {
            id, seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1, metadata: null, metadataVersion: 1,
            agentState: null, agentStateVersion: 1, thinking: false, thinkingAt: 0, presence: 'offline',
        } as any;
    }

    async function renderSessionItem(props: SessionItemProps) {
        const { SessionItem } = await import('./SessionItem');
        return renderScreen(
            <SessionItem
                {...props}
                rowModel={props.rowModel ?? createSessionItemTestRowModel(props)}
            />,
        );
    }

    function baseProps(overrides: Partial<SessionItemProps> = {}): SessionItemProps {
        return {
            session: createSession('sess_1'),
            serverId: 'server_a',
            selected: false,
            isFirst: true,
            isLast: true,
            isSingle: true,
            variant: 'default',
            compact: false,
            ...overrides,
        };
    }

    function hoverRow(screen: Awaited<ReturnType<typeof renderSessionItem>>) {
        const row = screen.findByTestId('session-list-item-sess_1') as any;
        const container = row?.parent as any;
        container.props.onMouseEnter?.();
        container.props.onPointerEnter?.();
    }

    function findMoreMenu(screen: Awaited<ReturnType<typeof renderSessionItem>>) {
        return screen.root.findAll((node) => String(node.type) === 'DropdownMenu'
            && (node.props.items as Array<{ id: string }>).some((item) => item.id.startsWith('ui.session.')))[0] ?? null;
    }

    afterEach(() => {
        storage.setState({ sessionOrganizationSessionAppearancesSupportedByServerId: {} } as any);
        standardCleanup();
    });

    it('shows the effective colour as a row stripe only when the row has one', async () => {
        const colored = await renderSessionItem(baseProps({
            rowModel: createSessionItemTestRowModel(baseProps(), { appearanceColor: { kind: 'accent', key: 'orange' } }),
        }));
        expect(colored.findByTestId('session-item-appearance-stripe:sess_1')).not.toBeNull();
        await colored.unmount();

        const plain = await renderSessionItem(baseProps());
        expect(plain.findByTestId('session-item-appearance-stripe:sess_1')).toBeNull();
        await plain.unmount();
    });

    it('offers the session colour only on servers that store it, and writes through the list owner', async () => {
        const onSetSessionAppearance = vi.fn();
        const unsupported = await renderSessionItem(baseProps({ onSetSessionAppearance }));
        await act(async () => {
            hoverRow(unsupported);
        });
        await act(async () => {
            findMoreMenu(unsupported)!.props.onOpenChange(true);
        });
        expect((findMoreMenu(unsupported)!.props.items as Array<{ id: string }>).map((item) => item.id))
            .not.toContain(SESSION_ACTION_SET_APPEARANCE_COLOR_ID);
        await unsupported.unmount();

        storage.setState({ sessionOrganizationSessionAppearancesSupportedByServerId: { server_a: true } } as any);
        const supported = await renderSessionItem(baseProps({ onSetSessionAppearance }));
        await act(async () => {
            hoverRow(supported);
        });
        await act(async () => {
            findMoreMenu(supported)!.props.onOpenChange(true);
        });
        const menu = findMoreMenu(supported)!;
        const colorItem = (menu.props.items as any[]).find((item) => item.id === SESSION_ACTION_SET_APPEARANCE_COLOR_ID);
        expect(colorItem).toBeDefined();
        const blue = (colorItem.submenu.items as any[]).find((item) => item.swatch)!;
        await act(async () => {
            await menu.props.onSelect(blue.id);
        });

        expect(onSetSessionAppearance).toHaveBeenCalledWith('sess_1', { kind: 'accent', key: 'blue' }, { serverId: 'server_a' });
        await supported.unmount();
    });

    it('hands the row\'s inherited project colour to its colour menu', async () => {
        storage.setState({ sessionOrganizationSessionAppearancesSupportedByServerId: { server_a: true } } as any);
        const screen = await renderSessionItem(baseProps({
            onSetSessionAppearance: vi.fn(),
            rowModel: createSessionItemTestRowModel(baseProps(), { appearanceColor: { kind: 'accent', key: 'orange' } }),
        }));
        await act(async () => {
            hoverRow(screen);
        });
        await act(async () => {
            findMoreMenu(screen)!.props.onOpenChange(true);
        });
        const colorItem = (findMoreMenu(screen)!.props.items as any[]).find((item) => item.id === SESSION_ACTION_SET_APPEARANCE_COLOR_ID);
        const inherited = (colorItem.submenu.items as any[]).filter((item) => item.swatch?.inherited);
        expect(inherited.map((item) => item.id)).toEqual([`${SESSION_ACTION_SET_APPEARANCE_COLOR_ID}:accent:orange`]);
        await screen.unmount();
    });
});
