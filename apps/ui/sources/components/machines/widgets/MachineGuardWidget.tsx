import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { MachineGuardViewV1 } from '@happier-dev/protocol/machines/guard/guardRpcV1';
import type { MachineGuardPolicyV1 } from '@happier-dev/protocol/machines/guard/guardPolicyV1';
import type { WidgetSizeV1 } from '@happier-dev/protocol/widgets';

import { MachineActivityRow } from '@/components/machines/guard/activity/MachineActivityRow';
import { useGuardWayBack } from '@/components/machines/guard/activity/useGuardWayBack';
import { GuardCountdown } from '@/components/machines/guard/GuardCountdown';
import {
  GuardLadder,
  NeverTouchedLine,
} from '@/components/machines/guard/GuardLadder';
import {
  describeMemoryGuardRow,
  formatGuardClock,
  formatGuardDuration,
  formatGuardGrace,
  resolveMemoryGuardRowState,
} from '@/components/machines/guard/guardPresentation';
import { ReadOnlyValue } from '@/components/machines/guard/guardRows';
import type { MachinePageTabParams } from '@/components/machines/page/machinePageTabQuery';
import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';
import { MemoryTile } from '@/components/machines/vitals/MemoryTile';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/Text';
import { useWidgetFrameBodyMeta } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { machineGuardStore } from '@/sync/domains/machines/guard/machineGuardStore';
import { DEFAULT_MACHINE_GUARD_ACTIVITY_QUERY, keepMachineGuardWorkRunningViaAction } from '@/sync/domains/machines/guard/machineGuardRpc';
import { useMachineGuardActivity, useMachineGuardView } from '@/sync/domains/machines/guard/useMachineGuardView';
export { isMachineGuardOn } from '@/sync/domains/machines/guard/useMachineGuardView';
import { useMachineDaemonReadTarget } from '@/sync/domains/machines/useMachineDaemonReadTarget';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
  MachineWidgetColumn,
  MachineWidgetMetaText,
  MachineWidgetSectionLabel,
  MachineWidgetState,
  MachineWidgetTwoColumns,
  useMachineWidgetMachine,
  useMachineWidgetSize,
  useMachineWidgetTarget,
  useOpenMachinePage,
  type MachineWidgetBodyProps,
  type MachineWidgetMachineFacts,
  type MachineWidgetTarget,
} from './machineWidgetKit';
import { useMachineWidgetVitalsView } from './machineWidgetVitalsView';

/** Candidates the compact sizes list: the next two the ladder would take (lab `rw` G). */
const COMPACT_CANDIDATES = 2;

type GuardOpen = (tab?: MachinePageTabParams) => void;

/**
 * Guard (rw:G): the policy explains itself — what Guard would stop first if memory ran short, in order,
 * with the daemon's real candidates — plus its warning before an automatic stop, the hand-over when it
 * runs out of options and its last action with the way back. The view is plan 50's, live while shown
 * (one parked watch shared with the Guard tab); the rules are the machine's synced resources policy.
 */
export function MachineGuardWidget(props: MachineWidgetBodyProps) {
  const target = useMachineWidgetTarget(props.input);
  if (!target)
    return (
      <MachineWidgetState
        kind="empty"
        title={t('machines.widgets.body.common.unknownMachine')}
        testID={props.testID}
      />
    );
  return <GuardBody target={target} testID={props.testID} />;
}

type PendingStop =
  | Readonly<{
      kind: 'session';
      id: string;
      title: string;
      stopAt: number;
      idleMs: number;
    }>
  | Readonly<{
      kind: 'terminal';
      id: string;
      title: string;
      stopAt: number;
      idleMs: number;
    }>;

