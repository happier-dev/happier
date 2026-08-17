import type { ReactElement } from 'react';

import { HappierStatus } from '../presentation/status/Status.js';
import {
  type PluginUiFocusTarget,
  usePluginUiFocusTargetBindingInternal,
} from './Focus.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';
import { resolveAuthorText } from './resolveAuthorText.js';
import type { TextTone } from './Text.js';

export type StatusProps = Readonly<{
  /** Semantic meaning, resolved from the host theme. */
  tone: TextTone;
  /**
   * What the status means, in words.
   *
   * Required, and not for symmetry: a colour-only indicator conveys nothing to
   * a screen-reader user or to a user who cannot distinguish the hue. Making
   * the label mandatory removes the invalid state instead of leaving an
   * `accessibilityLabel` prop an author can forget.
   */
  label: string;
  /** A key from this plugin's declared translation bundle; `label` is its fallback. */
  labelKey?: string;
  /**
   * Whether the status is live/in-flight. The host's reduced-motion preference
   * still decides whether the indicator actually animates.
   */
  pulsing?: boolean;
  /** Logical focus target transferred by the mounted host after author state changes. */
  focusTarget?: PluginUiFocusTarget;
  testID?: string;
}>;

/**
 * A labelled status indicator for plugin surfaces.
 *
 * The shared status row owns its live-region semantics, tone mapping and
 * decorative dot. This adapter resolves only plugin-local copy and theme facts.
 */
export function Status({ tone, label, labelKey, pulsing, focusTarget, testID }: StatusProps): ReactElement {
  const theme = usePluginTheme();
  const translate = usePluginTranslation();
  const resolvedLabel = resolveAuthorText(translate, label, labelKey) ?? label;
  const focusBinding = usePluginUiFocusTargetBindingInternal(focusTarget);

  return (
    <HappierStatus
      label={resolvedLabel}
      tone={tone}
      theme={theme}
      isPulsing={pulsing}
      controlRef={focusBinding}
      testID={testID}
    />
  );
}
