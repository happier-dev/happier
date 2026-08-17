import {
  projectTriageDisplayTextV1,
  truncateTriageUtf8V1,
  type TriageBoundedTextV1,
} from '@happier-dev/triage-protocol/v1';

/**
 * The published UTF-8 truncation, under this source's own name.
 *
 * Truncating on a UTF-8 boundary and never on a surrogate boundary is a rule of the
 * protocol the bounds belong to, not of this forge: a local reimplementation is a second
 * decision-maker for one rule, and that is how a source drifts out of the shape the
 * strict target admits.
 */
export const truncateUtf8: (value: string, maxUtf8Bytes: number) => TriageBoundedTextV1 =
  truncateTriageUtf8V1;

/**
 * Projects untrusted provider prose into one bounded display line.
 *
 * Every published V1 string is single-line: a control character is not representable in
 * any of them, and a result carrying one is rejected atomically rather than repaired.
 * Real provider titles do contain tabs and newlines, so the shared owner collapses a
 * control run to one space — before projection — and only then bounds it.
 *
 * `null` means no display text survived normalization, which is a different answer from
 * an empty string: the caller supplies its own identity-derived fallback rather than
 * publishing a blank required field.
 */
export function toBoundedDisplayLine(
  value: string,
  maxBytes: number,
): TriageBoundedTextV1 | null {
  const projected = projectTriageDisplayTextV1(value, maxBytes);
  return projected.value.length === 0 ? null : projected;
}
