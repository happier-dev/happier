import type { ReactElement, ReactNode } from 'react';

import { HappierText } from '../presentation/text/Text.js';
import type { HappierTextVariant, HappierTone } from '../presentation/semantics.js';
import { usePluginTranslation } from './PluginUiProvider.js';
import { resolveAuthorText } from './resolveAuthorText.js';

export type TextTone = HappierTone;
export type TextVariant = HappierTextVariant;

export type TextProps = Readonly<{
  /** Literal text. Use it for content the plugin produced, not for UI chrome. */
  value?: string;
  /**
   * A key from this plugin's declared translation bundle, resolved for the
   * user's locale.
   *
   * `fallback` is required whenever `valueKey` is used: a key the plugin never
   * declared must degrade to readable author-supplied text, never to the raw
   * key. That requirement is what makes the prop resolvable at all — the
   * predecessor shipped an unresolved key with no translation owner.
   */
  valueKey?: string;
  fallback?: string;
  tone?: TextTone;
  variant?: TextVariant;
  numberOfLines?: number;
  selectable?: boolean;
  accessibilityLabel?: string;
  testID?: string;
  children?: ReactNode;
}>;

/**
 * Happier text for plugin surfaces.
 *
 * It is a thin adapter: the implementation, typography, tone mapping, text
 * scaling and selectability all live in the shared presentation owner that
 * Happier core renders too (UI-T27).
 */
export function Text({
  value,
  valueKey,
  fallback,
  tone,
  variant,
  numberOfLines,
  selectable,
  accessibilityLabel,
  testID,
  children,
}: TextProps): ReactElement {
  const translate = usePluginTranslation();
  const resolved = resolveAuthorText(translate, value, valueKey, fallback);

  return (
    <HappierText
      variant={variant ?? 'body'}
      tone={tone ?? 'neutral'}
      numberOfLines={numberOfLines}
      selectable={selectable}
      accessibilityLabel={accessibilityLabel}
      testID={testID}
    >
      {children ?? resolved}
    </HappierText>
  );
}
