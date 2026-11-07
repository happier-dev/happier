import { useMemo, type ReactElement } from 'react';

import { useHappierUiAccessibility, useOptionalHappierUiTypography } from '../environment/context.js';
import { HAPPIER_RADIUS_V1 } from '../environment/radius.js';
import { HAPPIER_SPACE_STEPS } from '../environment/spacing.js';
import { HappierDisclosureChevron } from '../presentation/collection/DisclosureChevron.js';
import { HappierText } from '../presentation/text/Text.js';
import { resolveHappierTypeRoleStyle } from '../presentation/text/typeRole.js';
import { happierPageSheetShape } from '../presentation/layout/PageSection.js';
import {
  HappierWorkflowRunFoldHeader,
  type HappierWorkflowRunFoldHeaderProps,
} from '../presentation/work/WorkflowRunFoldHeader.js';
import { usePluginTheme } from './PluginUiProvider.js';

/** Controlled presentation only. The caller owns reads, control eligibility and navigation. */
export type WorkflowRunFoldHeaderProps = Omit<HappierWorkflowRunFoldHeaderProps, 'theme' | 'host'>;

/** The same Run band that core binds into Session and Discussion transcripts. */
export function WorkflowRunFoldHeader(props: WorkflowRunFoldHeaderProps): ReactElement {
  const theme = usePluginTheme();
  const typography = useOptionalHappierUiTypography();
  const { reducedMotion } = useHappierUiAccessibility();
  const foldTheme = useMemo(() => ({
      colors: { text: { primary: theme.colors.text, secondary: theme.colors.secondaryText, tertiary: theme.colors.mutedText },
        border: { focus: theme.colors.focus } },
      borderStyle: { borderColor: theme.colors.border, borderWidth: happierPageSheetShape().borderWidth },
      space: HAPPIER_SPACE_STEPS,
      borderRadius: { md: theme.radii.control, lg: HAPPIER_RADIUS_V1.lg },
    }), [theme]);
  const textStyle = useMemo(() => ({
    meta: resolveHappierTypeRoleStyle('meta', theme, typography),
    strong: resolveHappierTypeRoleStyle('meta', theme, typography, 'semiBold'),
    action: resolveHappierTypeRoleStyle('meta', theme, typography, 'medium'),
  }), [theme, typography]);
  return <HappierWorkflowRunFoldHeader {...props} theme={foldTheme}
    host={{
      Text: HappierText,
      textStyle,
      renderCaret: expanded => <HappierDisclosureChevron expanded={expanded} color={theme.colors.secondaryText} reducedMotion={reducedMotion} />,
    }} />;
}
