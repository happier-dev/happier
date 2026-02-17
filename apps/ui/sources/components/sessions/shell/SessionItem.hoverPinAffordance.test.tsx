import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

vi.mock('@/components/ui/text/StyledText', () => ({
    Text: 'Text',
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

vi.mock('@/sync/domains/state/storage', () => ({
    useHasUnreadMessages: () => false,
    useProfile: () => ({ id: 'u1' }),
}));

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
    return tree.root.findByProps({ accessibilityLabel: 'Pin session' });
}

function resolveOpacity(style: unknown): number | null {
    if (!style) return null;
    if (Array.isArray(style)) {
        for (let i = style.length - 1; i >= 0; i--) {
            const entry = style[i] as any;
            if (entry && typeof entry === 'object' && typeof entry.opacity === 'number') return entry.opacity;
        }
        return null;
    }
    if (typeof style === 'object' && typeof (style as any).opacity === 'number') return (style as any).opacity;
    return null;
}

describe('SessionItem pin hover affordance (web)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('hides the pin action promptly after leaving the row', async () => {
        const { SessionItem } = await import('./SessionItem');

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
        const pin = findPinPressable(tree!);
        const overlay = pin.parent;
        expect(overlay?.props.pointerEvents).toBe('none');
        expect(resolveOpacity(overlay?.props.style)).toBe(0);

        await act(async () => {
            row.props.onHoverIn();
        });
        expect(overlay?.props.pointerEvents).toBe('auto');
        expect(resolveOpacity(overlay?.props.style)).toBe(1);

        await act(async () => {
            row.props.onHoverOut();
            vi.advanceTimersByTime(1);
        });
        expect(overlay?.props.pointerEvents).toBe('none');
        expect(resolveOpacity(overlay?.props.style)).toBe(0);
    });

    it('hides the pin action promptly after leaving the pin button', async () => {
        const { SessionItem } = await import('./SessionItem');

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
        const pin = findPinPressable(tree!);
        const overlay = pin.parent;

        await act(async () => {
            row.props.onHoverIn();
        });
        expect(overlay?.props.pointerEvents).toBe('auto');
        expect(resolveOpacity(overlay?.props.style)).toBe(1);

        await act(async () => {
            row.props.onHoverOut();
            pin.props.onHoverIn();
        });

        await act(async () => {
            pin.props.onHoverOut();
            vi.advanceTimersByTime(1);
        });

        expect(overlay?.props.pointerEvents).toBe('none');
        expect(resolveOpacity(overlay?.props.style)).toBe(0);
    });
});
