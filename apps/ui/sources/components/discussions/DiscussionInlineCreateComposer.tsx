import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { DiscussionErrorCodeV1 } from '@happier-dev/protocol/discussions/errors';
import type { DiscussionOpenedSummaryV1 } from '@happier-dev/protocol/discussions/actions';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { t } from '@/text';
import { DiscussionComposer } from './DiscussionComposer';
import type { DiscussionDetailsTarget } from './discussionDetailsTarget';
import { discussionFailureLabel } from './discussionFailureLabel';
import { useDiscussionDraft } from './useDiscussionDraft';
import { useNewDiscussionCreate } from './useNewDiscussionCreate';

/**
 * The first comment of a thread that does not exist yet, written in place (a Doc passage's margin, an item's
 * Activity): its private `newDiscussion` draft and the one Discussion composer. Send creates the Discussion
 * through the one create path the new-Discussion page uses; nothing is sent before Send. An outcome that needs
 * the person (refused, not known yet, waiting for approval) says so in place, and leads to the full page when
 * the caller offers one.
 */
export function DiscussionInlineCreateComposer(
  props: Readonly<{
    testID: string;
    binding: ServerCredentialAccountScopeBinding;
    draftId: string;
    anchor?: Extract<DiscussionDetailsTarget, { kind: 'new' }>['anchor'];
    focusOnOpen?: boolean;
    onCreated: (discussion: DiscussionOpenedSummaryV1) => void;
    /** A refusal this caller resolves itself (an item thread that another device created first). */
    onRefused?: (errorCode: DiscussionErrorCodeV1 | string | undefined) => void;
    onOpenDiscussion?: () => void;
  }>,
): React.ReactElement {
  const { binding } = props;
  const address = React.useMemo(
    () => ({ serverId: binding.scope.serverId }),
    [binding.scope.serverId],
  );
  const create = useNewDiscussionCreate({
    scope: binding.scope,
    address,
    accountLifetime: binding,
    draftId: props.draftId,
    ...(props.anchor ? { anchor: props.anchor } : {}),
    onCreated: props.onCreated,
  });
  const { text, mentions, setComposer } = useDiscussionDraft({
    scope: binding.scope,
    address: create.draftAddress,
  });
  const value = React.useMemo(() => ({ text, mentions }), [mentions, text]);
  const { mutation } = create;
  const failedCode =
    mutation?.status === 'failed' ? mutation.errorCode : undefined;
  const onRefused = props.onRefused;
  React.useEffect(() => {
    if (mutation?.status === 'failed') onRefused?.(failedCode);
  }, [failedCode, mutation?.status, onRefused]);
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
          {props.onOpenDiscussion ? (
            <RoundButton
              size="small"
              display="inverted"
              title={t('artifacts.browser.passage.openConversation')}
              testID={`${props.testID}.open`}
              onPress={props.onOpenDiscussion}
            />
          ) : mutation.status === 'failed' ? (
            <RoundButton
              size="small"
              display="inverted"
              title={t('common.close')}
              testID={`${props.testID}.dismiss`}
              onPress={create.dismissRefusal}
            />
          ) : null}
        </View>
      ) : (
        <DiscussionComposer
          scope={binding.scope}
          accountLifetime={binding}
          address={address}
          availability="available"
          disabled={create.composerDisabled}
          isSendDisabled={create.createDisabled}
          isSending={
            mutation?.status === 'sending' || mutation?.status === 'checking'
          }
          value={value}
          onChange={setComposer}
          onSend={(content, attachments) =>
            void create.submit(content, attachments)
          }
          draftAddress={create.draftAddress}
          focusOnOpen={props.focusOnOpen === true}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  needsPerson: { gap: theme.space.s8, alignItems: 'flex-start' },
  needsPersonText: { color: theme.colors.text.secondary },
}));
