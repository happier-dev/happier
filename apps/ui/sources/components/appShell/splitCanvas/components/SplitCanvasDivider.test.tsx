import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { findFirstByType, invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import { installPanelCommonModuleMocks } from '@/components/ui/panels/panelTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installPanelCommonModuleMocks();

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.filter(Boolean).map(flattenStyle));
    }
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

describe('SplitCanvasDivider', () => {
    it('reuses the docked-pane resize core to commit ratios on horizontal drags', async () => {
        const onCommitRatio = vi.fn();
        const onDragRatio = vi.fn();

        const fakeWindow = new (globalThis as any).EventTarget();
        (globalThis as any).window = fakeWindow;
        (globalThis as any).PointerEvent = class PointerEvent extends Event {
            clientX: number;
            constructor(type: string, init: { clientX: number }) {
                super(type);
                this.clientX = init.clientX;
            }
        };

        const { SplitCanvasDivider } = await import('./SplitCanvasDivider');

        const screen = await renderScreen(
            <SplitCanvasDivider
                axis="row"
                splitId="split-root"
                containerSizePx={1000}
                ratio={0.5}
                minRatio={0.2}
                maxRatio={0.8}
                onCommitRatio={onCommitRatio}
                onDragRatio={onDragRatio}
            />,
        );

        const handle = findFirstByType(screen.tree, 'Pressable');
        expect(handle).toBeTruthy();

        await act(async () => {
            invokeTestInstanceHandler(handle, 'onPressIn', {
                clientX: 100,
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });

        await act(async () => {
            (globalThis as any).window.dispatchEvent(new (globalThis as any).PointerEvent('pointermove', { clientX: 250 }));
        });

        await act(async () => {
            (globalThis as any).window.dispatchEvent(new (globalThis as any).PointerEvent('pointerup', { clientX: 250 }));
        });

        expect(onCommitRatio).toHaveBeenCalledWith(
            0.65,
            expect.objectContaining({
                clampedSizePx: 650,
                exceededMinPx: false,
                exceededMaxPx: false,
            }),
        );
        expect(onDragRatio).toHaveBeenLastCalledWith(null, null);
    });

    it('renders the shared column resize handle metrics for row-axis splits', async () => {
        const { SplitCanvasDivider } = await import('./SplitCanvasDivider');

        const screen = await renderScreen(
            <SplitCanvasDivider
                axis="row"
                splitId="split-root"
                containerSizePx={1000}
                ratio={0.5}
                minRatio={0.2}
                maxRatio={0.8}
                onCommitRatio={() => {}}
            />,
        );

        const handle = findFirstByType(screen.tree, 'Pressable');
        expect(handle).toBeTruthy();
        if (!handle) {
            throw new Error('expected split canvas divider handle');
        }
        const separatorLine = handle.findByType('View');

        expect(separatorLine).toBeTruthy();
        expect(flattenStyle(handle.props.style)).toEqual(expect.objectContaining({
            width: 10,
            cursor: 'col-resize',
        }));
        expect(separatorLine.props.style).toEqual(expect.objectContaining({
            width: 1,
            height: '100%',
        }));
    });

    it('renders the shared row resize handle grip for column-axis splits', async () => {
        const { SplitCanvasDivider } = await import('./SplitCanvasDivider');

        const screen = await renderScreen(
            <SplitCanvasDivider
                axis="column"
                splitId="split-root"
                containerSizePx={800}
                ratio={0.5}
                minRatio={0.2}
                maxRatio={0.8}
                onCommitRatio={() => {}}
            />,
        );

        const handle = findFirstByType(screen.tree, 'Pressable');
        expect(handle).toBeTruthy();
        if (!handle) {
            throw new Error('expected split canvas divider handle');
        }
        const grip = handle.findByType('View');

        expect(flattenStyle(handle.props.style)).toEqual(expect.objectContaining({
            height: 18,
            cursor: 'row-resize',
        }));
        expect(grip.props.style).toEqual(expect.objectContaining({
            width: 56,
            height: 5,
            borderRadius: 999,
        }));
    });
});
