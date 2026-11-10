import type { ReactNode } from 'react';
import type { ScmFileViewedSource } from '@happier-dev/plugin-sdk/scm';

/** One changed file as its source lists it. Paths are repository-relative. */
export type HappierChangedFile = Readonly<{
  path: string;
  previousPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';
  additions?: number;
  deletions?: number;
  binary?: boolean;
  /** Set when the source has no diff for this file: it stays listed with this sentence, and nothing is read for it. */
  diffUnavailableReason?: string;
  /** This file on its source, offered in the file's ⋯ as the request's `openOnSourceLabel`. */
  webUrl?: string;
}>;

/** One file's diff evidence from its source. `reason` is a sentence the reader sees (a shortened diff shows it beside the diff). */
export type HappierChangedFileDiff =
  | Readonly<{ state: 'available'; unifiedDiff: string }>
  | Readonly<{ state: 'truncated'; unifiedDiff: string; reason: string }>
  | Readonly<{ state: 'unavailable'; reason: string }>;

/**
 * The portable, read-only request for Happier's changed-files review (the Session review tab's file
 * list, tree/list modes, continuous diffs and find). The host decides which diffs to read and when;
 * the source answers one file at a time. No editing, review drafts or Keep/Discard cross this seam.
 */
export type HappierChangedFilesReviewRequest = Readonly<{
  /** What these files compare (for example a pull request at its head). A new identity drops every read diff. */
  identity: string;
  label: string;
  files: readonly HappierChangedFile[];
  loadDiff: (
    path: string,
    signal: AbortSignal,
  ) => Promise<HappierChangedFileDiff>;
  /** The source's Viewed facts from `useScmFileViewed`: a count in the header and a mark on each file. */
  fileViewed?: ScmFileViewedSource | null;
  /** Under the review's header, above the files (a failure or an incomplete-list notice). */
  leadingContent?: ReactNode;
  /** After the last file (load more). */
  trailingContent?: ReactNode;
  /** False while the surface is not presented: the review holds its last state and reads nothing. */
  active: boolean;
  /** A file the reader or an agent asked to open: Review opens it and brings it into view. */
  focusPath?: string | null;
  /** The file ⋯ row that opens a file's `webUrl` ("Open on GitHub"); without it no file offers one. */
  openOnSourceLabel?: string;
  testID?: string;
}>;

/** Keep optional-member omission stable across plugin and app adapters. */
export function resolveHappierChangedFilesReviewRequest(
  input: HappierChangedFilesReviewRequest,
): HappierChangedFilesReviewRequest {
  return Object.freeze({
    identity: input.identity,
    label: input.label,
    files: input.files,
    loadDiff: input.loadDiff,
    active: input.active,
    ...(input.fileViewed === undefined ? {} : { fileViewed: input.fileViewed }),
    ...(input.focusPath === undefined ? {} : { focusPath: input.focusPath }),
    ...(input.openOnSourceLabel === undefined ? {} : { openOnSourceLabel: input.openOnSourceLabel }),
    ...(input.leadingContent === undefined
      ? {}
      : { leadingContent: input.leadingContent }),
    ...(input.trailingContent === undefined
      ? {}
      : { trailingContent: input.trailingContent }),
    ...(input.testID === undefined ? {} : { testID: input.testID }),
  });
}
