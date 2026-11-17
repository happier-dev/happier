import * as React from 'react';

import { InboxContent } from '@/components/inbox/InboxContent';
import type { InboxItem } from '@/components/inbox/inboxItems';
import { resolveInboxItemPageRoute } from '@/components/inbox/inboxItemFocus';
import { createInboxAttentionFixture } from '@/dev/testkit/fixtures/inboxFixtures';
import type { InboxModel } from '@/hooks/inbox/useInboxModel';

/**
 * Dev-only specimen of the Inbox's Mentions view (coordination lab V3 P4-Mp) drawn by the real `InboxContent`:
 * mentions from two people with their faces and quoted lines, one from an Agent (no face, its type glyph), and
 * the same rows while a followed Run could not be read (`?scene=failed`: the stale line with its one Retry).
 * Fixture facts only; nothing is read, opened or retried.
 */
export type InboxStatesSpecimenScene = 'mentions' | 'failed';

const SERVER = 'specimen-home';
const MINUTE = 60_000;

function mention(
  input: Readonly<{
    id: string;
    title: string;
    source: string;
    at: number;
    author: InboxItem['author'];
    excerpt: string;
  }>,
): InboxItem {
  const focus = {
    kind: 'discussion',
    serverId: SERVER,
    id: `discussion-${input.id}`,
    messageId: input.id,
  } as const;
  return {
    key: `discussion:${SERVER}:${focus.id}:${input.id}`,
    producer: 'live',
    type: 'mention',
    view: 'mentions',
    title: input.title,
    context: null,
    createdAt: input.at,
    read: false,
    focus,
    pageRoute: resolveInboxItemPageRoute(focus),
    source: {
      kind: 'discussion',
      id: focus.id,
      serverId: SERVER,
      displayName: input.source,
    },
    author: input.author,
    excerpt: input.excerpt,
  };
}

function buildModel(scene: InboxStatesSpecimenScene): InboxModel {
  const now = Date.now();
  const items: InboxItem[] = [
    mention({
      id: 'm-ben',
      title: 'Retry cap during deploys',
      source: 'payments',
      at: now - 14 * MINUTE,
      author: {
        name: 'Ben Ortiz',
        avatar: { id: `${SERVER}:account-ben`, imageUrl: null },
      },
      excerpt: '“@you ok to ship 5 with jitter?”',
    }),
    mention({
      id: 'm-mei',
      title: 'Support runbook',
      source: 'doc passage',
      at: now - 26 * 60 * MINUTE,
      author: {
        name: 'Mei Kato',
        avatar: { id: `${SERVER}:account-mei`, imageUrl: null },
      },
      excerpt: '“Legal wants the exact wording.”',
    }),
    mention({
      id: 'm-agent',
      title: 'Checkout UI retry states',
      source: 'checkout',
      at: now - 50 * 60 * MINUTE,
      author: { name: 'Daily coordinator' },
      excerpt: '“Can you confirm the webkit e2e run before I merge?”',
    }),
  ];
  const attention = createInboxAttentionFixture(SERVER);
  // A dev specimen: the screen reads only these fields for the Mentions view, so the rest of the model is omitted.
  return {
    ...attention,
    items,
    executionRunAttention: {
      loading: false,
      failed: scene === 'failed',
      retry: () => {},
    },
    openApprovals: [],
    openUsageNotices: [],
    friendRequests: [],
    actionOperationEntries: [],
    sessionPresentation: {
      sessionsNeedingAttention: [],
      readySessions: [],
      markAllReadTargets: [],
      pendingRequestHydrationTargets: [],
    },
    targetBySessionAddress: new Map(),
    pendingReadKeys: new Set(),
    readUnavailableReasonBySessionAddress: new Map(),
    markAllReadUnavailableReason: null,
    markAllPending: false,
    isLoading: false,
    hasPrimaryAttention: false,
    showCaughtUp: false,
    workGroups: [],
    spansHomes: false,
    markRead: async () => {},
    resolveActionOperation: () => {},
    settle: async () => {},
    setReminder: async () => {},
  } as unknown as InboxModel;
}

export function InboxStatesSpecimen(
  props: Readonly<{ scene: InboxStatesSpecimenScene }>,
) {
  const model = React.useMemo(() => buildModel(props.scene), [props.scene]);
  return <InboxContent model={model} view="mentions" />;
}
