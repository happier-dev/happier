import type { ReactElement, ReactNode } from 'react';

import {
  isHappierBannerUrgent,
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
import { softenHappierWorkColor } from '../presentation/work/workStatus.js';
import { usePluginHostApi } from '../hostApi/context.js';
import {
  type PluginUiFocusTarget,
  usePluginUiFocusTargetBindingInternal,
  useCollectionDetailHeadingBindingInternal,
} from './Focus.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';
import { resolveAuthorText } from './resolveAuthorText.js';
import { Icon, PluginUiIconGlyph, type IconName } from './Icon.js';
import { useHappierTypeRoleStyle } from '../presentation/text/typeRole.js';
import { resolveHappierIconSize } from '../presentation/content/Icon.js';

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
  const focusBinding = useCollectionDetailHeadingBindingInternal(focusTarget);
  return <HappierHeading level={level} theme={usePluginTheme()} controlRef={focusBinding} testID={testID}>{children ?? label}</HappierHeading>;
}

export type LabelProps = AuthorText & Readonly<{ testID?: string; children?: ReactNode }>;

export function Label({ testID, children, ...text }: LabelProps): ReactElement {
  const label = useAuthorText(text);
  return <HappierLabel theme={usePluginTheme()} testID={testID}>{children ?? label}</HappierLabel>;
}

export type DividerProps = Readonly<{
  accessibilityLabel?: string;
  accessibilityLabelKey?: string;
  testID?: string;
}>;

export function Divider(props: DividerProps): ReactElement {
  const { accessibilityLabel, accessibilityLabelKey, ...rest } = props;
  const resolvedAccessibilityLabel = resolveAuthorText(
    usePluginTranslation(),
    accessibilityLabel,
    accessibilityLabelKey,
  );
  return (
    <HappierDivider
      {...rest}
      accessibilityLabel={resolvedAccessibilityLabel}
      color={usePluginTheme().colors.divider}
    />
  );
}

/** A badge in a column sizes to its words rather than stretching to the column. */
const BADGE_SELF_ALIGNMENT = { alignSelf: 'flex-start' } as const;

export type BadgeProps = AuthorText & Readonly<{
  tone?: HappierTone;
  /**
   * `outlined` (default): tone ink inside a tone ring on the elevated surface, for a quiet label.
   * `tinted`: tone ink on a faint tint of the same tone with no ring, for the one loud fact of a row
   * ("Review requested"); a neutral tint stays on the elevated surface.
   */
  variant?: 'outlined' | 'tinted';
  /** A leading icon in the badge's ink ("Review requested" with an eye). Decorative: the words carry the meaning. */
  icon?: IconName;
  testID?: string;
  children?: ReactNode;
}>;

export function Badge({ tone = 'neutral', variant = 'outlined', icon, testID, children, ...text }: BadgeProps): ReactElement {
  const theme = usePluginTheme();
  const color = theme.colors[HAPPIER_TONE_COLOR_TOKEN[tone]];
  const label = useAuthorText(text);
  // The icon sits at the words' own line height, so a badge with an icon is exactly as tall as one without.
  const iconSize = useHappierTypeRoleStyle('caption', theme).lineHeight;
  const tinted = variant === 'tinted';
  // The tint is the tone at the one strength the shared work-state tint uses; a theme colour with no
  // softened form (a custom rgba) keeps the elevated surface rather than guessing a mix.
  const tint = tinted && tone !== 'neutral' && tone !== 'secondary' && tone !== 'muted'
    ? softenHappierWorkColor(color, 0.1)
    : null;
  return (
    <HappierBadge
      color={color}
      backgroundColor={tint ?? theme.colors.elevatedSurface}
      // A tinted chip keeps the ring's geometry but not its ink: a translucent tint drawn twice at the edge reads as a ring.
      borderColor={tinted ? 'transparent' : tone === 'neutral' ? theme.colors.border : color}
      // One status geometry for every badge (HAPPIER_BADGE_METRICS), on the host's small-mark radius step.
      radius={theme.radii.small}
      style={BADGE_SELF_ALIGNMENT}
      {...(icon === undefined ? {} : {
        leading: (
          <PluginUiIconGlyph
            name={icon}
            size={typeof iconSize === 'number' ? iconSize : resolveHappierIconSize('small')}
            tone={tone}
            {...(testID === undefined ? {} : { testID: `${testID}:icon` })}
          />
        ),
      })}
      testID={testID}
    >
      {children ?? label}
    </HappierBadge>
  );
}

/** A portable author-owned metadata row; visual tokens remain adapter-owned. */
export type MetadataEntry = Readonly<{
  label: string;
  labelKey?: string;
  value: string;
  tone?: HappierTone;
  accessibilityLabel?: string;
  accessibilityLabelKey?: string;
  testID?: string;
}>;
export type MetadataProps = Readonly<{
  title?: string;
  titleKey?: string;
  entries: readonly MetadataEntry[];
  testID?: string;
}>;

export function Metadata(props: MetadataProps): ReactElement {
  const translate = usePluginTranslation();
  return (
    <HappierMetadata
      title={resolveAuthorText(translate, props.title, props.titleKey)}
      entries={props.entries.map(({ labelKey, accessibilityLabelKey, ...entry }) => ({
        ...entry,
        label: resolveAuthorText(translate, entry.label, labelKey) ?? entry.label,
        accessibilityLabel: resolveAuthorText(
          translate,
          entry.accessibilityLabel,
          accessibilityLabelKey,
        ),
      }))}
      testID={props.testID}
      theme={usePluginTheme()}
    />
  );
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

export type ProgressProps = Readonly<{
  value?: number;
  label: string;
  labelKey?: string;
  /**
   * Shares of one whole (0–1 each), drawn left to right in their tones on one track, such as a
   * file's lines added and removed. The bar is then one picture named by `label`, not a progress
   * value, and `value` is not drawn.
   */
  segments?: readonly Readonly<{ value: number; tone: HappierTone }>[];
  testID?: string;
}>;

export function Progress({ label, labelKey, segments, ...props }: ProgressProps): ReactElement {
  const theme = usePluginTheme();
  const resolvedLabel = resolveAuthorText(usePluginTranslation(), label, labelKey) ?? label;
  return (
    <HappierProgress
      {...props}
      label={resolvedLabel}
      theme={theme}
      {...(segments === undefined ? {} : {
        semantics: 'image' as const,
        segments: segments.map((segment) => ({ value: segment.value, color: theme.colors[HAPPIER_TONE_COLOR_TOKEN[segment.tone]] })),
      })}
    />
  );
}

export type BannerProps = Readonly<{
  tone?: HappierTone;
  title: string;
  titleKey?: string;
  description?: string;
  descriptionKey?: string;
  action?: ReactNode;
  testID?: string;
}>;

export function Banner({ tone = 'info', title, titleKey, description, descriptionKey, ...props }: BannerProps): ReactElement {
  const translate = usePluginTranslation();
  return (
    <HappierBanner
      {...props}
      title={resolveAuthorText(translate, title, titleKey) ?? title}
      description={resolveAuthorText(translate, description, descriptionKey)}
      tone={tone}
      icon={<Icon name={isHappierBannerUrgent(tone) ? 'warning' : 'info'} tone={tone} />}
      theme={usePluginTheme()}
    />
  );
}
