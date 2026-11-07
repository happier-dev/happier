import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { DocPassageRefV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationV1';
import type { DiscussionOpenedSummaryV1 } from '@happier-dev/protocol/discussions/actions';

import { DiscussionComposer } from '@/components/discussions/DiscussionComposer';
import { discussionFailureLabel } from '@/components/discussions/discussionFailureLabel';
import { useDiscussionDraft } from '@/components/discussions/useDiscussionDraft';
import { useNewDiscussionCreate } from '@/components/discussions/useNewDiscussionCreate';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import {
  useServerCredentialAccountScopeBindings,
  type ServerCredentialAccountScopeBinding,
} from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { t } from '@/text';

/** A comment being started on a passage: its private `newDiscussion` draft and the passage it is about. */
export type DocNewPassageComment = Readonly<{
  draftId: string;
  passage: DocPassageRefV1;
}>;

/**
 * A new thread in the Doc's margin, beside the selection it comments on (lab K1-S): the passage's quote
 * and the one Discussion composer on the draft Comment wrote. Send creates the anchored Discussion through
 * the same create path as the new-Discussion page; nothing is sent before Send, and an unaddressed comment
 * starts no agent turn. An outcome that needs the person (refused, not known yet, waiting for approval)
 * is handled on that page, which "Open discussion" leads to with the same draft.
 */
export function ArtifactNewPassageThread(
  props: Readonly<{
    scope: ServerAccountScope;
    comment: DocNewPassageComment;
    onCreated: (discussion: DiscussionOpenedSummaryV1) => void;
    onOpenDiscussion: () => void;
    onClose: () => void;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  const serverIds = React.useMemo(
    () => [props.scope.serverId],
    [props.scope.serverId],
  );
  const bindings = useServerCredentialAccountScopeBindings(serverIds);
  const binding = [...bindings.values()][0] ?? null;
  const testID = `artifact:passage-new:${props.comment.draftId}`;
  return (
    <View
      testID={testID}
      style={[styles.card, { borderColor: theme.colors.state.active.border }]}
    >
      <View style={styles.quoteRow}>
        <Icon
          name="quotes"
          size={ICON_SIZE.xs}
          color={theme.colors.text.tertiary}
        />
        <Text variant="meta" numberOfLines={1} style={styles.quote}>
          {props.comment.passage.quote}
        </Text>
        <IconButton
          testID={`${testID}.close`}
          iconName="x"
          size={24}
          accessibilityLabel={t('common.cancel')}
          onPress={props.onClose}
        />
      </View>
      {binding ? (
        <NewPassageThreadComposer
          key={JSON.stringify([
            binding.scope.serverId,
            binding.scope.accountId,
            props.comment.draftId,
          ])}
          testID={testID}
          binding={binding}
          {...props}
        />
      ) : null}
    </View>
  );
}

function NewPassageThreadComposer(
  props: Readonly<{
    testID: string;
    binding: ServerCredentialAccountScopeBinding;
    comment: DocNewPassageComment;
    onCreated: (discussion: DiscussionOpenedSummaryV1) => void;
    onOpenDiscussion: () => void;
  }>,
) {
  const { binding } = props;
  const address = React.useMemo(
    () => ({ serverId: binding.scope.serverId }),
    [binding.scope.serverId],
  );
  const create = useNewDiscussionCreate({
    scope: binding.scope,
    address,
    accountLifetime: binding,
    draftId: props.comment.draftId,
    onCreated: props.onCreated,
  });
  const { text, mentions, setComposer } = useDiscussionDraft({
    scope: binding.scope,
    address: create.draftAddress,
  });
  const value = React.useMemo(() => ({ text, mentions }), [mentions, text]);
  const { mutation } = create;
  // Sending and checking are on their way; anything else that is not done is the person's to settle.
  const needsPerson =
    mutation !== null &&
    (mutation.status === 'failed' ||
      mutation.status === 'outcome_unknown' ||
      mutation.status === 'approval_pending');
  return (
    <>
      {create.createUnavailableLabel ? (
        <SurfaceStateCard
          size="line"
          kind="warning"
          title={create.createUnavailableLabel}
        />
      ) : null}
      {needsPerson ? (
        <View testID={`${props.testID}.needsPerson`} style={styles.needsPerson}>
          <Text variant="meta" style={styles.needsPersonText}>
            {mutation.status === 'failed'
              ? discussionFailureLabel(mutation.errorCode)
              : mutation.status === 'approval_pending'
                ? t('approvals.status.open')
                : t('session.collaboration.discussion.deliveryUnknown')}
          </Text>
          <RoundButton
            size="small"
            display="inverted"
            title={t('artifacts.browser.passage.openConversation')}
            testID={`${props.testID}.open`}
            onPress={props.onOpenDiscussion}
          />
        </View>
      ) : (
        <DiscussionComposer
          scope={binding.scope}
          accountLifetime={binding}
          address={address}
          availability="available"
          disabled={create.createDisabled}
          value={value}
          onChange={setComposer}
          onSend={(content, attachments) =>
            void create.submit(content, attachments)
          }
          draftAddress={create.draftAddress}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    borderWidth: 1,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface.base,
    paddingVertical: theme.space.s10,
    paddingHorizontal: theme.space.s12,
    gap: theme.space.s8,
  },
  quoteRow: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6 },
  quote: { flex: 1, minWidth: 0, color: theme.colors.text.tertiary },
  needsPerson: { gap: theme.space.s8, alignItems: 'flex-start' },
  needsPersonText: { color: theme.colors.text.secondary },
}));
