import * as React from 'react';
import { Platform } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import type { SplitCanvasLeafNode, SplitCanvasNode } from '@/components/appShell/splitCanvas/model/splitCanvasTypes';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { usePluginSurfaceFocusEligibility } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

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

const nativeBack = vi.hoisted(() => ({
    addEventListener: vi.fn(() => ({ remove: () => {} })),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'node',
            select: <T,>(values: { default?: T; web?: T; native?: T; ios?: T; android?: T }) => (
                values.default ?? values.web ?? values.native ?? values.ios ?? values.android
            ),
        },
        BackHandler: {
            addEventListener: nativeBack.addEventListener,
        },
    });
});

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
            selectedDestination: null,
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
            selectedDestination: null,
            tabState: {},
        },
    },
    openRight: vi.fn(),
    closeRight: vi.fn(),
    setRightTab: vi.fn(),
    selectRightDestination: vi.fn(),
    setRightTabState: vi.fn(),
    openBottom: vi.fn(),
    closeBottom: vi.fn(),
    setBottomTab: vi.fn(),
    selectBottomDestination: vi.fn(),
    setBottomTabState: vi.fn(),
    openDetailsTab: vi.fn(),
    replaceDetailsTab: vi.fn(),
    setDetailsTabState: vi.fn(),
    pinDetailsTab: vi.fn(),
    unpinDetailsTab: vi.fn(),
    closeDetails: vi.fn(),
    openDetailsOverlay: vi.fn(),
    closeDetailsOverlay: vi.fn(),
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
        nativeBack.addEventListener.mockClear();
        pane.splitDetailsGroup.mockReset();
        pane.closeDetails.mockReset();
        pane.openRight.mockReset();
        pane.closeDetailsOverlay?.mockReset();
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

    it('keeps an inactive retained details tab mounted without allowing it to reactivate the parent focus fact', async () => {
        const { DetailsSplitWorkspace } = await import('./DetailsSplitWorkspace');
        const firstGroup = pane.scopeState!.details.groups![0]!;
        const inactiveTab = {
            ...firstGroup.tabs[0]!,
            key: 'file:c',
            title: 'c.txt',
            resource: { kind: 'file' as const, path: 'c.txt' },
        };
        const screen = await renderScreen(
            <DetailsSplitWorkspace
                pane={{
                    ...pane,
                    scopeState: {
                        ...pane.scopeState!,
                        details: {
                            ...pane.scopeState!.details,
                            groups: [
                                {
                                    ...firstGroup,
                                    tabKeys: ['file:a', 'file:c'],
                                    tabs: [firstGroup.tabs[0]!, inactiveTab],
                                    activeTabKey: 'file:a',
                                },
                                pane.scopeState!.details.groups![1]!,
                            ],
                        },
                    },
                }}
                renderTabContent={(tab) => (
                    <FocusEligibilityProbe testID={`details-tab-focus-${tab.key}`} />
                )}
            />,
        );

        expect(findFocusEligibilityProbe(screen.root, 'details-tab-focus-file:a').props.eligible).toBe(true);
        expect(findFocusEligibilityProbe(screen.root, 'details-tab-focus-file:c').props.eligible).toBe(false);
        expect(findFocusEligibilityProbe(screen.root, 'details-tab-focus-file:b').props.eligible).toBe(true);
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

    it('keeps the retained details workspace mounted but inert under a host-owned full-bleed overlay', async () => {
        const { DetailsSplitWorkspace } = await import('./DetailsSplitWorkspace');
        const overlay = {
            destination: { pluginId: 'com.example.viewer', localId: 'activity-log' },
            instanceKey: 'activity:run-1',
            returnFocusedGroupId: 'group:2',
            returnMaximizedGroupId: null,
            returnIsOpen: true,
        } as const;
        const screen = await renderScreen(
            <DetailsSplitWorkspace
                pane={{
                    ...pane,
                    scopeState: {
                        ...pane.scopeState!,
                        details: {
                            ...pane.scopeState!.details,
                            overlay,
                        },
                    },
                }}
                renderTabContent={(tab) => (
                    <FocusEligibilityProbe testID={`details-workspace-focus-${tab.key}`} />
                )}
                renderOverlay={(currentOverlay) => (
                    <FocusEligibilityProbe
                        testID="details-workspace-overlay-focus"
                        overlay={currentOverlay}
                    />
                )}
            />,
        );

        expect(splitCanvasHostSpy).toHaveBeenCalledTimes(1);
        expect(screen.root.findAllByType(FocusEligibilityProbe)).toHaveLength(3);
        expect(screen.root.findByProps({ testID: 'details-workspace-underlay' }).props).toMatchObject({
            pointerEvents: 'none',
            accessibilityElementsHidden: true,
            importantForAccessibility: 'no-hide-descendants',
        });
        expect(screen.root.findByProps({ testID: 'details-workspace-overlay' })).toBeTruthy();
        expect(findFocusEligibilityProbe(screen.root, 'details-workspace-focus-file:a').props.eligible).toBe(false);
        expect(findFocusEligibilityProbe(screen.root, 'details-workspace-focus-file:b').props.eligible).toBe(false);
        expect(findFocusEligibilityProbe(screen.root, 'details-workspace-overlay-focus').props).toMatchObject({
            eligible: true,
            overlay,
        });

        screen.root.findByProps({ testID: 'details-workspace-overlay-back' }).props.onPress();
        expect(pane.closeDetailsOverlay).toHaveBeenCalledTimes(1);

        screen.root.findByProps({ testID: 'details-workspace-overlay-reveal-right' }).props.onPress();
        expect(pane.closeDetails).toHaveBeenCalledTimes(1);
        expect(pane.openRight).toHaveBeenCalledTimes(1);
    });

    it('returns from the full-bleed overlay on Escape without closing the retained Details workspace', async () => {
        const { DetailsSplitWorkspace } = await import('./DetailsSplitWorkspace');
        const { dispatchEscapeToLayerStack } = await import('@/keyboard/escape');
        const originalPlatform = Platform.OS;
        const overlay = {
            destination: { pluginId: 'com.example.viewer', localId: 'activity-log' },
            instanceKey: 'activity:run-1',
            returnFocusedGroupId: 'group:2',
            returnMaximizedGroupId: null,
            returnIsOpen: true,
        } as const;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        let unmount: (() => Promise<void>) | null = null;

        try {
            const screen = await renderScreen(
                <DetailsSplitWorkspace
                    pane={{
                        ...pane,
                        scopeState: {
                            ...pane.scopeState!,
                            details: {
                                ...pane.scopeState!.details,
                                overlay,
                            },
                        },
                    }}
                    renderTabContent={(tab) => React.createElement('TabContent', { tabKey: tab.key })}
                />,
            );
            unmount = screen.unmount;
            const event = {
                key: 'Escape',
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
                stopImmediatePropagation: vi.fn(),
            };

            expect(dispatchEscapeToLayerStack(event)).toBe(true);
            expect(pane.closeDetailsOverlay).toHaveBeenCalledTimes(1);
            expect(pane.closeDetails).not.toHaveBeenCalled();
            expect(event.preventDefault).toHaveBeenCalledTimes(1);
        } finally {
            await unmount?.();
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
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

    it('uses the shared platform target size for every full-bleed overlay control', async () => {
        const { DetailsSplitWorkspace } = await import('./DetailsSplitWorkspace');
        const originalPlatform = Platform.OS;
        const overlay = {
            destination: { pluginId: 'com.example.viewer', localId: 'activity-log' },
            instanceKey: 'activity:run-1',
            returnFocusedGroupId: 'group:2',
            returnMaximizedGroupId: null,
            returnIsOpen: true,
        } as const;

        try {
            for (const platform of ['android', 'ios', 'web'] as const) {
                Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
                const screen = await renderScreen(
                    <DetailsSplitWorkspace
                        pane={{
                            ...pane,
                            scopeState: {
                                ...pane.scopeState!,
                                details: {
                                    ...pane.scopeState!.details,
                                    overlay,
                                },
                            },
                        }}
                        renderTabContent={(tab) => React.createElement('TabContent', { tabKey: tab.key })}
                    />,
                );
                const targetSize = resolveMinimumInteractiveTargetSize(platform);

                for (const testID of [
                    'details-workspace-overlay-back',
                    'details-workspace-overlay-focus-workspace',
                    'details-workspace-overlay-reveal-right',
                    'details-workspace-overlay-close',
                ]) {
                    const action = screen.root.findByProps({ testID });
                    const style = flattenStyle(action.props.style);
                    expect(style.minWidth).toBe(targetSize);
                    expect(style.minHeight).toBe(targetSize);
                }

                await screen.unmount();
            }
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
    });
});

function FocusEligibilityProbe(props: Readonly<{
    testID: string;
    overlay?: unknown;
}>): React.ReactElement {
    return React.createElement('FocusEligibilityProbe', {
        testID: props.testID,
        eligible: usePluginSurfaceFocusEligibility(),
        ...(props.overlay === undefined ? {} : { overlay: props.overlay }),
    });
}

function findFocusEligibilityProbe(root: ReactTestInstance, testID: string): ReactTestInstance {
    const probe = root
        .findAllByType('FocusEligibilityProbe')
        .find((candidate) => candidate.props.testID === testID);
    if (!probe) {
        throw new Error(`Missing focus eligibility probe: ${testID}`);
    }
    return probe;
}

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, entry) => ({ ...acc, ...flattenStyle(entry) }), {});
    }
    if (typeof style === 'object') return style as Record<string, unknown>;
    return {};
}
