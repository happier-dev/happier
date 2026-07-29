import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import type { SplitCanvasLeafNode, SplitCanvasNode } from '@/components/appShell/splitCanvas/model/splitCanvasTypes';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/components/sessions/shell/sessionPinIcons', () => ({
    PinIcon: (props: Record<string, unknown>) => React.createElement('PinIcon', props),
    PinSlashIcon: (props: Record<string, unknown>) => React.createElement('PinSlashIcon', props),
}));

vi.mock('@/components/ui/media/FileIcon', () => ({
    FileIcon: (props: Record<string, unknown>) => React.createElement('FileIcon', props),
}));

vi.mock('@/components/ui/scroll/useWebScrollLockBypass', () => ({
    useWebScrollLockBypass: () => {},
}));

const splitCanvasHostSpy = vi.hoisted(() => vi.fn());

function collectLeaves<TLeafPayload>(
    node: SplitCanvasNode<TLeafPayload> | null,
): SplitCanvasLeafNode<TLeafPayload>[] {
    if (!node) return [];
    if (node.kind === 'leaf') return [node];
    return [...collectLeaves(node.first), ...collectLeaves(node.second)];
}

vi.mock('@/components/appShell/splitCanvas/components/SplitCanvasHost', () => ({
    SplitCanvasHost: (props: {
        state: { root: SplitCanvasNode<{ groupId: string }> | null };
        renderLeaf: (input: {
            leaf: SplitCanvasLeafNode<{ groupId: string }>;
            isFocused: boolean;
            isMaximized: boolean;
        }) => React.ReactNode;
    }) => {
        splitCanvasHostSpy(props);
        return React.createElement(
            React.Fragment,
            null,
            ...collectLeaves(props.state.root).map((leaf) => props.renderLeaf({
                leaf,
                isFocused: false,
                isMaximized: false,
            })),
        );
    },
}));

const pane = {
    scopeId: 'scope:details',
    scopeState: {
        right: {
            isOpen: false,
            activeTabId: null,
            tabState: {},
        },
        details: {
            isOpen: true,
            tabs: [{ key: 'file:b', kind: 'file', title: 'b.txt', isPinned: true, isPreview: false, resource: { kind: 'file', path: 'b.txt' } }],
            activeTabKey: 'file:b',
            tabState: {},
            focusedGroupId: 'group:2',
            groups: [
                {
                    id: 'group:1',
                    tabKeys: ['file:a'],
                    activeTabKey: 'file:a',
                    tabs: [{ key: 'file:a', kind: 'file', title: 'a.txt', isPinned: true, isPreview: false, resource: { kind: 'file', path: 'a.txt' } }],
                    isFocused: false,
                },
                {
                    id: 'group:2',
                    tabKeys: ['file:b'],
                    activeTabKey: 'file:b',
                    tabs: [{ key: 'file:b', kind: 'file', title: 'b.txt', isPinned: true, isPreview: false, resource: { kind: 'file', path: 'b.txt' } }],
                    isFocused: true,
                },
            ],
            root: {
                kind: 'split',
                id: 'split:1',
                axis: 'row',
                ratio: 0.5,
                first: {
                    id: 'group:1',
                    kind: 'leaf',
                    leafKind: 'details-group',
                    payload: { groupId: 'group:1' },
                },
                second: {
                    id: 'group:2',
                    kind: 'leaf',
                    leafKind: 'details-group',
                    payload: { groupId: 'group:2' },
                },
            },
        },
        bottom: {
            isOpen: false,
            activeTabId: null,
            tabState: {},
        },
    },
    openRight: vi.fn(),
    closeRight: vi.fn(),
    setRightTab: vi.fn(),
    setRightTabState: vi.fn(),
    openBottom: vi.fn(),
    closeBottom: vi.fn(),
    setBottomTab: vi.fn(),
    setBottomTabState: vi.fn(),
    openDetailsTab: vi.fn(),
    replaceDetailsTab: vi.fn(),
    setDetailsTabState: vi.fn(),
    pinDetailsTab: vi.fn(),
    unpinDetailsTab: vi.fn(),
    closeDetails: vi.fn(),
    closeDetailsTab: vi.fn(),
    setActiveDetailsTab: vi.fn(),
    splitDetailsGroup: vi.fn(),
    moveDetailsTabToGroup: vi.fn(),
    focusDetailsGroup: vi.fn(),
    setMaximizedDetailsGroup: vi.fn(),
    setDetailsSplitRatio: vi.fn(),
    closeDetailsGroup: vi.fn(),
} satisfies AppPaneScopeApi;

