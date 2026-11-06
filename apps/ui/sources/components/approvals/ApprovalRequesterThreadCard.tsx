import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter, type Href } from 'expo-router';

import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { useDeviceType } from '@/utils/platform/responsive';
import { ApprovalPromptChrome } from '@/components/tools/shell/approvals/ApprovalPromptChrome';
import { ApprovalOpenButton } from '@/components/tools/shell/approvals/ApprovalOpenButton';
import {
  workStatusGlyphColor,
  workStatusWordStyle,
} from '@/components/work/status/workStatusTreatment';
import type { DiscussionRequesterApproval } from '@/sync/domains/artifacts/approvalArtifacts';
import { t } from '@/text';
import { ApprovalInlineDecisionBar, ApprovalInlineFields, useInlineApprovalDecision } from './ApprovalInlineDecision';
import { ApprovalOperationActorLine } from './ApprovalOperationActorLine';
import {
  useApprovalAccountLabel,
  useApprovalRequesterViewer,
} from './ApprovalRequesterConfirmationSection';
import { buildApprovalHref } from './approvalNavigation';
import {
  readApprovalArtifactTitleInput,
  useApprovalRequestTitle,
} from './approvalRequestTitle';
import { resolveApprovalRequesterThreadState } from './approvalRequesterThreadState';

/**
 * C7 "External write needs confirmation", in the thread that asked: a shared Bot's outward request,
 * the exact operation, and who confirms. A receipt adds "Using <credential>" only from the operation's admitted evidence. Only the person who asked decides:
 * a request the shared review shows whole is approved or declined here, in the Session approval card's anatomy
 * (declared verb, details behind a disclosure, the request page one tap away); anything the page must show
 * (a specialized review, a withheld approval) keeps "Review and confirm…". Everyone else who can read the request sees who can act. Once decided the card is the receipt in
 * place: done only with effect evidence, and an unknown effect never reads as success.
 */
