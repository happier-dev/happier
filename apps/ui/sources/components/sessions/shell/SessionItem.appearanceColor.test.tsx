import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { SESSION_ACTION_SET_APPEARANCE_COLOR_ID } from '@/components/sessions/actions/sessionActionIds';
import {
    createModelBackedSessionItemTestComponent,
    type ModelBackedSessionItemTestProps,
} from './sessionItemRowViewModelTestFixture';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type SessionItemProps = ModelBackedSessionItemTestProps;

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
        const { createStorageModuleMock, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                storage: createStorageStoreMock({ sessionOrganizationPinsBySessionKey: {} }),
                useHasUnreadMessages: () => false,
                useProfile: () => ({
                    id: 'u1',
                    timestamp: 0,
                    firstName: null,
                    name: null,
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
                useSession: () => null,
                useSessionListMeaningfulActivityAt: () => null,
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
    resolveLockedSessionTitle: (title: string) => title,
    getSessionSubtitle: () => 'Subtitle',
    getSessionAvatarId: () => 'avatar',
    getSessionStatus: () => ({
        isConnected: true,
        statusText: 'Connected',
        statusColor: '#000',
        statusDotColor: '#0f0',
        isPulsing: false,
    }),
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
vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => vi.fn(),
}));
vi.mock('@/utils/platform/responsive', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/platform/responsive')>(),
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
            sessionStopWithServerScope: vi.fn(async (sessionId: string) => ({ success: true, sessionId, stopped: true as const })),
            sessionArchiveWithServerScope: vi.fn(async () => ({ success: true })),
        },
    });
});
vi.mock('./sessionPinIcons', () => ({
    PinIcon: (props: Record<string, unknown>) => React.createElement('PinIcon', props),
    PinSlashIcon: (props: Record<string, unknown>) => React.createElement('PinSlashIcon', props),
}));

const { SessionItem } = await import('./SessionItem');
const ModelBackedSessionItem = createModelBackedSessionItemTestComponent(SessionItem);

const { getStorage } = await import('@/sync/domains/state/storageStore');

describe('SessionItem colour', () => {
    function createSession(id: string) {
        return {
            id, seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1, metadata: null, metadataVersion: 1,
            agentState: null, agentStateVersion: 1, thinking: false, thinkingAt: 0, presence: 'offline',
        } as any;
    }
    const baseProps = (overrides: Partial<SessionItemProps> = {}): SessionItemProps => ({
        session: createSession('sess_1'), serverId: 'server_a', selected: false, variant: 'default', compact: false, ...overrides,
    } as SessionItemProps);

    function hoverRow(screen: Awaited<ReturnType<typeof renderScreen>>) {
        // The row's hover owner: the nearest ancestor of the press target that tracks the pointer.
        let node: any = (screen as any).findHostByTestId('session-list-item-sess_1')?.parent;
        while (node && typeof node.props?.onPointerEnter !== 'function') node = node.parent;
        node?.props.onMouseEnter?.();
        node?.props.onHoverIn?.();
        node?.props.onPointerEnter?.();
    }
    function findMoreMenu(screen: Awaited<ReturnType<typeof renderScreen>>) {
        // The row's more menu: the one menu whose trigger is the row's ⋯ button.
        return screen.root.findAll((node: any) => String(node.type) === 'DropdownMenu' && Array.isArray(node.props.items)
            && typeof node.props.onSelect === 'function' && node.props.onOpenChange !== undefined)[0] ?? null;
    }

    afterEach(() => {
        getStorage().setState({ sessionOrganizationSessionAppearancesSupportedByServerId: {} } as any);
        standardCleanup();
    });

    it('shows the effective colour as a row stripe only when the row has one', async () => {
        const colored = await renderScreen(<ModelBackedSessionItem {...baseProps({ rowViewModelOverrides: { appearanceColor: { kind: 'accent', key: 'orange' } } })} />);
        expect(colored.findByTestId('session-item-appearance-stripe:sess_1')).not.toBeNull();
        await colored.unmount();
        const plain = await renderScreen(<ModelBackedSessionItem {...baseProps()} />);
        expect(plain.findByTestId('session-item-appearance-stripe:sess_1')).toBeNull();
        await plain.unmount();
    });

    it('offers the session colour only where the server stores it, writes through the list owner, and marks the inherited colour', async () => {
        const onSetSessionAppearance = vi.fn();
        const openMenu = async (screen: Awaited<ReturnType<typeof renderScreen>>) => {
            await act(async () => { hoverRow(screen); });
            await act(async () => { findMoreMenu(screen)!.props.onOpenChange(true); });
            return findMoreMenu(screen)!;
        };
        const unsupported = await renderScreen(<ModelBackedSessionItem {...baseProps({ onSetSessionAppearance })} />);
        expect(((await openMenu(unsupported)).props.items as Array<{ id: string }>).map((item) => item.id))
            .not.toContain(SESSION_ACTION_SET_APPEARANCE_COLOR_ID);
        await unsupported.unmount();

        getStorage().setState({ sessionOrganizationSessionAppearancesSupportedByServerId: { server_a: true } } as any);
        const supported = await renderScreen(<ModelBackedSessionItem {...baseProps({
            onSetSessionAppearance,
            rowViewModelOverrides: { appearanceColor: { kind: 'accent', key: 'orange' } },
        })} />);
        const menu = await openMenu(supported);
        const colorItem = (menu.props.items as any[]).find((item) => item.id === SESSION_ACTION_SET_APPEARANCE_COLOR_ID);
        expect(colorItem).toBeDefined();
        const submenu = colorItem.submenu.items as any[];
        expect(submenu.filter((item) => item.swatch?.inherited).map((item) => item.id))
            .toEqual([`${SESSION_ACTION_SET_APPEARANCE_COLOR_ID}:accent:orange`]);
        await act(async () => {
            await menu.props.onSelect(submenu.find((item) => item.swatch)!.id);
        });
        expect(onSetSessionAppearance).toHaveBeenCalledWith('sess_1', { kind: 'accent', key: 'blue' }, { serverId: 'server_a' });
        await supported.unmount();
    });
});
