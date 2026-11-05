import type { HappierUiTheme } from '../../environment/types.js';
import { Platform } from 'react-native';
import type { HappierPortableStyle } from '../portableTypes.js';
import { happierRaisedEdgeStyle, settleHappierRaisedEdge, type HappierRaisedEdge } from '../layout/raisedEdge.js';
import { happierFocusRingStyle } from './focusVisible.js';
import { happierSurfaceGradientWebStyle, resolveHappierSurfaceFinish, type HappierSurfaceGradient } from '../layout/material.js';
import { happierMaterialBackgroundColor } from '../layout/material.js';
import { useContainingHappierMaterialRole, useHappierMaterialColorResolver } from '../layout/Surface.js';
import { useOptionalHappierUiPalette, useOptionalHappierUiPlatform } from '../../environment/context.js';
import { useOptionalPluginUiPresentationHost } from '../../presentationHost/context.js';
import { mixHappierColorOverPaper } from '../data/dataModel.js';
import { HAPPIER_PAGE_METRICS } from '../layout/pageMetrics.js';

/** Material facts are resolved at the host boundary; this does not own glass policy. */
export function useHappierButtonMaterial(theme: HappierUiTheme) {
  const containingRole = useContainingHappierMaterialRole();
  const resolveColor = useHappierMaterialColorResolver();
  const host = useOptionalPluginUiPresentationHost();
  const dark = useOptionalHappierUiPlatform()?.colorScheme === 'dark';
  const palette = useOptionalHappierUiPalette(theme);
  const role = containingRole ?? 'content';
  const nested = containingRole !== undefined;
  // A secondary action is bordered (DESIGN.md: one primary, everything else bordered or quiet): the field box's
  // inside and outline, as the host's own secondary button and the page field trigger draw it. Without a host
  // palette it keeps the control fill.
  const secondaryColor = palette?.fieldBackground ?? theme.colors.control;
  return {
    dark,
    resolveColor,
    secondaryFill: nested ? resolveColor(secondaryColor) : host?.resolveMaterialColor?.({ color: secondaryColor, role: containingRole, nested })
      ?? happierMaterialBackgroundColor(secondaryColor, role, Platform.OS === 'web', nested),
    ...(palette?.controlBorder === undefined ? {} : { secondaryBorder: palette.controlBorder }),
  };
}

export type HappierButtonChromeVariant = 'primary' | 'secondary' | 'plain' | 'destructive';

/**
 * `normal` is the page action, drawn at the page control height (`HAPPIER_PAGE_METRICS.controlHeightPx`,
 * the settings lab's `.btn`). `small` is an action inside the content — a row's peek, a card, a section — drawn
 * at the lab's small control (`.btn.sm`). Neither is sized by a touch target, on any
 * platform: under a finger the shared pressable reaches the target with its hit area, past the drawn
 * button (DESIGN.md → touch targets are hit areas, not drawn sizes).
 */
export type HappierButtonChromeSize = 'normal' | 'small';

/** The dense control height (settings lab `.btn.sm`). */
export const HAPPIER_SMALL_BUTTON_HEIGHT = HAPPIER_PAGE_METRICS.smallControlHeightPx;

/** A label line (20) and the edge (2 × 2) centred in the 32 control: a wrapped label still breathes. */
const BUTTON_PADDING_VERTICAL = 4;
/** The button's edge: transparent, it carries the primary fill's gloss line on its top side. */
const BUTTON_EDGE_WIDTH = 2;
export const HAPPIER_BUTTON_DISABLED_OPACITY = 0.35;
/**
 * How much of the primary shows while it cannot act. A disabled primary is still the view's one action:
 * its own fill and words recede into the page as solid colours, exactly as the host's primary does
 * (unified-work lab `.uwr-dis`), instead of a generic slab dimmed a second time by opacity.
 */
const DISABLED_PRIMARY_PRESENCE = 0.38;

function recedeHappierPrimary(theme: HappierUiTheme): Readonly<{ background: string; foreground: string }> | null {
  const background = mixHappierColorOverPaper(theme.colors.accent, theme.colors.surface, DISABLED_PRIMARY_PRESENCE);
  const foreground = mixHappierColorOverPaper(theme.colors.onAccent, theme.colors.surface, DISABLED_PRIMARY_PRESENCE);
  return background === null || foreground === null ? null : { background, foreground };
}

