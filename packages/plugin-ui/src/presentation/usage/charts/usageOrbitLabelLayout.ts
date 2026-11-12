export type UsageOrbitLabelBox = Readonly<{
  /** The edge the label starts from: its left edge for `start`, its right edge for `end`. */
  x: number;
  /** The baseline the planet would put the label on. */
  y: number;
  /** The label's drawn width. */
  span: number;
  anchor: 'start' | 'end';
}>;

/**
 * Baselines for the Orbit's planet labels. Planets keep their own orbit, so on a narrow body two
 * labels can land on the same line and overprint ("Custom Acp1%"). A label that would touch another
 * moves down by a line (up when it would leave the drawing), so every name stays readable and
 * stays beside its planet. Labels that do not touch keep the baseline their planet gave them.
 */
export function placeUsageOrbitLabels(
  labels: readonly UsageOrbitLabelBox[],
  frame: Readonly<{ height: number; line: number }>,
): number[] {
  const left = (label: UsageOrbitLabelBox) => (label.anchor === 'start' ? label.x : label.x - label.span);
  const touches = (a: UsageOrbitLabelBox, b: UsageOrbitLabelBox) => left(a) < left(b) + b.span && left(b) < left(a) + a.span;
  const order = labels.map((_, index) => index).sort((a, b) => labels[a]!.y - labels[b]!.y);
  const lowest = frame.height - 4;
  const y = labels.map((label) => label.y);
  const placed: number[] = [];
  for (const index of order) {
    for (const other of placed) {
      if (touches(labels[index]!, labels[other]!) && Math.abs(y[index]! - y[other]!) < frame.line) y[index] = y[other]! + frame.line;
    }
    y[index] = Math.min(y[index]!, lowest);
    placed.push(index);
  }
  // Labels pushed against the bottom edge make room upward instead of leaving the drawing.
  for (let step = placed.length - 1; step > 0; step--) {
    const index = placed[step]!;
    for (let before = step - 1; before >= 0; before--) {
      const other = placed[before]!;
      if (touches(labels[index]!, labels[other]!) && y[index]! - y[other]! < frame.line) y[other] = Math.max(frame.line, y[index]! - frame.line);
    }
  }
  return y;
}

/** The lab's hand-set angles: the largest planet just above the right, the next ones alternating sides. */
const USAGE_ORBIT_WIDE_ANGLES = [-0.12, 3.0, 0.42, 3.62, -0.62, 2.4, 0.95] as const;
/** How far above or below its side's middle a planet may sit on a narrow body (radians). */
const USAGE_ORBIT_NARROW_SPREAD = 0.9;

/**
 * Each planet's angle on its orbit. A wide body with no more planets than the lab drew keeps the lab's angles. A narrow
 * body (a phone), or one with more planets than those angles, alternates sides and spreads each side's planets evenly
 * from its middle outward, so no two planets share an angle and their labels start on different lines rather than
 * crowding beside the largest planet.
 */
export function usageOrbitAngles(count: number, narrow: boolean): number[] {
  if (!narrow && count <= USAGE_ORBIT_WIDE_ANGLES.length) return USAGE_ORBIT_WIDE_ANGLES.slice(0, count);
  const perSide = [Math.ceil(count / 2), Math.floor(count / 2)];
  const slots = perSide.map((n) => {
    const evenly = Array.from({ length: n }, (_, k) => n <= 1 ? 0 : -USAGE_ORBIT_NARROW_SPREAD + 2 * USAGE_ORBIT_NARROW_SPREAD * k / (n - 1));
    // Middle first, so the largest planets sit level with the centre and the smallest go above and below.
    return evenly.sort((a, b) => Math.abs(a) - Math.abs(b) || a - b);
  });
  return Array.from({ length: count }, (_, index) => {
    const side = index % 2, slot = slots[side]![Math.floor(index / 2)]!;
    return side === 0 ? slot : Math.PI - slot;
  });
}
