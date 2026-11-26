import * as React from 'react';
import type { ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { StorageInventoryItemV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import type { DiscussionOpenedMessageV1 } from '@happier-dev/protocol/discussions/actions';
import { readDiscussionAttachmentPayloadsV1 } from '@happier-dev/protocol/discussions/content';

import { resolveDiscussionMessageAuthorLabel } from '@/components/discussions/discussionTimelineProjection';
import { useShareViewerProfile } from '@/components/sharing/useShareViewerProfile';
import { createDiscussionClient } from '@/sync/api/discussions/discussionActions';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

/** What a stored file's row needs from the message that carries it. */
export type DiscussionStorageMessage = Pick<
  DiscussionOpenedMessageV1,
  'id' | 'content' | 'authorAccountId' | 'accountActor' | 'createdAt'
>;

/** A file's message as the page's exact read opened it, with the title of the Discussion it lives in. */
export type DiscussionStorageExactMessage = Readonly<{
  message: DiscussionStorageMessage;
  discussionTitle: string | null;
}>;

/** The Discussions owner's typed refusal of a page's exact read (`errorCode`, and its cause when it names one). */
export type DiscussionStorageExactFailure = Readonly<{ code: string; failureCause?: ActionFailureCauseV1 }>;

/**
 * The page's messages by `discussionId`/`messageId`: an entry once the exact read settled it, `null` where the Home
 * left it out (missing, not readable, locked), absent while it is being read or when its read failed (`failed`).
 */
export type DiscussionStorageExactMessages = Readonly<{
  messages: ReadonlyMap<string, DiscussionStorageExactMessage | null>;
  /** The page's pairs are read here: one absent from `messages` is still being read (its row shimmers), not unknown. */
  reading: boolean;
  /** Pairs whose read failed: they are not being read and were not left out. */
  failed: ReadonlySet<string>;
  /** The first failed read's typed refusal; `null` while none failed. */
  failure: DiscussionStorageExactFailure | null;
  /** Asks again, once, for each failed read's same pairs; `null` while none failed. */
  retry: (() => void) | null;
}>;

export function discussionStorageMessageKey(
  discussionId: string,
  messageId: string,
): string {
  return `${discussionId}\u0000${messageId}`;
}

/** A file's name in its message: the file's own name, or its path in a folder. */
export function readDiscussionAttachmentName(
  message: DiscussionStorageMessage,
  blobId: string,
): string | null {
  if (!message.content) return null;
  for (const attachment of readDiscussionAttachmentPayloadsV1(
    message.content,
  )) {
    if (attachment.kind === 'file' && attachment.file.blobId === blobId)
      return attachment.name;
    if (attachment.kind !== 'folder') continue;
    const entry = attachment.entries.find(
      (candidate) => candidate.file.blobId === blobId,
    );
    if (entry) return `${attachment.name}/${entry.relativePath}`;
  }
  return null;
}

const NO_MESSAGES: ReadonlyMap<string, DiscussionStorageExactMessage | null> =
  new Map();
const NO_HELD: ReadonlySet<string> = new Set();
const NO_FAILED: ReadonlySet<string> = new Set();
const PAIR_SEPARATOR = '\u0001';

/** One page's exact read that failed: its pairs, asked again together on Retry. */
type FailedRead = Readonly<{ keys: readonly string[]; failure: DiscussionStorageExactFailure }>;
const NO_FAILED_READS: readonly FailedRead[] = [];
type SettledReads = Readonly<{
  scope: ServerAccountScope | null;
  messages: ReadonlyMap<string, DiscussionStorageExactMessage | null>;
  failedReads: readonly FailedRead[];
}>;

/**
 * The messages that name a storage page's Discussion files: at most ONE exact read
 * (`createDiscussionClient().exactMessages`) per page, for the page's distinct message pairs this surface neither
 * holds nor has asked about yet, however many files or Discussions the page holds, and one more per failed read only
 * on an explicit Retry. `held` is the surface's own loaded messages by `discussionStorageMessageKey` (an open
 * Discussion's thread window); a page whose every pair is held reads nothing. Titles and messages are opened on this
 * device by the Discussions API owner. A message the Home leaves out settles `null`; a failed read keeps its typed
 * refusal and its pairs for Retry, and never fails the rest of the list.
 */
export function useDiscussionStorageExactMessages(
  scope: ServerAccountScope | null,
  items: readonly StorageInventoryItemV1[],
  held: ReadonlySet<string> = NO_HELD,
): DiscussionStorageExactMessages {
  const pairsKey = React.useMemo(() => {
    const keys = new Set<string>();
    for (const item of items) {
      if (item.location.kind !== 'discussion') continue;
      const key = discussionStorageMessageKey(
        item.location.discussionId,
        item.location.messageId,
      );
      if (!held.has(key)) keys.add(key);
    }
    return [...keys].join(PAIR_SEPARATOR);
  }, [held, items]);
  const [settled, setSettled] = React.useState<SettledReads>(() => ({
    scope,
    messages: NO_MESSAGES,
    failedReads: NO_FAILED_READS,
  }));
  // The pairs this scope has asked about, settled or in flight: a later page reads only its new ones.
  const asked = React.useRef<
    Readonly<{ scope: ServerAccountScope | null; keys: Set<string> }>
  >({ scope, keys: new Set() });
  // Failed reads a Retry already asked again: pressing it twice before they settle asks nothing more.
  const retried = React.useRef(new WeakSet<FailedRead>());
  const read = React.useCallback(
    (readScope: ServerAccountScope, keys: readonly string[]) => {
      const pairs = keys.map((key) => {
        const [discussionId, messageId] = key.split('\u0000') as [string, string];
        return { discussionId, messageId };
      });
      void (async () => {
        // A read that answers settles every pair: named where the Home returned it, `null` where it left the message
        // out. A failed read settles none of them and keeps its typed refusal for Retry; nothing asks again on its own.
        let opened: Map<string, DiscussionStorageExactMessage | null> | null = null;
        let failure: DiscussionStorageExactFailure | null = null;
        try {
          const outcome = await createDiscussionClient({ scope: readScope, availability: 'available' }).exactMessages(pairs);
          if (outcome.kind === 'succeeded') {
            opened = new Map(keys.map((key) => [key, null]));
            for (const discussion of outcome.value.discussions) {
              for (const message of discussion.messages) {
                const key = discussionStorageMessageKey(discussion.discussionId, message.id);
                if (opened.has(key)) opened.set(key, { message, discussionTitle: discussion.title });
              }
            }
          } else {
            failure = outcome.kind === 'failed'
              ? { code: outcome.errorCode, ...(outcome.failureCause ? { failureCause: outcome.failureCause } : {}) }
              : { code: 'outcome_unknown' };
          }
        } catch {
          // The client settles its own failures as outcomes; anything else is a failed read too.
          failure = { code: 'outcome_unknown' };
        }
        const answered = opened;
        const refused = failure;
        setSettled((previous) => {
          const base = previous.scope === readScope ? previous
            : { scope: readScope, messages: NO_MESSAGES, failedReads: NO_FAILED_READS };
          return {
            scope: readScope,
            messages: answered ? new Map([...base.messages, ...answered]) : base.messages,
            failedReads: refused ? [...base.failedReads, { keys, failure: refused }] : base.failedReads,
          };
        });
      })();
    },
    [],
  );
  React.useEffect(() => {
    if (!scope || !pairsKey) return;
    if (asked.current.scope !== scope)
      asked.current = { scope, keys: new Set() };
    const keys = pairsKey
      .split(PAIR_SEPARATOR)
      .filter((key) => !asked.current.keys.has(key));
    if (keys.length === 0) return;
    for (const key of keys) asked.current.keys.add(key);
    read(scope, keys);
  }, [pairsKey, read, scope]);
  const current = settled.scope === scope ? settled : null;
  const messages = current?.messages ?? NO_MESSAGES;
  const failedReads = current?.failedReads ?? NO_FAILED_READS;
  const retry = React.useCallback(() => {
    if (!scope) return;
    const again = failedReads.filter((entry) => !retried.current.has(entry));
    if (again.length === 0) return;
    for (const entry of again) retried.current.add(entry);
    setSettled((previous) => previous.scope === scope
      ? { ...previous, failedReads: previous.failedReads.filter((entry) => !again.includes(entry)) }
      : previous);
    for (const entry of again) read(scope, entry.keys);
  }, [failedReads, read, scope]);
  const failed = React.useMemo(
    () => failedReads.length === 0 ? NO_FAILED : new Set(failedReads.flatMap((entry) => entry.keys)),
    [failedReads],
  );
  const failure = failedReads[0]?.failure ?? null;
  const reading = scope !== null && pairsKey !== '';
  const hasFailed = failedReads.length > 0;
  return React.useMemo(
    () => ({ messages, reading, failed, failure, retry: hasFailed ? retry : null }),
    [failed, failure, hasFailed, messages, reading, retry],
  );
}

/** Who sent a file's message, as the Discussion's timeline names them ("Mika Tanaka", or "You"). */
export function useDiscussionStorageAuthorLabel(
  scope: ServerAccountScope | null,
): (message: DiscussionStorageMessage) => string {
  const profile = useShareViewerProfile(scope);
  const serverId = scope?.serverId;
  const accountId = scope?.accountId ?? null;
  return React.useCallback(
    (message: DiscussionStorageMessage) =>
      resolveDiscussionMessageAuthorLabel(
        message,
        accountId === null ? undefined : { serverId, accountId, profile },
      ),
    [accountId, profile, serverId],
  );
}
