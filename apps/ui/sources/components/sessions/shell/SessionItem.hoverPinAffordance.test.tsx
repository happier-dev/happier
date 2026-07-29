import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
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
                storage: createStorageStoreMock({}),
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

describe('SessionItem pin hover affordance (web)', () => {
    function createSession(id: string) {
        return {
            id,
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: false,
            activeAt: 1,
            metadata: null,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            thinking: false,
            thinkingAt: 0,
            presence: 'offline',
        } as any;
    }

    async function renderSessionItem(props: SessionItemProps) {
        const { SessionItem } = await import('./SessionItem');
        const ModelBackedSessionItem = createModelBackedSessionItemTestComponent(SessionItem);
        return renderScreen(<ModelBackedSessionItem {...props} />);
    }

    function findSessionRow(screen: Awaited<ReturnType<typeof renderSessionItem>>, sessionId: string) {
        return screen.findByTestId(`session-list-item-${sessionId}`) as any;
    }

    function findSessionRowContainer(screen: Awaited<ReturnType<typeof renderSessionItem>>, sessionId: string) {
        const row = findSessionRow(screen, sessionId);
        if (!row.parent) throw new Error(`expected session row container for ${sessionId}`);
        return row.parent as any;
    }

    function findPinActions(row: ReturnType<typeof findSessionRow>) {
        return row.findAllByProps({ accessibilityLabel: 'sessionInfo.pinSession' });
    }

    function triggerHoverEnter(node: any) {
        node.props.onMouseEnter?.();
        node.props.onHoverIn?.();
        node.props.onPointerEnter?.();
    }

    function triggerHoverLeave(node: any) {
        node.props.onMouseLeave?.();
        node.props.onHoverOut?.();
        node.props.onPointerLeave?.();
    }

    function findRightArea(screen: Awaited<ReturnType<typeof renderSessionItem>>) {
        return screen.findByTestId('session-item-right-area') as any;
    }

    function flattenStyleValue(style: unknown, key: string): unknown {
        if (Array.isArray(style)) {
            return style.reduce<unknown>((value, entry) => {
                const next = flattenStyleValue(entry, key);
                return next === undefined ? value : next;
            }, undefined);
        }
        if (style && typeof style === 'object' && key in style) {
            return (style as Record<string, unknown>)[key];
        }
        return undefined;
    }

    afterEach(() => {
        standardCleanup();
    });

    it('hides the pin action promptly after leaving the row', async () => {
        const screen = await renderSessionItem({
            session: createSession('sess_1'),
            serverId: 'server_a',
            pinned: false,
            onTogglePinned: vi.fn(),
            selected: false,
            isFirst: true,
            isLast: true,
            isSingle: true,
            variant: 'default',
            compact: false,
        });

        const row = findSessionRow(screen, 'sess_1');
        const container = findSessionRowContainer(screen, 'sess_1');

        expect(findPinActions(row)).toHaveLength(0);

        await act(async () => {
            triggerHoverEnter(container);
        });

        expect(findPinActions(row)).toHaveLength(1);

        await act(async () => {
            triggerHoverLeave(container);
        });

        expect(findPinActions(row)).toHaveLength(0);

        await screen.unmount();
    });

    it('keeps the actions visible when moving the cursor from the row to the actions area', async () => {
        const screen = await renderSessionItem({
            session: createSession('sess_3'),
            serverId: 'server_a',
            pinned: false,
            onTogglePinned: vi.fn(),
            selected: false,
            isFirst: true,
            isLast: true,
            isSingle: true,
            variant: 'default',
            compact: false,
        });

        const row = findSessionRow(screen, 'sess_3');
        const container = findSessionRowContainer(screen, 'sess_3');
        expect(findPinActions(row)).toHaveLength(0);

        await act(async () => {
            triggerHoverEnter(container);
        });
        expect(findPinActions(row)).toHaveLength(1);

        const rightArea = findRightArea(screen);
        await act(async () => {
            triggerHoverEnter(rightArea);
        });
        expect(findPinActions(row)).toHaveLength(1);

        await act(async () => {
            triggerHoverLeave(container);
        });
        expect(findPinActions(row)).toHaveLength(0);

        await screen.unmount();
    });

    it('shows the actions when hovered and hides them when leaving the row', async () => {
        const screen = await renderSessionItem({
            session: createSession('sess_2'),
            serverId: 'server_a',
            pinned: false,
            onTogglePinned: vi.fn(),
            selected: false,
            isFirst: true,
            isLast: true,
            isSingle: true,
            variant: 'default',
            compact: false,
        });

        const row = findSessionRow(screen, 'sess_2');
        const container = findSessionRowContainer(screen, 'sess_2');

        await act(async () => {
            triggerHoverEnter(container);
        });
        expect(findPinActions(row)).toHaveLength(1);

        await act(async () => {
            triggerHoverLeave(container);
        });
        expect(findPinActions(row)).toHaveLength(0);

        await screen.unmount();
    });

    it('keeps actions reachable when the pointer moves from row content to the action icons', async () => {
        const screen = await renderSessionItem({
            session: createSession('sess_5'),
            serverId: 'server_a',
            pinned: false,
            onTogglePinned: vi.fn(),
            selected: false,
            isFirst: true,
            isLast: true,
            isSingle: true,
            variant: 'default',
            compact: false,
        });

        const row = findSessionRow(screen, 'sess_5');
        const container = findSessionRowContainer(screen, 'sess_5');
        const rightArea = findRightArea(screen);
        expect(row.props.onHoverIn).toBeUndefined();
        expect(row.props.onHoverOut).toBeUndefined();
        expect(typeof container.props.onPointerEnter).toBe('function');
        expect(typeof container.props.onPointerLeave).toBe('function');

        await act(async () => {
            triggerHoverEnter(container);
            triggerHoverEnter(rightArea);
        });
        expect(findPinActions(row)).toHaveLength(1);

        await act(async () => {
            triggerHoverLeave(rightArea);
        });
        expect(findPinActions(row)).toHaveLength(1);

        await act(async () => {
            triggerHoverLeave(container);
        });
        expect(findPinActions(row)).toHaveLength(0);

        await screen.unmount();
    });

    it('indents the full row chrome for sessions inside folders', async () => {
        const screen = await renderSessionItem({
            session: createSession('sess_6'),
            serverId: 'server_a',
            pinned: false,
            onTogglePinned: vi.fn(),
            selected: false,
            isFirst: true,
            isLast: true,
            isSingle: true,
            variant: 'default',
            compact: false,
            folderDepth: 1,
        });

        const row = findSessionRow(screen, 'sess_6');
        expect(flattenStyleValue(row.parent?.props.style, 'marginLeft')).toBe(50);

        await screen.unmount();
    });

    it('anchors the row action dropdowns below the trigger on web', async () => {
        const screen = await renderSessionItem({
            session: {
                ...createSession('sess_4'),
                active: true,
                presence: 'online',
            },
            serverId: 'server_a',
            pinned: false,
            onTogglePinned: vi.fn(),
            tagsEnabled: true,
            tags: ['alpha'],
            allKnownTags: ['alpha', 'beta'],
            onSetTags: vi.fn(),
            selected: false,
            isFirst: true,
            isLast: true,
            isSingle: true,
            variant: 'default',
            compact: false,
        });

        const row = findSessionRow(screen, 'sess_4');
        const container = findSessionRowContainer(screen, 'sess_4');
        await act(async () => {
            triggerHoverEnter(container);
        });

        const tagDropdown = screen.findAllByType('DropdownMenu' as any).find((dropdown: any) => dropdown.props.search === true);
        const moreDropdown = screen.findAllByType('DropdownMenu' as any).find((dropdown: any) => dropdown.props.search !== true);

        expect(tagDropdown?.props.placement).toBe('bottom');
        expect(tagDropdown?.props.popoverAnchorAlign).toBe('end');
        expect(moreDropdown?.props.placement).toBe('bottom');
        expect(moreDropdown?.props.popoverAnchorAlign).toBe('end');

        await screen.unmount();
    });
});
