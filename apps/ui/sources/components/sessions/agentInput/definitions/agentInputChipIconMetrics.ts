import { ICON_LABEL_OPTICAL_NUDGE_STYLE } from '@/components/ui/icons/iconOpticalAlignment';

/**
 * One glyph size for every composer action chip.
 *
 * The chip row used to render at two sizes at once: chips drawn with Octicons asked for 16 and chips
 * drawn with Ionicons asked for 18, purely because of which family the file happened to import. The
 * Phosphor migration snapped both onto the nearest scale step, which silently shrank the 18s and made
 * the whole row read smaller than it had.
 *
 * 18 is deliberately between {@link ICON_SIZE.sm} and {@link ICON_SIZE.md}: the chip row already has a
 * fixed optical anchor in the agent brand logo, which renders at ~18 in this row (a 16 slot times its
 * per-brand scale). Matching that anchor makes the row uniform, which the shared scale cannot express
 * without adding a step that would reopen 16/18/20 drift everywhere else.
 */
export const AGENT_INPUT_CHIP_ICON_SIZE_PX = 18;

/**
 * Pairs with the size above: the optical nudge that puts a chip's glyph on its label's ink.
 *
 * Measured in the running app — a chip icon centred on its label's line box sits 1.37px above the
 * text's actual centre, because the box reserves descender space the lowercase run does not use.
 * Chips do not share a row component (each builds its own layout), so the correction rides on the
 * glyph rather than a container, which is also what makes it impossible to add a chip and forget it.
 */
export const AGENT_INPUT_CHIP_ICON_STYLE = ICON_LABEL_OPTICAL_NUDGE_STYLE;

/**
 * Glyphs a chip contributes to the **collapsed action menu**.
 *
 * These render at the size written here, verbatim. It is tempting to assume the menu's row owner
 * normalises them the way `Item`/`SelectableRow` normalise a list row's icon — it does not:
 * `ActionListSection` wraps each contributed icon in a plain `<View>` before handing it to
 * `SelectableRow` as `left`, and that wrapper is not icon-like (no `name`, and it has children), so
 * the row's resize deliberately skips it. Anything written at a `collapsedAction` /
 * `collapsedContentPopover` / `collapsedOptionsPopover` call site is therefore the final size, and
 * must stay on the menu step rather than following the chip anchor.
 */
export const AGENT_INPUT_MENU_ICON_SIZE_PX = 16;

/**
 * Glyphs a chip contributes to a small *badge* rather than drawing on itself or on a menu row.
 *
 * Named rather than inlined so the row rule stays a rule: a bare number in a chip file is drift, a
 * named exception is a decision.
 */
export const AGENT_INPUT_CHIP_OPTION_ICON_SIZE_PX = 14;
