import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';

installPanelCommonModuleMocks();

describe('SplitCanvasLeafFrame', () => {
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
