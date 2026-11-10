import * as React from 'react';
import { layoutHitArea } from '@/dev/testkit/harness/hitFrameReach';
import { Platform } from 'react-native';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import type { DetailsTabState, DetailsWorkspaceGroupView } from './detailsWorkspaceTypes';
import { registerMountedTabUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';

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

function createPane(): AppPaneScopeApi {
    return {
        scopeId: 'scope:details',
        scopeState: {},
        openRight: vi.fn(),
        closeRight: vi.fn(),
        setRightTab: vi.fn(),
        setRightTabState: vi.fn(),
        openBottom: vi.fn(),
        closeBottom: vi.fn(),
        setBottomTab: vi.fn(),
        setBottomTabState: vi.fn(),
        openDetailsTab: vi.fn(),
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
    } as unknown as AppPaneScopeApi;
}

function browserViewTab(): DetailsTabState {
    return {
        key: 'browser-view:bs:bv',
        kind: 'browser-view',
        title: 'Docs',
        isPinned: false,
        isPreview: false,
        resource: { kind: 'browser-view', browserSessionId: 'bs', viewId: 'bv', target: { kind: 'externalUrl', targetId: 't', url: 'https://docs.test/' } },
    };
}

function group(tab: DetailsTabState): DetailsWorkspaceGroupView {
    return {
        id: 'group:1',
        tabKeys: [tab.key],
        activeTabKey: tab.key,
        tabs: [tab],
        isFocused: true,
    };
}

const testIds = {
    tab: (k: string) => `tab-${k}`,
    tabPin: (k: string) => `tab-pin-${k}`,
    tabUnpin: (k: string) => `tab-unpin-${k}`,
    tabClose: (k: string) => `tab-close-${k}`,
    tabFavicon: (k: string) => `tab-favicon-${k}`,
    tabSpinner: (k: string) => `tab-spinner-${k}`,
};

// Load the real surface during collection, outside individual gesture decision budgets.
await import('./DetailsTabStrip');

describe('DetailsTabStrip chrome absorption for browser-view tabs', () => {
    it('gives an SCM review tab the supported diff glyph', async () => {
        const { resolveDetailsTabGlyph } = await import('./DetailsTabStrip');
        const tab: DetailsTabState = {
            key: 'scmReview:review', kind: 'scmReview', title: 'Review', isPinned: false, isPreview: false,
            resource: { kind: 'scmReview' },
        };
        expect(resolveDetailsTabGlyph(tab)).toBe('git-diff');
    });

    it('keeps 120 Details tab visual callbacks local to the changed tab', async () => {
        const { DetailsTabStrip } = await import('./DetailsTabStrip');
        const { WorkspaceDestinationRow } = await import('@/components/appShell/workspace/WorkspaceDestinationRow');
        const pane = createPane();
        const tabs: DetailsTabState[] = Array.from({ length: 120 }, (_, index) => ({
            ...browserViewTab(), key: `browser-view:bs:view-${index}`, title: `Document ${index}`,
            resource: { kind: 'browser-view', browserSessionId: 'bs', viewId: `view-${index}`,
                target: { kind: 'externalUrl', targetId: `target-${index}`, url: `https://docs.test/page/${index}` } },
        }));
        const originalGroup = { ...group(tabs[0]!), tabs, tabKeys: tabs.map(tab => tab.key) };
        const resolveIcon = vi.fn((_tab: DetailsTabState) => 'circle');
        const resolveHref = vi.fn((tab: DetailsTabState) => `/docs?title=${encodeURIComponent(tab.title)}`);
        const screen = await renderScreen(<DetailsTabStrip pane={pane} group={originalGroup}
            resolveTabIconName={resolveIcon} resolveTabHref={resolveHref} testIds={testIds} />);
        try {
            expect(resolveIcon).toHaveBeenCalledTimes(120);
            resolveIcon.mockClear(); resolveHref.mockClear();
            await screen.update(<DetailsTabStrip pane={pane} group={{ ...originalGroup, isFocused: false }}
                resolveTabIconName={resolveIcon} resolveTabHref={resolveHref} testIds={testIds} />);
            const focusWork = [resolveIcon.mock.calls.length, resolveHref.mock.calls.length];
            resolveIcon.mockClear(); resolveHref.mockClear();
            const renamed = tabs.map((tab, index) => index === 42 ? { ...tab, title: 'Renamed document' } : tab);
            const renamedGroup = { ...originalGroup, isFocused: false, tabs: renamed };
            await screen.update(<DetailsTabStrip pane={pane} group={renamedGroup}
                resolveTabIconName={resolveIcon} resolveTabHref={resolveHref} testIds={testIds} />);
            expect([focusWork, [resolveIcon.mock.calls.length, resolveHref.mock.calls.length]])
                .toEqual([[0, 0], [1, 1]]);
            expect(screen.findAllByType(WorkspaceDestinationRow)[42]!.props.href).toBe('/docs?title=Renamed%20document');

            // Visual callback changes are real inputs, not hidden behind latest-value refs.
            const replacementIcon = vi.fn((_tab: DetailsTabState) => 'terminal');
            const replacementHref = (tab: DetailsTabState) => `/replacement/${tab.key}`;
            await screen.update(<DetailsTabStrip pane={pane} group={renamedGroup}
                resolveTabIconName={replacementIcon} resolveTabHref={replacementHref} testIds={testIds} />);
            expect(replacementIcon).toHaveBeenCalledTimes(120);
            expect(screen.findAllByType(WorkspaceDestinationRow)[42]!.props.href).toBe(`/replacement/${renamed[42]!.key}`);
        } finally { await screen.unmount(); }
    });

    it.each([
        ['keepEditing', 'x'], ['save', 'x'], ['discard', 'x'],
        ['keepEditing', 'middle'], ['save', 'middle'], ['discard', 'middle'],
        ['keepEditing', 'opened'], ['save', 'opened'], ['discard', 'opened'],
    ] as const)('guards a dirty close and handles %s through %s', async (decision, entryPoint) => {
        const { DetailsTabStrip } = await import('./DetailsTabStrip');
        const { WorkspaceDestinationRow } = await import('@/components/appShell/workspace/WorkspaceDestinationRow');
        const originalPlatform = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        const pane = createPane();
        const tab = browserViewTab();
        const requestDecision = vi.fn(async () => decision);
        const onDiscard = vi.fn();
        const remove = registerMountedTabUnsavedChangesGuard(tab.key, {
            isDirtyRef: { current: true }, tag: 'test-editor', requestDecision,
            onSave: async () => false, onDiscard,
        });
        try {
            const screen = await renderScreen(<DetailsTabStrip pane={pane} group={group(tab)} testIds={testIds} />);
            await act(async () => {
                if (entryPoint === 'x') screen.findByTestId('tab-close-browser-view_bs_bv')?.props.onPress({});
                else if (entryPoint === 'middle') screen.findByTestId('tab-browser-view_bs_bv')?.props.onAuxClick?.({ button: 1, preventDefault: vi.fn(), stopPropagation: vi.fn() });
                else screen.findAllByType(WorkspaceDestinationRow)[0]!.props.onOpened();
            });
            expect(requestDecision).toHaveBeenCalledTimes(1);
            expect(pane.closeDetailsTab).toHaveBeenCalledTimes(decision === 'discard' ? 1 : 0);
            expect(onDiscard).toHaveBeenCalledTimes(decision === 'discard' ? 1 : 0);
        } finally {
            remove();
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
    });
    it('falls back to the globe for a browser-view tab when no surface names its icon', async () => {
        // UI-17 r5: the Session Details strip passes no browser icon resolver, so a page tab drew the
        // generic circle instead of the globe every other browser strip shows (lab Q).
        const { DetailsTabStrip } = await import('./DetailsTabStrip');
        const { Icon } = await import('@/components/ui/icons/Icon');
        const tab = browserViewTab();
        const screen = await renderScreen(
            <DetailsTabStrip pane={createPane()} group={group(tab)} testIds={testIds} />,
        );
        try {
            expect(screen.findAllByType(Icon).map(icon => icon.props.name)).toContain('globe');
        } finally { await screen.unmount(); }
    });

    it('renders a favicon for a browser-view tab via the generic presentation hook', async () => {
        const { DetailsTabStrip } = await import('./DetailsTabStrip');
        const tab = browserViewTab();
        const screen = await renderScreen(
            <DetailsTabStrip
                pane={createPane()}
                group={group(tab)}
                resolveTabPresentation={() => ({ faviconUrl: 'https://docs.test/favicon.ico', isLoading: false })}
                testIds={testIds}
            />,
        );
        expect(screen.findByTestId('tab-favicon-browser-view_bs_bv')).not.toBeNull();
    });

    it('renders a loading spinner while the browser-view tab is loading', async () => {
        const { DetailsTabStrip } = await import('./DetailsTabStrip');
        const tab = browserViewTab();
        const screen = await renderScreen(
            <DetailsTabStrip
                pane={createPane()}
                group={group(tab)}
                resolveTabPresentation={() => ({ faviconUrl: 'https://docs.test/favicon.ico', isLoading: true })}
                testIds={testIds}
            />,
        );
        expect(screen.findByTestId('tab-spinner-browser-view_bs_bv')).not.toBeNull();
    });

    it('exposes a per-tab close affordance routed to the workspace pane', async () => {
        const { DetailsTabStrip } = await import('./DetailsTabStrip');
        const pane = createPane();
        const tab = browserViewTab();
        const screen = await renderScreen(
            <DetailsTabStrip
                pane={pane}
                group={group(tab)}
                resolveTabPresentation={() => ({ faviconUrl: null, isLoading: false })}
                testIds={testIds}
            />,
        );
        const close = screen.findByTestId('tab-close-browser-view_bs_bv');
        expect(close).not.toBeNull();
        close?.props.onPress({});
        expect(pane.closeDetailsTab).toHaveBeenCalledWith(tab.key);
    });

    it('exposes the group tabs as a selected tablist rather than independent buttons', async () => {
        const { DetailsTabStrip } = await import('./DetailsTabStrip');
        const activeTab = browserViewTab();
        const inactiveTab: DetailsTabState = {
            key: 'file:readme',
            kind: 'file',
            title: 'README.md',
            isPinned: false,
            isPreview: false,
            resource: { kind: 'file', path: 'README.md' },
        };
        const screen = await renderScreen(
            <DetailsTabStrip
                pane={createPane()}
                group={{
                    ...group(activeTab),
                    tabKeys: [activeTab.key, inactiveTab.key],
                    tabs: [activeTab, inactiveTab],
                }}
                testIds={testIds}
            />,
        );

        expect(screen.root.findAllByProps({ accessibilityRole: 'tablist' })).toHaveLength(1);
        expect(screen.findByTestId('tab-browser-view_bs_bv')?.props).toMatchObject({
            accessibilityRole: 'tab',
            accessibilityState: { selected: true },
            'aria-selected': true,
        });
        expect(screen.findByTestId('tab-file_readme')?.props).toMatchObject({
            accessibilityRole: 'tab',
            accessibilityState: { selected: false },
            'aria-selected': false,
        });
        expect(screen.findByTestId('tab-browser-view_bs_bv')?.props).toMatchObject({
            tabIndex: 0,
            nativeID: 'details-group_1-tab-browser-view_bs_bv',
            'aria-controls': 'details-group_1-panel-browser-view_bs_bv',
        });
        expect(screen.findByTestId('tab-file_readme')?.props.tabIndex).toBe(-1);
    });

    it('uses the shared RTL-aware roving keyboard contract for outer Details tabs', async () => {
        const { DetailsTabStrip } = await import('./DetailsTabStrip');
        // Roving arrow keys are a web keyboard contract (native tabs are reached by the screen reader).
        const originalPlatform = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        const pane = createPane();
        const activeTab = browserViewTab();
        const inactiveTab: DetailsTabState = {
            key: 'file:readme',
            kind: 'file',
            title: 'README.md',
            isPinned: false,
            isPreview: false,
            resource: { kind: 'file', path: 'README.md' },
        };
        const screen = await renderScreen(
            <DetailsTabStrip
                pane={pane}
                group={{
                    ...group(activeTab),
                    tabKeys: [activeTab.key, inactiveTab.key],
                    tabs: [activeTab, inactiveTab],
                }}
                testIds={testIds}
            />,
        );

        const event = { key: 'ArrowRight', preventDefault: vi.fn() };
        screen.findByTestId('tab-browser-view_bs_bv')?.props.onKeyDown?.(event);
        expect(event.preventDefault).toHaveBeenCalledTimes(1);
        expect(pane.setActiveDetailsTab).toHaveBeenCalledWith(inactiveTab.key);
        Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
    });

    it('gives a finger the platform touch floor and keeps the strip dense under a precise pointer', async () => {
        const { DetailsTabStrip } = await import('./DetailsTabStrip');
        const originalPlatform = Platform.OS;
        const tab = { ...browserViewTab(), isPreview: true };

        try {
            for (const platform of ['android', 'ios', 'web'] as const) {
                Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
                const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
                const screen = await renderScreen(
                    <HappierUiPlatformProvider platform={{ platform, colorScheme: 'light' }}>
                        <DetailsTabStrip
                            pane={createPane()}
                            group={group(tab)}
                            testIds={testIds}
                        />
                    </HappierUiPlatformProvider>,
                );
                const floor = platform === 'web' ? 24 : platform === 'android' ? 48 : 44;

                // The strip stays dense under every pointer: its tab and controls keep their design size and
                // a finger reaches the platform floor through the hit area.
                const tabStyle = flattenStyle(screen.findByTestId('tab-browser-view_bs_bv')?.props.style);
                expect(tabStyle.minHeight ?? 28).toBe(28);
                for (const testID of ['tab-pin-browser-view_bs_bv', 'tab-close-browser-view_bs_bv']) {
                    const style = flattenStyle(screen.findByTestId(testID)?.props.style);
                    const drawn = { width: Number(style.width ?? style.minWidth), height: Number(style.height ?? style.minHeight) };
                    expect(drawn, `${platform} ${testID} drawn`).toEqual({ width: 24, height: 24 });
                    const area = await layoutHitArea(() => screen.findByTestId(testID), drawn);
                    expect(area.height, `${platform} ${testID} hit height`).toBeGreaterThanOrEqual(floor);
                    expect(area.width, `${platform} ${testID} hit width`).toBeGreaterThanOrEqual(24);
                }

                await screen.unmount();
            }
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
    });

    it('keeps pin and close targets in a sibling action region rather than over the tab target', async () => {
        const { DetailsTabStrip } = await import('./DetailsTabStrip');
        const tab = { ...browserViewTab(), isPreview: true };
        const screen = await renderScreen(
            <DetailsTabStrip
                pane={createPane()}
                group={group(tab)}
                testIds={testIds}
            />,
        );
        const tabTarget = screen.findByTestId('tab-browser-view_bs_bv');
        const pin = screen.findByTestId('tab-pin-browser-view_bs_bv');
        const close = screen.findByTestId('tab-close-browser-view_bs_bv');
        const actionRegion = close?.parent;
        if (!tabTarget || !pin || !close || !actionRegion) {
            throw new Error('Expected the tab and both trailing action targets');
        }

        expect(flattenStyle(tabTarget.props.style).flex).toBe(1);
        expect(flattenStyle(actionRegion.props.style).position).toBeUndefined();
        expect(pin.props.hitSlop ?? 0).toBe(0);
        expect(close.props.hitSlop ?? 0).toBe(0);
    });
});

describe('DetailsTabStrip unsaved tabs', () => {
    it('marks a tab whose content reports unsaved edits, and says so on its close control', async () => {
        const { DetailsTabGroupPanel } = await import('./DetailsTabGroupPanel');
        const { useDetailsTabChrome } = await import('./detailsTabChrome');
        const tab: DetailsTabState = {
            key: 'file:src/a.ts',
            kind: 'file',
            title: 'a.ts',
            isPinned: true,
            isPreview: false,
            resource: { kind: 'file', path: 'src/a.ts' },
        };
        let reportUnsaved: ((unsaved: boolean) => void) | null = null;
        function EditorContent() {
            const chrome = useDetailsTabChrome();
            reportUnsaved = chrome.setUnsaved;
            return null;
        }
        const screen = await renderScreen(
            <DetailsTabGroupPanel
                pane={createPane()}
                group={group(tab)}
                testIds={{ ...testIds, tabUnsaved: (k: string) => `tab-unsaved-${k}` }}
                renderTabContent={() => <EditorContent />}
            />,
        );
        expect(screen.findByTestId('tab-unsaved-file_src_a.ts')).toBeNull();

        await act(async () => { reportUnsaved?.(true); });
        expect(screen.findByTestId('tab-unsaved-file_src_a.ts')).not.toBeNull();
        expect(screen.findByTestId('tab-close-file_src_a.ts')?.props.accessibilityLabel)
            .toContain('detailsSurface.chrome.closeUnsavedTabA11y');
        expect(screen.findByTestId('tab-close-file_src_a.ts')?.props.accessibilityLabel).toContain(tab.title);

        await act(async () => { reportUnsaved?.(false); });
        expect(screen.findByTestId('tab-unsaved-file_src_a.ts')).toBeNull();
    });
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    // The native Pressable boundary asks its real style callback for the resting target geometry.
    if (typeof style === 'function') return flattenStyle(style({ pressed: false, hovered: false, focused: false }));
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, entry) => ({ ...acc, ...flattenStyle(entry) }), {});
    }
    if (typeof style === 'object') return style as Record<string, unknown>;
    return {};
}
