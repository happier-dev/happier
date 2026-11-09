import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { MarkdownView } from '@/components/markdown/MarkdownView';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useEnsureSidechainsLoaded } from '@/hooks/session/useEnsureSidechainsLoaded';
import {
  useSessionMessages,
  useSessionSidechainMessages,
} from '@/sync/domains/state/storage';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';

import {
  NO_WALKTHROUGH_STOP_EXCHANGES,
  projectWalkthroughStopExchanges,
  sameWalkthroughStopExchanges,
  type WalkthroughStopExchange,
  type WalkthroughStopExchanges as WalkthroughStopExchangesMap,
} from './walkthroughStopExchanges';

type ExchangesContextValue = Readonly<{
  exchanges: WalkthroughStopExchangesMap;
  modelLabel: string | null;
  onOpenConversation: (() => void) | null;
}>;

const NO_EXCHANGES: ExchangesContextValue = {
  exchanges: NO_WALKTHROUGH_STOP_EXCHANGES,
  modelLabel: null,
  onOpenConversation: null,
};
const WalkthroughStopExchangesContext =
  React.createContext<ExchangesContextValue>(NO_EXCHANGES);

export type WalkthroughStopExchangesSource = Readonly<{
  sessionId: string;
  runId: string;
  /** The run's transcript id in the Session, where its replies are committed. */
  sidechainId: string | null;
  resultId: string;
  stopIds: readonly string[];
}>;

/**
 * Reads the Session and run transcripts once for the whole reading and hands each stop its exchanges. Only this
 * provider and the stops that show an exchange re-render on transcript activity; the reading passed as children
 * keeps its identity.
 */
export function WalkthroughStopExchangesProvider(
  props: Readonly<{
    source: WalkthroughStopExchangesSource | null;
    modelLabel: string | null;
    onOpenConversation: (() => void) | null;
    children: React.ReactNode;
  }>,
) {
  return props.source ? (
    <WalkthroughStopExchangesReader {...props} source={props.source} />
  ) : (
    <>{props.children}</>
  );
}

function WalkthroughStopExchangesReader(
  props: Readonly<{
    source: WalkthroughStopExchangesSource;
    modelLabel: string | null;
    onOpenConversation: (() => void) | null;
    children: React.ReactNode;
  }>,
) {
  const { sessionId, runId, sidechainId, resultId, stopIds } = props.source;
  const { messages } = useSessionMessages(sessionId);
  const sidechainIds = React.useMemo(
    () => (sidechainId ? [sidechainId] : []),
    [sidechainId],
  );
  useEnsureSidechainsLoaded({
    enabled: sidechainId !== null,
    sessionId,
    sidechainIds,
  });
  const runMessages = useSessionSidechainMessages(sessionId, sidechainId);
  const stopIdKey = stopIds.join('\n');
  const stopIdSet = React.useMemo(
    () => new Set(stopIdKey ? stopIdKey.split('\n') : []),
    [stopIdKey],
  );
  const previous = React.useRef<WalkthroughStopExchangesMap>(
    NO_WALKTHROUGH_STOP_EXCHANGES,
  );
  const exchanges = React.useMemo(() => {
    const next = projectWalkthroughStopExchanges({
      runId,
      resultId,
      stopIds: stopIdSet,
      messages,
      runMessages,
    });
    return sameWalkthroughStopExchanges(previous.current, next)
      ? previous.current
      : next;
  }, [messages, resultId, runId, runMessages, stopIdSet]);
  previous.current = exchanges;
  const value = React.useMemo<ExchangesContextValue>(
    () => ({
      exchanges,
      modelLabel: props.modelLabel,
      onOpenConversation: props.onOpenConversation,
    }),
    [exchanges, props.modelLabel, props.onOpenConversation],
  );
  return (
    <WalkthroughStopExchangesContext.Provider value={value}>
      {props.children}
    </WalkthroughStopExchangesContext.Provider>
  );
}

/** The questions asked about one stop and their answers, under that stop (lab WT3-D1). */
export const WalkthroughStopExchangeList = React.memo(
  function WalkthroughStopExchangeList(props: Readonly<{ stopId: string }>) {
    const { exchanges, modelLabel, onOpenConversation } = React.useContext(
      WalkthroughStopExchangesContext,
    );
    const list = exchanges.get(props.stopId);
    if (!list || list.length === 0) return null;
    return (
      <>
        {list.map((exchange) => (
          <WalkthroughStopExchangeCard
            key={exchange.id}
            exchange={exchange}
            modelLabel={modelLabel}
            onOpenConversation={onOpenConversation}
          />
        ))}
      </>
    );
  },
);

function WalkthroughStopExchangeCard(
  props: Readonly<{
    exchange: WalkthroughStopExchange;
    modelLabel: string | null;
    onOpenConversation: (() => void) | null;
  }>,
) {
  const { theme } = useUnistyles();
  const exchange = props.exchange;
  const meta = [
    props.modelLabel,
    exchange.answeredAtMs !== null
      ? formatAsOfTime(exchange.answeredAtMs)
      : null,
  ].filter(Boolean);
  return (
    <View testID={`walkthrough-exchange-${exchange.id}`} style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.asker}>{t('walkthrough.exchange.youAsked')}</Text>
        {props.onOpenConversation ? (
          <HappierPressable
            testID={`walkthrough-exchange-open-${exchange.id}`}
            accessibilityRole="link"
            accessibilityLabel={t('walkthrough.openConversation')}
            onPress={props.onOpenConversation}
            style={(state) => [
              styles.open,
              focusRingStyle({
                focused: state.focused,
                color: theme.colors.border.focus,
              }),
            ]}
          >
            <Text style={styles.openText}>
              {t('walkthrough.exchange.openConversation')}
            </Text>
          </HappierPressable>
        ) : null}
      </View>
      {/* Plain text: the person's question is what they typed, never markup. */}
      <Text style={styles.question}>{exchange.question}</Text>
      <View style={styles.answerHead}>
        <Icon
          name="path"
          size={ICON_SIZE.xs}
          color={theme.colors.text.tertiary}
        />
        <Text style={styles.answerMeta}>
          <Text style={styles.answerBy}>
            {t('scmComparison.view.walkthrough')}
          </Text>
          {meta.length > 0 ? ` · ${meta.join(' · ')}` : ''}
        </Text>
      </View>
      {exchange.answer !== null ? (
        <MarkdownView
          markdown={exchange.answer}
          textStyle={styles.answer}
          renderCacheKey={`walkthrough-exchange:${exchange.id}`}
        />
      ) : (
        <Text style={styles.waiting}>{t('walkthrough.exchange.waiting')}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The same quiet inset sheet as an explanation asked for under a stop: an aside to the reading, not a message bubble.
  card: {
    marginTop: theme.space.s12,
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s12,
    gap: theme.space.s6,
    borderRadius: 12,
    backgroundColor: theme.colors.surface.inset,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  asker: {
    flex: 1,
    ...Typography.variant('body', 'medium'),
    color: theme.colors.text.secondary,
  },
  open: { borderRadius: 6 },
  openText: {
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
  },
  question: {
    ...Typography.variant('body'),
    color: theme.colors.text.secondary,
  },
  answerHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    marginTop: theme.space.s4,
  },
  answerMeta: {
    flexShrink: 1,
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
  },
  answerBy: {
    ...Typography.variant('meta', 'semiBold'),
    color: theme.colors.text.secondary,
  },
  answer: { fontSize: 15, lineHeight: 22, color: theme.colors.text.primary },
  waiting: { ...Typography.variant('body'), color: theme.colors.text.tertiary },
}));
