import { HAPPIER_FIELD_BOX_METRICS, HAPPIER_FIELD_BOX_SHAPE } from '@happier-dev/plugin-ui/presentation';

/**
 * The bordered field box of configuration pages: a page select's trigger and a page text field share
 * this one shape, so a row of fields reads as one set whatever the control. The shape is owned by
 * shared presentation (a plugin page-row select draws the same box); this adapter maps the colours.
 */
export const FIELD_BOX_METRICS = HAPPIER_FIELD_BOX_METRICS;

type FieldBoxTheme = Readonly<{
    colors: Readonly<{
        border: Readonly<{ strong: string }>;
        surface: Readonly<{ base: string }>;
        text: Readonly<{ primary: string }>;
        input: Readonly<{ placeholder: string }>;
        state: Readonly<{ danger: Readonly<{ foreground: string }> }>;
    }>;
}>;

export type FieldBoxState = 'idle' | 'invalid';

/**
 * The field box colours. There is no focused colour: a text field's caret is its focus cue
 * (DESIGN.md → focus), and a select trigger takes the row's own focus-visible treatment.
 */
export function resolveFieldBoxColors(theme: FieldBoxTheme, state: FieldBoxState = 'idle') {
    return {
        borderColor: state === 'invalid' ? theme.colors.state.danger.foreground : theme.colors.border.strong,
        backgroundColor: theme.colors.surface.base,
        valueColor: theme.colors.text.primary,
        placeholderColor: theme.colors.input.placeholder,
    } as const;
}

export const fieldBoxShapeStyle: typeof HAPPIER_FIELD_BOX_SHAPE = HAPPIER_FIELD_BOX_SHAPE;
