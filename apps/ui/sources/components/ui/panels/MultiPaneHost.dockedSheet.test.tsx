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
});
