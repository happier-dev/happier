import { useContext, type ReactElement, type ReactNode } from 'react';
import type { ScmFileViewedSource } from '@happier-dev/plugin-sdk/scm';

import { PLUGIN_HOST_API_CONTEXT_INTERNAL } from '../hostApi/context.js';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { HappierStack } from '../presentation/layout/Layout.js';
import { HappierText } from '../presentation/text/Text.js';
import {
  resolveHappierChangedFilesReviewRequest,
  type HappierChangedFile,
  type HappierChangedFileDiff,
} from '../presentation/content/ChangedFilesReview.js';

export type ChangedFilesReviewProps = Readonly<{
  /** What these files compare (for example a pull request at its head). A new identity drops every read diff. */
  identity: string;
  /** A short visible description that also orients screen-reader users. */
  label: string;
  files: readonly HappierChangedFile[];
  /** Reads one file's diff. The review calls it only for files near the reader, never for the whole list. */
  loadDiff: (
    path: string,
    signal: AbortSignal,
  ) => Promise<HappierChangedFileDiff>;
  /** The source's Viewed facts from `useScmFileViewed`. */
  fileViewed?: ScmFileViewedSource | null;
  /** Under the review's header, above the files (a failure or an incomplete-list notice). */
  leadingContent?: ReactNode;
  /** After the last file (load more). */
  trailingContent?: ReactNode;
  /** A file the reader or an agent asked to open: the review opens it and brings it into view. */
  focusPath?: string | null;
  /** False while the panel holding it is hidden (an unselected tab): the review keeps its state and reads nothing. */
  active?: boolean;
  /** The file ⋯ row that opens a file's `webUrl` on its source ("Open on GitHub"). */
  openOnSourceLabel?: string;
  testID?: string;
}>;

/**
 * A source's changed files in Happier's one changed-files review: the same file index, tree and list
 * modes, continuous diffs and find as the Session review tab. Read-only. The panel gives it the
 * space it fills; it is its own scroller. Isolated author renders list the paths.
 */
export function ChangedFilesReview(
  props: ChangedFilesReviewProps,
): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  // A retained surface that is not presented reads nothing; an isolated author render is live.
  const surfaceActive = useContext(PLUGIN_HOST_API_CONTEXT_INTERNAL)?.surfaceActive ?? true;
  const active = surfaceActive && props.active !== false;
  const hosted = host?.renderChangedFilesReview?.(
    resolveHappierChangedFilesReviewRequest({ ...props, active }),
  );
  if (hosted !== undefined && hosted !== null) return <>{hosted}</>;
  return (
    <HappierStack gap={8} testID={props.testID}>
      {props.leadingContent}
      <HappierText variant="micro">{props.label}</HappierText>
      {props.files.map((file) => (
        <HappierText key={file.path} selectable variant="code">
          {file.path}
        </HappierText>
      ))}
      {props.trailingContent}
    </HappierStack>
  );
}

export type {
  HappierChangedFile as ChangedFile,
  HappierChangedFileDiff as ChangedFileDiff,
};
