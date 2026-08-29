/**
 * The portable, read-only request understood by Happier's one diff renderer.
 * Review drafts, line selection, parser policy, and virtualization are
 * intentionally absent: those remain with the mounted product owner.
 */
export type HappierDiffViewerRequest = Readonly<{
  unifiedDiff: string;
  filePath?: string;
  testID?: string;
}>;

/** Keep optional-member omission stable across plugin and app adapters. */
export function resolveHappierDiffViewerRequest(
  input: HappierDiffViewerRequest,
): HappierDiffViewerRequest {
  return Object.freeze({
    unifiedDiff: input.unifiedDiff,
    ...(input.filePath === undefined ? {} : { filePath: input.filePath }),
    ...(input.testID === undefined ? {} : { testID: input.testID }),
  });
}
