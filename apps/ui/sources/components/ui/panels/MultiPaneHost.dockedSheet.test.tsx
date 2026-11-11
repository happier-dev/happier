import * as React from 'react';
import Color from 'color';
import type { ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { resolveBrowserMaterialPaint } from '@/dev/testkit/glassBackdrop';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

const { MultiPaneHost } = await import('./MultiPaneHost');
const { GlassSurface } = await import('@/components/ui/glass/GlassSurface');
const { glassPresetMaterials } = await import('@/components/ui/glass/glassMaterial');
const { resolveGlassPresentationVariables } = await import('@/components/ui/glass/glassDocumentPresentation');
const { GlassRuntimeEnvironmentProvider } = await import('@/components/ui/glass/glassRuntimeEnvironment');
const { GlassMaterialSettingsProvider } = await import('@/components/ui/glass/useGlassMaterialSettings');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Panel() {
    return null;
}

const styleOf = (node: ReactTestInstance) => Object.assign({}, ...[node.props.style].flat(Infinity).filter(Boolean)) as Record<string, unknown>;

describe('MultiPaneHost docked sheet', () => {
    it.each([false, true])('uses the configured pane material for docked companions (on canvas: %s)', async (onCanvas) => {
        const environment = { desktopWindow: true, nativeWindowMaterialLive: true, atmosphereBehind: 'wallpaper' as const };
        for (const materials of [glassPresetMaterials('everywhere'), glassPresetMaterials('solid'),
            { ...glassPresetMaterials('clear'), content: { blur: 'light' as const, opacity: 0.23 } }]) {
            const settings = { glassSurfaceMaterials: materials };
            const screen = await renderScreen(<GlassRuntimeEnvironmentProvider value={environment}>
                <GlassMaterialSettingsProvider value={settings}>
                    <GlassSurface plane surfaceGroup="content" finishRole={null} atmosphereCoat="reading">
                        <GlassSurface testID="pane-material-reference" surfaceGroup="content" nested={!onCanvas}>{null}</GlassSurface>
                        <MultiPaneHost main={null} rightPane={<Panel />} detailsPane={null}
                            rightTail={onCanvas ? { host: null, hidden: false } : undefined}
                            layout={{ main: 'docked', kind: 'twoPane', right: 'docked', details: 'hidden' }}
                            rightDockWidthPx={360} detailsDockWidthPx={520} onCloseRight={() => {}} onCloseDetails={() => {}}
                            onCommitRightDockWidthPx={() => {}} onCommitDetailsDockWidthPx={() => {}} />
                    </GlassSurface>
                </GlassMaterialSettingsProvider>
            </GlassRuntimeEnvironmentProvider>);
            try {
                const variables = resolveGlassPresentationVariables(settings, environment);
                const paints: string[] = [];
                const column = screen.findByTestId('multi-pane-right-docked')!;
                for (let node: ReactTestInstance | null = screen.root.findByType(Panel).parent; node && node !== column.parent; node = node.parent) {
                    if (typeof node.type !== 'string') continue;
                    const layers = [node, ...node.children.filter((child): child is ReactTestInstance => typeof child !== 'string'
                        && typeof child.type === 'string' && child.props.dataSet?.happyGlassBackdrop === 'true')];
                    for (const layer of layers) {
                        const color = styleOf(layer).backgroundColor;
                        if (typeof color === 'string') paints.push(color);
                    }
                }
                const alpha = (color: string) => Color(resolveBrowserMaterialPaint(color, variables)).alpha();
                const reference = screen.findHostByTestId('pane-material-reference')!;
                const referencePaint = reference.find(node => typeof node.type === 'string' && node.props.dataSet?.happyGlassBackdrop === 'true');
                const expected = alpha(styleOf(referencePaint).backgroundColor as string);
                expect(1 - paints.reduce((clear, color) => clear * (1 - alpha(color)), 1)).toBeCloseTo(expected);
                if (materials.content.opacity !== 1) expect(expected).toBeLessThan(1);
            } finally { await screen.unmount(); }
        }
    });

    it('floats an overlay pane over the page in the floating panel glass, like dialogs and anchored panels (owner 11-11 #12)', async () => {
        // Auto glass with nothing behind: the page plane is solid there, floating surfaces are still glass.
        const screen = await renderScreen(<GlassMaterialSettingsProvider value={{}}>
            <MultiPaneHost main={null} rightPane={null} detailsPane={<Panel />}
                layout={{ main: 'docked', kind: 'twoPane', right: 'hidden', details: 'overlay' }}
                rightDockWidthPx={360} detailsDockWidthPx={520} onCloseRight={() => {}} onCloseDetails={() => {}}
                onCommitRightDockWidthPx={() => {}} onCommitDetailsDockWidthPx={() => {}} />
        </GlassMaterialSettingsProvider>);
        try {
            const pane = screen.findByTestId('multi-pane-details-overlay')!;
            const layers = pane.findAll(node => typeof node.type === 'string' && node.props.dataSet?.happyGlassBackdrop === 'true');
            const backdrop = styleOf(layers[0]!);
            expect(String(backdrop.backdropFilter ?? backdrop.WebkitBackdropFilter ?? '')).toContain('blur(');
        } finally { await screen.unmount(); }
    });

    it.each([false, true])('leaves the docked pane\'s seam unclipped so its resize target reaches over the page beside it (on canvas: %s)', async (onCanvas) => {
        // The handle's web target reaches past the pane edge; a clipping column would cut that outer part off.
        const screen = await renderScreen(<MultiPaneHost main={null} rightPane={<Panel />} detailsPane={null}
            rightTail={onCanvas ? { host: null, hidden: false } : undefined}
            layout={{ main: 'docked', kind: 'twoPane', right: 'docked', details: 'hidden' }}
            rightDockWidthPx={360} rightDockMinWidthPx={280} rightDockMaxWidthPx={640} detailsDockWidthPx={520}
            onCloseRight={() => {}} onCloseDetails={() => {}}
            onCommitRightDockWidthPx={() => {}} onCommitDetailsDockWidthPx={() => {}} />);
        try {
            const pane = screen.findHostByTestId('multi-pane-right-docked')!;
            const handle = pane.find(node => node.props.accessibilityRole === 'adjustable');
            const host = screen.findHostByTestId('multi-pane-main-column') ?? null;
            const clipping: string[] = [];
            for (let node: ReactTestInstance | null = handle.parent; node && node !== host?.parent; node = node.parent) {
                if (typeof node.type === 'string' && styleOf(node).overflow === 'hidden') clipping.push(String(node.props.testID ?? node.type));
            }
            expect(clipping).toEqual([]);
        } finally { await screen.unmount(); }
    });
});
