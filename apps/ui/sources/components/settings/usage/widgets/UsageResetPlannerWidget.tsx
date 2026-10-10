import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import { IntervalTimeline } from '@happier-dev/plugin-ui/presentation';
import { AccountUsageResetsLine } from '@/components/settings/connectedServices/usage/AccountUsageFacts';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useSession } from '@/sync/domains/state/storage';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { t } from '@/text';
import { usageSignatureAccent } from '../usageAccent';
import {
  UsageBodyInsufficient,
  UsageCoverageLine,
  useUsagePluginTheme,
  type UsageBodyProps,
} from './usageBodyKit';
import { adviseUsageBankedReset, type UsagePlanAccount, type UsagePlanEvent } from './plans/usagePlansModel';
import { UsageCalendarExportButton, useUsagePlanAction } from './plans/UsagePlanActions';
import { UsageResetStartSection } from './plans/UsageResetStartControl';
import type { UsageCalendarExportInput } from '@happier-dev/protocol/usage/usageCalendarExport';
import {
  useUsagePlans,
  type UsagePlanAccountName,
} from './plans/useUsagePlans';
import {
  formatPlanCountdown,
  formatPlanMoment,
  formatPlanPercent,
  UsagePlanIdentity,
  UsagePlanSectionHead,
  UsagePlansNothingRead,
  usePlanText,
} from './plans/UsagePlanParts';

function eventText(event: UsagePlanEvent): string {
  switch (event.kind) {
    case 'reset':
      return t('usage.board.plans.eventReset', { window: event.label ?? '' });
    case 'renews':
      return t('usage.board.plans.eventRenews');
    case 'ends':
      return t('usage.board.plans.eventEnds');
    case 'credit_expires':
      return t('usage.board.plans.eventCredit');
  }
}

/**
 * Every known reset, renewal, ending and banked-reset expiry, from the accepted B reads. The span is
 * the facts' own (now to the last known moment); waiting work and banked resets act through their
 * existing owners.
 */
export function UsageResetPlannerWidget(props: UsageBodyProps) {
  const plans = useUsagePlans(props.slice, props.model);
  const { projection, nameOf, nowMs } = plans;
  const text = usePlanText();
  // A tile keeps to the shared timeline, whose own rows are the exact list at that size.
  const tile = useWidgetPresentation()?.size === 'small';
  const refresh = plans.refresh;
  const settle = React.useCallback(() => { void refresh(); }, [refresh]);
  // Binding a queued message to a reset needs exactly one Session: the Session Usage view names it.
  const sessions = props.query.session;
  const sessionId = Array.isArray(sessions) ? (sessions.length === 1 ? sessions[0]! : null) : (sessions ?? null);
  useWidgetFrameBodyCaption(t('usage.board.plans.resetsCaption'));
  if (projection.accounts.length === 0) {
    return (
      <View style={styles.body}>
        <UsagePlansNothingRead
          testID={`${props.testID}.none`}
          slice={props.slice}
          onRetry={props.model.refresh}
        />
      </View>
    );
  }
  const withCredits = projection.accounts.filter(
    (account) => (account.recoveryCredits?.availableCount ?? 0) > 0,
  );
  const waiting = projection.accounts.flatMap((account) =>
    account.read.waitingWork.status === 'available'
      ? account.read.waitingWork.entries.map((entry) => ({ account, entry }))
      : [],
  );
  const selectedEvents = projection.events.flatMap<UsageCalendarExportInput['selectedEvents'][number]>(event => {
    const account = projection.accounts.find(account => account.key === event.accountKey)?.read.source.ref;
    if (!account) return [];
    if (event.kind === 'renews') return [{ account, kind: 'renewal' as const }];
    if (event.kind === 'reset' && event.window) return [{ account, kind: 'reset' as const, meterId: event.window.meterId }];
    return [];
  });
  return (
    <View style={styles.body} testID={`${props.testID}.resets`}>
      {projection.events.length === 0 ? (
        <UsageBodyInsufficient
          testID={`${props.testID}.noResets`}
          title={t('usage.board.plans.resetsNone')}
          reason={t('usage.board.plans.resetsNoneReason')}
        />
      ) : (
        <>
          {tile ? null : (
            <ResetList
              accounts={projection.accounts}
              events={projection.events}
              nameOf={nameOf}
              nowMs={nowMs}
              testID={`${props.testID}.list`}
            />
          )}
          <ResetTimeline
            accounts={projection.accounts}
            events={projection.events}
            nameOf={nameOf}
            nowMs={nowMs}
            testID={`${props.testID}.timeline`}
          />
        </>
      )}
      {selectedEvents.length > 0 ? <UsageCalendarExportButton input={{ query: props.query, selectedEvents }}
        serverId={props.serverId} testID={`${props.testID}.calendarExport`} /> : null}
      {withCredits.length > 0 ? (
        <View style={styles.waiting} testID={`${props.testID}.wallet`}>
          <UsagePlanSectionHead title={t('usage.board.plans.walletTitle')} meta={t('usage.board.plans.walletMeta')} />
          {withCredits.map((account) => {
            const name = nameOf(account);
            const advice = adviseUsageBankedReset(account);
            return (
              <View key={account.key} style={styles.credits} testID={`${props.testID}.wallet.${account.accountId}`}>
                <UsagePlanIdentity name={name} compact />
                <AccountUsageResetsLine
                  testID={`${props.testID}.credits.${account.accountId}`}
                  recoveryCredits={account.recoveryCredits}
                  legacyServiceId={name.legacyServiceId}
                  accountId={account.accountId}
                  snapshotFetchedAtMs={account.observedAtMs}
                  now={nowMs}
                  onApplied={settle}
                />
                {advice ? (
                  <Text testID={`${props.testID}.wallet.${account.accountId}.advice`} style={[styles.listEvent, text.detail]}>
                    {t(
                      advice.kind === 'expires_before_reset'
                        ? 'usage.board.plans.walletExpiresFirst'
                        : 'usage.board.plans.walletOutlasts',
                      {
                        window: advice.window.label,
                        expires: formatPlanMoment(advice.expiresAtMs, nowMs),
                        reset: formatPlanMoment(advice.resetAtMs, nowMs),
                      },
                    )}
                  </Text>
                ) : null}
              </View>
            );
          })}
        </View>
      ) : null}
      {waiting.length > 0 ? (
        <View style={styles.waiting} testID={`${props.testID}.waiting`}>
          <UsagePlanSectionHead title={t('usage.board.plans.waitingTitle')} meta={String(waiting.length)} />
          {waiting.map(({ account, entry }) => (
            <WaitingRow
              key={`${entry.sessionId}:${entry.localId}`}
              sessionId={entry.sessionId}
              localId={entry.localId}
              serverId={props.serverId}
              ready={entry.readiness.status === 'ready'}
              window={
                account.windows.find(
                  (window) => window.meterId === entry.meterId,
                )?.label ?? null
              }
              onSettled={settle}
              testID={`${props.testID}.waiting.${entry.localId}`}
            />
          ))}
        </View>
      ) : null}
      {sessionId ? (
        <UsageResetStartSection
          sessionId={sessionId}
          serverId={props.serverId}
          accounts={projection.accounts}
          nameOf={nameOf}
          nowMs={nowMs}
          onSettled={settle}
          testID={`${props.testID}.resetStart`}
        />
      ) : null}
      <UsageCoverageLine
        slice={props.slice}
        sources={['quota']}
        onRetry={props.model.refresh}
        testID={`${props.testID}.coverage`}
      />
    </View>
  );
}

