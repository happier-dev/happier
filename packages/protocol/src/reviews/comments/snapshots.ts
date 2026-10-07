import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

export type ReviewCommentTextSnapshotLinesV1 = Readonly<{
  selectedLines: readonly string[];
  beforeContext: readonly string[];
  afterContext: readonly string[];
}>;

const BIDI_CONTROL_RE_V1 = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

export function reviewCommentTextSnapshotHasBidiControlsV1(lines: readonly string[]): boolean {
  return lines.some((line) => BIDI_CONTROL_RE_V1.test(line));
}

export function reviewCommentTextSnapshotIsLikelyMinifiedV1(lines: readonly string[]): boolean {
  if (lines.length === 0) return false;
  const joined = lines.join('\n');
  if (joined.length < 2000) return false;
  const newlineDensity = lines.length / Math.max(joined.length, 1);
  const averageLineLength = joined.length / lines.length;
  return averageLineLength > 500 && newlineDensity < 0.003;
}

function sha256Json(value: unknown): string {
  return `sha256:${bytesToHex(sha256(utf8ToBytes(JSON.stringify(value))))}`;
}

export function buildReviewCommentTextSnapshotHashes(lines: ReviewCommentTextSnapshotLinesV1): Readonly<{
  selectedLinesHash: string;
  contextWindowHash: string;
}> {
  return {
    selectedLinesHash: sha256Json(lines.selectedLines),
    contextWindowHash: sha256Json({
      beforeContext: lines.beforeContext,
      selectedLines: lines.selectedLines,
      afterContext: lines.afterContext,
    }),
  };
}
