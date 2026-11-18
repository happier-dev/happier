import type { ReactElement } from 'react';

import { useOptionalHappierUiPalette, useOptionalHappierUiTypography } from '../environment/context.js';
import {
  HappierWidgetGlanceRow,
  type HappierWidgetGlanceRowProps,
  type HappierWidgetGlanceRowTextProps,
} from '../presentation/layout/WidgetGlanceRow.js';
import { HappierText } from '../presentation/text/Text.js';
import { resolveHappierTypeRoleStyle } from '../presentation/text/typeRole.js';
import { Icon, type IconName } from './Icon.js';
import { usePluginTheme } from './PluginUiProvider.js';

/**
 * The one row inside a widget body: a mark, a label with an optional short tag, an optional quiet
 * fact beneath, and one trailing element. The same row Happier's own widgets draw.
 */
export type WidgetGlanceRowProps = Omit<HappierWidgetGlanceRowProps, 'Text' | 'colors' | 'space' | 'mark'> & Readonly<{
  /** A glyph, or an element (a brand mark, a spinner). It stands alone, never on a tile. */
  mark?: IconName | ReactElement | null;
}>;

/** The spacing steps the row is laid out on: the regular density of the host's rhythm. */
const GLANCE_ROW_SPACE = Object.freeze({ s6: 6, s8: 8, s10: 10 });

export function WidgetGlanceRow({ mark, ...props }: WidgetGlanceRowProps): ReactElement {
  const theme = usePluginTheme();
  const palette = useOptionalHappierUiPalette(theme);
  return (
    <HappierWidgetGlanceRow
      {...props}
      Text={GlanceRowText}
      colors={{
        text: theme.colors.text,
        secondaryText: theme.colors.secondaryText,
        mutedText: theme.colors.mutedText,
        attention: theme.statusText?.warning ?? theme.colors.warning,
        danger: theme.statusText?.danger ?? theme.colors.danger,
        pressed: palette?.navigationHover ?? theme.colors.control,
        focus: theme.colors.focus,
      }}
      space={GLANCE_ROW_SPACE}
      {...(mark === undefined ? {} : { mark: typeof mark === 'string' ? <Icon name={mark} size="small" tone="secondary" /> : mark })}
    />
  );
}

/** Row title (label, semibold) or row meta, one line, in the host's faces. */
function GlanceRowText(props: HappierWidgetGlanceRowTextProps): ReactElement {
  const theme = usePluginTheme();
  const typography = useOptionalHappierUiTypography();
  const role = props.role === 'title'
    ? resolveHappierTypeRoleStyle('label', theme, typography, 'semiBold')
    : resolveHappierTypeRoleStyle('meta', theme, typography);
  const mono = props.mono && theme.typography.code.fontFamily ? { fontFamily: theme.typography.code.fontFamily } : null;
  return (
    <HappierText numberOfLines={props.lines ?? 1} style={[role, mono, { color: props.color }, props.style]}>
      {props.children}
    </HappierText>
  );
}
