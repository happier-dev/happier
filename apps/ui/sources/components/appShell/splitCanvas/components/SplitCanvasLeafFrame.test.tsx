import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';
import { StyleSheet } from 'react-native';
import Color from 'color';

installPanelCommonModuleMocks();

describe('SplitCanvasLeafFrame', () => {
    it('inherits the content plane instead of painting another opaque frame', async () => {
        const { SplitCanvasLeafFrame } = await import('./SplitCanvasLeafFrame');
        const { AppShellMaterialFrame } = await import('@/components/navigation/shell/AppShellMaterialFrame');
        const { GlassMaterialSettingsProvider } = await import('@/components/ui/glass/useGlassMaterialSettings');
        const { GlassRuntimeEnvironmentProvider } = await import('@/components/ui/glass/glassRuntimeEnvironment');
        const { glassPresetMaterials } = await import('@/components/ui/glass/glassMaterial');
        const screen = await renderScreen(
            <GlassRuntimeEnvironmentProvider value={{ desktopWindow: true, nativeWindowMaterialLive: true }}>
            <GlassMaterialSettingsProvider value={{ glassBlurEnabled: true, glassSurfaceMaterials: glassPresetMaterials('everywhere') }}>
            <AppShellMaterialFrame showChrome={false} dragEnabled={false} leftOffsetPx={0} sidebarWidth={320}
                titleStrip={null} rail={null} column={null} peek={null}>
                <SplitCanvasLeafFrame leafId="glass" isFocused={false} isMaximized={false}
                    showControls showFocusRing={false} onFocus={() => {}} onClose={() => {}} onToggleMaximize={() => {}}>
                    <Child />
                </SplitCanvasLeafFrame>
            </AppShellMaterialFrame>
            </GlassMaterialSettingsProvider>
            </GlassRuntimeEnvironmentProvider>,
        );
        const frame = StyleSheet.flatten(screen.findByTestId('split-canvas-leaf-interaction-surface-glass')!.props.style);
        expect(Color(frame.backgroundColor).alpha()).toBe(0);
        expect(frame.opacity).toBeUndefined();
    });

    it('exposes descendant-interaction capture on the shared leaf surface', async () => {
        const onFocus = vi.fn();
        const onClose = vi.fn();
        const onToggleMaximize = vi.fn();

        const { SplitCanvasLeafFrame } = await import('./SplitCanvasLeafFrame');

        const screen = await renderScreen(
            <SplitCanvasLeafFrame
                leafId="leaf-a"
                isFocused={false}
                isMaximized={false}
                showControls
                showFocusRing={false}
                onFocus={onFocus}
                onClose={onClose}
                onToggleMaximize={onToggleMaximize}
            >
                <Child />
            </SplitCanvasLeafFrame>,
        );

        invokeTestInstanceHandler(
            screen.findByTestId('split-canvas-leaf-interaction-surface-leaf-a'),
            'onStartShouldSetResponderCapture',
            {},
            'split-canvas-leaf-interaction-surface-leaf-a',
        );

        expect(onFocus).toHaveBeenCalledTimes(1);
    });
});

function Child() {
    return React.createElement('LeafChild');
}
