import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { motionTokens } from '@/components/ui/motion';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { useHoverPreviewPopover } from './useHoverPreviewPopover';

describe('useHoverPreviewPopover', () => {
    it('closing an already closed preview does not render the owner again', async () => {
        let renders = 0;
        let close: (() => void) | undefined;
        function Owner() {
            renders += 1;
            close = useHoverPreviewPopover({ enabled: false }).close;
            return null;
        }
        const screen = await renderScreen(<Owner />);
        try {
            const before = renders;
            await act(async () => { for (let index = 0; index < 5; index += 1) close!(); });
            expect(renders).toBe(before);
        } finally {
            await screen.unmount();
        }
    });

    it('stacks a pointer preview as a hover card and an opened popover as a popover', async () => {
        let hover: ReturnType<typeof useHoverPreviewPopover> | undefined;
        function Owner() {
            hover = useHoverPreviewPopover({ enabled: true });
            return null;
        }
        const screen = await renderScreen(<Owner />);
        try {
            expect(hover!.popoverLayer).toBeUndefined();
            await act(async () => {
                hover!.hoverProps.onPointerEnter();
                await new Promise((resolve) => setTimeout(resolve, motionTokens.overlay.popover.hoverOpenDelayMs + 50));
            });
            expect(hover!.mode).toBe('preview');
            // A resting pointer's preview never covers a popover or menu someone opened.
            expect(hover!.popoverLayer).toBe('hoverCard');
            await act(async () => { hover!.open(); });
            expect(hover!.popoverLayer).toBeUndefined();
        } finally {
            await screen.unmount();
        }
    });
});