/**
 * The one chrome of a button-shaped control: geometry, fill, focus ring and
 * label colour for each variant. `Button` renders it, and so does a menu whose
 * trigger is the page's primary action ("Add a source ▾"), so the two can never
 * drift into two looks for the same action weight. Press feedback stays with
 * each caller's pressable, which already owns it.
 */
export function resolveHappierButtonChrome(input: Readonly<{
  theme: HappierUiTheme;
  variant: HappierButtonChromeVariant;
  disabled: boolean;
  focused: boolean;
  size?: HappierButtonChromeSize;
  /** Pressed this frame: a primary button's gloss goes flat under the finger. */
  pressed?: boolean;
  /** The host's accent gloss (`HappierUiPalette.accentGloss`), the light top line of the primary fill. */
  gloss?: HappierRaisedEdge | null;
  dark?: boolean;
  secondaryFill?: string;
  /** The secondary action's outline (`useHappierButtonMaterial`); absent, it draws on its fill alone. */
  secondaryBorder?: string;
  resolveColor?: (color: string, translucentColor?: string, paintRole?: 'surface' | 'solidControl') => string;
}>): Readonly<{
  style: HappierPortableStyle;
  foreground: string;
  gradient: HappierSurfaceGradient | null;
  /** The opacity the control takes while disabled: a receded primary already says it, so it is not dimmed again. */
  disabledOpacity: number;
}> {
  const { theme, variant } = input;
  const small = input.size === 'small';
  const receded = variant === 'primary' && input.disabled ? recedeHappierPrimary(theme) : null;
  const foreground = receded?.foreground ?? (variant === 'primary' ? theme.colors.onAccent
    : variant === 'destructive' ? theme.colors.danger : theme.colors.text);
  const background = variant === 'plain'
    ? 'transparent'
    : receded?.background ?? (input.disabled
      ? theme.colors.controlDisabled
      : (variant === 'primary' ? theme.colors.accent : input.secondaryFill ?? theme.colors.control));
  const outline = variant === 'secondary' && input.secondaryBorder !== undefined ? input.secondaryBorder : null;
  const gradient = variant === 'plain' ? null : resolveHappierSurfaceFinish({
    role: variant === 'primary' ? 'primaryButton' : 'secondaryButton', gradients: theme.surfaceFinish ?? {},
    state: { disabled: input.disabled, focused: input.focused, pressed: input.pressed },
  });
  return {
    foreground: variant === 'primary' && receded === null ? input.resolveColor?.(foreground, theme.colors.text, 'solidControl') ?? foreground : foreground,
    gradient,
    disabledOpacity: receded === null ? HAPPIER_BUTTON_DISABLED_OPACITY : 1,
    style: {
      minHeight: small ? HAPPIER_SMALL_BUTTON_HEIGHT : HAPPIER_PAGE_METRICS.controlHeightPx,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: small ? theme.spacing.xsmall : theme.spacing.small,
      // The outline replaces one pixel of the transparent edge, so a bordered secondary keeps the same box.
      paddingHorizontal: (small ? theme.spacing.medium : theme.spacing.large) + (outline === null ? 0 : BUTTON_EDGE_WIDTH - 1),
      paddingVertical: small ? 0 : BUTTON_PADDING_VERTICAL,
      borderRadius: theme.radii.control,
      backgroundColor: input.resolveColor?.(background, undefined, variant === 'primary' || input.disabled ? 'solidControl' : 'surface') ?? background,
      ...(Platform.OS === 'web' ? happierSurfaceGradientWebStyle(gradient, input.dark !== true) : null),
      borderWidth: outline === null ? BUTTON_EDGE_WIDTH : 1,
      borderColor: outline ?? 'transparent',
      ...happierFocusRingStyle({ visible: input.focused, color: theme.colors.focus }),
      ...(variant === 'primary'
        ? happierRaisedEdgeStyle(settleHappierRaisedEdge(input.gloss, {
          disabled: input.disabled,
          focused: input.focused,
          pressed: input.pressed === true,
        }))
        : null),
    },
  };
}