describe('DetailsSplitWorkspace', () => {
    beforeEach(() => {
        splitCanvasHostSpy.mockReset();
        pane.splitDetailsGroup.mockReset();
    });

    it('renders every visible details group through the shared split canvas host', async () => {
        const { DetailsSplitWorkspace } = await import('./DetailsSplitWorkspace');

        const screen = await renderScreen(
            <DetailsSplitWorkspace
                pane={pane}
                renderTabContent={(tab) => React.createElement('TabContent', { tabKey: tab.key })}
            />,
        );

        expect(splitCanvasHostSpy).toHaveBeenCalledTimes(1);
        expect(screen.root.findAllByType('TabContent')).toHaveLength(2);
    });

    it('renders the empty details state without the shared split canvas host when no groups are open', async () => {
        const { DetailsSplitWorkspace } = await import('./DetailsSplitWorkspace');

        const screen = await renderScreen(
            <DetailsSplitWorkspace
                pane={{
                    ...pane,
                    scopeState: {
                        ...pane.scopeState!,
                        details: {
                            isOpen: false,
                            tabs: [],
                            activeTabKey: null,
                            tabState: {},
                            groups: [],
                            root: null,
                            focusedGroupId: null,
                            maximizedGroupId: null,
                        },
                    },
                }}
                renderTabContent={(tab) => React.createElement('TabContent', { tabKey: tab.key })}
            />,
        );

        expect(splitCanvasHostSpy).toHaveBeenCalledTimes(0);
        expect(screen.root.findAllByProps({ testID: 'pane-details-empty-state-title' }).length).toBeGreaterThan(0);
        expect(screen.root.findAllByType('TabContent')).toHaveLength(0);
    });

    it('coerces legacy flat details state through the shared split workspace host', async () => {
        const { DetailsSplitWorkspace } = await import('./DetailsSplitWorkspace');

        const screen = await renderScreen(
            <DetailsSplitWorkspace
                pane={{
                    ...pane,
                    scopeState: {
                        ...pane.scopeState!,
                        details: {
                            isOpen: true,
                            tabs: [
                                { key: 'file:a', kind: 'file', title: 'a.txt', isPinned: true, isPreview: false, resource: { kind: 'file', path: 'a.txt' } },
                                { key: 'file:b', kind: 'file', title: 'b.txt', isPinned: true, isPreview: false, resource: { kind: 'file', path: 'b.txt' } },
                            ],
                            activeTabKey: null,
                            tabState: {},
                        },
                    },
                }}
                renderTabContent={(tab) => React.createElement('TabContent', { tabKey: tab.key })}
            />,
        );

        expect(splitCanvasHostSpy).toHaveBeenCalledTimes(1);
        const [hostProps] = splitCanvasHostSpy.mock.calls[0] ?? [];
        expect(hostProps?.state.root).toEqual({
            id: 'group:legacy',
            kind: 'leaf',
            leafKind: 'details-group',
            payload: { groupId: 'group:legacy' },
        });
        expect(screen.root.findAllByType('TabContent')).toHaveLength(2);
    });

    it('exposes split requests for the focused details group through the shared split canvas host', async () => {
        const { DetailsSplitWorkspace } = await import('./DetailsSplitWorkspace');

        await renderScreen(
            <DetailsSplitWorkspace
                pane={pane}
                renderTabContent={(tab) => React.createElement('TabContent', { tabKey: tab.key })}
            />,
        );

        expect(splitCanvasHostSpy).toHaveBeenCalledTimes(1);
        const [hostProps] = splitCanvasHostSpy.mock.calls[0] ?? [];
        expect(hostProps).toMatchObject({
            onRequestSplitLeaf: expect.any(Function),
        });

        hostProps.onRequestSplitLeaf?.({ leafId: 'group:2', direction: 'right' });
        expect(pane.splitDetailsGroup).toHaveBeenCalledWith({
            axis: 'vertical',
            groupId: 'group:2',
            placement: 'after',
        });

        hostProps.onRequestSplitLeaf?.({ leafId: 'group:2', direction: 'down' });
        expect(pane.splitDetailsGroup).toHaveBeenCalledWith({
            axis: 'horizontal',
            groupId: 'group:2',
            placement: 'after',
        });

        hostProps.onRequestSplitLeaf?.({ leafId: 'group:2', direction: 'left' });
        expect(pane.splitDetailsGroup).toHaveBeenCalledWith({
            axis: 'vertical',
            groupId: 'group:2',
            placement: 'before',
        });

        hostProps.onRequestSplitLeaf?.({ leafId: 'group:2', direction: 'up' });
        expect(pane.splitDetailsGroup).toHaveBeenCalledWith({
            axis: 'horizontal',
            groupId: 'group:2',
            placement: 'before',
        });
    });

    it('keeps shared split-canvas keyboard handling enabled for details groups', async () => {
        const { DetailsSplitWorkspace } = await import('./DetailsSplitWorkspace');

        await renderScreen(
            <DetailsSplitWorkspace
                pane={pane}
                renderTabContent={(tab) => React.createElement('TabContent', { tabKey: tab.key })}
            />,
        );

        expect(splitCanvasHostSpy).toHaveBeenCalledTimes(1);
        const [hostProps] = splitCanvasHostSpy.mock.calls[0] ?? [];
        expect(hostProps).toMatchObject({
            keyboardEnabled: true,
        });
    });

    it('forwards split-canvas focus actions to the canonical details group focus API', async () => {
        const { DetailsSplitWorkspace } = await import('./DetailsSplitWorkspace');

        await renderScreen(
            <DetailsSplitWorkspace
                pane={pane}
                renderTabContent={(tab) => React.createElement('TabContent', { tabKey: tab.key })}
            />,
        );

        expect(splitCanvasHostSpy).toHaveBeenCalledTimes(1);
        const [hostProps] = splitCanvasHostSpy.mock.calls[0] ?? [];
        expect(hostProps).toMatchObject({
            dispatch: expect.any(Function),
        });

        hostProps.dispatch?.({
            type: 'focusLeaf',
            leafId: 'group:1',
        });

        expect(pane.focusDetailsGroup).toHaveBeenCalledWith('group:1');
    });
});
