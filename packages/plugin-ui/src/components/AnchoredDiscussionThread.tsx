import type { ReactElement, ReactNode } from 'react';
import type { TriageEntryRefV1 } from '@happier-dev/plugin-sdk/protocol';

import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';

export type AnchoredDiscussionThreadProps = Readonly<{
  /** The item the comments are about: a Task or a source entry, by its complete qualified reference. */
  anchor: TriageEntryRefV1;
  /**
   * `internal`: private comments beside an external item's public ones (the Activity's Internal switch). The host
   * says who can read them and that agents asked here reply only here. Default `thread`: the item's own comments.
   */
  audience?: 'thread' | 'internal';
  /** The source's name for the Internal copy ("nothing here is posted to GitHub"). */
  sourceName?: string;
  /**
   * The item owner's own decision that this person cannot write here (View only), passed through as it was
   * decided. The thread then offers no composer. The host still decides every post.
   */
  readOnly?: boolean;
  /** A comment was committed (an Internal switch turns itself off after a send). */
  onPosted?: () => void;
  testID?: string;
  /** Shown by hosts without Happier's Discussions (an isolated web frame). */
  fallback?: ReactNode;
}>;

/**
 * Comments on one item, drawn by Happier's own Discussion timeline and composer: one thread per item, created
 * by its first comment. Access follows the item (a Task's people), mentions of someone who cannot see the
 * item are held with "Share first?", and every key and decryption stays in the host. Your plugin never reads
 * the messages or the Discussion's identity.
 *
 * ```tsx
 * <AnchoredDiscussionThread anchor={task.entryRef} readOnly={task.edit === null} />
 * ```
 */
export function AnchoredDiscussionThread({
  fallback,
  ...input
}: AnchoredDiscussionThreadProps): ReactElement {
  return (
    <>
      {useOptionalPluginUiPresentationHost()?.renderAnchoredDiscussionThread?.(
        input,
      ) ?? fallback}
    </>
  );
}
