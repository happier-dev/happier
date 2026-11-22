import * as React from 'react';
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

/**
 * The page's messages by `discussionId`/`messageId`: an entry once the exact read settled it, `null` where the Home
 * left it out (missing, not readable, locked) or the read failed, absent while it is being read.
 */
export type DiscussionStorageExactMessages = Readonly<{
  messages: ReadonlyMap<string, DiscussionStorageExactMessage | null>;
  /** The page's pairs are read here: one absent from `messages` is still being read (its row shimmers), not unknown. */
  reading: boolean;
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
const PAIR_SEPARATOR = '\u0001';

/**
 * The messages that name a storage page's Discussion files, for a surface that has not loaded those Discussions:
 * at most ONE exact read (`createDiscussionClient().exactMessages`) per page, for the page's distinct message pairs it
 * has not asked about yet, however many files or Discussions the page holds. Titles and messages are opened on this
 * device by the Discussions API owner. `enabled: false` (a Discussion already loaded here) reads nothing.
 */
export function useDiscussionStorageExactMessages(
  scope: ServerAccountScope | null,
  items: readonly StorageInventoryItemV1[],
  enabled: boolean,
): DiscussionStorageExactMessages {
  const pairsKey = React.useMemo(() => {
    if (!enabled) return '';
    const keys = new Set<string>();
    for (const item of items) {
      if (item.location.kind === 'discussion')
        keys.add(
          discussionStorageMessageKey(
            item.location.discussionId,
            item.location.messageId,
          ),
        );
    }
    return [...keys].join(PAIR_SEPARATOR);
  }, [enabled, items]);
  const [settled, setSettled] = React.useState<
    Readonly<{
      scope: ServerAccountScope | null;
      messages: ReadonlyMap<string, DiscussionStorageExactMessage | null>;
    }>
  >(() => ({ scope, messages: NO_MESSAGES }));
  // The pairs this scope has asked about, settled or in flight: a later page reads only its new ones.
  const asked = React.useRef<
    Readonly<{ scope: ServerAccountScope | null; keys: Set<string> }>
  >({ scope, keys: new Set() });
  React.useEffect(() => {
    if (!scope || !pairsKey) return;
    if (asked.current.scope !== scope)
      asked.current = { scope, keys: new Set() };
    const keys = pairsKey
      .split(PAIR_SEPARATOR)
      .filter((key) => !asked.current.keys.has(key));
    if (keys.length === 0) return;
    for (const key of keys) asked.current.keys.add(key);
    const pairs = keys.map((key) => {
      const [discussionId, messageId] = key.split('\u0000') as [string, string];
      return { discussionId, messageId };
    });
    void (async () => {
      // Every asked pair settles: named where the Home returned it, `null` (the row's fallback) otherwise. No retry loop;
      // a reopened view asks again.
      const opened = new Map<string, DiscussionStorageExactMessage | null>(
        keys.map((key) => [key, null]),
      );
      try {
        const outcome = await createDiscussionClient({ scope, availability: 'available' }).exactMessages(pairs);
        if (outcome.kind === 'succeeded') {
          for (const discussion of outcome.value.discussions) {
            for (const message of discussion.messages) {
              const key = discussionStorageMessageKey(
                discussion.discussionId,
                message.id,
              );
              if (opened.has(key))
                opened.set(key, { message, discussionTitle: discussion.title });
            }
          }
        }
      } catch {
        // The client settles its own failures as outcomes; anything else leaves these rows on their fallback.
      } finally {
        setSettled((previous) => ({
          scope,
          messages: new Map([
            ...(previous.scope === scope ? previous.messages : NO_MESSAGES),
            ...opened,
          ]),
        }));
      }
    })();
  }, [pairsKey, scope]);
  const messages = settled.scope === scope ? settled.messages : NO_MESSAGES;
  const reading = scope !== null && pairsKey !== '';
  return React.useMemo(() => ({ messages, reading }), [messages, reading]);
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
