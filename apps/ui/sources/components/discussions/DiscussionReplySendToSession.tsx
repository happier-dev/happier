import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { DiscussionSelectionSourceV1 } from '@happier-dev/protocol/discussions/content';

import { SessionAskTargetChip } from '@/components/sessions/transcript/askRecord/SessionAskRecord';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { randomUUID } from '@/platform/randomUUID';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useSetting } from '@/sync/domains/state/storage';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { t } from '@/text';
import {
  sendDiscussionSelectionToSessionNow,
  type DiscussionSessionSendReceipt,
} from './sendDiscussionSelectionToSession';

type PreparedReply = Readonly<{
  text: string;
  source: Omit<DiscussionSelectionSourceV1, 'draftCorrelationId'>;
}>;
type Attempt = Readonly<{
  localId: string;
  receipt: DiscussionSessionSendReceipt | null;
}>;

/**
 * One Send per reply and Session for this app run. A recycled row finds its attempt again, so pressing
 * Send after scrolling reuses the same localId and the Session dedupes it instead of reading it twice.
 */
const attempts = new Map<string, Attempt>();

/**
 * Lab T3-D's action row under a finished reply in a Session-anchored Discussion: Send it to that Session as
 * information (`session.message.send`, reply none), settling in place into the ask record's target chip.
 * It never touches the Session's composer draft; the selection bar keeps that handoff.
 */
export function DiscussionReplySendToSession(
  props: Readonly<{
    scope: ServerAccountScope;
    sessionId: string;
    /** The Session's readable name; the button says where the reply goes. */
    sessionName: string | null;
    discussionId: string;
    messageId: string;
    /** The reply as the selection handoff formats it; null when it can't be read. */
    prepare: () => PreparedReply | null;
    /** Invite another model or Session into this Discussion through its existing invite step. */
    onAskAnother?: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const template = useSetting('transcriptMessageSendToSessionTemplate');
  const key = `${props.scope.serverId}\u0000${props.scope.accountId}\u0000${props.discussionId}\u0000${props.messageId}\u0000${props.sessionId}`;
  const [attempt, setAttempt] = React.useState<Attempt | null>(
    () => attempts.get(key) ?? null,
  );
  const [sending, setSending] = React.useState(false);
  const send = React.useCallback(async () => {
    if (sending) return;
    const prepared = props.prepare();
    if (!prepared) return;
    const localId = attempts.get(key)?.localId ?? randomUUID();
    attempts.set(key, { localId, receipt: attempts.get(key)?.receipt ?? null });
    setSending(true);
    try {
      const receipt = await sendDiscussionSelectionToSessionNow({
        scope: props.scope,
        sessionId: props.sessionId,
        selectedText: prepared.text,
        source: prepared.source,
        template,
        sourceSessionName: props.sessionName,
        localId,
        execute: createFrontDoorActionExecute(),
      });
      const settled = { localId, receipt };
      attempts.set(key, settled);
      setAttempt(settled);
    } catch {
      const settled = {
        localId,
        receipt: { status: 'unknown', requestBound: false } as const,
      };
      attempts.set(key, settled);
      setAttempt(settled);
    } finally {
      setSending(false);
    }
  }, [
    key,
    props.prepare,
    props.scope,
    props.sessionId,
    props.sessionName,
    sending,
    template,
  ]);

  const receipt = attempt?.receipt ?? null;
  const testID = `discussion-reply-send:${props.messageId}`;
  return (
    <View style={styles.row} testID={testID}>
      {receipt ? (
        <>
          <SessionAskTargetChip
            target={receipt}
            reply="none"
            testID={`${testID}:receipt`}
          />
          {receipt.status === 'queued' || receipt.status === 'unknown' ? (
            <Text style={styles.hint} numberOfLines={2}>
              {receipt.status === 'queued'
                ? t('session.collaboration.discussion.secondOpinion.sentNextTurn')
                : t('session.collaboration.discussion.secondOpinion.uncertainHint')}
            </Text>
          ) : null}
          {receipt.status === 'failed' || receipt.status === 'unknown' ? (
            <ToolbarButton
              testID={`${testID}:retry`}
              busy={sending}
              disabled={sending}
              onPress={() => void send()}
              label={
                receipt.status === 'failed'
                  ? t('common.retry')
                  : t(
                      'session.collaboration.discussion.secondOpinion.checkAgain',
                    )
              }
            />
          ) : null}
        </>
      ) : (
        <ToolbarButton
          testID={`${testID}:send`}
          label={
            props.sessionName
              ? t('session.collaboration.discussion.secondOpinion.sendTo', {
                  name: props.sessionName,
                })
              : t(
                  'session.collaboration.discussion.secondOpinion.sendToSession',
                )
          }
          icon={
            <Icon
              name="paper-plane-tilt"
              size={ICON_SIZE.xs}
              color={theme.colors.text.secondary}
            />
          }
          busy={sending}
          disabled={sending}
          onPress={() => void send()}
        />
      )}
      {props.onAskAnother ? (
        <ToolbarButton
          testID={`${testID}:ask-another`}
          label={t('session.collaboration.discussion.secondOpinion.askAnother')}
          onPress={props.onAskAnother}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  hint: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
    flexShrink: 1,
  },
}));
