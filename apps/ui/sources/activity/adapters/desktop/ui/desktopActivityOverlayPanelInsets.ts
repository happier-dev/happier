import type { HappierPageSection } from '@happier-dev/plugin-ui/presentation';
import type { UnistylesThemes } from 'react-native-unistyles';

type Theme = UnistylesThemes[keyof UnistylesThemes];

/**
 * The open panel's one content edge (owner 11-19 O9): row marks, ask cards, banners, the Loading row and the
 * reply field all start on it, so they can't drift apart again. `panel` is the panel's own inset, where a row's
 * hover plate starts; `content` is from that plate to its mark. Everything that is not a plated row sits
 * `content` in from the panel inset.
 */
export function resolveDesktopActivityOverlayPanelInsets(theme: Theme): Readonly<{ panel: number; content: number; edge: number }> {
    const panel = theme.space.s8;
    const content = theme.space.s8;
    return { panel, content, edge: panel + content };
}

/**
 * A freshness line (a banner) inside the panel stands on its parent's content edge rather than on a list's
 * tool inset: the same mechanism a page's own notice uses (`MachineTabSubHead`).
 */
export const DESKTOP_ACTIVITY_OVERLAY_LINE_ON_CONTENT_EDGE: HappierPageSection = { rowDividerColor: 'transparent', rowInsetPx: 0 };