export const ApprovalRequesterThreadCard = React.memo(
  function ApprovalRequesterThreadCard(
    props: Readonly<{
      approval: DiscussionRequesterApproval;
      /** The viewer's profile for the Discussion's Home: routes the request page and the decision. */
      serverId: string;
      /** Where the request page returns once the confirmed write has run. */
      returnHref?: string;
    }>,
  ) {
    const { theme } = useUnistyles();
    const router = useRouter();
    // A phone gives the decision the card's whole width, one control per line, as the request page does.
    const phone = useDeviceType() === 'phone';
    const { artifact, parsed, subject } = props.approval;
    const personaSessionId = subject.personaSessionRef.sessionId;
    const [recordedDecision, setRecordedDecision] = React.useState<
      'approve' | 'reject' | null
    >(null);
    const state = resolveApprovalRequesterThreadState(parsed, recordedDecision);
    const entitled = useApprovalRequesterViewer(subject, props.serverId);
    const viewerName = t('session.collaboration.discussion.attribution.you');
    const requester =
      useApprovalAccountLabel(
        subject.personaSessionRef.serverId,
        subject.requesterAccountId,
        'sentence',
      ) ?? t('session.collaboration.discussion.attribution.anotherPerson');
    const decidingAccountId =
      'decidingAccountId' in state ? state.decidingAccountId : null;
    const decider =
      useApprovalAccountLabel(
        subject.personaSessionRef.serverId,
        decidingAccountId ?? undefined,
        'sentence',
      ) ??
      (decidingAccountId === null && recordedDecision ? viewerName : requester);
    const titleInput = readApprovalArtifactTitleInput(artifact, parsed, [
      personaSessionId,
    ]);
    const title = useApprovalRequestTitle(titleInput, props.serverId).title;
    const detail =
      titleInput.previewSummary?.trim() &&
      titleInput.previewSummary.trim() !== title
        ? titleInput.previewSummary.trim()
        : null;
    // The same decision core the Session card uses; a requester decision travels through the original Bot
    // Session and nothing here grants or forwards authority.
    const decision = useInlineApprovalDecision(
      { id: artifact.id, header: artifact.header ?? null },
      parsed.request,
      personaSessionId,
      props.serverId,
      setRecordedDecision,
    );
    const decidesHere = state.kind === 'open' && entitled && decision.decidesHere;
    const openPage = React.useCallback(() => {
      router.push(
        buildApprovalHref(
          artifact.id,
          props.serverId,
          props.returnHref,
        ) as Href,
      );
    }, [artifact.id, props.returnHref, props.serverId, router]);

    const outcome: Readonly<{
      icon: IconName;
      text: string;
      tone: 'neutral' | 'success' | 'danger';
    }> | null =
      state.kind === 'open'
        ? null
        : state.kind === 'done'
          ? {
              icon: 'check',
              text: t('detailPages.approval.requester.thread.done', {
                name: decider,
              }),
              tone: 'success',
            }
          : state.kind === 'declined'
            ? {
                icon: 'x',
                text: t('detailPages.approval.requester.thread.declined', {
                  name: decider,
                }),
                tone: 'neutral',
              }
            : state.kind === 'canceled'
              ? {
                  icon: 'x',
                  text: t('detailPages.approval.requester.thread.canceled'),
                  tone: 'neutral',
                }
              : state.kind === 'failed'
                ? {
                    icon: 'warning-circle',
                    text: t('detailPages.approval.requester.thread.failed'),
                    tone: 'danger',
                  }
                : state.kind === 'uncertain'
                  ? {
                      icon: 'clock',
                      text: t(
                        'detailPages.approval.requester.thread.uncertain',
                      ),
                      tone: 'neutral',
                    }
                  : {
                      icon: 'clock',
                      text: t(
                        'detailPages.approval.requester.thread.confirmedPending',
                        { name: decider },
                      ),
                      tone: 'neutral',
                    };

    const operationUses =
      'operationCredentialUses' in state ? state.operationCredentialUses : undefined;

    const footer =
      state.kind === 'open' ? (
        entitled ? (
          <View style={styles.askRow}>
            <View style={styles.note}>
              <Icon
                name="hand"
                size={14}
                color={workStatusGlyphColor(theme.colors, 'attention')}
              />
              <Text variant="body" style={[styles.noteText, workStatusWordStyle('attention')]}>
                {t('detailPages.approval.requester.thread.youConfirm')}
              </Text>
            </View>
            <View style={phone ? styles.decisionStacked : styles.decision}>
            <ApprovalInlineDecisionBar
              decision={decision}
              testIDPrefix="approval-requester-thread"
              layout={phone ? 'stacked' : 'inline'}
              onOpenPage={openPage}
              openPageLabel={t('detailPages.approval.requester.thread.review')}
            />
            </View>
          </View>
        ) : (
          <Text
            testID="approval-requester-thread-waiting"
            variant="body"
            style={styles.outcomeText}
          >
            {t('detailPages.approval.requester.thread.waiting', {
              name: requester,
            })}
          </Text>
        )
      ) : outcome ? (
        <View
          testID={`approval-requester-thread-receipt-${state.kind}`}
          style={styles.note}
          accessible
          accessibilityRole="text"
          accessibilityLiveRegion="polite"
        >
          <Icon
            name={outcome.icon}
            size={14}
            color={
              outcome.tone === 'success'
                ? theme.colors.state.success.foreground
                : outcome.tone === 'danger'
                  ? workStatusGlyphColor(theme.colors, 'danger')
                  : theme.colors.text.secondary
            }
          />
          <Text
            variant="body"
            style={[
              styles.outcomeText,
              outcome.tone === 'danger' ? workStatusWordStyle('danger') : null,
            ]}
          >
            {outcome.text}
          </Text>
        </View>
      ) : null;

    return (
      <ApprovalPromptChrome
        testID={`approval-requester-thread-card-${artifact.id}`}
        title={title}
        subtitle={detail}
        subtitleNumberOfLines={2}
        tone={
          state.kind === 'open' && entitled
            ? 'attention'
            : state.kind === 'failed'
              ? 'danger'
              : undefined
        }
        icon={state.kind === 'failed' ? 'warning-circle' : undefined}
        headerAccessory={decidesHere ? (
          <ApprovalOpenButton testID="approval-requester-thread-open" onPress={openPage} />
        ) : null}
        footer={footer}
      >
        {decidesHere ? <ApprovalInlineFields decision={decision} serverId={props.serverId} collapsed={phone} /> : null}
        {operationUses?.length ? (
          <ApprovalOperationActorLine
            uses={operationUses}
            serverId={subject.personaSessionRef.serverId}
          />
        ) : null}
      </ApprovalPromptChrome>
    );
  },
);

const styles = StyleSheet.create((theme) => ({
  askRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    rowGap: theme.space.s8,
    columnGap: theme.space.s12,
  },
  decision: {
    flexShrink: 1,
    maxWidth: '100%',
  },
  decisionStacked: {
    width: '100%',
  },
  note: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    flexShrink: 1,
  },
  noteText: {
    flexShrink: 1,
  },
  outcomeText: {
    flexShrink: 1,
    color: theme.colors.text.secondary,
  },
}));
