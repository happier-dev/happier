/**
 * DOM readers for the web hit area the shared pressable renders (`useHappierHitArea`): an invisible
 * absolute `[data-happier-hit-area]` frame, the pressable's first child, offset from its padding edge.
 */

type Side = 'top' | 'bottom' | 'left' | 'right';
export type HappierRenderedHitReach = Readonly<Record<Side, number>>;

const px = (value: string): number => Number.parseFloat(value) || 0;

/** The hit frame `control` hosts, or `null` when no hit area applies. */
export function readHitAreaFrame(control: HTMLElement): HTMLElement | null {
  return control.querySelector<HTMLElement>(':scope > [data-happier-hit-area="true"]');
}

/**
 * How far the hit area reaches past the control's drawn OUTER box on each side: the frame's offset
 * from the padding edge less the control's own border, so a bordered and a borderless control that
 * reach the same target read the same. `null` when no hit area applies.
 */
export function readHitAreaReach(control: HTMLElement): HappierRenderedHitReach | null {
  const frame = readHitAreaFrame(control);
  if (frame === null) return null;
  const frameStyle = getComputedStyle(frame);
  const own = getComputedStyle(control);
  const reach = (side: Side, border: string) => 0 - px(frameStyle[side]) - px(border);
  return {
    top: reach('top', own.borderTopWidth),
    bottom: reach('bottom', own.borderBottomWidth),
    left: reach('left', own.borderLeftWidth),
    right: reach('right', own.borderRightWidth),
  };
}

const CLIPS = new Set(['hidden', 'clip']);

/**
 * The elements from `control` itself up to (not including) `within` that clip their overflow. The frame
 * reaches past the drawn box, so a clipping control or ancestor inside the component cuts its reach
 * off: the browser never hit-tests the clipped part. A jsdom mount has no layout to hit-test, so the
 * clipping ancestry is the observable contract; the live probe (`apps/ui/scripts/qa/hitAreaProbe.mjs`)
 * checks the real `elementFromPoint` at the frame's edges.
 */
export function hitAreaClippingAncestors(control: HTMLElement, within: HTMLElement): readonly HTMLElement[] {
  const clipping: HTMLElement[] = [];
  for (let node: HTMLElement | null = control; node !== null && node !== within; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (CLIPS.has(style.overflow) || CLIPS.has(style.overflowX) || CLIPS.has(style.overflowY)) clipping.push(node);
  }
  return clipping;
}
