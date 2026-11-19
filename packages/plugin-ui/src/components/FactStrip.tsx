import type { ReactElement } from 'react';

import { useOptionalHappierUiPalette, useOptionalHappierUiTypography } from '../environment/context.js';
import {
  HappierFactStrip,
  type HappierFactStripProps,
  type HappierFactStripTextProps,
} from '../presentation/data/FactStrip.js';
import { HappierText } from '../presentation/text/Text.js';
import { resolveHappierTypeRoleStyle } from '../presentation/text/typeRole.js';
import { usePluginTheme } from './PluginUiProvider.js';

/** A thing's few headline facts side by side, a quiet label over each value: the strip Happier's own pages draw. */
export type FactStripProps = Omit<HappierFactStripProps, 'Text' | 'ruleColor'>;

export function FactStrip(props: FactStripProps): ReactElement | null {
  const theme = usePluginTheme();
  const palette = useOptionalHappierUiPalette(theme);
  return <HappierFactStrip {...props} Text={FactStripText} ruleColor={palette?.rowDivider ?? theme.colors.border} />;
}

/** The strip's type roles in the host's faces and inks. */
function FactStripText(props: HappierFactStripTextProps): ReactElement {
  const theme = usePluginTheme();
  const typography = useOptionalHappierUiTypography();
  const role = props.role === 'headline' ? 'title' : props.role === 'value' ? 'label' : 'meta';
  const color = props.tone === 'danger'
    ? theme.statusText?.danger ?? theme.colors.danger
    : props.tone === 'attention'
      ? theme.statusText?.warning ?? theme.colors.warning
      : props.role === 'label' ? theme.colors.mutedText
        : props.role === 'detail' ? theme.colors.secondaryText : theme.colors.text;
  return (
    <HappierText
      tabularNumbers={props.role === 'value' || props.role === 'headline'}
      style={[resolveHappierTypeRoleStyle(role, theme, typography), { color }]}
      {...(props.numberOfLines === undefined ? {} : { numberOfLines: props.numberOfLines })}
    >
      {props.children}
    </HappierText>
  );
}
