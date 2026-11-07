import * as React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture, renderScreen } from '@/dev/testkit';
import { SessionListIdentity } from '@/components/sessions/shell/SessionListIdentity';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const platformState = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'web' }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return await createReactNativeWebMock({
        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        View: 'View',
        // A live getter so one suite can render both the native and the web
        // composition; the runtime merges Platform preserving descriptors.
        Platform: {
            get OS() {
                return platformState.os;
            },
            select: (choices: Record<string, unknown>) => choices[platformState.os] ?? choices.default,
        },
    });
});

vi.mock('react-native-gesture-handler', () => ({
    Swipeable: React.forwardRef(({ children, ...props }: any, _ref) => (
        React.createElement('Swipeable', props, children)
    )),
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

const hydrateSessionListRows = vi.hoisted(() => vi.fn(async (_addresses: readonly { serverId: string; sessionId: string }[]) => undefined));
vi.mock('@/sync/sync', () => ({ sync: { hydrateSessionListRows } }));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

/** Host nodes only: a composite and the host it renders both carry `testID`. */
function findByTestId(tree: renderer.ReactTestRenderer, testID: string) {
    return tree.root.findAll((node) => (
        typeof node.type === 'string'
        && (node.props as { testID?: string } | undefined)?.testID === testID
    ));
}

async function renderRow(overrides?: Partial<{
    pending: boolean;
    readUnavailableReason: string;
    serverId: string | null;
    identityDisplay: 'avatar' | 'agentLogo' | 'none';
}>) {
    const onMarkRead = vi.fn(async () => {});
    const onOpen = vi.fn();
    const { InboxReadySessionRow } = await import('./InboxReadySessionRow');
    const tree = (await renderScreen(
        <InboxReadySessionRow
            session={createSessionFixture({ id: 'session-1', active: false, metadata: null })}
            identityDisplay={overrides?.identityDisplay ?? 'agentLogo'}
            connected={true}
            sessionId="session-1"
            serverId={overrides?.serverId === undefined ? 'server-a' : overrides.serverId}
            title="Unread session"
            pending={overrides?.pending ?? false}
            readUnavailableReason={overrides?.readUnavailableReason}
            onOpen={onOpen}
            onMarkRead={onMarkRead}
        />,
    )).tree;
    return { tree, onMarkRead, onOpen };
}

describe('InboxReadySessionRow', () => {
    beforeEach(() => {
        platformState.os = 'ios';
        hydrateSessionListRows.mockClear();
    });

    it('demands the content of the Session it names, so an undecided one is not titled "Encrypted session"', async () => {
        await renderRow();
        expect(hydrateSessionListRows).toHaveBeenCalledWith([{ serverId: 'server-a', sessionId: 'session-1' }]);
    });

    it('exposes a native swipe action that marks only that session as read', async () => {
        const { tree, onMarkRead } = await renderRow();

        const swipeable = tree.root.findByType('Swipeable');
        let action!: renderer.ReactTestRenderer;
        await renderer.act(async () => {
            action = renderer.create(swipeable.props.renderRightActions());
        });
        const swipeButton = action.root.findByType('Pressable');
        await renderer.act(async () => {
            swipeButton.props.onPress();
        });

        expect(onMarkRead).toHaveBeenCalledOnce();
    });

    it('offers a labelled mark-read control on web, where the swipe does not exist', async () => {
        platformState.os = 'web';
        const { tree, onMarkRead } = await renderRow();

        expect(tree.root.findAll((node) => String(node.type) === 'Swipeable')).toHaveLength(0);

        const [control] = findByTestId(tree, 'inbox.ready_session.server-a.session-1.mark_read');
        expect(control).toBeDefined();
        expect(control.props.accessibilityLabel).toBe('sessionInfo.markSessionRead');

        await renderer.act(async () => {
            control.props.onPress?.();
        });
        expect(onMarkRead).toHaveBeenCalledOnce();
    });

    it('keeps the row the single focusable owner on native and marks read from its own action', async () => {
        const { tree, onMarkRead, onOpen } = await renderRow();

        // No sibling control competes with the row for VoiceOver/TalkBack focus.
        expect(findByTestId(tree, 'inbox.ready_session.server-a.session-1.mark_read')).toHaveLength(0);

        const [row] = findByTestId(tree, 'inbox.ready_session.server-a.session-1');
        expect(row.props.accessibilityActions).toEqual([
            { name: 'markRead', label: 'sessionInfo.markSessionRead' },
        ]);

        // Opening and marking read coexist on that one focused row.
        await renderer.act(async () => {
            row.props.onPress();
        });
        await renderer.act(async () => {
            row.props.onAccessibilityAction({ nativeEvent: { actionName: 'markRead' } });
        });

        expect(onOpen).toHaveBeenCalledOnce();
        expect(onMarkRead).toHaveBeenCalledOnce();
    });

    it('ignores an unrelated native action name instead of marking read', async () => {
        const { tree, onMarkRead } = await renderRow();

        const [row] = findByTestId(tree, 'inbox.ready_session.server-a.session-1');
        await renderer.act(async () => {
            row.props.onAccessibilityAction({ nativeEvent: { actionName: 'activate' } });
        });

        expect(onMarkRead).not.toHaveBeenCalled();
    });

    it('suppresses only mark read while a mark is in flight, so the row still opens', async () => {
        const { tree, onMarkRead, onOpen } = await renderRow({ pending: true });

        const [row] = findByTestId(tree, 'inbox.ready_session.server-a.session-1');
        expect(row.props.accessibilityActions).toEqual([]);
        expect(row.props.onAccessibilityAction).toBeUndefined();
        // Pending belongs to the mark, never to navigation.
        expect(row.props.disabled).toBeFalsy();

        await renderer.act(async () => {
            row.props.onPress();
        });

        expect(onOpen).toHaveBeenCalledOnce();
        expect(onMarkRead).not.toHaveBeenCalled();
    });

    it('announces that the completed session is ready for review', async () => {
        const { tree } = await renderRow();

        const [row] = findByTestId(tree, 'inbox.ready_session.server-a.session-1');
        expect(row.props.accessibilityLabel).toBe('inbox.readySessionAccessibilityLabel');
    });

    it.each(['ios', 'web'] as const)('explains unavailable read actions on %s while keeping navigation available', async os => {
        platformState.os = os;
        const { tree, onMarkRead, onOpen } = await renderRow({ readUnavailableReason: 'Home offline' });
        const [row] = findByTestId(tree, 'inbox.ready_session.server-a.session-1');
        expect(row.props.accessibilityActions).toEqual([]);
        expect(row.props.disabled).toBeFalsy();
        await renderer.act(async () => { row.props.onPress(); });
        expect(onOpen).toHaveBeenCalledOnce();
        if (os === 'web') {
            const { IconButton } = await import('@/components/ui/buttons/IconButton');
            const button = tree.root.findByType(IconButton);
            expect(button.props.disabled).toBe(true);
            expect(button.props.disabledReason).toBe('Home offline');
            await renderer.act(async () => { button.props.onPress(); });
        } else {
            let action!: renderer.ReactTestRenderer;
            await renderer.act(async () => { action = renderer.create(tree.root.findByType('Swipeable').props.renderRightActions()); });
            const button = action.root.findByType('Pressable');
            expect(button.props.disabled).toBe(true);
            expect(button.props.accessibilityHint).toBe('Home offline');
            await renderer.act(async () => { button.props.onPress(); });
            await renderer.act(async () => { action.unmount(); });
        }
        expect(onMarkRead).not.toHaveBeenCalled();
    });

    it('scopes its identity to the exact Home so a same-id session elsewhere cannot collide', async () => {
        const { tree } = await renderRow({ serverId: 'server-b' });

        expect(findByTestId(tree, 'inbox.ready_session.server-b.session-1')).toHaveLength(1);
        expect(findByTestId(tree, 'inbox.ready_session.server-a.session-1')).toHaveLength(0);
    });

    it('does not reserve an empty identity gutter when Session-list identity is disabled', async () => {
        const { tree } = await renderRow({ identityDisplay: 'none' });
        const [row] = findByTestId(tree, 'inbox.ready_session.server-a.session-1');

        expect(tree.root.findAllByType(SessionListIdentity)).toHaveLength(0);
        expect(row.props.accessibilityRole).toBe('button');
    });

    it('refuses a second mark on the web control while the first is still in flight', async () => {
        platformState.os = 'web';
        const { tree, onMarkRead } = await renderRow({ pending: true });

        const [control] = findByTestId(tree, 'inbox.ready_session.server-a.session-1.mark_read');
        await renderer.act(async () => {
            control.props.onPress?.();
        });

        expect(onMarkRead).not.toHaveBeenCalled();
    });
});
