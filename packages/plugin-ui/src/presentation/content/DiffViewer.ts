import type { ReactNode } from 'react';

/**
 * The portable, read-only request understood by Happier's one diff renderer.
 * Review drafts, line selection, parser policy, and virtualization are
 * intentionally absent: those remain with the mounted product owner.
 *
 * A request is either a unified diff, or a prose passage given as its two
 * sides with their visible labels (instructions and suggested edits people
 * read, not code). The host renders both with its one diff viewer.
 */
export type HappierDiffViewerRequest =
  | Readonly<{
    unifiedDiff: string;
    filePath?: string;
    testID?: string;
    /**
     * The diff is its panel's one vertical scroller: it fills the space it is given and is a list,
     * never a capped box inside another scroller. `leadingContent` reads above the first line and
     * scrolls with it.
     */
    fill?: true;
    leadingContent?: ReactNode;
  }>
  | Readonly<{
    before: string;
    after: string;
    beforeLabel: string;
    afterLabel: string;
    testID?: string;
  }>;

/** Keep optional-member omission stable across plugin and app adapters. */
export function resolveHappierDiffViewerRequest(
  input: HappierDiffViewerRequest,
): HappierDiffViewerRequest {
  if ('before' in input) {
    return Object.freeze({
      before: input.before,
      after: input.after,
      beforeLabel: input.beforeLabel,
      afterLabel: input.afterLabel,
      ...(input.testID === undefined ? {} : { testID: input.testID }),
    });
  }
  return Object.freeze({
    unifiedDiff: input.unifiedDiff,
    ...(input.filePath === undefined ? {} : { filePath: input.filePath }),
    ...(input.testID === undefined ? {} : { testID: input.testID }),
    ...(input.fill === true ? { fill: true as const } : {}),
    ...(input.leadingContent === undefined ? {} : { leadingContent: input.leadingContent }),
  });
}
