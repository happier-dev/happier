import type { ReactElement } from 'react';

import { useHappierUiAccessibility } from '../environment/context.js';
import { HappierDisclosureChevron } from '../presentation/collection/DisclosureChevron.js';
import type { HappierDisclosureCaretDensity } from '../presentation/collection/DisclosureToggle.js';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { usePluginTheme } from './PluginUiProvider.js';

/**
 * The disclosure caret of plugin-ui and plugin code: the host's own caret when it supplies one (the same mark as its
 * rows, at the asked density), otherwise the package's drawn chevron. `row` ends a folded row; `compact` sits beside
 * a meta label in an in-place toggle. Decorative: the pressable around it owns the label and the expanded state.
 */
export function HappierDisclosureCaret(props: Readonly<{
  expanded: boolean;
  density?: HappierDisclosureCaretDensity;
}>): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  const theme = usePluginTheme();
  const { reducedMotion } = useHappierUiAccessibility();
  if (host?.renderDisclosureCaret) {
    return <>{host.renderDisclosureCaret({ expanded: props.expanded, density: props.density ?? 'row' })}</>;
  }
  return <HappierDisclosureChevron expanded={props.expanded} color={theme.colors.secondaryText} reducedMotion={reducedMotion} />;
}