/** The soonest automatic stop the daemon has warned about (R31: a warning comes before every idle stop). */
export function selectGuardPendingStop(
  view: MachineGuardViewV1,
  nowMs: number,
): PendingStop | null {
  const pending: PendingStop[] = [
    ...view.idle.flatMap((entry) =>
      entry.status === 'stops_at' &&
      entry.stopAt !== undefined &&
      entry.stopAt > nowMs
        ? [
            {
              kind: 'session' as const,
              id: entry.sessionRef,
              title: entry.title ?? t('session.untitled'),
              stopAt: entry.stopAt,
              idleMs: entry.idleMs,
            },
          ]
        : [],
    ),
    ...(view.idleTerminals ?? []).flatMap((entry) =>
      entry.status === 'stops_at' &&
      entry.stopAt !== undefined &&
      entry.stopAt > nowMs
        ? [
            {
              kind: 'terminal' as const,
              id: entry.terminalKey,
              title: entry.label,
              stopAt: entry.stopAt,
              idleMs: entry.idleMs,
            },
          ]
        : [],
    ),
  ];
  return pending.sort((a, b) => a.stopAt - b.stopAt)[0] ?? null;
}

/**
 * The header's one word. Only a Guard view proves On/Off; the separate synced settings
 * describe rules, not the operational state of a machine we have not read.
 */
export function guardHeaderStateText(
  input: Readonly<{ offline: boolean; on: boolean | null }>,
): string | null {
  if (input.offline) return t('machines.widgets.body.common.offline');
  if (input.on === null) return null;
  return input.on ? t('machineGuard.on') : t('machineGuard.off');
}

function GuardBody(
  props: Readonly<{ target: MachineWidgetTarget; testID: string }>,
) {
  const size = useMachineWidgetSize();
  const facts = useMachineWidgetMachine(props.target);
  const open = useOpenMachinePage(props.target);
  const guard = useMachineGuardView({
    machineId: props.target.machineId,
    serverId: props.target.serverId,
  });
  const view = guard.view;
  // A held view remains last-known truth after a failed refresh. With no view, loading,
  // error and not-reported all remain unknown rather than inheriting default Off.
  const on = guard.on;
  const offline = guard.offline || facts.online === false;
  const metaText = guardHeaderStateText({
    offline,
    on: facts.online === null ? null : on,
  });
  const meta = React.useMemo(
    () =>
      metaText ? (
        <MachineWidgetMetaText
          text={metaText}
          testID={`${props.testID}.state`}
        />
      ) : null,
    [metaText, props.testID],
  );
  useWidgetFrameBodyMeta(meta);

  if (facts.online === null) return <MachineWidgetState kind="unavailable" title={t('common.unknown')} testID={props.testID} />;

  if (guard.status === 'not_reported')
    return (
      <MachineWidgetState
        kind="not_reported"
        machineName={facts.name}
        testID={props.testID}
      />
    );
  if (offline) {
    return (
      <MachineWidgetState
        kind="offline"
        machineName={facts.name}
        lastSeenAt={facts.lastSeenAt}
        detail={t('machines.widgets.body.guard.offlineDetail')}
        testID={props.testID}
      />
    );
  }
  if (!view) {
    return guard.status === 'error' ? (
      <MachineWidgetState
        kind="error"
        onRetry={guard.retry}
        testID={props.testID}
      />
    ) : (
      <MachineWidgetState
        kind="loading"
        rows={size === 'small' || size === 'wide' ? 2 : 3}
        testID={props.testID}
      />
    );
  }
  if (on === false) {
    return (
      <MachineWidgetState
        kind="empty"
        testID={`${props.testID}.off`}
        title={t('machines.widgets.body.guard.offTitle')}
        reason={
          facts.recipient
            ? t('machines.widgets.body.common.recipient')
            : t('machines.widgets.body.guard.offBody')
        }
        {...(facts.recipient
          ? {}
          : {
              action: {
                label: t('machines.widgets.body.guard.turnOn'),
                onPress: () => open({ id: 'guard' }),
              },
            })}
      />
    );
  }
  const pending = selectGuardPendingStop(view, Date.now());
  if (pending)
    return (
      <GuardWarning
        pending={pending}
        target={props.target}
        facts={facts}
        testID={props.testID}
      />
    );
  if (view.state.episode?.state === 'out_of_steps') {
    return (
      <MachineWidgetColumn testID={`${props.testID}.outOfOptions`}>
        <ToneSentence
          tone="danger"
          text={t('machines.widgets.body.guard.stillShort')}
        />
        <Text style={styles.detail}>
          {t('machines.widgets.body.guard.outOfOptionsBody')}
        </Text>
        <View style={styles.actions}>
          <RoundButton
            size="small"
            display="secondary"
            testID={`${props.testID}.reviewProcesses`}
            title={t('machines.widgets.body.guard.reviewProcesses')}
            onPress={() => open({ id: 'processes', sort: 'memory' })}
          />
        </View>
      </MachineWidgetColumn>
    );
  }
  return (
    <GuardOn
      size={size}
      view={view}
      policy={view.policy}
      target={props.target}
      facts={facts}
      open={open}
      testID={props.testID}
    />
  );
}

