import * as React from 'react';
import { Platform } from 'react-native';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { SplitCanvasHost } from '@/components/appShell/splitCanvas/components/SplitCanvasHost';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { usePluginSurfaceFocusEligibility } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { registerMountedTabUnsavedChangesGuard, runGuardedTabNavigation } from '@/utils/navigation/runGuardedNavigation';
import type { DetailsTabState } from './detailsWorkspaceTypes';

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

const pane = {
    scopeId: 'scope:details',
    scopeState: {
        mainHidden: false,
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
    setMainTab: vi.fn(),
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
    patchDetailsTabState: vi.fn(),
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

// Collect the real surface before timed behavior tests; per-test imports use this same module cache.
await import('./DetailsSplitWorkspace');

describe('DetailsSplitWorkspace', () => {
    it('defers unopened details bodies until presented and preserves visited drafts and passive lifetimes', async () => {
        const { DetailsTabGroupPanel } = await import('./DetailsTabGroupPanel');
        const firstGroup = pane.scopeState!.details.groups![0]!;
        const tabs = Array.from({ length: 20 }, (_, index) => ({
            ...firstGroup.tabs[0]!,
            key: `cold-details:${index}`,
            title: `${index}.txt`,
        }));
        const store = createStore(() => ({ revision: 0 }));
        const subscriptions = new Set<string>();
        const mounts: string[] = [];
        const unmounts: string[] = [];
        const rendered: string[] = [];
        const requestDecision = vi.fn(async () => 'keepEditing' as const);

        function StatefulDetailsBody({ tabKey }: { tabKey: string }) {
            const [draft, setDraft] = React.useState('');
            const [scroll, setScroll] = React.useState(0);
            const dirtyRef = React.useRef(false);
            dirtyRef.current = draft.length > 0;
            const subscribe = React.useCallback((notify: () => void) => {
                subscriptions.add(tabKey);
                const unsubscribe = store.subscribe(notify);
                return () => { subscriptions.delete(tabKey); unsubscribe(); };
            }, [tabKey]);
            const revision = React.useSyncExternalStore(subscribe, store.getState).revision;
            React.useEffect(() => {
                mounts.push(tabKey);
                const unregister = registerMountedTabUnsavedChangesGuard(tabKey, {
                    isDirtyRef: dirtyRef, tag: 'details-cold-mount-test', requestDecision,
                });
                return () => { unmounts.push(tabKey); unregister(); };
            }, [tabKey]);
            return React.createElement('StatefulDetailsBody', { tabKey, draft, scroll, revision, setDraft, setScroll });
        }

        const renderTabContent = (tab: DetailsTabState) => {
            rendered.push(tab.key);
            return <StatefulDetailsBody tabKey={tab.key} />;
        };
        const panel = (activeIndex: number, presented = true) => (
            <DetailsTabGroupPanel
                pane={pane}
                group={{ ...firstGroup, tabs, tabKeys: tabs.map(tab => tab.key), activeTabKey: tabs[activeIndex]!.key }}
                presented={presented}
                renderTabContent={renderTabContent}
            />
        );
        const screen = await renderScreen(panel(0, false));
        expect({ callbacks: rendered, mounts, subscriptions: [...subscriptions] }).toEqual({
            callbacks: [], mounts: [], subscriptions: [],
        });
        await screen.update(panel(0));
        expect([...subscriptions]).toEqual(['cold-details:0']);
        expect(new Set(rendered)).toEqual(new Set(['cold-details:0']));
        const body = () => screen.root.findAllByType('StatefulDetailsBody').find(node => node.props.tabKey === 'cold-details:0')!;
        await act(async () => {
            body().props.setDraft('unsaved draft');
            body().props.setScroll(240);
        });
        await screen.update(panel(1));
        await screen.update(panel(1, false));
        expect([...subscriptions]).toEqual(['cold-details:0', 'cold-details:1']);
        expect(mounts).toEqual(['cold-details:0', 'cold-details:1']);
        expect(unmounts).toEqual([]);
        const navigate = vi.fn();
        expect(await runGuardedTabNavigation(['cold-details:0'], navigate)).toBe(false);
        expect(requestDecision).toHaveBeenCalledOnce();
        expect(navigate).not.toHaveBeenCalled();
        await act(async () => { store.setState({ revision: 1 }); });
        await screen.update(panel(0));
        expect(body().props).toMatchObject({ draft: 'unsaved draft', scroll: 240, revision: 1 });
        expect(mounts).toEqual(['cold-details:0', 'cold-details:1']);
        expect(new Set(rendered)).toEqual(new Set(['cold-details:0', 'cold-details:1']));
    });
    it('keeps a group open when one of its retained editors declines closing', async () => {
        const { DetailsSplitWorkspace } = await import('./DetailsSplitWorkspace');
        const requestDecision = vi.fn(async () => 'keepEditing' as const);
        const remove = registerMountedTabUnsavedChangesGuard('file:a', { isDirtyRef: { current: true }, tag: 'file-editor', requestDecision });
        const closeDetailsGroup = vi.fn();
        try {
            const screen = await renderScreen(<DetailsSplitWorkspace pane={{ ...pane, closeDetailsGroup }} renderTabContent={() => null} />);
            await act(async () => {
                screen.findAllByType(SplitCanvasHost)[0]!.props.dispatch({ type: 'closeLeaf', leafId: 'group:1' });
            });
            expect(requestDecision).toHaveBeenCalledTimes(1);
            expect(closeDetailsGroup).not.toHaveBeenCalled();
        } finally { remove(); }
    });
    beforeEach(() => {
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

        expect(screen.findAllByType(SplitCanvasHost)).toHaveLength(1);
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

        expect(screen.findAllByType(SplitCanvasHost)).toHaveLength(0);
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

        expect(screen.findAllByType(SplitCanvasHost)).toHaveLength(1);
        const hostProps = screen.findByType(SplitCanvasHost).props;
        expect(hostProps?.state.root).toEqual({
            id: 'group:legacy',
            kind: 'leaf',
            leafKind: 'details-group',
            payload: { groupId: 'group:legacy' },
        });
        expect(screen.root.findAllByType('TabContent').map(node => node.props.tabKey)).toEqual(['file:b']);
    });

    it('keeps a visited details tab mounted without allowing it to reactivate presentation or the parent focus fact', async () => {
        const { DetailsSplitWorkspace } = await import('./DetailsSplitWorkspace');
        const firstGroup = pane.scopeState!.details.groups![0]!;
        const inactiveTab = {
            ...firstGroup.tabs[0]!,
            key: 'file:c',
            title: 'c.txt',
            resource: { kind: 'file' as const, path: 'c.txt' },
        };
        const presentation = new Map<string, boolean>();
        const workspace = (activeTabKey: string) => (
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
                                    activeTabKey,
                                },
                                pane.scopeState!.details.groups![1]!,
                            ],
                        },
                    },
                }}
                renderTabContent={(tab, tabPresentation) => {
                    presentation.set(tab.key, tabPresentation.active);
                    return <FocusEligibilityProbe testID={`details-tab-focus-${tab.key}`} />;
                }}
            />
        );
        const screen = await renderScreen(workspace('file:c'));
        await screen.update(workspace('file:a'));

        expect(findFocusEligibilityProbe(screen.root, 'details-tab-focus-file:a').props.eligible).toBe(true);
        expect(findFocusEligibilityProbe(screen.root, 'details-tab-focus-file:c').props.eligible).toBe(false);
        expect(findFocusEligibilityProbe(screen.root, 'details-tab-focus-file:b').props.eligible).toBe(true);
        expect(Object.fromEntries(presentation)).toEqual({
            'file:a': true,
            'file:c': false,
            'file:b': true,
        });
    });

    it('reports no tab presented for a group hidden behind a maximized sibling', async () => {
        // A maximized group is the only one on screen — the same definition the
        // Board's own visibility owner uses. Its siblings stay mounted for
        // continuity, so their active tab must not keep owning an editor.
        const { DetailsSplitWorkspace } = await import('./DetailsSplitWorkspace');
        const presentation = new Map<string, boolean>();

        const screen = await renderScreen(
            <DetailsSplitWorkspace
                pane={pane}
                renderTabContent={(tab, tabPresentation) => {
                    presentation.set(tab.key, tabPresentation.active);
                    return React.createElement('TabContent', { tabKey: tab.key });
                }}
            />,
        );

        await act(async () => {
            screen.findByTestId('split-canvas-host')!.props.onLayout({
                nativeEvent: { layout: { width: 1200, height: 800 } },
            });
        });
        await screen.update(
            <DetailsSplitWorkspace
                pane={{ ...pane, scopeState: { ...pane.scopeState!, details: { ...pane.scopeState!.details, maximizedGroupId: 'group:2' } } }}
                renderTabContent={(tab, tabPresentation) => {
                    presentation.set(tab.key, tabPresentation.active);
                    return React.createElement('TabContent', { tabKey: tab.key });
                }}
            />,
        );
        expect(Object.fromEntries(presentation)).toEqual({
            'file:a': false,
            'file:b': true,
        });
    });

    it('exposes split requests for the focused details group through the shared split canvas host', async () => {
        const { DetailsSplitWorkspace } = await import('./DetailsSplitWorkspace');

        const screen = await renderScreen(
            <DetailsSplitWorkspace
                pane={pane}
                renderTabContent={(tab) => React.createElement('TabContent', { tabKey: tab.key })}
            />,
        );

        expect(screen.findAllByType(SplitCanvasHost)).toHaveLength(1);
        const hostProps = screen.findByType(SplitCanvasHost).props;
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

        const screen = await renderScreen(
            <DetailsSplitWorkspace
                pane={pane}
                renderTabContent={(tab) => React.createElement('TabContent', { tabKey: tab.key })}
            />,
        );

        expect(screen.findAllByType(SplitCanvasHost)).toHaveLength(1);
        const hostProps = screen.findByType(SplitCanvasHost).props;
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

        expect(screen.findAllByType(SplitCanvasHost)).toHaveLength(1);
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

        const screen = await renderScreen(
            <DetailsSplitWorkspace
                pane={pane}
                renderTabContent={(tab) => React.createElement('TabContent', { tabKey: tab.key })}
            />,
        );

        expect(screen.findAllByType(SplitCanvasHost)).toHaveLength(1);
        const hostProps = screen.findByType(SplitCanvasHost).props;
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
