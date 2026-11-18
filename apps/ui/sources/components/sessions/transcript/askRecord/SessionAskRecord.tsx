import * as React from 'react';
import { View, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { Message } from '@happier-dev/session-core/messages';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { useOptionalSessionTranscriptSource, useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { transcriptMarkdownTextStyle } from '@/components/sessions/transcript/transcriptMarkdownTypography';
import {
  UserMessageBubble,
  userMessageBubbleAlignerStyle,
} from '@/components/sessions/transcript/UserMessageBubble';
import {
  useSessionMessageInvocation,
  type InvocationReadState as SessionMessageInvocationReadState,
  type SessionMessageInvocationTarget,
} from '@/components/sessions/transcript/references/useSessionMessageInvocation';
import { useTranscriptSessionIdentity } from '@/components/sessions/transcript/references/useTranscriptSessionIdentity';
import { useSessionReturnedAnswers } from '@/sync/store/hooks';
import type { ReturnedAnswerEntry } from '@/sync/store/sessionReturnedAnswers';
import { readSessionMessageInvocation } from '@/components/sessions/transcript/references/readSessionMessageInvocation';
import { sessionMessageReplyKey } from '@/sync/api/session/sessionMessageReplyApi';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import {
  StatusPill,
  type StatusPillVariant,
} from '@/components/ui/status/StatusPill';
import { RowActionRevealSlot } from '@/components/ui/lists/RowActionRevealSlot';
import { Text } from '@/components/ui/text/Text';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { navigateWithBlurOnWeb } from '@/utils/platform/navigateWithBlurOnWeb';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { t } from '@/text';
import { HappierListRowRule, HappierPressable } from '@happier-dev/plugin-ui/presentation';

const EVENT_ICON_CONTAINER_SIZE = 20;
/** The header's first line: the state chip's height, so the icon centres on the sentence beside it. */
const ASK_HEADER_LINE_PX = 28;
const TALK_SELECTORS = [
  'manager',
  'workers',
  'siblings',
  'followers',
  'following',
  'discussion',
  'matching',
] as const;

type TargetState = Readonly<{
  variant: StatusPillVariant;
  label: string;
  icon: IconName;
  failed: boolean;
  /** Work is still moving (a Machine waking, a send in flight): a spinner stands in for the icon. */
  spinning?: boolean;
}>;

/** The facts one target's chip reads; a reply-less send needs no reply read. */
export type SessionAskTargetChipTarget = Pick<SessionMessageInvocationTarget, 'status' | 'requestBound'>
  & Partial<Pick<SessionMessageInvocationTarget, 'replyStatus'>>;

/** One target's state chip, in the ask record's one vocabulary, for any surface that sends to a Session. */
export function SessionAskTargetChip(props: Readonly<{
  target: SessionAskTargetChipTarget;
  reply: 'none' | 'wait' | 'return';
  testID?: string;
}>) {
  return <TargetStatePill state={describeTargetState(props.target, props.reply)} testID={props.testID} />;
}

/** What one target's chip says. An unavailable read is never evidence of an answer or of its absence. */
function describeTargetState(
  target: SessionAskTargetChipTarget,
  reply: 'none' | 'wait' | 'return',
): TargetState {
  switch (target.status) {
    case 'answered':
      return {
        variant: 'neutral',
        label: t('session.askRecord.answered'),
        icon: 'check',
        failed: false,
      };
    case 'passed':
      return {
        variant: 'neutral',
        label: t('session.askRecord.passed'),
        icon: 'minus-circle',
        failed: false,
      };
    case 'cancelled':
      return {
        variant: 'neutral',
        label: t('session.askRecord.cancelled'),
        icon: 'x-circle',
        failed: false,
      };
    case 'terminal_no_result':
      return {
        variant: 'neutral',
        label: t('session.askRecord.noAnswer'),
        icon: 'x-circle',
        failed: false,
      };
    case 'held':
      return {
        variant: 'attention',
        label: t('session.askRecord.waitsForYou'),
        icon: 'pause-circle',
        failed: false,
      };
    case 'unknown':
      return {
        variant: 'warning',
        label: t('session.askRecord.unsure'),
        icon: 'warning',
        failed: true,
      };
    case 'failed':
      return {
        variant: 'danger',
        icon: 'warning',
        failed: true,
        label: target.requestBound
          ? t('session.askRecord.notAnswered')
          : t('session.askRecord.notSent'),
      };
    case 'queued':
      if (reply === 'none')
        return {
          variant: 'neutral',
          label: t('session.askRecord.sent'),
          icon: 'check',
          failed: false,
        };
      if (target.replyStatus === 'unavailable') {
        return {
          variant: 'neutral',
          label: t('session.askRecord.unavailable'),
          icon: 'clock',
          failed: false,
        };
      }
      return {
        variant: 'neutral',
        label: t('session.askRecord.noAnswerYet'),
        icon: 'clock',
        failed: false,
      };
  }
}

function summarize(
  targets: readonly SessionMessageInvocationTarget[],
  reply: 'none' | 'wait' | 'return',
): string {
  const states = targets.map((target) => ({
    target,
    state: describeTargetState(target, reply),
  }));
  const count = (pick: (entry: (typeof states)[number]) => boolean) =>
    states.filter(pick).length;
  const parts = [
    [
      count((entry) => entry.target.status === 'answered'),
      'session.askRecord.summaryAnswered',
    ],
    [
      count((entry) => entry.target.status === 'passed'),
      'session.askRecord.summaryPassed',
    ],
    // One word per chip state: a refusal, a request-bound failure and an unknown delivery are counted apart.
    [count((entry) => entry.target.status === 'failed' && !entry.target.requestBound), 'session.askRecord.summaryFailed'],
    [count((entry) => entry.target.status === 'failed' && entry.target.requestBound), 'session.askRecord.summaryNotAnswered'],
    [count((entry) => entry.target.status === 'unknown'), 'session.askRecord.summaryUnsure'],
    [
      count(
        (entry) =>
          !entry.state.failed &&
          entry.target.status !== 'answered' &&
          entry.target.status !== 'passed',
      ),
      reply === 'none'
        ? 'session.askRecord.summarySent'
        : 'session.askRecord.summaryWaiting',
    ],
  ] as const;
  return parts
    .filter(([n]) => n > 0)
    .map(([n, key]) => t(key, { count: n }))
    .join(' · ');
}

function TargetStatePill(
  props: Readonly<{ state: TargetState; testID?: string; style?: ViewStyle }>,
) {
  const { theme } = useUnistyles();
  const color =
    props.state.variant === 'neutral' ? theme.colors.text.secondary : undefined;
  return (
    <StatusPill
      testID={props.testID}
      style={props.style}
      variant={props.state.variant}
      label={props.state.label}
      labelVariant="phrase"
      leading={props.state.spinning ? (
        <ActivitySpinner size={ICON_SIZE.xs} color={color ?? theme.colors.text.secondary} />
      ) : (
        <Icon
          name={props.state.icon}
          size={ICON_SIZE.xs}
          color={color ?? theme.colors.text.secondary}
        />
      )}
      {...(color ? { foregroundColor: color } : {})}
    />
  );
}

/** A host-supplied state for a target whose result is a control-plane effect, not a message admission. */
export type SessionAskTargetRowState = Omit<TargetState, 'failed'>;

/**
 * One target of a send drawn as a full row (bulk compose results, lab bc results): the agent mark and name,
 * one reason line under it, the state chip in a fixed column and an optional action. Rows reserve their chip and
 * action columns from the first render so every chip shares one right edge. `compact` (a phone) keeps the chip
 * on the title line and moves the action under the reason.
 */
export function SessionAskTargetRow(props: Readonly<{
  target: SessionMessageInvocationTarget;
  serverId: string | null;
  reply: 'none' | 'wait' | 'return';
  /** Overrides the chip for a state the invocation read cannot express (waking, switched, skipped). */
  state?: SessionAskTargetRowState;
  reason?: string | null;
  action?: React.ReactNode;
  reserveActionColumn?: boolean;
  compact?: boolean;
  navigate?: ((href: string) => void) | null;
  /**
   * Another row follows in the same list: a row with a reason line under its name is ruled from its text column,
   * a one-line row parts by spacing alone (the one list-row rule, owner 2026-11-17 23:52Z).
   */
  followed?: boolean;
  testID?: string;
}>) {
  const { theme } = useUnistyles();
  const state: TargetState = props.state ? { ...props.state, failed: false } : describeTargetState(props.target, props.reply);
  const chip = <TargetStatePill state={state} testID={props.testID ? `${props.testID}-state` : undefined} />;
  return (
    <View testID={props.testID} style={styles.targetRow}>
      <View style={styles.targetRowMark}>
        <TargetMark target={props.target} serverId={props.serverId} />
      </View>
      <View style={styles.targetRowBody}>
        <View style={styles.targetRowTitle}>
          <View style={styles.targetRowName}><TargetName target={props.target} serverId={props.serverId} navigate={props.navigate} /></View>
          {props.compact ? chip : null}
        </View>
        {props.reason ? (
          <Text variant="meta" style={{ color: theme.colors.text.secondary }}>{props.reason}</Text>
        ) : null}
        {props.compact && props.action ? <View style={styles.targetRowCompactAction}>{props.action}</View> : null}
      </View>
      {props.compact ? null : <View style={styles.targetRowState}>{chip}</View>}
      {props.compact || !(props.reserveActionColumn || props.action) ? null : (
        <View style={styles.targetRowAction}>{props.action}</View>
      )}
      {props.followed && props.reason ? (
        <HappierListRowRule startPx={EVENT_ICON_CONTAINER_SIZE + theme.space.s12} color={theme.colors.border.divider} />
      ) : null}
    </View>
  );
}

function TargetMark(props: Readonly<{ target: SessionMessageInvocationTarget; serverId: string | null }>) {
  const identity = useTranscriptSessionIdentity(props.target.target.sessionId, props.target.target.serverId ?? props.serverId);
  return <AgentIcon agentId={identity.agentId} size={ICON_SIZE.sm} />;
}

/** The target's name; opens the actual result message when it exists, else the Session. */
function TargetName(
  props: Readonly<{
    target: SessionMessageInvocationTarget;
    serverId: string | null;
    /** A line under a group header: the agent mark and a step smaller than the header's name. */
    mark?: boolean;
    testID?: string;
    /** Outside a transcript (bulk compose results) the host says how a name opens its Session. */
    navigate?: ((href: string) => void) | null;
  }>,
) {
  const { theme } = useUnistyles();
  const navigate = useOptionalSessionTranscriptSource()?.navigate ?? props.navigate ?? null;
  const identity = useTranscriptSessionIdentity(
    props.target.target.sessionId,
    props.target.target.serverId ?? props.serverId,
  );
  const ref = props.target.resultRef;
  const open = navigate
    ? () =>
        navigate(
          buildScopedSessionRouteHref(
            ref?.kind === 'session'
              ? {
                  sessionId: ref.session.sessionId,
                  serverId: ref.session.serverId,
                  messageId: ref.messageId,
                }
              : {
                  sessionId: props.target.target.sessionId,
                  serverId: props.target.target.serverId,
                },
          ),
        )
    : undefined;
  const name = (
    <Text
      variant={props.mark ? 'meta' : 'label'}
      emphasis={props.mark ? 'medium' : 'semiBold'}
      numberOfLines={1}
      style={{ color: theme.colors.text.primary }}
    >
      {identity.name}
    </Text>
  );
  return (
    <View style={styles.targetName}>
      {props.mark ? (
        <AgentIcon agentId={identity.agentId} size={ICON_SIZE.xs} />
      ) : null}
      {open ? (
        <HappierPressable
          testID={props.testID}
          accessibilityRole="link"
          accessibilityLabel={identity.name}
          onPress={open}
          style={({ pressed }) => ({
            opacity: pressed ? 0.7 : 1,
            flexShrink: 1,
            minWidth: 0,
          })}
        >
          {name}
        </HappierPressable>
      ) : (
        name
      )}
    </View>
  );
}

/** What the target answered, as one muted line that gives way to the name and the chip. */
function TargetSnippet(props: Readonly<{ text: string | undefined }>) {
  const { theme } = useUnistyles();
  if (!props.text) return <View style={styles.grow} />;
  return (
    <Text
      variant="meta"
      numberOfLines={1}
      style={[styles.snippet, { color: theme.colors.text.secondary }]}
    >
      {props.text}
    </Text>
  );
}

export type SessionAskRecordProps = Readonly<{
  /** The informational source entry (composer) or the existing `session.message.send` tool row (agent). */
  message: Message;
  sessionId: string;
  serverId: string | null;
  /** Inside a row that already owns its horizontal inset (the tool row). */
  embedded?: boolean;
  /** The agent's tool-call origin keeps its generic tool details one press away (the message detail page). */
  details?: Readonly<{ routeMessageId: string | null; revealed: boolean }>;
}>;

/**
 * One Ask or Send as the asker's transcript shows it (coordination lab T1q): a quiet row saying who was
 * asked with its result chip, and for a group one line per frozen target. Targets and their immediate
 * results come from the source entry; answers and passes are read live through the invocation hook.
 */
export function SessionAskRecord(props: SessionAskRecordProps) {
  const scope = useActiveServerAccountScope(props.serverId);
  // The returns already sit in this transcript: they settle the chips and give each answered line its snippet.
  const requestKeys = React.useMemo(() => {
    if (!scope) return [];
    const entry = readSessionMessageInvocation(props.message, { serverId: scope.serverId, sessionId: props.sessionId });
    return entry?.invocation.targets.flatMap(row => row.localId
      ? [sessionMessageReplyKey({ sessionId: row.target.sessionId, localId: row.localId })] : []) ?? [];
  }, [props.message, props.sessionId, scope?.serverId]);
  const returned = useSessionReturnedAnswers(props.sessionId, requestKeys);
  const returnedAnswers = React.useMemo(
    () => returned.map((entry) => entry.answer),
    [returned],
  );
  const record = useSessionMessageInvocation({
    scope,
    sessionId: props.sessionId,
    message: props.message,
    active: true,
    returnedAnswers,
  });
  if (record.status !== 'ready') return null;
  return <SessionAskRecordContent {...props} record={record} returned={returned} />;
}

/**
 * The Ask record drawn from its settled read: the frozen targets with their states, and the returns already in
 * the asker's transcript (each answered line's snippet). `SessionAskRecord` supplies them live.
 */
export function SessionAskRecordContent(
  props: SessionAskRecordProps &
    Readonly<{
      record: Extract<SessionMessageInvocationReadState, Readonly<{ status: 'ready' }>>;
      returned: readonly ReturnedAnswerEntry[];
    }>,
) {
  const { theme } = useUnistyles();
  const navigate = useSessionTranscriptSource().navigate;
  const { record, returned } = props;
  const snippets = React.useMemo(
    () =>
      new Map(
        returned
          .filter((entry) => entry.answer.outcome === 'answer' && entry.snippet)
          .map((entry) => [
            sessionMessageReplyKey({
              sessionId: entry.answer.requestSessionId,
              localId: entry.answer.requestLocalId,
            }),
            entry.snippet,
          ]),
      ),
    [returned],
  );
  const { invocation, targets } = record;
  const reply = invocation.reply;
  const selector =
    typeof invocation.target === 'string' ? null : invocation.target.selector;
  const group = selector !== null && targets.length !== 1;
  const selectorTitle =
    selector && (TALK_SELECTORS as readonly string[]).includes(selector)
      ? t(
          `session.participants.talk.${selector as (typeof TALK_SELECTORS)[number]}`,
        )
      : t('session.askRecord.selectorFallback');
  const first = targets[0] ?? null;
  const failedTargets = targets.filter(
    (target) => describeTargetState(target, reply).failed,
  );
  const headerState: TargetState = group
    ? {
        variant: 'neutral',
        // Waiting only while something still waits; a settled group with a failure is not a clock.
        icon: targets.some(
          (target) => target.status === 'queued' || target.status === 'held',
        )
          ? 'clock'
          : failedTargets.length > 0
            ? 'warning'
            : 'check',
        failed: false,
        label: summarize(targets, reply),
      }
    : first
      ? describeTargetState(first, reply)
      : {
          variant: 'danger',
          icon: 'warning',
          failed: true,
          label: t('session.askRecord.notSent'),
        };
  const verb = group
    ? t(
        reply === 'none'
          ? 'session.askRecord.groupSentTo'
          : 'session.askRecord.groupAsked',
      )
    : t(
        reply === 'none'
          ? 'session.askRecord.sentTo'
          : 'session.askRecord.asked',
      );

  return (
    <View
      testID={`session-ask-record:${record.sourceRowId}`}
      style={props.embedded ? styles.embedded : styles.container}
    >
      {record.origin === 'composer' && record.text ? (
        <View style={styles.bubbleRow}>
          <View style={styles.bubbleAligner}>
            <UserMessageBubble
              testID={`session-ask-record-text:${record.sourceRowId}`}
            >
              <MarkdownView
                codeBlockStateKey={JSON.stringify([
                  props.sessionId,
                  record.sourceRowId,
                ])}
                markdown={record.text}
                selectable
                profile="user"
                textStyle={transcriptMarkdownTextStyle}
              />
            </UserMessageBubble>
          </View>
        </View>
      ) : null}
      <View style={styles.row}>
        <View style={styles.iconSlot}>
          <Icon
            name="chat-circle"
            size={18}
            color={theme.colors.text.secondary}
          />
        </View>
        {/* The sentence and its chip share one column on the icon's right: a chip that wraps on a phone
            starts under the sentence, never as an orphaned right-aligned line. */}
        <View style={styles.headWrap}>
        <View style={styles.headline}>
          {group || !first ? (
            // One run of text, so a narrow phone wraps it as a sentence beside the chip.
            <Text variant="label" style={{ color: theme.colors.text.secondary }}>
              {verb}{' '}
              <Text
                variant="label"
                emphasis="semiBold"
                style={{ color: theme.colors.text.primary }}
              >
                {selectorTitle}
              </Text>
              {group ? ` · ${targets.length}` : null}
            </Text>
          ) : (
            <>
              <Text
                variant="label"
                numberOfLines={1}
                style={[styles.verb, { color: theme.colors.text.secondary }]}
              >
                {verb}
              </Text>
              <TargetName target={first} serverId={props.serverId} />
            </>
          )}
        </View>
        {props.details?.routeMessageId && navigate ? (
          <RowActionRevealSlot
            revealed={props.details.revealed}
            testID={`session-ask-record-details-slot:${record.sourceRowId}`}
          >
            <HappierPressable
              testID={`session-ask-record-details:${record.sourceRowId}`}
              accessibilityRole="link"
              onPress={() => {
                const routeMessageId = props.details?.routeMessageId;
                if (!routeMessageId) return;
                navigateWithBlurOnWeb(() => navigate(buildScopedSessionRouteHref({
                  sessionId: props.sessionId,
                  serverId: props.serverId,
                  suffix: `/message/${encodeURIComponent(routeMessageId)}`,
                })));
              }}
              style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
            >
              <Text variant="meta" style={{ color: theme.colors.text.tertiary }}>{t('common.details')}</Text>
            </HappierPressable>
          </RowActionRevealSlot>
        ) : null}
        <TargetStatePill
          state={headerState}
          testID={`session-ask-record-state:${record.sourceRowId}`}
        />
        </View>
      </View>
      {group && targets.length > 0 ? (
        <View
          style={styles.lines}
          testID={`session-ask-record-targets:${record.sourceRowId}`}
        >
          {targets.map((target) => (
            <View
              key={`${target.target.serverId}:${target.target.sessionId}`}
              style={styles.line}
              testID={`session-ask-record-target:${target.target.sessionId}`}
            >
              <TargetName target={target} serverId={props.serverId} mark />
              <TargetSnippet
                text={
                  target.status === 'answered' && target.localId
                    ? snippets.get(
                        sessionMessageReplyKey({
                          sessionId: target.target.sessionId,
                          localId: target.localId,
                        }),
                      )
                    : undefined
                }
              />
              <TargetStatePill state={describeTargetState(target, reply)} testID={`session-ask-record-target-state:${target.target.sessionId}`} />
            </View>
          ))}
        </View>
      ) : null}
      {record.origin === 'composer' && targets.some((target) => target.status === 'failed') ? (
        <Text
          variant="meta"
          style={[styles.hint, { color: theme.colors.text.tertiary }]}
          testID={`session-ask-record-retry:${record.sourceRowId}`}
        >
          {t('session.askRecord.retryHint')}
        </Text>
      ) : null}
      {/* An unknown delivery may have arrived: the person checks it before sending again, so no retry is offered. */}
      {targets.some((target) => target.status === 'unknown') ? (
        <Text
          variant="meta"
          style={[styles.hint, { color: theme.colors.text.tertiary }]}
          testID={`session-ask-record-unsure:${record.sourceRowId}`}
        >
          {t('session.askRecord.unsureHint')}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    marginHorizontal: theme.space.s16,
    paddingBottom: theme.transcript.messageGap,
    alignSelf: 'stretch',
  },
  embedded: {
    paddingTop: theme.space.s8,
    alignSelf: 'stretch',
  },
  bubbleRow: {
    alignSelf: 'stretch',
    paddingBottom: theme.space.s12,
  },
  bubbleAligner: userMessageBubbleAlignerStyle,
  // The icon stays on the sentence's first line; the sentence and chip wrap in their own column.
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    columnGap: theme.space.s10,
    minWidth: 0,
  },
  // A long summary chip drops under the sentence on a phone, on the sentence's edge; on one line the
  // growing headline keeps it at the row's end.
  headWrap: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    alignContent: 'center',
    columnGap: theme.space.s10,
    rowGap: theme.space.s4,
    minWidth: 0,
    minHeight: ASK_HEADER_LINE_PX,
  },
  iconSlot: {
    width: EVENT_ICON_CONTAINER_SIZE,
    height: ASK_HEADER_LINE_PX,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  headline: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 190,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
    minWidth: 0,
  },
  verb: {
    flexShrink: 0,
  },
  targetName: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    flexShrink: 1,
    minWidth: 0,
  },
  lines: {
    marginTop: theme.space.s6,
    marginLeft: EVENT_ICON_CONTAINER_SIZE + theme.space.s4,
    paddingLeft: theme.space.s10,
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border.subtle,
    gap: theme.space.s4,
  },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    minHeight: 28,
    minWidth: 0,
  },
  grow: {
    flex: 1,
  },
  targetRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    columnGap: theme.space.s12,
    paddingVertical: theme.space.s12,
    minWidth: 0,
  },
  targetRowMark: {
    width: EVENT_ICON_CONTAINER_SIZE,
    minHeight: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  targetRowBody: {
    flex: 1,
    minWidth: 0,
    gap: theme.space.s2,
  },
  targetRowTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: theme.space.s8,
    minWidth: 0,
  },
  targetRowName: {
    flex: 1,
    minWidth: 0,
  },
  targetRowState: {
    width: 128,
    alignItems: 'flex-end',
  },
  targetRowAction: {
    width: 72,
    alignItems: 'flex-end',
  },
  targetRowCompactAction: {
    marginTop: theme.space.s6,
    alignItems: 'flex-start',
  },
  snippet: {
    flex: 1,
    minWidth: 0,
  },
  // Under the target lines, on their content edge: icon slot, rule, rule padding.
  hint: {
    marginTop: theme.space.s6,
    marginLeft: EVENT_ICON_CONTAINER_SIZE + theme.space.s4 + 1 + theme.space.s10,
  },
}));
