import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
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
    storage: async (importOriginal) => importOriginal(),
});
vi.mock('react-native-gesture-handler', () => ({
    Swipeable: 'Swipeable',
}));

vi.doUnmock('@/sync/domains/state/storage');
vi.doUnmock('@/hooks/session/useDraft');
vi.doUnmock('@/agents/registry/registryUiBehavior');

const { renderScreen: renderCanonicalScreen } = await import('@/dev/testkit/render/renderScreen');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { storage } = await import('@/sync/domains/state/storage');
let previousStorageState: ReturnType<typeof storage.getState>;
beforeEach(() => { previousStorageState = storage.getState(); });
afterEach(async () => {
    await standardCleanup();
    storage.setState(previousStorageState, true);
});
function renderScreen(...args: Parameters<typeof renderCanonicalScreen>) {
    return renderCanonicalScreen(<InjectedAuthProvider credentials={null}>{args[0]}</InjectedAuthProvider>, args[1]);
}

const { SessionItem } = await import('./SessionItem');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const ModelBackedSessionItem = createModelBackedSessionItemTestComponent(SessionItem);

describe('SessionItem pin hover affordance (web)', () => {
    function createSession(id: string) {
        return createSessionFixture({ id, active: false, presence: 0 });
    }

    async function renderSessionItem(props: SessionItemProps) {
        return renderScreen(<ModelBackedSessionItem {...props} />);
    }

    function findSessionRow(screen: Awaited<ReturnType<typeof renderSessionItem>>, sessionId: string) {
        return screen.findHostByTestId(`session-list-item-${sessionId}`) as any;
    }

    /** The row's hover owner: the nearest ancestor of the press target that tracks the pointer. */
    function findSessionRowContainer(screen: Awaited<ReturnType<typeof renderSessionItem>>, sessionId: string) {
        let node = findSessionRow(screen, sessionId).parent;
        while (node && typeof node.props?.onPointerEnter !== 'function') node = node.parent;
        if (!node) throw new Error(`expected session row container for ${sessionId}`);
        return node as any;
    }

    /** The row actions sit in the trailing area beside the row's press target (never inside its `<button>`). */
    function findPinActions(row: ReturnType<typeof findSessionRow>) {
        let rowRoot = row.parent;
        while (rowRoot && typeof rowRoot.props?.onPointerEnter !== 'function') rowRoot = rowRoot.parent;
        const rightArea = (rowRoot ?? row).findAll((node: any) => node.props?.testID === 'session-item-right-area')[0];
        if (!rightArea) return [];
        // One action per press handler (a mocked Pressable and its host both carry the label).
        const byHandler = new Map<unknown, any>();
        for (const node of rightArea.findAllByProps({ accessibilityLabel: 'sessionInfo.pinSession' })) {
            if (!byHandler.has(node.props.onPress)) byHandler.set(node.props.onPress, node);
        }
        return [...byHandler.values()];
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


    it('hides the pin action promptly after leaving the row', async () => {
        const screen = await renderSessionItem({
            session: createSession('sess_1'),
            serverId: 'server_a',
            pinned: false,
            onTogglePinned: vi.fn(),
            selected: false,
            variant: 'default',
            compact: false,
        });

        const row = findSessionRow(screen, 'sess_1');
        const container = findSessionRowContainer(screen, 'sess_1');

        expect(findPinActions(row)).toHaveLength(0);

        await act(async () => {
            triggerHoverEnter(container);
        });

        expect(findPinActions(row)).not.toHaveLength(0);

        await act(async () => {
            triggerHoverLeave(container);
        });

        expect(findPinActions(row)).toHaveLength(0);

        await screen.unmount();
    });

    it('shows a carried row as a quiet ghost: no hover actions while it is being dragged (lab E1)', async () => {
        const screen = await renderSessionItem({
            session: createSession('sess_1'),
            serverId: 'server_a',
            pinned: false,
            onTogglePinned: vi.fn(),
            selected: false,
            variant: 'default',
            compact: false,
            dragEnabled: true,
            isBeingDragged: true,
        });

        const row = findSessionRow(screen, 'sess_1');
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
            variant: 'default',
            compact: false,
        });

        const row = findSessionRow(screen, 'sess_3');
        const container = findSessionRowContainer(screen, 'sess_3');
        expect(findPinActions(row)).toHaveLength(0);

        await act(async () => {
            triggerHoverEnter(container);
        });
        expect(findPinActions(row)).not.toHaveLength(0);

        const rightArea = findRightArea(screen);
        await act(async () => {
            triggerHoverEnter(rightArea);
        });
        expect(findPinActions(row)).not.toHaveLength(0);

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
            variant: 'default',
            compact: false,
        });

        const row = findSessionRow(screen, 'sess_2');
        const container = findSessionRowContainer(screen, 'sess_2');

        await act(async () => {
            triggerHoverEnter(container);
        });
        expect(findPinActions(row)).not.toHaveLength(0);

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
        expect(findPinActions(row)).not.toHaveLength(0);

        await act(async () => {
            triggerHoverLeave(rightArea);
        });
        expect(findPinActions(row)).not.toHaveLength(0);

        await act(async () => {
            triggerHoverLeave(container);
        });
        expect(findPinActions(row)).toHaveLength(0);

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
            variant: 'default',
            compact: false,
        });

        const row = findSessionRow(screen, 'sess_4');
        const container = findSessionRowContainer(screen, 'sess_4');
        await act(async () => {
            triggerHoverEnter(container);
        });

        const tagDropdown = screen.findAllByType(DropdownMenu).find((dropdown: any) => dropdown.props.search === true);
        const moreDropdown = screen.findAllByType(DropdownMenu).find((dropdown: any) => dropdown.props.search !== true);

        expect(tagDropdown?.props.placement).toBe('bottom');
        expect(tagDropdown?.props.popoverAnchorAlign).toBe('end');
        expect(moreDropdown?.props.placement).toBe('bottom');
        expect(moreDropdown?.props.popoverAnchorAlign).toBe('end');

        await screen.unmount();
    });
});
