import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

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
});
