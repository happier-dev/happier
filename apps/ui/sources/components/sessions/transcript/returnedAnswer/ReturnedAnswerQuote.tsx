import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import {
  HappierReturnedAnswerQuote,
  type HappierReturnedAnswerQuestion,
  type HappierReturnedAnswerQuoteActionProps,
  type HappierReturnedAnswerQuoteLabels,
  type HappierReturnedAnswerQuoteTextProps,
} from '@happier-dev/plugin-ui/components';
import type { Message } from '@happier-dev/session-core/messages';
import type { SessionInputReturnedAnswerV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import { transcriptMarkdownTextStyle } from '@/components/sessions/transcript/transcriptMarkdownTypography';
import { useTranscriptSessionIdentity } from '@/components/sessions/transcript/references/useTranscriptSessionIdentity';
import { useSelectedSessionMessageReply } from '@/components/sessions/transcript/references/useSelectedSessionMessageReply';
import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { ICON_SIZE, Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { resolveVerticalScrollEdgeMaskStyle } from '@/components/ui/scroll/resolveScrollEdgeMaskStyle';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { t } from '@/text';

// The clip ends in the shared scroll-edge fade, so a long answer never ends on half a line of text.
const QUOTE_CLIP_FADE = resolveVerticalScrollEdgeMaskStyle(
  { top: false, bottom: true, left: false, right: false },
  { fadeSize: transcriptMarkdownTextStyle.lineHeight * 1.5 },
) ?? undefined;

function readLabels(): HappierReturnedAnswerQuoteLabels {
  return {
    outcome: {
      answer: t('session.returnedAnswer.answered'),
      pass: t('session.returnedAnswer.passed'),
      failed: t('session.returnedAnswer.failed'),
      cancelled: t('session.returnedAnswer.cancelled'),
      terminal_no_result: t('session.returnedAnswer.noResult'),
    },
    open: t('session.returnedAnswer.open'),
    information: t('session.returnedAnswer.asInformation'),
    yourQuestion: t('session.returnedAnswer.yourQuestion'),
    loading: t('common.loading'),
    askedFromHere: t('session.returnedAnswer.askedFromHere'),
    openQuestion: t('session.returnedAnswer.openQuestion'),
    questionUnavailable: t('session.returnedAnswer.questionUnavailable'),
    retry: t('common.retry'),
  };
}

/**
 * An answer another session returned to an Ask from here (coordination lab T1q), drawn by the shared
 * plugin-ui quote external authors use. The host admits the answer, names the answering session from
 * the transcript's Home, routes, and reads the exact question only while "Your question" is open.
 */
export function ReturnedAnswerQuote(
  props: Readonly<{
    message: Message;
    answer: SessionInputReturnedAnswerV1;
    sessionId: string;
    serverId?: string | null;
    children: React.ReactNode;
  }>,
) {
  const { theme } = useUnistyles();
  const transcriptSource = useSessionTranscriptSource();
  const senderId =
    props.answer.senderSessionId ??
    props.answer.sourceMessageRef?.session.sessionId ??
    null;
  // The transcript's own Home qualifies the sender, as the provenance label does.
  const serverId = props.serverId ?? transcriptSource.serverId ?? null;
  const sender = useTranscriptSessionIdentity(senderId, serverId);
  const navigate = transcriptSource.navigate;
  const [questionOpen, setQuestionOpen] = React.useState(false);
  // One exact read, only while the question is open; never one per transcript row.
  const scope = useActiveServerAccountScope(serverId);
  const [refreshKey, retry] = React.useReducer((value: number) => value + 1, 0);
  const reply = useSelectedSessionMessageReply({
    scope,
    sessionId: props.sessionId,
    message: props.message,
    active: questionOpen,
    refreshKey,
  });
  const question = React.useMemo((): HappierReturnedAnswerQuestion => {
    if (reply.status === 'loading') return { status: 'loading' };
    if (reply.status !== 'ready') return { status: 'unavailable' };
    if (reply.model.reply.status !== 'available') return { status: 'unavailable', onRetry: retry };
    const requestRef = reply.model.requestRef;
    return {
      status: 'asked',
      onOpen: requestRef && navigate
        ? () => navigate(buildScopedSessionRouteHref({
            sessionId: requestRef.session.sessionId,
            serverId: requestRef.session.serverId,
          }))
        : undefined,
    };
  }, [reply, navigate]);
  const labels = readLabels();

  return (
    <HappierReturnedAnswerQuote
      testID={`transcript-returned-answer:${props.message.id}`}
      answerer={sender.name}
      outcome={props.answer.outcome}
      onOpenAnswerer={senderId && navigate
        ? () => navigate(buildScopedSessionRouteHref({ sessionId: senderId, serverId }))
        : undefined}
      question={{ open: questionOpen, onToggle: () => setQuestionOpen((open) => !open), state: question }}
      labels={labels}
      answererMark={<AgentIcon agentId={sender.agentId} size={ICON_SIZE.xs} />}
      informationMark={<Icon name="info" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />}
      Text={QuoteText}
      Action={QuoteAction}
      colors={{
        text: theme.colors.text.primary,
        secondaryText: theme.colors.text.secondary,
        danger: theme.colors.status.error,
        border: theme.colors.border.default,
        surface: theme.colors.surface.inset,
      }}
      radius={theme.borderRadius.xl}
      collapse={{
        lineHeight: transcriptMarkdownTextStyle.lineHeight,
        fade: QUOTE_CLIP_FADE,
        showMore: t('session.returnedAnswer.showMore'),
        showLess: t('session.returnedAnswer.showLess'),
      }}
      space={theme.space}
    >
      {props.children}
    </HappierReturnedAnswerQuote>
  );
}

function QuoteText(props: HappierReturnedAnswerQuoteTextProps) {
  return (
    <Text
      testID={props.testID}
      variant="meta"
      emphasis={props.role === 'answerer' ? 'semiBold' : undefined}
      numberOfLines={props.numberOfLines}
      style={{ color: props.color }}
    >
      {props.children}
    </Text>
  );
}

function QuoteAction(props: HappierReturnedAnswerQuoteActionProps) {
  return <TextLinkButton {...props} size="meta" />;
}
