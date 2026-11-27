import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';
import type { TriageEntryRefV1 } from '@happier-dev/protocol/tasks/entryRefV1';
import { MENTION_KIND_V1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import type { DiscussionOpenedSummaryV1 } from '@happier-dev/protocol/discussions/actions';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { useSessionCollaborationAvailabilityState } from '@/hooks/session/useSessionCollaborationAvailability';
import { createDiscussionClient } from '@/sync/api/discussions/discussionActions';
import {
  useServerCredentialAccountScopeBindings,
  type ServerCredentialAccountScopeBinding,
} from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { t } from '@/text';
import { DiscussionDetailsView } from './DiscussionDetailsView';
import { DiscussionInlineCreateComposer } from './DiscussionInlineCreateComposer';
import { discussionFailureLabel } from './discussionFailureLabel';
import { useDiscussionDraft } from './useDiscussionDraft';

export type ItemDiscussionThreadProps = Readonly<{
  serverId: string;
  anchor: TriageEntryRefV1;
  audience?: 'thread' | 'internal';
  sourceName?: string;
  readOnly?: boolean;
  onPosted?: () => void;
  testID?: string;
}>;

type ItemThreadLookup =
  | Readonly<{ kind: 'resolving' }>
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'found'; discussionId: string }>
  | Readonly<{ kind: 'failed'; errorCode: string }>;

const RESOLVING: ItemThreadLookup = Object.freeze({ kind: 'resolving' });

/** One stable private draft per item, so a first comment survives leaving and coming back. */
function itemDraftId(anchor: TriageEntryRefV1): string {
  return `item:${JSON.stringify([anchor.source, anchor.kindId, anchor.entryId, anchor.collisionScope ?? null])}`;
}

/**
 * Comments on one item (a Task, an external issue): the item's one Discussion, found through the Discussions
 * list owner's exact item filter, drawn by the Discussion page itself (timeline, composer, held mentions,
 * capabilities). Before the first comment there is no Discussion: the first Send creates it, anchored to the
 * item, through the one create path. Audience, keys and post admission stay with the server and the item's
 * own grants; `readOnly` is the item owner's decision passed through, used only to not offer a first comment.
 */
export function ItemDiscussionThread(
  props: ItemDiscussionThreadProps,
): React.ReactElement | null {
  const serverIds = React.useMemo(() => [props.serverId], [props.serverId]);
  const binding =
    [...useServerCredentialAccountScopeBindings(serverIds).values()][0] ?? null;
  const availability = useSessionCollaborationAvailabilityState(props.serverId);
  if (availability === 'loading' || !binding) return null;
  if (availability !== 'available') {
    return (
      <SurfaceStateCard
        size="line"
        kind="unavailable"
        title={t('session.collaboration.discussion.unavailable')}
      />
    );
  }
  return (
    <ItemDiscussionThreadContent
      key={`${binding.scope.serverId}:${binding.scope.accountId}`}
      {...props}
      binding={binding}
    />
  );
}

