import * as React from 'react';

import { InboxContent } from '@/components/inbox/InboxContent';
import type { InboxItem } from '@/components/inbox/inboxItems';
import { resolveInboxItemPageRoute } from '@/components/inbox/inboxItemFocus';
import { createInboxAttentionFixture } from '@/dev/testkit/fixtures/inboxFixtures';
import type { InboxModel } from '@/hooks/inbox/useInboxModel';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';

/**
 * Dev-only specimen of the Inbox's Mentions view (coordination lab V3 P4-Mp) drawn by the real `InboxContent`:
 * mentions from two people with their faces and quoted lines, one from an Agent (no face, its type glyph), and
 * the same rows while a followed Run could not be read (`?scene=failed`: the stale line with its one Retry).
 * Fixture facts only; nothing is read, opened or retried.
 */
export type InboxStatesSpecimenScene = 'mentions' | 'failed' | 'signIn' | 'signInBusy' | 'signInFailed';
const SIGN_IN_SCENES: readonly InboxStatesSpecimenScene[] = ['signIn', 'signInBusy', 'signInFailed'];

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

/**
 * Needs you with a pending machine sign-in (`?scene=signIn|signInBusy|signInFailed`) beside a deletion reminder: the
 * real row and its Confirm sign-in through a fixture answer (confirmed after a beat, still running, or refused).
 */
function signInItems(now: number): InboxItem[] {
  const reminderFocus = { kind: 'managed_machine', serverId: SERVER, id: 'managed-gpu' } as const;
  const signInFocus = { kind: 'managed_machine', serverId: SERVER, id: 'managed-build' } as const;
  return [{
    key: 'sign-in:build', producer: 'live', type: 'approval', view: 'needs_you', title: t('machineSignIn.inboxTitle'),
    context: null, sourceLabel: 'Build box', createdAt: 0, read: false, focus: signInFocus,
    pageRoute: resolveInboxItemPageRoute(signInFocus),
    machineSignIn: { kind: 'managed_machine_sign_in_approval', serverId: SERVER, requesterAccountId: 'account-you',
      homeId: 'home-specimen', managedId: 'managed-build', operationId: 'operation-build', taskId: 'task-build' },
    source: { kind: 'managed_machine_sign_in', serverId: SERVER, id: 'sign-in:build' },
  }, {
    key: 'managed-machine:gpu', producer: 'live', type: 'blocked', view: 'needs_you', title: 'GPU runner',
    context: t('managedRetention.consequence.deleteAt', { time: formatAsOfTime(now + 26 * 60 * MINUTE) }),
    createdAt: now - 40 * MINUTE, read: false, focus: reminderFocus, pageRoute: resolveInboxItemPageRoute(reminderFocus),
    source: { kind: 'managed_machine', serverId: SERVER, id: 'managed-gpu' },
  }, {
    // A failing service's health notice: with the removal reminder it reads under Alerts, not as a blocked session.
    key: `notice:${SERVER}:health-orders`, producer: 'notice', type: 'blocked', view: 'needs_you', title: 'Orders API is failing',
    context: 'It stopped answering its health check on Build box. Open it to see the last log lines.',
    createdAt: now - 12 * MINUTE, read: false, focus: { kind: 'notice', id: 'health-orders', serverId: SERVER },
    pageRoute: resolveInboxItemPageRoute({ kind: 'notice', id: 'health-orders', serverId: SERVER }),
    source: { kind: 'account_notice', id: 'health-orders', serverId: SERVER, displayName: null },
  }];
}

function confirmFor(scene: InboxStatesSpecimenScene): InboxModel['confirmMachineSignIn'] {
  return () => new Promise<ActionExecuteResult>((resolve) => {
    if (scene === 'signInBusy') return;
    setTimeout(() => resolve(scene === 'signInFailed'
      ? { ok: false, errorCode: 'auth_request_expired', error: 'auth_request_expired' } : { ok: true, result: { ok: true } }), 1_200);
  });
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
  const signIn = SIGN_IN_SCENES.includes(scene);
  // A dev specimen: the screen reads only these fields for the Mentions view, so the rest of the model is omitted.
  return {
    ...attention,
    items: signIn ? signInItems(now) : items,
    confirmMachineSignIn: confirmFor(scene),
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
  return <InboxContent model={model} view={SIGN_IN_SCENES.includes(props.scene) ? 'needs_you' : 'mentions'} />;
}
