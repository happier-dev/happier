import { happierRaisedEdgeStyle } from '@happier-dev/plugin-ui/presentation';
import { describe, expect, it } from 'vitest';

import { darkTheme, lightTheme } from '@/theme';

import { resolveFieldBoxColors } from './fieldBox';

describe('field box colours', () => {
    it('stands an idle field box on its raised edge: lit top on dark, bottom lip on light, on the raised fill', () => {
        const dark = resolveFieldBoxColors(darkTheme);
        expect(happierRaisedEdgeStyle(dark.edge)).toMatchObject({ borderTopColor: darkTheme.colors.edge.strong });
        expect(dark.backgroundColor).toBe(darkTheme.colors.edge.fill);

        const light = resolveFieldBoxColors(lightTheme);
        expect(happierRaisedEdgeStyle(light.edge)).toMatchObject({ borderBottomColor: lightTheme.colors.edge.strong });
    });

    it('sits an invalid box flat on its danger border, and a focused trigger flat inside its focus ring', () => {
        const invalid = resolveFieldBoxColors(darkTheme, 'invalid');
        expect(invalid.borderColor).toBe(darkTheme.colors.state.danger.foreground);
        expect(invalid.edge).toBeNull();

        const focused = resolveFieldBoxColors(lightTheme, 'focused');
        // The ring is the shared outline around the box, never its own border recoloured.
        expect(focused.focusRing).toBe(lightTheme.colors.border.focus);
        expect(focused.borderColor).toBe(lightTheme.colors.border.strong);
        expect(focused.edge).toBeNull();
        expect(resolveFieldBoxColors(lightTheme).focusRing).toBeNull();
        expect(resolveFieldBoxColors(lightTheme, 'invalid').focusRing).toBeNull();
    });
});