function ItemDiscussionThreadContent(
  props: ItemDiscussionThreadProps &
    Readonly<{ binding: ServerCredentialAccountScopeBinding }>,
) {
  const { binding, anchor } = props;
  const anchorKey = JSON.stringify(anchor);
  const [lookup, setLookup] = React.useState<ItemThreadLookup>(RESOLVING);
  const [generation, refresh] = React.useReducer(
    (value: number) => value + 1,
    0,
  );
  React.useEffect(() => {
    const controller = new AbortController();
    const client = createDiscussionClient({
      scope: binding.scope,
      availability: 'available',
    });
    void client
      .list(
        { anchorTask: JSON.parse(anchorKey) as TriageEntryRefV1 },
        controller.signal,
      )
      .then((outcome) => {
        if (controller.signal.aborted || !binding.isCurrent()) return;
        if (outcome.kind !== 'succeeded') {
          setLookup({
            kind: 'failed',
            errorCode:
              outcome.kind === 'failed' ? outcome.errorCode : 'outcome_unknown',
          });
          return;
        }
        const thread = outcome.value.discussions[0];
        setLookup(
          thread
            ? { kind: 'found', discussionId: thread.id }
            : { kind: 'none' },
        );
      });
    return () => controller.abort();
  }, [anchorKey, binding, generation]);
  const { onPosted } = props;
  const created = React.useCallback(
    (discussion: DiscussionOpenedSummaryV1) => {
      setLookup({ kind: 'found', discussionId: discussion.id });
      onPosted?.();
    },
    [onPosted],
  );
  // Another device posted the first comment between our read and our Send: open the thread it made.
  const refused = React.useCallback((errorCode: string | undefined) => {
    if (errorCode === 'discussion_task_thread_exists') refresh();
  }, []);
  const internal = props.audience === 'internal';
  const draftAddress = React.useMemo(
    () =>
      lookup.kind === 'found'
        ? { kind: 'discussion' as const, discussionId: lookup.discussionId }
        : { kind: 'newDiscussion' as const, draftId: itemDraftId(anchor) },
    [anchor, lookup],
  );
  const testID = props.testID ?? 'item-discussion-thread';
  return (
    <View testID={testID} style={styles.root}>
      {internal ? (
        <Text
          testID={`${testID}.audience`}
          variant="meta"
          style={styles.secondary}
        >
          {t(
            'session.collaboration.discussion.controls.internalAudiencePersonal',
          )}
        </Text>
      ) : null}
      {internal ? (
        <InternalAgentGuard
          scope={binding.scope}
          address={draftAddress}
          sourceName={props.sourceName}
          testID={testID}
        />
      ) : null}
      {lookup.kind === 'resolving' ? null : lookup.kind === 'failed' ? (
        <SurfaceStateCard
          size="line"
          kind="warning"
          title={discussionFailureLabel(lookup.errorCode)}
        />
      ) : lookup.kind === 'found' ? (
        <View testID={`${testID}.timeline`} style={styles.timeline}>
          <DiscussionDetailsView
            target={{
              kind: 'discussion',
              address: { serverId: binding.scope.serverId },
              discussionId: lookup.discussionId,
            }}
            {...(onPosted === undefined ? {} : { onMessagePosted: onPosted })}
            active
          />
        </View>
      ) : props.readOnly === true ? (
        <Text
          testID={`${testID}.empty`}
          variant="meta"
          style={styles.secondary}
        >
          {t('session.collaboration.discussion.controls.itemCommentsEmpty')}
        </Text>
      ) : (
        <DiscussionInlineCreateComposer
          testID={`${testID}.first`}
          binding={binding}
          draftId={itemDraftId(anchor)}
          anchor={{ kind: 'task', entry: anchor }}
          onCreated={created}
          onRefused={refused}
        />
      )}
    </View>
  );
}

/**
 * Inside an Internal thread an addressed agent replies here only (the server refuses any public write from it);
 * the person is told so while their draft addresses one.
 */
function InternalAgentGuard(
  props: Readonly<{
    scope: ServerCredentialAccountScopeBinding['scope'];
    address:
      | Readonly<{ kind: 'discussion'; discussionId: string }>
      | Readonly<{ kind: 'newDiscussion'; draftId: string }>;
    sourceName?: string;
    testID: string;
  }>,
) {
  const { mentions } = useDiscussionDraft({
    scope: props.scope,
    address: props.address,
  });
  if (!mentions.some((mention) => mention.kind === MENTION_KIND_V1.session)) return null;
  return (
    <SurfaceStateCard
      testID={`${props.testID}.agentGuard`}
      size="line"
      kind="warning"
      title={props.sourceName?.trim()
        ? t('session.collaboration.discussion.controls.internalAgentGuard', { source: props.sourceName.trim() })
        : t('session.collaboration.discussion.controls.internalAgentGuardUnnamed')}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { gap: theme.space.s8, alignSelf: 'stretch' },
  // A thread is a long reading block inside the page: it shows this much and scrolls within.
  timeline: {
    height: HAPPIER_PAGE_METRICS.readingClipHeightPx,
    alignSelf: 'stretch',
  },
  secondary: { color: theme.colors.text.secondary },
}));
