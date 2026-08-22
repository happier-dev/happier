import { describe, expect, it } from 'vitest';

import { shouldReadLiveRowRenderables } from './sessionListRowRenderableFreeze';

describe('shouldReadLiveRowRenderables', () => {
    it('reads live while the surface is active', () => {
        expect(shouldReadLiveRowRenderables({ dataActive: true, hasFrozenRenderables: false })).toBe(true);
        expect(shouldReadLiveRowRenderables({ dataActive: true, hasFrozenRenderables: true })).toBe(true);
    });

    it('keeps the frozen snapshot while inactive once there is one to keep', () => {
        // This is the whole point of the freeze: an inactive row holds its content instead of
        // re-subscribing. Reading live here would undo that.
        expect(shouldReadLiveRowRenderables({ dataActive: false, hasFrozenRenderables: true })).toBe(false);
    });

    it('reads live while inactive when the row has never frozen anything', () => {
        // A row whose FIRST render happens while the surface is inactive has nothing to fall back
        // to. Presenting its empty starting snapshot is what renders a blank row until the surface
        // comes back.
        expect(shouldReadLiveRowRenderables({ dataActive: false, hasFrozenRenderables: false })).toBe(true);
    });
});
