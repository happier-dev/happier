import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('react-native-gesture-handler', () => ({
    Swipeable: 'Swipeable',
}));

vi.mock('react-native', async () => {
    const stub = await import('@/dev/reactNativeStub');
    return {
        ...stub,
        Platform: { ...stub.Platform, OS: 'web' },
    };
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
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

vi.mock('@/sync/ops', () => ({
    sessionStopWithServerScope: vi.fn(async () => ({ success: true })),
    sessionArchiveWithServerScope: vi.fn(async () => ({ success: true })),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/state/storage')>();
    return {
        ...actual,
        useHasUnreadMessages: () => false,
        useProfile: () => ({ id: 'u1' }),
        useSession: () => null,
        useSessionListMeaningfulActivityAt: () => null,
    };
});

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn() },
}));

vi.mock('./sessionPinIcons', () => ({
    PinIcon: (props: Record<string, unknown>) => React.createElement('PinIcon', props),
    PinSlashIcon: (props: Record<string, unknown>) => React.createElement('PinSlashIcon', props),
}));

const sessionItemModulePromise = import('./SessionItem');

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

function findRowPressable(tree: renderer.ReactTestRenderer) {
    const pressables = tree.root.findAllByType('Pressable');
    const row = pressables.find((p) => !p.props.accessibilityLabel);
    if (!row) throw new Error('Row Pressable not found');
    return row;
}

function findPinPressable(tree: renderer.ReactTestRenderer) {
    return tree.root.findByProps({ accessibilityLabel: 'sessionInfo.pinSession' });
}

function findPinPressables(tree: renderer.ReactTestRenderer) {
    return tree.root.findAllByProps({ accessibilityLabel: 'sessionInfo.pinSession' });
}

function triggerHoverEnter(node: renderer.ReactTestInstance) {
    node.props.onMouseEnter?.();
    node.props.onHoverIn?.();
    node.props.onPointerEnter?.();
}

function triggerHoverLeave(node: renderer.ReactTestInstance) {
    node.props.onMouseLeave?.();
    node.props.onHoverOut?.();
    node.props.onPointerLeave?.();
}

function findRightArea(tree: renderer.ReactTestRenderer) {
    // The right area View has onPointerEnter/onPointerLeave handlers
    const views = tree.root.findAllByType('View');
    return views.find((v) => v.props.onPointerEnter && v.props.onPointerLeave);
}

describe('SessionItem pin hover affordance (web)', () => {
    it('hides the pin action promptly after leaving the row', async () => {
        const { SessionItem } = await sessionItemModulePromise;
        const session = createSession('sess_1');
        const onTogglePinned = vi.fn();

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <SessionItem
                    session={session}
                    serverId="server_a"
                    pinned={false}
                    onTogglePinned={onTogglePinned}
                    selected={false}
                    isFirst={true}
                    isLast={true}
                    isSingle={true}
                    variant="default"
                    compact={false}
                />,
            );
        });

        const row = findRowPressable(tree!);

        // Before hover: pin button should NOT be in the DOM
        expect(findPinPressables(tree!)).toHaveLength(0);

        await act(async () => {
            triggerHoverEnter(row);
        });

        // After hover: pin button should be in the DOM
        expect(findPinPressables(tree!)).toHaveLength(1);
        expect(findPinPressable(tree!)).toBeTruthy();

        await act(async () => {
            triggerHoverLeave(row);
        });

        // After leaving: pin button should be gone again
        expect(findPinPressables(tree!)).toHaveLength(0);
    });

    it('keeps the actions visible when moving the cursor from the row to the actions area', async () => {
        const { SessionItem } = await sessionItemModulePromise;
        const session = createSession('sess_3');
        const onTogglePinned = vi.fn();

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <SessionItem
                    session={session}
                    serverId="server_a"
                    pinned={false}
                    onTogglePinned={onTogglePinned}
                    selected={false}
                    isFirst={true}
                    isLast={true}
                    isSingle={true}
                    variant="default"
                    compact={false}
                />,
            );
        });

        const row = findRowPressable(tree!);
        expect(findPinPressables(tree!)).toHaveLength(0);

        await act(async () => {
            triggerHoverEnter(row);
        });
        expect(findPinPressables(tree!)).toHaveLength(1);

        // Move cursor from the row to the right area (actions).
        // The actions should remain visible because actions area hover keeps them shown.
        const rightArea = findRightArea(tree!);
        await act(async () => {
            triggerHoverLeave(row);
            if (rightArea) triggerHoverEnter(rightArea);
        });
        expect(findPinPressables(tree!)).toHaveLength(1);

        await act(async () => {
            if (rightArea) triggerHoverLeave(rightArea);
        });
        expect(findPinPressables(tree!)).toHaveLength(0);
    });

    it('shows the actions when hovered and hides them when leaving the row', async () => {
        const { SessionItem } = await sessionItemModulePromise;
        const session = createSession('sess_2');
        const onTogglePinned = vi.fn();

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <SessionItem
                    session={session}
                    serverId="server_a"
                    pinned={false}
                    onTogglePinned={onTogglePinned}
                    selected={false}
                    isFirst={true}
                    isLast={true}
                    isSingle={true}
                    variant="default"
                    compact={false}
                />,
            );
        });

        const row = findRowPressable(tree!);

        await act(async () => {
            triggerHoverEnter(row);
        });
        expect(findPinPressables(tree!)).toHaveLength(1);

        await act(async () => {
            triggerHoverLeave(row);
        });

        expect(findPinPressables(tree!)).toHaveLength(0);
    });
});
