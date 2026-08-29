/**
 * Semantic projection bounds.
 *
 * Every ceiling here is READ from the published contract symbol and never remembered
 * as a number. `packages/triage-protocol/src/v1/bounds.ts` owns them and tightens them
 * independently of this plugin, and the strict target rejects an over-bound result
 * ATOMICALLY — so one oversize row loses every sibling row in the same page. A local
 * constant that merely happened to agree once is the shape of that failure.
 *
 * Oversize presentation is truncated, never a reason to drop an identity-valid entry:
 * a merge request with a 20 KB title is still a merge request the user must see.
 */

import {
  MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1,
  MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  projectTriageDisplayTextV1,
} from '@happier-dev/triage-protocol/v1';

const ELLIPSIS = '…';
const ELLIPSIS_UTF8_BYTES = new TextEncoder().encode(ELLIPSIS).byteLength;

export type BoundedText = Readonly<{ text: string; truncated: boolean }>;

/**
 * Projects provider text into one bounded display line, announcing a cut with an
 * ellipsis.
 *
 * The single-line rule and the UTF-8-safe cut both belong to
 * `@happier-dev/triage-protocol`: every V1 display string is a single line, so a
 * provider title carrying a newline is not a string the target repairs — it rejects the
 * whole result — and cutting mid-sequence produces a replacement character in the UI.
 * Restating either rule here would be a second decision-maker for it. What stays local
 * is only the presentation choice: this source announces a cut, so it reserves the
 * ellipsis out of the byte budget rather than appending past the bound.
 */
export function boundGitlabText(
  value: string,
  maxUtf8Bytes: number = MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
): BoundedText {
  const fitted = projectTriageDisplayTextV1(value, maxUtf8Bytes);
  if (!fitted.truncated) return { text: fitted.value, truncated: false };
  const kept = projectTriageDisplayTextV1(value, maxUtf8Bytes - ELLIPSIS_UTF8_BYTES);
  return { text: `${kept.value}${ELLIPSIS}`, truncated: true };
}

/** One projected row-fact string, at the contract's own row-fact ceiling. */
export function boundGitlabRowFactText(value: string): BoundedText {
  return boundGitlabText(value, MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1);
}

/**
 * A deterministic label summary bounded only by the published row-fact byte
 * contract. The provider supplies the labels and the protocol supplies the real
 * carrier boundary; an additional count ceiling would hide short labels that fit.
 */
export function summarizeGitlabLabels(labels: readonly string[]): BoundedText {
  if (labels.length === 0) return { text: '', truncated: false };
  return boundGitlabRowFactText(labels.join(', '));
}
