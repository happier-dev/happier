import type { ReactElement } from 'react';

import { useOptionalHappierUiPalette, useOptionalHappierUiTypography } from '../environment/context.js';
import {
  HappierDiffStat,
  type HappierDiffStatProps,
  type HappierDiffStatTextProps,
} from '../presentation/content/DiffStat.js';
import { HappierText } from '../presentation/text/Text.js';
import { resolveHappierTypeRoleStyle } from '../presentation/text/typeRole.js';
import { usePluginTheme } from './PluginUiProvider.js';

/** Lines added and removed ("+53 −5"): the same readout Happier's own change lists draw. */
export type DiffStatProps = Omit<HappierDiffStatProps, 'Text' | 'renderCount'>;

export function DiffStat(props: DiffStatProps): ReactElement | null {
  return <HappierDiffStat {...props} Text={DiffStatText} />;
}

/** The row-meta step with tabular figures, in the host's version-control inks. */
function DiffStatText(props: HappierDiffStatTextProps): ReactElement {
  const theme = usePluginTheme();
  const palette = useOptionalHappierUiPalette(theme);
  const typography = useOptionalHappierUiTypography();
  const color = props.kind === 'added'
    ? palette?.versionControlAdded ?? theme.statusText?.success ?? theme.colors.success
    : props.kind === 'removed'
      ? palette?.versionControlRemoved ?? theme.statusText?.danger ?? theme.colors.danger
      : null;
  return (
    <HappierText
      tabularNumbers
      style={[resolveHappierTypeRoleStyle('meta', theme, typography), DIFF_STAT_TEXT_STYLE, color === null ? null : { color }]}
      {...(props.numberOfLines === undefined ? {} : { numberOfLines: props.numberOfLines })}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
    >
      {props.children}
    </HappierText>
  );
}

const DIFF_STAT_TEXT_STYLE = { flexShrink: 0 } as const;
