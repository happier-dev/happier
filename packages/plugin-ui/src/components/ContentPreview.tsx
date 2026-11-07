import type { ReactElement, ReactNode } from 'react';
import { Platform } from 'react-native';

import { useOptionalHappierUiAccessibility, useOptionalHappierUiTypography } from '../environment/context.js';
import { HappierChevron } from '../presentation/collection/DisclosureChevron.js';
import { HappierDisclosureToggle } from '../presentation/collection/DisclosureToggle.js';
import {
  HappierCollapsibleBody,
  type HappierCollapsibleBodyActionProps,
} from '../presentation/content/CollapsibleBody.js';
import { HappierText } from '../presentation/text/Text.js';
import { resolveHappierTypeRoleStyle } from '../presentation/text/typeRole.js';
import { usePluginTheme } from './PluginUiProvider.js';

export type ContentPreviewProps = Readonly<{
  /** How many lines of reading text the preview shows before Show more. */
  lines: number;
  /** The caller's own Show more / Show less words. */
  showMoreLabel: string;
  showLessLabel: string;
  /** On the measured content. */
  testID?: string;
  children: ReactNode;
}>;

/**
 * Long content (a pull request description, a long comment) previewed at a bounded height and opened whole on
 * request; content that fits, or barely overflows by a line, is drawn whole with nothing to open. Keyboard focus
 * entering the clipped part opens it, and the control says whether the content is open.
 */
export function ContentPreview(props: ContentPreviewProps): ReactElement {
  const theme = usePluginTheme();
  const lineHeight = theme.typography.reading.lineHeight;
  // The bound falls wherever the content's blocks fall (headings and gaps break the line grid), so the last line's
  // height is fully clear and the whole line above it fades: a reader never sees the tops of cut glyphs.
  const mask = `linear-gradient(to bottom, black calc(100% - ${String(lineHeight * 2.5)}px), transparent calc(100% - ${String(lineHeight)}px))`;
  return (
    <HappierCollapsibleBody
      maxHeight={lineHeight * props.lines}
      slack={lineHeight}
      showMore={props.showMoreLabel}
      showLess={props.showLessLabel}
      Action={PreviewAction}
      gap={theme.spacing.small}
      {...(Platform.OS === 'web' ? { fade: { maskImage: mask, WebkitMaskImage: mask } } : {})}
      {...(props.testID === undefined ? {} : { contentTestID: props.testID })}
    >
      {props.children}
    </HappierCollapsibleBody>
  );
}

/** Read more / Show less: the one in-place disclosure, its chevron pointing where the text goes. */
function PreviewAction(props: HappierCollapsibleBodyActionProps): ReactNode {
  const theme = usePluginTheme();
  const typography = useOptionalHappierUiTypography();
  const reducedMotion = useOptionalHappierUiAccessibility()?.reducedMotion;
  const label = resolveHappierTypeRoleStyle('label', theme, typography, 'semiBold');
  const expanded = props.expanded === true;
  return <HappierDisclosureToggle label={props.label} open={expanded} onPress={props.onPress} align="center"
    focusColor={theme.colors.focus}
    {...(props.testID === undefined ? {} : { testID: props.testID })}
    caret={<HappierChevron direction={expanded ? 'up' : 'down'} color={theme.colors.secondaryText}
      {...(reducedMotion === undefined ? {} : { reducedMotion })} />}
    renderLabel={(text) => <HappierText accessible={false} style={{ ...label, color: theme.colors.secondaryText }}>{text}</HappierText>} />;
}
