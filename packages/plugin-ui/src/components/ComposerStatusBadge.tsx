import type { ReactElement, RefObject } from 'react';

import { useOptionalHappierUiTypography } from '../environment/context.js';
import { HappierChevron } from '../presentation/collection/DisclosureChevron.js';
import {
  HAPPIER_COMPOSER_STATUS_BADGE_METRICS,
  HAPPIER_COMPOSER_STATUS_BADGE_TYPE,
  HappierComposerStatusBadge,
  resolveHappierComposerStatusState,
  type HappierComposerStatusEmphasis,
  type HappierComposerStatusTone,
} from '../presentation/status/ComposerStatusBadge.js';
import { HappierText } from '../presentation/text/Text.js';
import { resolveHappierTypeRoleStyle } from '../presentation/text/typeRole.js';
import { softenHappierWorkColor } from '../presentation/work/workStatus.js';
import { HAPPIER_TONE_COLOR_TOKEN } from '../presentation/semantics.js';
import { PluginUiIconGlyph, type IconName } from './Icon.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';
import { resolveAuthorText } from './resolveAuthorText.js';

export type ComposerStatusBadgeTone = HappierComposerStatusTone;
export type ComposerStatusBadgeEmphasis = HappierComposerStatusEmphasis;

export type ComposerStatusBadgeProps = Readonly<{
  /** The short phrase ("PR #482 · checks running"); `labelKey` resolves it from the plugin's catalog. */
  label?: string;
  labelKey?: string;
  /** `active` work under way, `complete`, `warning` needs a look, `paused` / `neutral` a plain fact. */
  tone?: ComposerStatusBadgeTone;
  /** `prominent` (default): a capsule among the composer's chips. `quiet`: plain words. */
  emphasis?: ComposerStatusBadgeEmphasis;
  /** A leading mark in the tone's marker ink. Decorative: the words carry the meaning. */
  icon?: IconName;
  onPress?: () => void;
  /** The item opens a popover: a prominent item shows the composer's caret. */
  opensPopover?: boolean;
  /** Whether that popover is open, announced to assistive tech. */
  expanded?: boolean;
  /** The node a popover anchors to. */
  anchorRef?: RefObject<unknown>;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  /** Lines before the words truncate (default 1); `0` keeps required disclosure text whole. */
  numberOfLines?: number;
  testID?: string;
}>;

/**
 * The composer's status item for plugin authors: the same capsule, rhythm, caret and press target Happier
 * draws in a Session's instrument strip (one owner, `HappierComposerStatusBadge`), in the plugin's theme.
 */
export function ComposerStatusBadge(props: ComposerStatusBadgeProps): ReactElement {
  const theme = usePluginTheme();
  const typography = useOptionalHappierUiTypography();
  const label = resolveAuthorText(usePluginTranslation(), props.label, props.labelKey) ?? '';
  const emphasis = props.emphasis ?? 'prominent';
  const state = resolveHappierComposerStatusState(props.tone ?? 'neutral');
  const type = HAPPIER_COMPOSER_STATUS_BADGE_TYPE[emphasis];
  const marker = theme.colors[HAPPIER_TONE_COLOR_TOKEN[state === 'neutral' ? 'muted' : state]];
  // The host projects its state tints; a snapshot without them softens the marker ink the way a
  // tinted `Badge` does, and a neutral item keeps the elevated surface.
  const tint = theme.statusTint?.[state]
    ?? (state === 'neutral' ? theme.colors.elevatedSurface : softenHappierWorkColor(marker, 0.1) ?? theme.colors.elevatedSurface);
  // The words' ink: primary on a prominent tint, secondary for a quiet item's plain words.
  const ink = emphasis === 'quiet' ? theme.colors.secondaryText : theme.colors.text;
  return (
    <HappierComposerStatusBadge
      label={label}
      text={(
        <HappierText
          testID={props.testID === undefined ? undefined : `${props.testID}:label`}
          numberOfLines={props.numberOfLines ?? 1}
          ellipsizeMode="tail"
          style={{
            ...resolveHappierTypeRoleStyle(type.role, theme, typography, type.emphasis),
            letterSpacing: type.letterSpacing,
            color: ink,
            flexShrink: 1,
            minWidth: 0,
          }}
        >
          {label}
        </HappierText>
      )}
      {...(props.icon === undefined ? {} : {
        leading: (
          <PluginUiIconGlyph
            name={props.icon}
            size={HAPPIER_COMPOSER_STATUS_BADGE_METRICS.iconSize}
            color={marker}
            {...(props.testID === undefined ? {} : { testID: `${props.testID}:icon` })}
          />
        ),
      })}
      caret={(
        <HappierChevron
          direction="down"
          color={theme.colors.mutedText}
          size={HAPPIER_COMPOSER_STATUS_BADGE_METRICS.caretSize}
          {...(props.testID === undefined ? {} : { testID: `${props.testID}:caret` })}
        />
      )}
      opensPopover={props.opensPopover}
      emphasis={emphasis}
      tintColor={tint}
      inkColor={ink}
      onPress={props.onPress}
      anchorRef={props.anchorRef}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityHint={props.accessibilityHint}
      {...(props.opensPopover ? { accessibilityState: { expanded: props.expanded === true } } : {})}
      testID={props.testID}
    />
  );
}