function ResetMarker(props: Readonly<{ kind: UsagePlanEvent['kind'] }>) {
  const { theme } = useUnistyles();
  const accent = usageSignatureAccent(theme);
  switch (props.kind) {
    case 'reset':
      return <View style={[styles.dot, { backgroundColor: accent }]} />;
    case 'renews':
      return (
        <View style={[styles.dot, styles.ring, { borderColor: accent }]} />
      );
    case 'ends':
      return (
        <Icon
          name="flag"
          size={12}
          color={theme.colors.state.warning.foreground}
        />
      );
    case 'credit_expires':
      return (
        <View
          style={[
            styles.diamond,
            { borderColor: theme.colors.state.warning.foreground },
          ]}
        />
      );
  }
}

function ResetTimeline(
  props: Readonly<{
    accounts: readonly UsagePlanAccount[];
    events: readonly UsagePlanEvent[];
    nameOf: (account: UsagePlanAccount) => UsagePlanAccountName;
    nowMs: number;
    testID: string;
  }>,
) {
  const theme = useUsagePluginTheme();
  const presentation = useWidgetPresentation();
  const byKey = new Map(props.accounts.map(account => [account.key, account]));
  const eventsByKey = new Map(props.events.map(event => [event.key, event]));
  return <IntervalTimeline theme={theme} label={t('usage.board.plans.resetsCaption')} testID={props.testID}
    domain={{ start: props.nowMs, end: Math.max(props.nowMs, ...props.events.map(event => event.atMs)) }}
    size={presentation?.size === 'small' ? 'tile' : 'full'}
    geometry={presentation?.geometry}
    startLabel={t('common.start')}
    formatValue={value => formatPlanMoment(value, props.nowMs)}
    intervals={props.events.map(event => {
      const account = byKey.get(event.accountKey);
      const name = account ? props.nameOf(account) : null;
      return { id: event.key, kind: 'point' as const,
        label: [name?.title, name?.qualifier, eventText(event)].filter(Boolean).join(' · '),
        start: event.atMs, end: event.atMs };
    })}
    renderMarker={interval => <ResetMarker kind={eventsByKey.get(interval.id)!.kind} />} />;
}

