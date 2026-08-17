import type { ReactElement, ReactNode } from 'react';

import {
  HappierBadge,
  HappierBanner,
  HappierDivider,
  HappierHeading,
  HappierLabel,
  HappierLink,
  HappierMetadata,
  HappierProgress,
} from '../presentation/content/Foundation.js';
import { HAPPIER_TONE_COLOR_TOKEN, type HappierTone } from '../presentation/semantics.js';
import { usePluginHostApi } from '../hostApi/context.js';
import {
  type PluginUiFocusTarget,
  usePluginUiFocusTargetBindingInternal,
} from './Focus.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';
import { resolveAuthorText } from './resolveAuthorText.js';

type AuthorText = Readonly<{ value?: string; valueKey?: string; fallback?: string }>;

function useAuthorText({ value, valueKey, fallback }: AuthorText): string {
  return resolveAuthorText(usePluginTranslation(), value, valueKey, fallback) ?? '';
}

export type HeadingProps = AuthorText & Readonly<{
  level?: 1 | 2 | 3 | 4 | 5 | 6;
  /** Logical focus target transferred by the mounted host after author state changes. */
  focusTarget?: PluginUiFocusTarget;
  testID?: string;
  children?: ReactNode;
}>;

export function Heading({ level = 2, focusTarget, testID, children, ...text }: HeadingProps): ReactElement {
  const label = useAuthorText(text);
  const focusBinding = usePluginUiFocusTargetBindingInternal(focusTarget);
  return <HappierHeading level={level} theme={usePluginTheme()} controlRef={focusBinding} testID={testID}>{children ?? label}</HappierHeading>;
}

export type LabelProps = AuthorText & Readonly<{ testID?: string; children?: ReactNode }>;

export function Label({ testID, children, ...text }: LabelProps): ReactElement {
  const label = useAuthorText(text);
  return <HappierLabel theme={usePluginTheme()} testID={testID}>{children ?? label}</HappierLabel>;
}

export type DividerProps = Readonly<{ accessibilityLabel?: string; testID?: string }>;

export function Divider(props: DividerProps): ReactElement {
  return <HappierDivider {...props} color={usePluginTheme().colors.divider} />;
}

export type BadgeProps = AuthorText & Readonly<{ tone?: HappierTone; testID?: string; children?: ReactNode }>;

export function Badge({ tone = 'neutral', testID, children, ...text }: BadgeProps): ReactElement {
  const theme = usePluginTheme();
  const color = theme.colors[HAPPIER_TONE_COLOR_TOKEN[tone]];
  const label = useAuthorText(text);
  return (
    <HappierBadge
      color={color}
      backgroundColor={theme.colors.elevatedSurface}
      borderColor={tone === 'neutral' ? theme.colors.border : color}
      radius={theme.radii.pill}
      horizontalPadding={theme.spacing.small}
      verticalPadding={theme.spacing.xsmall}
      testID={testID}
    >
      {children ?? label}
    </HappierBadge>
  );
}

/** A portable author-owned metadata row; visual tokens remain adapter-owned. */
export type MetadataEntry = Readonly<{
  label: string;
  value: string;
  tone?: HappierTone;
  accessibilityLabel?: string;
  testID?: string;
}>;
export type MetadataProps = Readonly<{ title?: string; entries: readonly MetadataEntry[]; testID?: string }>;

export function Metadata(props: MetadataProps): ReactElement {
  return <HappierMetadata {...props} theme={usePluginTheme()} />;
}

export type LinkProps = Readonly<{ title: string; titleKey?: string; url: string; disabled?: boolean; testID?: string }>;

export function Link({ title, titleKey, url, disabled, testID }: LinkProps): ReactElement {
  const hostApi = usePluginHostApi();
  const label = resolveAuthorText(usePluginTranslation(), title, titleKey) ?? title;
  return (
    <HappierLink
      label={label}
      disabled={disabled}
      onPress={() => hostApi.openExternalLink(url)}
      theme={usePluginTheme()}
      testID={testID}
    >
      {label}
    </HappierLink>
  );
}

export type ProgressProps = Readonly<{ value?: number; label: string; testID?: string }>;

export function Progress(props: ProgressProps): ReactElement {
  return <HappierProgress {...props} theme={usePluginTheme()} />;
}

export type BannerProps = Readonly<{ tone?: HappierTone; title: string; description?: string; action?: ReactNode; testID?: string }>;

export function Banner({ tone = 'info', ...props }: BannerProps): ReactElement {
  return <HappierBanner {...props} tone={tone} theme={usePluginTheme()} />;
}
