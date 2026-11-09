import { describe, expect, it } from 'vitest';

import { pluginSurfacePageOwnsMachineChip } from './pluginSurfaceMachineChip';

const placement = (container: string) => ({ contributionKind: 'surfacePlacement', binding: { kind: 'destination', container } });

describe('who draws a surface Machine chip', () => {
    it('leaves it to the page for an App page and for a companion that page opened', () => {
        expect(pluginSurfacePageOwnsMachineChip(placement('appPage'), false)).toBe(true);
        expect(pluginSurfacePageOwnsMachineChip(placement('rightSidebarTab'), true)).toBe(true);
    });

    it('keeps its own chip for any other side surface', () => {
        expect(pluginSurfacePageOwnsMachineChip(placement('rightSidebarTab'), false)).toBe(false);
        expect(pluginSurfacePageOwnsMachineChip(placement('rightPane'), false)).toBe(false);
        expect(pluginSurfacePageOwnsMachineChip({ contributionKind: 'composerControl', binding: null }, true)).toBe(false);
    });
});
