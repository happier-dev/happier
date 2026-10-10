import * as React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';

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

// The row primitive is a boundary here, but its accessory slots must still
// render: a passthrough that leaves `leftElement`/`rightElement` as inert props
// would hide the very control this suite is about.
vi.mock('@/components/ui/lists/Item', () => ({
    Item: ({ children, leftElement, rightElement, ...props }: any) => React.createElement(
        'Item',
        props,
        leftElement,
        rightElement,
        children,
    ),
}));
vi.mock('@/components/ui/icons/Icon', () => ({ Icon: 'Icon' }));
vi.mock('@/components/sessions/shell/SessionListIdentity', () => ({ SessionListIdentity: 'SessionListIdentity' }));
vi.mock('@/components/sessions/shell/resolveSessionListDensityViewState', () => ({
    SESSION_LIST_ROW_IDENTITY_METRICS: { compact: { slotSize: 30, agentLogoSize: 23 } },
}));
vi.mock('@/components/ui/text/Text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/feedback/ActivitySpinner', () => ({
    ActivitySpinner: 'ActivitySpinner',
    iconMatchedSpinnerSize: () => 'small',
}));
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
    serverId: string | null;
    identityDisplay: 'avatar' | 'agentLogo' | 'none';
}>) {
    const onMarkRead = vi.fn(async () => {});
    const onOpen = vi.fn();
    const { InboxReadySessionRow } = await import('./InboxReadySessionRow');
    const tree = (await renderScreen(
        <InboxReadySessionRow
            session={{ id: 'session-1', active: false, metadata: {} } as never}
            identityDisplay={overrides?.identityDisplay ?? 'agentLogo'}
            connected={true}
            sessionId="session-1"
            serverId={overrides?.serverId === undefined ? 'server-a' : overrides.serverId}
            title="Unread session"
            pending={overrides?.pending ?? false}
            onOpen={onOpen}
            onMarkRead={onMarkRead}
        />,
    )).tree;
    return { tree, onMarkRead, onOpen };
}

describe('InboxReadySessionRow', () => {
    beforeEach(() => {
        platformState.os = 'ios';
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

    it('scopes its identity to the exact Home so a same-id session elsewhere cannot collide', async () => {
        const { tree } = await renderRow({ serverId: 'server-b' });

        expect(findByTestId(tree, 'inbox.ready_session.server-b.session-1')).toHaveLength(1);
        expect(findByTestId(tree, 'inbox.ready_session.server-a.session-1')).toHaveLength(0);
    });

    it('does not reserve an empty identity gutter when Session-list identity is disabled', async () => {
        const { tree } = await renderRow({ identityDisplay: 'none' });
        const [row] = findByTestId(tree, 'inbox.ready_session.server-a.session-1');

        expect(tree.root.findAllByType('SessionListIdentity')).toHaveLength(0);
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
