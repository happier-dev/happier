import { HAPPIER_FIELD_BOX_METRICS, HAPPIER_FIELD_BOX_SHAPE, type HappierRaisedEdge } from '@happier-dev/plugin-ui/presentation';

import { resolveThemeControlEdge } from '@/components/ui/surfaces/themeRaisedEdge';
import type { ShadowLevels } from '@/shadowElevation';
import type { RaisedEdgeColors } from '@/theme/raisedEdge';

/**
 * The bordered field box of configuration pages: a page select's trigger and a page text field share
 * this one shape, so a row of fields reads as one set whatever the control. The shape is owned by
 * shared presentation (a plugin page-row select draws the same box); this adapter maps the colours.
 */
export const FIELD_BOX_METRICS = HAPPIER_FIELD_BOX_METRICS;

type FieldBoxTheme = Readonly<{
    dark: boolean;
    colors: Readonly<{
        edge: RaisedEdgeColors;
        shadowLevels: ShadowLevels;
        text: Readonly<{ primary: string }>;
        input: Readonly<{ placeholder: string }>;
        border: Readonly<{ strong: string; focus: string }>;
        state: Readonly<{ danger: Readonly<{ foreground: string }> }>;
    }>;
}>;

/** `focused`: a select trigger whose own box carries the keyboard focus ring (the box sits flat inside it). */
export type FieldBoxState = 'idle' | 'invalid' | 'focused';

export type FieldBoxColors = Readonly<{
    borderColor: string;
    backgroundColor: string;
    valueColor: string;
    placeholderColor: string;
    edge: HappierRaisedEdge | null;
    /** The shared focus ring's colour while a select trigger's box carries it. */
    focusRing: string | null;
}>;

/**
 * The field box colours. A text field has no focused colour: its caret is its focus cue (DESIGN.md →
 * focus); a select trigger whose box carries the ring passes `focused`. The box
 * stands on its raised edge; an invalid box sits flat so its danger border speaks alone.
 */
export function resolveFieldBoxColors(theme: FieldBoxTheme, state: FieldBoxState = 'idle'): FieldBoxColors {
    return {
        borderColor: state === 'invalid' ? theme.colors.state.danger.foreground : theme.colors.border.strong,
        backgroundColor: theme.colors.edge.fill,
        valueColor: theme.colors.text.primary,
        placeholderColor: theme.colors.input.placeholder,
        edge: resolveThemeControlEdge(theme, 'strong', { invalid: state === 'invalid', focused: state === 'focused' }),
        focusRing: state === 'focused' ? theme.colors.border.focus : null,
    } as const;
}

export const fieldBoxShapeStyle: typeof HAPPIER_FIELD_BOX_SHAPE = HAPPIER_FIELD_BOX_SHAPE;
