import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { GhosttyTerminalSurface } from './surface.native';

describe('GhosttyTerminalSurface', () => {
    it('reports native-module-missing once for a stable unavailable callback', async () => {
        const onUnavailable = vi.fn();
        const props = {
            surfaceId: 'surface-1',
            fontSize: 14,
            lineHeightPx: 18,
            onInput: vi.fn(),
            onReady: vi.fn(),
            onResize: vi.fn(),
            onUnavailable,
        };
        let root: renderer.ReactTestRenderer | null = null;

        await act(async () => {
            root = renderer.create(<GhosttyTerminalSurface {...props} />);
        });

        await act(async () => {
            root?.update(<GhosttyTerminalSurface {...props} />);
        });

        expect(onUnavailable).toHaveBeenCalledTimes(1);
        expect(onUnavailable).toHaveBeenCalledWith('native-module-missing');
    });
});
