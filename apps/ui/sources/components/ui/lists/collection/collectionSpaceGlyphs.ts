import type { PluginUiIconTokenV1 } from '@happier-dev/protocol/plugins/ui';

import { findPluginUiIconTokenForIconName } from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';
import { SESSION_SECTION_ICON_CHOICES } from '@/components/sessions/organization/sessionSectionIcons';

const SPACE_OWN_GLYPHS: readonly PluginUiIconTokenV1[] = [
  'list',
  'attention',
  'review',
  'pin',
  'new',
  'change-open',
  'bug',
  'terminal',
  'desktop',
];

/** The glyph tiles of Save as space / Edit space: the space's own, then whatever else a Section's icon can draw. */
export const COLLECTION_SPACE_GLYPHS: readonly PluginUiIconTokenV1[] = [
  ...new Set([
    ...SPACE_OWN_GLYPHS,
    ...SESSION_SECTION_ICON_CHOICES.flatMap(
      (choice) => findPluginUiIconTokenForIconName(choice, SPACE_OWN_GLYPHS) ?? [],
    ),
  ]),
];
