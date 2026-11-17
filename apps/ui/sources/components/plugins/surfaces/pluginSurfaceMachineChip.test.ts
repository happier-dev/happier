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

    it('leaves it to the host for an inline placement, which runs in its host\'s Machine scope; a widget keeps its own', () => {
        const inline = { contributionKind: 'surfacePlacement', binding: { kind: 'inline' } };
        expect(pluginSurfacePageOwnsMachineChip(inline, false, 'agentSettings')).toBe(true);
        expect(pluginSurfacePageOwnsMachineChip(inline, false, 'sessionInfoSection')).toBe(true);
        expect(pluginSurfacePageOwnsMachineChip(inline, false, 'widget')).toBe(false);
        expect(pluginSurfacePageOwnsMachineChip(inline, false, undefined)).toBe(false);
    });
});
