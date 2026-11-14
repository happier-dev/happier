import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { selectDiscussionSummariesForAnchor } from '@/components/discussions/discussionActivityItems';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import { createDiscussionClient } from '@/sync/api/discussions/discussionActions';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getDiscussionRepository } from '@/sync/ops/discussions/discussionRepositoryRegistry';
import { useDiscussionRepositorySnapshot } from '@/sync/ops/discussions/useDiscussionRepositorySnapshot';
import { t } from '@/text';

import { AGENT_INPUT_MENU_ICON_SIZE_PX } from '../definitions/agentInputChipIconMetrics';
import { SessionTalkStepBack } from './SessionTalkStepBack';

/**
 * The To picker's Discussion step: this session's active Discussions, read from the same anchored list People
 * shows. Mounted only while the person chooses one; the choice becomes the Discussion selector's id.
 */
export function SessionTalkDiscussionChoices(
  props: Readonly<{
    sessionId: string;
    serverId: string;
    selectedId: string | null;
    onChoose: (discussionId: string) => void;
    onBack: () => void;
  }>,
) {
  const { binding } = useServerCredentialAccountScopeBinding(props.serverId);
  const back = <SessionTalkStepBack testID="session-talk-discussion-back" onBack={props.onBack} />;
  return (
    <>
      {back}
      <CollectionListGroupLabel
        title={t('session.participants.talk.chooseDiscussion')}
        presentation="menu"
      />
      {binding?.isCurrent() ? (
        <DiscussionChoiceRows {...props} binding={binding} />
      ) : (
        <Item
          rowRole="menu"
          mode="info"
          showChevron={false}
          showDivider={false}
          title={t('session.participants.talk.discussionsUnavailable')}
        />
      )}
    </>
  );
}

function DiscussionChoiceRows(
  props: Readonly<{
    sessionId: string;
    serverId: string;
    selectedId: string | null;
    onChoose: (discussionId: string) => void;
    binding: NonNullable<
      ReturnType<typeof useServerCredentialAccountScopeBinding>['binding']
    >;
  }>,
) {
  const { theme } = useUnistyles();
  const { binding, sessionId } = props;
  const address = React.useMemo(
    () => ({ serverId: props.serverId }),
    [props.serverId],
  );
  const client = React.useMemo(
    () =>
      createDiscussionClient({
        scope: binding.scope,
        availability: 'available',
      }),
    [binding.scope],
  );
  const repository = React.useMemo(
    () =>
      getDiscussionRepository({
        scope: binding.scope,
        address,
        client,
        accountLifetime: binding,
      }),
    [address, binding, client],
  );
  useDiscussionRepositorySnapshot(repository);
  React.useEffect(() => {
    const unmount = repository.mount({ anchorSessionId: sessionId });
    if (repository.getListSnapshot(sessionId).lists.active.status === 'idle')
      void repository.refreshAnchoredList(sessionId, 'active');
    return unmount;
  }, [repository, sessionId]);
  const list = repository.getListSnapshot(sessionId).lists.active;
  const discussions = selectDiscussionSummariesForAnchor(list.items, {
    kind: 'session',
    sessionId,
  });
  const check = (
    <Icon
      name="check"
      size={AGENT_INPUT_MENU_ICON_SIZE_PX}
      color={theme.colors.text.primary}
    />
  );
  if (discussions.length === 0) {
    const loading = list.status === 'idle' || list.status === 'loading';
    const failed = !loading && list.status !== 'ready';
    return (
      <Item
        testID="session-talk-discussion-state"
        rowRole="menu"
        mode="info"
        showChevron={false}
        showDivider={false}
        loading={loading}
        title={
          loading
            ? t('common.loading')
            : failed
              ? t('session.participants.talk.discussionsUnavailable')
              : t('session.participants.talk.noDiscussions')
        }
        detail={failed ? t('common.retry') : undefined}
        onPress={
          failed
            ? () => {
                void repository.refreshAnchoredList(sessionId, 'active');
              }
            : undefined
        }
      />
    );
  }
  return (
    <>
      {discussions.map((discussion) => {
        const selected = discussion.id === props.selectedId;
        return (
          <Item
            key={discussion.id}
            testID={`session-talk-discussion:${discussion.id}`}
            rowRole="menu"
            icon={
              <Icon
                name="chats-circle"
                size={AGENT_INPUT_MENU_ICON_SIZE_PX}
                color={theme.colors.text.secondary}
              />
            }
            title={
              discussion.title ??
              t('session.collaboration.discussion.encryptedTitle')
            }
            selected={selected}
            rightElement={selected ? check : undefined}
            showChevron={false}
            showDivider={false}
            accessibilityRole="radio"
            accessibilityChecked={selected}
            onPress={() => props.onChoose(discussion.id)}
          />
        );
      })}
    </>
  );
}
