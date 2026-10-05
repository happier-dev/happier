/**
 * Pure presentation rules shared by every entity drag-and-drop surface (core and plugins): where the
 * carried release preview sits, how a Move / Open / Add-to chooser groups its destinations, and what
 * a key means during a staged keyboard move. Admission, effects and execution stay with the host's
 * drag owner and the domain Actions; nothing here decides whether a target takes an item.
 */

/** Pointer → card offset (lab E1): below and to the right, so the card never covers its target. */
export const HAPPIER_CARRIED_PREVIEW_OFFSET = Object.freeze({ x: 14, y: 18 });

/** The source stays in place, quieted while its carried card names the item (lab E1). */
export const HAPPIER_CARRIED_SOURCE_OPACITY = 0.38;

/** Breathing room kept between the carried card and the window edge when it has to flip. */
const WINDOW_MARGIN = 8;

export type HappierCarriedPreviewPlacement = Readonly<{
  left: number;
  top: number;
  /** Which side of the pointer the card sits on; the card leans away from it. */
  side: 'right' | 'left';
}>;

/**
 * Window-space placement for the carried card. It flips to the other side of the pointer only when
 * the preferred side would leave the window, and is clamped so it is always fully readable.
 */
export function resolveHappierCarriedPreviewPlacement(input: Readonly<{
  pointer: Readonly<{ x: number; y: number }>;
  size: Readonly<{ width: number; height: number }>;
  viewport: Readonly<{ width: number; height: number }>;
}>): HappierCarriedPreviewPlacement {
  const { pointer, size, viewport } = input;
  const offset = HAPPIER_CARRIED_PREVIEW_OFFSET;
  const fitsRight = pointer.x + offset.x + size.width <= viewport.width - WINDOW_MARGIN;
  const fitsBelow = pointer.y + offset.y + size.height <= viewport.height - WINDOW_MARGIN;
  const rawLeft = fitsRight ? pointer.x + offset.x : pointer.x - offset.x - size.width;
  const rawTop = fitsBelow ? pointer.y + offset.y : pointer.y - offset.y - size.height;
  const maxLeft = Math.max(0, viewport.width - size.width);
  const maxTop = Math.max(0, viewport.height - size.height);
  return {
    left: Math.min(Math.max(0, rawLeft), maxLeft),
    top: Math.min(Math.max(0, rawTop), maxTop),
    side: fitsRight ? 'right' : 'left',
  };
}

export type HappierDropChooserOptionInput = Readonly<{
  id: string;
  /** Already-localized destination name. */
  label: string;
  /** Its current state ("Working · devbox"); replaced by the reason when it is refused. */
  detail?: string;
  /** Section the destination belongs to when it is available (a project, a pane group). */
  group?: string;
  /** Where the item is now. */
  current?: boolean;
  /** The owner's already-localized reason this destination does not take the item. */
  refusedReason?: string | null;
}>;

export type HappierDropChooserOption = Readonly<{
  id: string;
  label: string;
  detail?: string;
  disabled: boolean;
  current: boolean;
}>;

export type HappierDropChooserSection = Readonly<{
  id: string;
  title?: string;
  options: readonly HappierDropChooserOption[];
}>;

const UNGROUPED_SECTION_ID = 'available';
const UNAVAILABLE_SECTION_ID = 'unavailable';

/**
 * Group chooser destinations: available ones by their group in first-seen order, then every
 * applicable destination that would refuse the item, still listed, under one section that says
 * so ("Can't take reports"), each with the owner's reason. A denied action always says why.
 */
export function resolveHappierDropChooserSections(input: Readonly<{
  options: readonly HappierDropChooserOptionInput[];
  unavailableTitle: string;
}>): readonly HappierDropChooserSection[] {
  const available = new Map<string, { title?: string; options: HappierDropChooserOption[] }>();
  const unavailable: HappierDropChooserOption[] = [];
  for (const option of input.options) {
    const refused = typeof option.refusedReason === 'string' && option.refusedReason.length > 0;
    if (refused) {
      unavailable.push({ id: option.id, label: option.label, detail: option.refusedReason!, disabled: true, current: option.current === true });
      continue;
    }
    const key = option.group ?? UNGROUPED_SECTION_ID;
    let section = available.get(key);
    if (!section) {
      section = option.group === undefined ? { options: [] } : { title: option.group, options: [] };
      available.set(key, section);
    }
    section.options.push({
      id: option.id,
      label: option.label,
      ...(option.detail !== undefined ? { detail: option.detail } : {}),
      disabled: false,
      current: option.current === true,
    });
  }
  const sections: HappierDropChooserSection[] = [];
  for (const [key, section] of available) {
    sections.push({ id: key === UNGROUPED_SECTION_ID ? key : `group:${key}`, ...(section.title !== undefined ? { title: section.title } : {}), options: section.options });
  }
  if (unavailable.length > 0) sections.push({ id: UNAVAILABLE_SECTION_ID, title: input.unavailableTitle, options: unavailable });
  return sections;
}

/**
 * What a key does during a staged keyboard move (the Board move handle's model, shared by every
 * list): Space or Enter picks up, ↑/↓ choose the previous/next place, → goes in (put under, the
 * next view) and ← goes out (top level, the previous view), Space or Enter drops, Escape cancels.
 * `in`/`out` follow reading direction.
 */
export type HappierStagedMoveKeyIntent = 'pickUp' | 'previous' | 'next' | 'in' | 'out' | 'drop' | 'cancel';

export function resolveHappierStagedMoveKey(input: Readonly<{
  key: string;
  staged: boolean;
  repeat?: boolean;
  rtl?: boolean;
}>): HappierStagedMoveKeyIntent | null {
  const commit = input.key === ' ' || input.key === 'Enter';
  if (!input.staged) return commit && input.repeat !== true ? 'pickUp' : null;
  if (commit) return input.repeat === true ? null : 'drop';
  switch (input.key) {
    case 'Escape': return 'cancel';
    case 'ArrowUp': return 'previous';
    case 'ArrowDown': return 'next';
    case 'ArrowRight': return input.rtl === true ? 'out' : 'in';
    case 'ArrowLeft': return input.rtl === true ? 'in' : 'out';
    default: return null;
  }
}
