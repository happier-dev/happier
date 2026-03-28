import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { installModalComponentCommonModuleMocks } from '@/modal/components/modalComponentTestHelpers';
import type { CommandPaletteProps } from './CommandPalette';

installModalComponentCommonModuleMocks();

vi.mock('./CommandPaletteInput', () => ({
    CommandPaletteInput: () => React.createElement('CommandPaletteInput'),
}));

vi.mock('./CommandPaletteResults', () => ({
    CommandPaletteResults: () => React.createElement('CommandPaletteResults'),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('CommandPalette', () => {
    it('drives modal card chrome when setChrome is provided', async () => {
        const { renderScreen } = await import('@/dev/testkit');
        const { CommandPalette } = await import('./CommandPalette');

        const setChrome = vi.fn() as NonNullable<CommandPaletteProps['setChrome']>;

        await renderScreen(
            React.createElement(CommandPalette, {
                commands: [{
                    id: 'c1',
                    title: 'Command',
                    action: () => {},
                }],
                onClose: () => {},
                setChrome,
            }),
        );

        expect(setChrome).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'card',
            }),
        );
    });
});
