import type { PluginUiThemeV1 } from '@happier-dev/plugin-sdk/ui';

import { resolveHappierSkeletonInk } from './skeletonInk.js';
import type { HappierUiPalette } from './types.js';

/**
 * Each page-anatomy colour role from the public theme snapshot: the nearest
 * snapshot role, so a realm without host facts (a hosted-web frame, the author
 * test fixture, the hosted HTML kit) draws the same anatomy in its own theme. Pure: no React, so a
 * browser realm can bundle it.
 */
export function resolveHappierUiPalette(theme: PluginUiThemeV1): HappierUiPalette {
  const colors = theme.colors;
  const skeleton = resolveHappierSkeletonInk(colors.text);
  return {
    page: colors.surface,
    sheet: colors.surface,
    sheetBorder: colors.divider,
    rowDivider: colors.divider,
    // The snapshot has one hairline role; the group separator's lighter weight is a host fact.
    groupDivider: colors.divider,
    controlBorder: colors.divider,
    fieldBackground: colors.surface,
    placeholder: colors.mutedText,
    // Selection is ink (DESIGN.md: colour means state): a host that projects no palette of its own
    // still draws chosen tiles, rings and radio marks in the text colour, never the accent.
    selection: colors.text,
    switchTrackOn: colors.accent,
    switchTrackOff: colors.control,
    switchThumb: colors.onAccent,
    segmentTrack: colors.control,
    segmentThumb: colors.surface,
    navigationSelected: colors.elevatedSurface,
    navigationHover: colors.control,
    pageTabSelected: colors.control,
    ...(skeleton === null ? {} : { skeleton }),
  };
}
