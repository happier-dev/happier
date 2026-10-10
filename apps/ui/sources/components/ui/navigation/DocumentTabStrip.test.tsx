import * as React from 'react';
import { StyleSheet, View } from 'react-native';
import Color from 'color';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import { DocumentTabStrip } from './DocumentTabStrip';
import { createEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropRuntime';

installPanelCommonModuleMocks();

describe('DocumentTabStrip actions', () => {
    it('keeps active strip and raised tabs as ink within the containing material', async () => {
        const { AppShellMaterialFrame } = await import('@/components/navigation/shell/AppShellMaterialFrame');
        const { GlassMaterialSettingsProvider } = await import('@/components/ui/glass/useGlassMaterialSettings');
        const { GlassRuntimeEnvironmentProvider } = await import('@/components/ui/glass/glassRuntimeEnvironment');
        const { glassPresetMaterials } = await import('@/components/ui/glass/glassMaterial');
        const { useUnistyles } = await import('react-native-unistyles');
        const { theme } = useUnistyles();
        for (const reduceTransparency of [false, true]) for (const variant of ['strip', 'bar'] as const) {
            const screen = await renderScreen(<GlassRuntimeEnvironmentProvider value={{ desktopWindow: true, nativeWindowMaterialLive: true, reduceTransparency }}>
                <GlassMaterialSettingsProvider value={{ glassBlurEnabled: true, glassSurfaceMaterials: glassPresetMaterials('everywhere') }}>
                    <AppShellMaterialFrame showChrome={false} dragEnabled={false} leftOffsetPx={0} sidebarWidth={320} titleStrip={null} rail={null} column={null} peek={null}>
                        <DocumentTabStrip variant={variant} tabs={[{ key: 'active', title: 'Active', isPinned: false, isPreview: false }]} activeTabKey="active" accessibilityLabel="Documents"
                            onActivate={() => {}} onPin={() => {}} onUnpin={() => {}} onClose={() => {}} renderLeadingIcon={() => null} tabNativeId={id => id} panelNativeId={id => id}
                            testIds={{ tab: id => `material-tab-${id}` }} />
                    </AppShellMaterialFrame>
                </GlassMaterialSettingsProvider>
            </GlassRuntimeEnvironmentProvider>);
            let node = screen.findHostByTestId('material-tab-active');
            let paint: string | undefined;
            while (node && paint === undefined) {
                const color = StyleSheet.flatten(node.props.style)?.backgroundColor;
                if (typeof color === 'string') paint = color;
                else node = node.parent;
            }
            expect(paint).toBeDefined();
            if (reduceTransparency) expect(Color(paint).hexa()).toBe(Color(variant === 'strip' ? theme.colors.surface.elevated : theme.colors.surface.pressed).hexa());
            else expect(Color(paint).alpha()).toBeLessThan(1);
            await screen.unmount();
        }
    });
    it('offers the same semantic before-tab destination to keyboard and chooser carries', async () => {
        const runtime = createEntityDragDropRuntime();
        const scope = { serverId: 'home', accountId: 'account' };
        runtime.registerSource({ id: 'row', scope, isCurrent: () => true,
            getItem: () => ({ kind: 'destination', scope, href: '/inbox' }) });
        const writes: unknown[] = [];
        const screen = await renderScreen(<DocumentTabStrip
            variant="bar" tabs={[{ key: 'anchor', title: 'Anchor', isPinned: false, isPreview: false }]}
            activeTabKey="anchor" accessibilityLabel="Documents"
            onActivate={() => {}} onPin={() => {}} onUnpin={() => {}} onClose={() => {}}
            renderLeadingIcon={() => null} tabNativeId={id => id} panelNativeId={id => id}
            entityDragDrop={{
                runtime, id: 'strip', scope, acceptedKinds: ['destination', 'workspace-tab'],
                getItem: tabId => ({ kind: 'workspace-tab', scope, tabId }),
                resolve: ({ beforeTabId }) => ({ status: 'allowed', effect: {
                    actionId: 'workspace.tabs.open', input: { href: '/inbox', beforeTabId },
                    preview: { verb: 'Open', target: 'Anchor' },
                } }),
                execute: async effect => { writes.push(effect.input); return { status: 'applied' }; },
            }}
        />);
        const destinations = runtime.getDestinations('row');
        expect(destinations).toHaveLength(1);
        await act(async () => { await runtime.perform('row', destinations[0].targetId, destinations[0].destination); });
        expect(writes).toEqual([{ href: '/inbox', beforeTabId: 'anchor' }]);
        await screen.unmount();
        expect(runtime.getDestinations('row')).toEqual([]);
    });
    it('marks the gap before an admitting tab, and lights nothing where the strip refuses', async () => {
        const runtime = createEntityDragDropRuntime();
        const scope = { serverId: 'home', accountId: 'account' };
        runtime.registerSource({ id: 'row', scope, isCurrent: () => true,
            getItem: () => ({ kind: 'destination', scope, href: '/inbox' }) });
        const screen = await renderScreen(<DocumentTabStrip
            variant="bar" tabs={[
                { key: 'open', title: 'Open', isPinned: false, isPreview: false },
                { key: 'full', title: 'Full', isPinned: false, isPreview: false },
            ]}
            activeTabKey="open" accessibilityLabel="Documents"
            onActivate={() => {}} onPin={() => {}} onUnpin={() => {}} onClose={() => {}}
            renderLeadingIcon={() => null} tabNativeId={id => id} panelNativeId={id => id}
            entityDragDrop={{
                runtime, id: 'strip', scope, acceptedKinds: ['destination'],
                getItem: () => null,
                resolve: ({ beforeTabId }) => beforeTabId === 'open'
                    ? { status: 'allowed', effect: { actionId: 'workspace.tabs.open', input: { beforeTabId }, preview: { verb: 'Open', target: 'Open' } } }
                    : { status: 'refused', reason: { code: 'no', message: 'No' } },
                execute: async () => ({ status: 'applied' }),
            }}
        />);
        const targetFor = (key: string) => runtime.getDestinations('row').find(entry => entry.label === (key === 'open' ? 'Open' : 'Full'))!;
        const carry = runtime.begin('row', 'keyboard');
        act(() => carry?.choose(targetFor('open').targetId, targetFor('open').destination));
        expect(screen.findHostByTestId('document-tab-drop-before-open')).toBeTruthy();
        act(() => carry?.choose(targetFor('full').targetId, targetFor('full').destination));
        expect(screen.findHostByTestId('document-tab-drop-before-open')).toBeFalsy();
        expect(screen.findHostByTestId('document-tab-drop-before-full')).toBeFalsy();
        act(() => carry?.cancel());
        await screen.unmount();
    });
    it.each(['bar', 'strip'] as const)('keeps pinned needs-you status visible and named in the %s presentation', async (variant) => {
        const screen = await renderScreen(<DocumentTabStrip
            variant={variant}
            tabs={[{ key: 'session', title: 'Fix layout', isPinned: true, isPreview: false }]}
            activeTabKey="session" accessibilityLabel="Workspace"
            onActivate={() => {}} onPin={() => {}} onUnpin={() => {}} onClose={() => {}}
            renderLeadingIcon={() => null} tabNativeId={(id) => `tab-${id}`} panelNativeId={(id) => `panel-${id}`}
            resolveTabPresentation={() => ({ status: { tone: 'attention', label: 'Needs you' } })}
            testIds={{ tab: (id) => `tab-${id}`, tabStatus: (id) => `status-${id}` }}
        />);
        expect(screen.findHostByTestId('status-session')).toBeTruthy();
        expect(screen.findByTestId('tab-session')?.props.accessibilityLabel).toContain('Needs you');
    });

    it('keeps the Agent mark beside a background working spinner and the active close action', async () => {
        const screen = await renderScreen(<DocumentTabStrip
            variant="bar"
            tabs={[{ key: 'active', title: 'Open session', isPinned: false, isPreview: false }, { key: 'background', title: 'Working session', isPinned: false, isPreview: false }]}
            activeTabKey="active" accessibilityLabel="Workspace"
            onActivate={() => {}} onPin={() => {}} onUnpin={() => {}} onClose={() => {}}
            renderLeadingIcon={(tab) => <View testID={`agent-${tab.key}`} />}
            tabNativeId={(id) => `tab-${id}`} panelNativeId={(id) => `panel-${id}`}
            resolveTabPresentation={() => ({ status: { tone: 'working', label: 'Working' } })}
            testIds={{ tab: (id) => `tab-${id}`, tabSpinner: (id) => `spinner-${id}`, tabClose: (id) => `close-${id}` }}
        />);
        expect(screen.findHostByTestId('spinner-background')).toBeTruthy();
        expect(screen.findHostByTestId('spinner-active')).toBeFalsy();
        expect(screen.findByTestId('close-active')).toBeTruthy();
        expect(screen.findHostByTestId('agent-background')).toBeTruthy();
    });

    it('identifies each tab in its action names and preserves pin, unpin and unsaved close intent', async () => {
        const pin = vi.fn();
        const unpin = vi.fn();
        const close = vi.fn();
        const screen = await renderScreen(<DocumentTabStrip
            tabs={[
                { key: 'a', title: 'Alpha', isPinned: false, isPreview: true },
                { key: 'b', title: 'Beta', isPinned: true, isPreview: false },
            ]}
            activeTabKey="a" accessibilityLabel="Documents"
            onActivate={() => {}} onPin={pin} onUnpin={unpin} onClose={close}
            renderLeadingIcon={() => null} tabNativeId={(id) => `tab-${id}`} panelNativeId={(id) => `panel-${id}`}
            unsavedTabKeys={new Set(['b'])}
            testIds={{ tabPin: (id) => `pin-${id}`, tabUnpin: (id) => `unpin-${id}`, tabClose: (id) => `close-${id}` }}
        />);
        const pinButton = screen.findByTestId('pin-a');
        const unpinButton = screen.findByTestId('unpin-b');
        const closeButton = screen.findByTestId('close-b');
        expect(pinButton?.props.accessibilityLabel).toContain('Alpha');
        expect(unpinButton?.props.accessibilityLabel).toContain('Beta');
        expect(closeButton?.props.accessibilityLabel).toContain('Beta');
        expect(closeButton?.props.accessibilityLabel).toContain('closeUnsavedTabA11y');
        await act(async () => {
            pinButton?.props.onPress({ stopPropagation() {} });
            unpinButton?.props.onPress({ stopPropagation() {} });
            closeButton?.props.onPress({ stopPropagation() {} });
        });
        expect(pin).toHaveBeenCalledWith('a');
        expect(unpin).toHaveBeenCalledWith('b');
        expect(close).toHaveBeenCalledWith('b');
    });

    it('shows a tab\'s live status in its trailing slot and keeps close on the open tab without one (terminal lab B1)', async () => {
        const screen = await renderScreen(<DocumentTabStrip
            variant="bar"
            tabs={[
                { key: 'zsh', title: 'zsh', isPinned: false, isPreview: false },
                { key: 'vite', title: 'vite', isPinned: false, isPreview: false },
                { key: 'claude', title: 'Claude', isPinned: false, isPreview: false },
            ]}
            activeTabKey="zsh" accessibilityLabel="Terminals"
            onActivate={() => {}} onPin={() => {}} onUnpin={() => {}} onClose={() => {}}
            renderLeadingIcon={() => null} tabNativeId={(id) => `tab-${id}`} panelNativeId={(id) => `panel-${id}`}
            resolveTabPresentation={(tab) => tab.key === 'vite' ? { status: { tone: 'running', label: 'Running' } }
                : tab.key === 'claude' ? { status: { tone: 'attention', label: 'Needs you' } } : null}
            testIds={{ tab: (id) => `tab-${id}`, tabClose: (id) => `close-${id}`, tabStatus: (id) => `status-${id}` }}
        />);
        expect(screen.findByTestId('close-zsh')).toBeTruthy();
        expect(screen.findByTestId('status-zsh')).toBeFalsy();
        expect(screen.findByTestId('status-vite')).toBeTruthy();
        expect(screen.findByTestId('close-vite')).toBeFalsy();
        expect(screen.findByTestId('tab-claude')?.props.accessibilityLabel).toContain('Needs you');
    });
});
