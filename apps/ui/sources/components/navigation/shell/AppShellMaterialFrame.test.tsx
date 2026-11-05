/** @vitest-environment jsdom */
import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

import { AppShellMaterialFrame, resolveColumnDrawnWidthPx } from './AppShellMaterialFrame';
import { lightTheme } from '@/theme';
import { applyGlassDocumentPresentation } from '@/components/ui/glass/glassDocumentPresentation';
import { glassPresetMaterials } from '@/components/ui/glass/glassMaterial';
import { GlassRuntimeEnvironmentProvider } from '@/components/ui/glass/glassRuntimeEnvironment';
import { GlassMaterialSettingsProvider } from '@/components/ui/glass/useGlassMaterialSettings';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { StyleSheet, View } from 'react-native';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

function ChromeLifetimeProbe() {
    const [identity] = React.useState(() => ({}));
    return React.createElement('ChromeLifetimeBoundary', { identity, active: useLayoutPresentationActive() });
}

function alphaAt(leaf: ReactTestInstance, doc: Document) {
    let remaining = 1;
    for (let node: ReactTestInstance | null = leaf; node; node = node.parent) {
        if (typeof node.type !== 'string') continue;
        // Material background siblings paint this region without becoming content ancestors.
        const coats = node.findAll(child => {
            if (typeof child.type !== 'string' || child.props.dataSet?.happyGlassBackdrop !== 'true') return false;
            let parent = child.parent;
            while (parent && typeof parent.type !== 'string') parent = parent.parent;
            return parent === node;
        });
        for (const layer of [node, ...coats]) {
            const color = StyleSheet.flatten(layer.props.style)?.backgroundColor;
            if (typeof color !== 'string' || color === 'transparent') continue;
            const variable = color.match(/var\((--happier-glass-(?:chrome|sidebar|content|floating)-(?:nested-)?(?:plane-)?opacity),/);
            const alpha = variable ? parseFloat(doc.documentElement.style.getPropertyValue(variable[1]!)) / 100 : 1;
            remaining *= 1 - alpha;
        }
    }
    return 1 - remaining;
}

describe('real shell material planes', () => {
    it('parks the document chrome without replacing its lifetime when the phone hides it', async () => {
        const frame = (wide: boolean) => <AppShellMaterialFrame showChrome={wide} dragEnabled={false}
            leftOffsetPx={0} sidebarWidth={320} titleStrip={<ChromeLifetimeProbe />} rail={null} column={null} peek={null}>
            <View testID="responsive-route" />
        </AppShellMaterialFrame>;
        const screen = await renderScreen(frame(true));
        try {
            const identity = screen.root.findByType('ChromeLifetimeBoundary').props.identity;
            const route = screen.findHostByTestId('responsive-route');
            await screen.update(frame(false));
            expect(screen.root.findByType('ChromeLifetimeBoundary').props).toMatchObject({ identity, active: false });
            expect(screen.root.findByType('ChromeLifetimeBoundary').props.identity).toBe(identity);
            expect(screen.findHostByTestId('responsive-route')).toBe(route);
            await screen.update(frame(true));
            expect(screen.root.findByType('ChromeLifetimeBoundary').props).toMatchObject({ identity, active: true });
            expect(screen.root.findByType('ChromeLifetimeBoundary').props.identity).toBe(identity);
            expect(screen.findHostByTestId('responsive-route')).toBe(route);
        } finally {
            await screen.unmount();
        }
    });
    it('blurs wallpaper beside chrome/sidebar content without making either plane a popover backdrop root', async () => {
        const screen = await renderScreen(<GlassRuntimeEnvironmentProvider value={{ atmosphereBehind: 'wallpaper' }}>
            <GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('clear') }}>
                <AppShellMaterialFrame showChrome dragEnabled={false} leftOffsetPx={384} sidebarWidth={320}
                    titleStrip={<GlassSurface><View testID="chrome-popover" /></GlassSurface>} rail={null}
                    column={<GlassSurface><View testID="sidebar-popover" /></GlassSurface>} peek={null}><View /></AppShellMaterialFrame>
            </GlassMaterialSettingsProvider>
        </GlassRuntimeEnvironmentProvider>);
        const backdrop = (node: ReactTestInstance) => typeof node.type === 'string'
            && typeof StyleSheet.flatten(node.props.style)?.backdropFilter === 'string';
        // The two floating surfaces plus the title, sidebar, two edge strips and the four page-corner cutouts.
        expect(screen.findAll(backdrop)).toHaveLength(10);
        for (const id of ['chrome-popover', 'sidebar-popover']) {
            for (let node = screen.findHostByTestId(id)?.parent; node; node = node.parent) {
                expect(backdrop(node)).toBe(false);
            }
        }
    });
    it('applies each coat once in its own region with live material variables', async () => {
        const screen = await renderScreen(<AppShellMaterialFrame showChrome dragEnabled={false} leftOffsetPx={384} sidebarWidth={320}
            titleStrip={<View testID="title" />} rail={<View testID="rail" />}
            column={<View testID="sidebar-body" />} peek={null}><View testID="content" /></AppShellMaterialFrame>);
        const doc = document.implementation.createHTMLDocument();
        const check = (materials: ReturnType<typeof glassPresetMaterials>) => {
            const stop = applyGlassDocumentPresentation(doc, { glassSurfaceMaterials: materials }, { desktopWindow: true, nativeWindowMaterialLive: true });
            try {
                for (const [id, group] of [['title', 'chrome'], ['rail', 'chrome'], ['sidebar-body', 'sidebar'], ['content', 'content']] as const) {
                    expect(alphaAt(screen.findHostByTestId(id)!, doc), id).toBeCloseTo(materials[group].opacity);
                }
            } finally { stop(); }
        };
        for (const opacity of [0.2, 0.8]) check({ ...glassPresetMaterials('everywhere'), chrome: { blur: 'regular', opacity }, sidebar: { blur: 'off', opacity: 0 }, content: { blur: 'off', opacity: 1 } });
        check(glassPresetMaterials('everywhere'));
        check(glassPresetMaterials('auto'));
        check(glassPresetMaterials('solid'));
    });

    it('coats the cutouts outside every rounded page corner once, with the canvas beside them, and nothing behind the page or a canvas panel', async () => {
        // Contrasting coats: a bare cutout reads 0, the chrome canvas 0.2, the column plane 0.7. Everything on the
        // trailing side is the canvas the left rail stands on (R11-1), never the column's plane.
        const materials = { ...glassPresetMaterials('everywhere'), chrome: { blur: 'off', opacity: 0.2 }, sidebar: { blur: 'off', opacity: 0.7 }, content: { blur: 'off', opacity: 0.45 } } as const;
        const frame = (column: boolean, placement: 'separate' | 'line' | 'shadow') => <AppShellMaterialFrame showChrome dragEnabled={false}
            leftOffsetPx={column ? 384 : 64} sidebarWidth={column ? 320 : 0} rightPanelPlacement={placement}
            titleStrip={<View testID="title" />} rail={<View testID="rail" />}
            column={column ? <View testID="sidebar-body" /> : null} peek={<View testID="peek-probe" />}><View testID="content" /></AppShellMaterialFrame>;
        const screen = await renderScreen(frame(true, 'separate'));
        const doc = document.implementation.createHTMLDocument();
        const stop = applyGlassDocumentPresentation(doc, { glassSurfaceMaterials: materials }, { desktopWindow: true, nativeWindowMaterialLive: true });
        try {
            const style = (node: ReactTestInstance) => StyleSheet.flatten(node.props.style) ?? {};
            for (const [column, placement] of [[true, 'separate'], [false, 'separate'], [true, 'line'], [false, 'shadow']] as const) {
                await screen.update(frame(column, placement));
                const leading = column ? materials.sidebar.opacity : materials.chrome.opacity;
                for (const [corner, at, expected] of [
                    ['tl', '100% 100%', leading], ['bl', '100% 0%', leading],
                    ['tr', '0% 100%', materials.chrome.opacity], ['br', '0% 0%', materials.chrome.opacity],
                ] as const) {
                    const cutout = screen.findHostByTestId(`app-shell-sheet-corner-${corner}`);
                    expect(cutout, `${corner} ${placement}`).not.toBeNull();
                    // The coat covers only what lies outside the page's curve.
                    expect(String(style(cutout!).maskImage), corner).toContain(`circle at ${at}, transparent 11.5px`);
                    expect(alphaAt(cutout!.findAll(node => typeof node.type === 'string' && node.props.dataSet?.happyGlassBackdrop !== 'true').at(-1)!, doc), `${corner} ${placement} column=${column}`).toBeCloseTo(expected);
                    expect(cutout!.findAll(node => node.props.testID === 'content')).toHaveLength(0);
                }
                // The page and the tail's panel host keep exactly their own coat: no canvas under the translucent page.
                expect(alphaAt(screen.findHostByTestId('content')!, doc)).toBeCloseTo(materials.content.opacity);
                expect(alphaAt(screen.findHostByTestId('app-shell-tail-right')!, doc)).toBeCloseTo(0);
                expect(alphaAt(screen.findHostByTestId('app-shell-tail-rail')!, doc)).toBeCloseTo(0);
                expect(alphaAt(screen.findHostByTestId('app-shell-tail-inset')!, doc)).toBeCloseTo(materials.chrome.opacity);
            }
        } finally {
            stop();
            await screen.unmount();
        }
    });

    it('lifts the page alone: the column stands on the navigation plane beside it and the seam traces the page edge', async () => {
        const frame = (column: boolean, width: number, overshootPx = 0) => <AppShellMaterialFrame showChrome dragEnabled={false}
            leftOffsetPx={64 + width} sidebarWidth={width} columnResizeState={{ collapseArmed: false, overshootPx, dragging: overshootPx !== 0 }}
            titleStrip={<View testID="title" />} rail={<View testID="rail" />}
            column={column ? <View testID="sidebar-body" /> : null} peek={<View testID="peek-probe" />}>
            <ChromeLifetimeProbe />
            <View testID="route" />
        </AppShellMaterialFrame>;
        const screen = await renderScreen(frame(true, 320));
        try {
            const style = (node: ReactTestInstance) => StyleSheet.flatten(node.props.style) ?? {};
            const clipped = (node: ReactTestInstance) => typeof node.type === 'string' && style(node).overflow === 'hidden' && Number(style(node).borderRadius) > 0;
            const hostAncestors = (node: ReactTestInstance) => {
                const result: ReactTestInstance[] = [];
                for (let parent = node.parent; parent; parent = parent.parent) if (typeof parent.type === 'string') result.push(parent);
                return result;
            };
            const sheetOf = (id: string) => hostAncestors(screen.findHostByTestId(id)!).find(clipped) ?? null;
            const identity = screen.root.findByType('ChromeLifetimeBoundary').props.identity;
            // Only the page is in the rounded sheet; the column and the peek are not clipped by it.
            const sheet = sheetOf('route');
            expect(sheet).not.toBeNull();
            expect(sheetOf('sidebar-body')).toBeNull();
            expect(sheetOf('peek-probe')).toBeNull();
            // No outline round the sheet and no hairline on the column's trailing edge.
            expect(style(sheet!).borderWidth ?? 0).toBe(0);
            const column = screen.findHostByTestId('navigation-sidebar')!;
            expect(style(column).borderRightWidth ?? 0).toBe(0);
            expect(style(column).width).toBe(320);
            // One inert seam, beside the sheet in the page's own slot (it moves with the page, never offset by the rail),
            // casting on both edges: the action rail stands on the canvas after the page in every placement.
            const seams = screen.findAll(node => typeof node.type === 'string' && style(node).boxShadow === lightTheme.colors.shadowSeamCastBothBoxShadow);
            expect(seams).toHaveLength(1);
            expect(seams[0]!.props.pointerEvents).toBe('none');
            expect(hostAncestors(seams[0]!)[0]).toBe(hostAncestors(sheet!)[0]);
            expect(style(seams[0]!).left ?? 0).toBe(0);
            expect(hostAncestors(sheet!)[0]!.findAll(node => node === column)).toHaveLength(0);
            // The drawn width (rubber band included) is the column's own width, so the page edge follows it.
            await screen.update(frame(true, 320, 40));
            expect(style(screen.findHostByTestId('navigation-sidebar')!).width).toBe(resolveColumnDrawnWidthPx(320, 40));
            // Hiding and showing the column, or resizing it, never replaces the page.
            await screen.update(frame(false, 0));
            await screen.update(frame(true, 280));
            expect(screen.root.findByType('ChromeLifetimeBoundary').props.identity).toBe(identity);
        } finally {
            await screen.unmount();
        }
    });
});
