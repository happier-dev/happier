import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

export type ReviewCommentTextSnapshotLinesV1 = Readonly<{
  selectedLines: readonly string[];
  beforeContext: readonly string[];
  afterContext: readonly string[];
}>;

export const REVIEW_COMMENT_TEXT_SNAPSHOT_MAX_BYTES_V1 = 5 * 1024 * 1024;
export const REVIEW_COMMENT_TEXT_SNAPSHOT_MAX_LINE_BYTES_V1 = 4_000;

const BIDI_CONTROL_RE_V1 = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

export function reviewCommentTextSnapshotUtf8BytesV1(value: string): number {
  return utf8ToBytes(value).length;
}

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
