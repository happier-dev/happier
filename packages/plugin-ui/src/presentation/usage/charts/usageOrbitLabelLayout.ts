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