/** The planner as a list (lab `p2reset` R4): when, whose, which window, and what it has left now. */
function ResetList(
  props: Readonly<{
    accounts: readonly UsagePlanAccount[];
    events: readonly UsagePlanEvent[];
    nameOf: (account: UsagePlanAccount) => UsagePlanAccountName;
    nowMs: number;
    testID: string;
  }>,
) {
  const text = usePlanText();
  const byKey = new Map(props.accounts.map((account) => [account.key, account]));
  return (
    <View testID={props.testID} accessibilityRole="list">
      {props.events.map((event, index) => {
        const account = byKey.get(event.accountKey);
        const name = account ? props.nameOf(account) : null;
        const when = formatPlanMoment(event.atMs, props.nowMs);
        const countdown = formatPlanCountdown(event.atMs, props.nowMs);
        const left = event.kind === 'reset' && event.window?.remainingFraction != null
          ? t('usage.board.plans.listLeftNow', { percent: formatPlanPercent(event.window.remainingFraction) })
          : null;
        const what = [eventText(event), left].filter(Boolean).join(' · ');
        return (
          <View
            key={event.key}
            testID={`${props.testID}.${index}`}
            style={[styles.listRow, index > 0 ? styles.listDivider : null]}
            accessibilityLabel={[when, countdown, name?.title, what].filter(Boolean).join(', ')}
          >
            <View style={styles.listMarker}>
              <ResetMarker kind={event.kind} />
            </View>
            <View style={styles.listText}>
              {name ? <UsagePlanIdentity name={name} compact /> : null}
              <Text style={[styles.listEvent, text.detail, event.kind === 'ends' ? styles.warning : null]} numberOfLines={2}>
                {what}
              </Text>
            </View>
            <View style={styles.listWhen}>
              <Text style={[styles.waitingName, text.title]} numberOfLines={1}>
                {when}
              </Text>
              {countdown ? (
                <Text style={[styles.listEvent, text.detail]} numberOfLines={1}>
                  {countdown}
                </Text>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

/** A queued message bound to a reset. Cancel withdraws it through the pending owner's own Action. */
function WaitingRow(
  props: Readonly<{
    sessionId: string;
    localId: string;
    serverId: string;
    ready: boolean;
    window: string | null;
    onSettled: () => void;
    testID: string;
  }>,
) {
  const session = useSession(props.sessionId, props.serverId);
  const text = usePlanText();
  const action = useUsagePlanAction();
  const state = action.state;
  const { sessionId, localId, serverId, onSettled } = props;
  const run = action.run;
  const cancel = React.useCallback(
    () => run('session.pending.resetStart.cancel', { sessionId, localId, serverId }, onSettled),
    [run, sessionId, localId, serverId, onSettled],
  );
  const status =
    state === 'approval'
      ? t('usage.board.plans.waitingApproval')
      : state === 'failed'
        ? t('usage.board.plans.waitingCancelFailed')
        : props.ready
          ? t('usage.board.plans.waitingReady')
          : t('usage.board.plans.waitingHeld');
  return (
    <View testID={props.testID} style={styles.waitingRow}>
      <View style={styles.listText}>
        <Text style={[styles.waitingName, text.title]} numberOfLines={1}>
          {session
            ? getSessionName(session, props.serverId)
            : t('usage.board.plans.waitingSession')}
        </Text>
        <Text style={[styles.listEvent, text.detail]} numberOfLines={1}>
          {[props.window, status].filter(Boolean).join(' · ')}
        </Text>
      </View>
      <RoundButton
        size="small"
        display="secondary"
        title={t('usage.board.plans.waitingCancel')}
        testID={`${props.testID}.cancel`}
        loading={state === 'pending'}
        disabled={state === 'pending' || state === 'approval'}
        onPress={() => {
          void cancel();
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: 16 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  ring: { backgroundColor: theme.colors.surface.base, borderWidth: 1.5 },
  diamond: {
    width: 8,
    height: 8,
    borderWidth: 1.5,
    transform: [{ rotate: '45deg' }],
  },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9 },
  listDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border.default },
  listMarker: { width: 14, alignItems: 'center' },
  listText: { flex: 1, minWidth: 0, gap: 1 },
  listWhen: { alignItems: 'flex-end', gap: 1 },
  listEvent: {
    ...Typography.default(),
    color: theme.colors.text.tertiary,
    fontVariant: ['tabular-nums'],
  },
  warning: { color: theme.colors.state.warning.foreground },
  credits: { gap: 4 },
  waiting: { gap: 8 },
  waitingRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  waitingName: {
    ...Typography.default('medium'),
    color: theme.colors.text.primary,
    fontVariant: ['tabular-nums'],
  },
}));