/** "Stopping website · dev server in 4:32" (lab G warning): the countdown ticks in its own leaf; Keep running acts at once. */
function GuardWarning(
  props: Readonly<{
    pending: PendingStop;
    target: MachineWidgetTarget;
    facts: MachineWidgetMachineFacts;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const { key } = useMachineDaemonReadTarget(props.target);
  const [keeping, setKeeping] = React.useState(false);
  const { pending } = props;
  const keepRunning = React.useCallback(() => {
    setKeeping(true);
    fireAndForget(
      (async () => {
        const kept = await keepMachineGuardWorkRunningViaAction(
          pending.kind === 'session'
            ? { ...key, sessionId: pending.id }
            : { ...key, terminalKey: pending.id },
        );
        setKeeping(false);
        machineGuardStore.refreshMachine(key);
        if (!kept.ok)
          Modal.alert(
            t('machines.widgets.body.guard.keepRunning'),
            t('machines.widgets.body.guard.keepRunningFailed'),
          );
      })(),
      { tag: 'MachineGuardWidget.keepRunning' },
    );
  }, [key, pending]);
  const attention = theme.colors.state.attention.textForeground;
  const duration = formatGuardDuration(pending.idleMs);
  return (
    <MachineWidgetColumn testID={`${props.testID}.warning`}>
      <Text style={styles.sentence} accessibilityLiveRegion="polite">
        <Text style={[styles.sentenceStrong, { color: attention }]}>
          {t('machines.widgets.body.guard.stopping', { title: pending.title })}
        </Text>{' '}
        <GuardCountdown
          stopAt={pending.stopAt}
          format={(remaining) =>
            t('machines.widgets.body.guard.stoppingIn', { remaining })
          }
          style={styles.countdown}
          testID={`${props.testID}.countdown`}
        />
      </Text>
      <Text style={styles.detail}>
        {pending.kind === 'session'
          ? t('machines.widgets.body.guard.stoppingSessionDetail', { duration })
          : t('machines.widgets.body.guard.stoppingTerminalDetail', {
              duration,
            })}
      </Text>
      {props.facts.recipient ? (
        <Text style={styles.detail}>
          {t('machines.widgets.body.common.recipient')}
        </Text>
      ) : (
        <View style={styles.actions}>
          <RoundButton
            size="small"
            display="secondary"
            testID={`${props.testID}.keepRunning`}
            loading={keeping}
            disabled={keeping}
            title={t('machines.widgets.body.guard.keepRunning')}
            onPress={keepRunning}
          />
        </View>
      )}
    </MachineWidgetColumn>
  );
}

function ToneSentence(
  props: Readonly<{ tone: 'danger' | 'attention' | 'plain'; text: string }>,
) {
  const { theme } = useUnistyles();
  const color =
    props.tone === 'danger'
      ? theme.colors.state.danger.textForeground
      : props.tone === 'attention'
        ? theme.colors.state.attention.textForeground
        : theme.colors.text.primary;
  return (
    <Text
      style={[styles.sentenceStrong, { color }]}
      accessibilityLiveRegion="polite"
    >
      {props.text}
    </Text>
  );
}

/** The six sizes of a Guard that is on (lab `gBody`): the same labelled list, growing into the ladder, rules and recent. */
function GuardOn(
  props: Readonly<{
    size: WidgetSizeV1;
    view: MachineGuardViewV1;
    policy: MachineGuardPolicyV1;
    target: MachineWidgetTarget;
    facts: MachineWidgetMachineFacts;
    open: GuardOpen;
    testID: string;
  }>,
) {
  const { size, view, policy, facts, open } = props;
  const activity = useMachineGuardActivity({
    ...props.target,
    ...DEFAULT_MACHINE_GUARD_ACTIVITY_QUERY,
    enabled: size !== 'small',
  });
  const entries = activity.list?.entries;
  const candidates = (
    <GuardCandidates
      view={view}
      policy={policy}
      facts={facts}
      open={open}
      short={size === 'small'}
      testID={props.testID}
    />
  );
  const recent = (count: number, label: string) =>
    entries && entries.length > 0 ? (
      <View style={styles.section}>
        <MachineWidgetSectionLabel label={label} />
        <GuardRecent
          target={props.target}
          facts={facts}
          entries={entries.slice(0, count)}
          open={open}
          testID={props.testID}
        />
      </View>
    ) : null;
  const never = (
    <NeverTouchedLine
      text={t('machineGuard.neverTouched')}
      testID={`${props.testID}.never`}
    />
  );
  const policies = (
    <GuardPolicies
      policy={policy}
      machineName={facts.name}
      testID={props.testID}
    />
  );
  if (size === 'small')
    return (
      <MachineWidgetColumn testID={props.testID}>
        {candidates}
      </MachineWidgetColumn>
    );
  if (size === 'wide') {
    const last = entries?.[0];
    return (
      <MachineWidgetTwoColumns
        lead={
          <View style={styles.section} testID={props.testID}>
            <ToneSentence
              tone="plain"
              text={t('machines.widgets.body.guard.onTitle')}
            />
            <Text style={styles.detail}>
              {[
                t('machines.widgets.body.guard.watching'),
                ...(last
                  ? [
                      t('machines.widgets.body.guard.lastActed', {
                        time: formatGuardClock(last.at),
                      }),
                    ]
                  : []),
              ].join(' ')}
            </Text>
          </View>
        }
        rest={candidates}
      />
    );
  }
  if (size === 'medium') {
    return (
      <MachineWidgetColumn testID={props.testID}>
        {candidates}
        {never}
        {recent(1, t('machines.widgets.body.guard.lastAction'))}
      </MachineWidgetColumn>
    );
  }
  if (size === 'full') {
    return (
      <MachineWidgetTwoColumns
        lead={
          <View style={styles.section} testID={props.testID}>
            {candidates}
            {never}
            {recent(1, t('machines.widgets.body.guard.lastAction'))}
          </View>
        }
        rest={
          <View style={styles.section}>
            {policies}
            <Text style={styles.detail}>
              {t('machines.widgets.body.guard.warningLead', {
                lead: formatGuardDuration(policy.idleSessions.warnBeforeMs),
              })}
            </Text>
          </View>
        }
      />
    );
  }
  const ladder = (
    <GuardLadder
      ladder={view.ladder}
      lead={t('machines.widgets.body.guard.ladderLead')}
      stepSwitches={null}
      othersWorkCount={view.othersWorkCount}
    />
  );
  if (size === 'tall') {
    return (
      <MachineWidgetColumn testID={props.testID}>
        {ladder}
        {policies}
        {recent(2, t('machines.widgets.body.guard.recent'))}
      </MachineWidgetColumn>
    );
  }
  return (
    <MachineWidgetColumn testID={props.testID}>
      <MachineWidgetTwoColumns
        lead={ladder}
        rest={
          <View style={styles.section}>
            {policies}
            {recent(3, t('machines.widgets.body.guard.recent'))}
          </View>
        }
      />
      <GuardMemoryChart
        target={props.target}
        facts={facts}
        testID={props.testID}
      />
    </MachineWidgetColumn>
  );
}

/** "Would stop first · if memory ran short": the ladder's candidates in its own order, numbered (lab `nextRows`). */
function GuardCandidates(
  props: Readonly<{
    view: MachineGuardViewV1;
    policy: MachineGuardPolicyV1;
    facts: MachineWidgetMachineFacts;
    open: GuardOpen;
    short: boolean;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const label = (
    <MachineWidgetSectionLabel
      label={t(
        props.short
          ? 'machines.widgets.body.guard.wouldStopFirst'
          : 'machines.widgets.body.guard.wouldStop',
      )}
      meta={t(
        props.short
          ? 'machines.widgets.body.guard.ifMemoryShort'
          : 'machines.widgets.body.guard.inThisOrder',
      )}
    />
  );
  const memory = resolveMemoryGuardRowState(
    props.policy,
    props.view.state,
    Date.now(),
  );
  if (memory.kind === 'unavailable') {
    // Windows reports no pressure signal: the memory guard cannot act, the rest of the guard still does.
    return (
      <View style={styles.section}>
        {label}
        <Text
          style={styles.detail}
          testID={`${props.testID}.memoryUnavailable`}
        >
          {describeMemoryGuardRow(memory, props.policy, props.facts.name)}
        </Text>
      </View>
    );
  }
  const candidates = props.view.ladder.steps
    .filter((step) => step.enabled && step.status !== 'off')
    .flatMap((step) => step.candidates)
    .slice(0, COMPACT_CANDIDATES);
  if (candidates.length === 0) {
    return (
      <View style={styles.section}>
        {label}
        <MachineWidgetState
          kind="empty"
          title={t('machines.widgets.body.guard.nothingIdleTitle')}
          reason={t('machines.widgets.body.guard.nothingIdleBody')}
          testID={`${props.testID}.nothingIdle`}
        />
      </View>
    );
  }
  const openGuard = () => props.open({ id: 'guard' });
  return (
    <View style={styles.section}>
      {label}
      <View accessibilityRole="list">
        {candidates.map((candidate, index) => (
          <Item
            key={candidate.ref}
            testID={`${props.testID}.candidate.${candidate.ref}`}
            density="tight"
            onPress={openGuard}
            accessibilityHint={t('machines.widgets.body.guard.open', {
              machine: props.facts.name,
            })}
            leftElement={
              <Text
                style={[styles.ordinal, { color: theme.colors.text.tertiary }]}
              >
                {String(index + 1)}
              </Text>
            }
            title={candidate.label ?? t('session.untitled')}
            titleAccessory={
              candidate.qualifier ? (
                <Text numberOfLines={1} style={styles.qualifier}>
                  {candidate.qualifier}
                </Text>
              ) : undefined
            }
            rightElement={
              <ReadOnlyValue
                text={formatMachineBytes(candidate.footprintBytes, 'memory')}
              />
            }
            showDivider={false}
          />
        ))}
      </View>
    </View>
  );
}

/** "Policies on leeroy-mbp": each rule's present value, read-only here — the Guard tab changes them. */
function GuardPolicies(
  props: Readonly<{
    policy: MachineGuardPolicyV1;
    machineName: string;
    testID: string;
  }>,
) {
  const { policy } = props;
  const leftBehind =
    policy.leftBehind.mode === 'off'
      ? t('machineGuard.off')
      : policy.leftBehind.mode === 'ask'
        ? t('machines.widgets.body.guard.ask')
        : policy.leftBehind.graceMs === 0
          ? t('machines.widgets.body.guard.automatic')
          : `${t('machines.widgets.body.guard.automatic')} · ${formatGuardGrace(policy.leftBehind.graceMs)}`;
  const rows = [
    {
      id: 'memory',
      title: t('machines.widgets.body.guard.policyMemory'),
      value: policy.memoryGuard.enabled
        ? t('machineGuard.on')
        : t('machineGuard.off'),
      on: policy.memoryGuard.enabled,
    },
    {
      id: 'idle',
      title: t('machines.widgets.body.guard.policyIdleSessions'),
      on: policy.idleSessions.enabled,
      value: policy.idleSessions.enabled
        ? t('machines.widgets.body.guard.after', {
            duration: formatGuardDuration(policy.idleSessions.afterMs),
          })
        : t('machineGuard.off'),
    },
    ...(policy.idleTerminals.enabled
      ? [
          {
            id: 'terminals',
            title: t('machines.widgets.body.guard.policyIdleTerminals'),
            on: true,
            value: t('machines.widgets.body.guard.after', {
              duration: formatGuardDuration(policy.idleTerminals.afterMs),
            }),
          },
        ]
      : []),
    {
      id: 'leftBehind',
      title: t('machines.widgets.body.guard.policyLeftBehind'),
      value: leftBehind,
      on: policy.leftBehind.mode !== 'off',
    },
  ];
  return (
    <View style={styles.section} testID={`${props.testID}.policies`}>
      <MachineWidgetSectionLabel
        label={t('machines.widgets.body.guard.policiesOn', {
          machine: props.machineName,
        })}
      />
      {rows.map((row) => (
        <Item
          key={row.id}
          testID={`${props.testID}.policy.${row.id}`}
          density="tight"
          mode="info"
          title={row.title}
          showDivider={false}
          rightElement={<ReadOnlyValue text={row.value} quiet={!row.on} />}
        />
      ))}
    </View>
  );
}

/** The Guard's own recent receipts through the one Activity row, each with its way back (Resume, Undo…). */
function GuardRecent(
  props: Readonly<{
    target: MachineWidgetTarget;
    facts: MachineWidgetMachineFacts;
    entries: MachineGuardViewV1['recentActivity'];
    open: GuardOpen;
    testID: string;
  }>,
) {
  const wayBack = useGuardWayBack(props.target);
  const openActivity = () => props.open({ id: 'guard', page: 'activity' });
  return (
    <View accessibilityRole="list">
      {props.entries.map((entry) => (
        <MachineActivityRow
          key={entry.id}
          entry={entry}
          pendingId={wayBack.pendingId}
          onWayBack={wayBack.run}
          readOnly={props.facts.recipient}
          onPress={openActivity}
        />
      ))}
    </View>
  );
}

/** Large: the last hour of memory in use, the Overview's own Memory tile (lab G Large chart). */
function GuardMemoryChart(
  props: Readonly<{
    target: MachineWidgetTarget;
    facts: MachineWidgetMachineFacts;
    testID: string;
  }>,
) {
  const vitals = useMachineWidgetVitalsView({
    target: props.target,
    facts: props.facts,
    range: '1h',
  });
  if (vitals.view.kind !== 'ready') return null;
  return (
    <View style={styles.section} testID={`${props.testID}.memory`}>
      <MachineWidgetSectionLabel
        label={t('machines.widgets.body.guard.memoryInUse')}
        meta={t('machines.widgets.body.guard.memoryInUseMeta')}
      />
      <MemoryTile
        sample={vitals.view.sample}
        attention={vitals.published?.attention ?? null}
        timeline={vitals.timeline}
        axis={vitals.axis}
        freshness={vitals.view.freshness}
        live
        nowMs={Date.now()}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: {
    gap: theme.space.s6,
    minWidth: 0,
  },
  sentence: {
    ...Typography.default(),
    ...Typography.variant('label', 'semiBold'),
    color: theme.colors.text.primary,
  },
  sentenceStrong: {
    ...Typography.variant('label', 'semiBold'),
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
  },
  countdown: {
    ...Typography.variant('label', 'semiBold'),
    ...Typography.default(),
    color: theme.colors.text.primary,
    fontVariant: ['tabular-nums'],
  },
  detail: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
    marginTop: theme.space.s4,
  },
  ordinal: {
    ...Typography.variant('meta'),
    ...Typography.tabular(),
    width: 14,
    textAlign: 'center',
  },
  qualifier: {
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
  },
}));
