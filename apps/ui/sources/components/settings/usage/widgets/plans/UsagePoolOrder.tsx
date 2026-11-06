import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HAPPIER_PRESS_FEEDBACK_V1,
  HappierPressable,
} from '@happier-dev/plugin-ui/presentation';
import { ConnectedServicePoolSelectionGetResponseV1Schema, type ConnectedServicePoolSelectionV1 } from '@happier-dev/protocol/connect/connectedServicePoolSelection';
import type { PluginUiResourceSnapshot } from '@happier-dev/plugin-ui/hostApi';
import { isPluginUiResourceReadAuthorityLost } from '@happier-dev/plugin-ui/advanced';
import { useAuth } from '@/auth/context/AuthContext';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { captureUiUsageQueryAccountContext, getUsageQueryResourceStore } from '@/sync/api/account/usageQueryResource';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { MeterBar } from '@/components/ui/lists/MeterBar';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { Typography } from '@/constants/Typography';
import { getPoolStrategyPresentation } from '@/sync/domains/connectedServices/connectedServicePoolPolicy';
import { t } from '@/text';
import type { UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { useUsageDrill } from '../../usageDrill';
import type { UsagePlanAccount, UsagePlanPool } from './usagePlansModel';
import {
  useUsagePoolMachineChoices,
  type UsagePlanAccountName,
  type UsagePoolMemberStatus,
  type UsagePoolSelectionState,
} from './useUsagePlans';
import {
  formatPlanMoment,
  formatPlanPercent,
  planExclusionText,
  UsagePlanIdentity,
  UsagePlanRank,
  UsagePlanSectionHead,
  usePlanText,
} from './UsagePlanParts';

type Selection = ConnectedServicePoolSelectionV1;
type Trace = Selection['decisionTrace'];
type NameOf = (account: UsagePlanAccount) => UsagePlanAccountName;

/** The popover's reading width; it narrows to the window on a phone. */
const WHY_POPOVER_WIDTH_PX = 380;
/** A queue row's meter: long enough to compare by eye, short enough to leave the reason its line. */
const QUEUE_METER_WIDTH_PX = 88;

/** One pool member as the selector's read lists it. The order is the read's; nothing is ranked here. */
export type UsagePoolMember = Readonly<{
  accountId: string;
  account: UsagePlanAccount | null;
  /** Place in the selector's eligible order, or null when it is not eligible. */
  rank: number | null;
  selected: boolean;
  candidate: Trace['orderedEligibleCandidates'][number] | null;
  evidence: Trace['candidates'][number] | null;
  exclusion: Selection['excluded'][number] | null;
}>;

/**
 * The selector's own answer, row by row: its eligible order first, then the members it left out in the
 * order its trace lists them. This reads the trace; it never compares two members.
 */
export function readUsagePoolMembers(
  pool: UsagePlanPool,
  accounts: readonly UsagePlanAccount[],
  selection: Selection,
): UsagePoolMember[] {
  const trace = selection.decisionTrace;
  const accountOf = (accountId: string) =>
    accounts.find(
      (account) =>
        pool.accountKeys.includes(account.key) &&
        account.accountId === accountId,
    ) ?? null;
  const selectedId = selection.selected?.profileId ?? null;
  const ordered = trace.orderedEligibleCandidates.map(
    (candidate) => candidate.profileId,
  );
  const rest = [
    ...trace.candidates.map((entry) => entry.profileId),
    ...selection.excluded.map((entry) => entry.profileId),
  ].filter(
    (id, index, all) => !ordered.includes(id) && all.indexOf(id) === index,
  );
  return [...ordered, ...rest].map((accountId) => ({
    accountId,
    account: accountOf(accountId),
    rank: ordered.includes(accountId) ? ordered.indexOf(accountId) + 1 : null,
    selected: accountId === selectedId,
    candidate:
      trace.orderedEligibleCandidates.find(
        (candidate) => candidate.profileId === accountId,
      ) ?? null,
    evidence:
      trace.candidates.find((entry) => entry.profileId === accountId) ?? null,
    exclusion:
      selection.excluded.find((entry) => entry.profileId === accountId) ?? null,
  }));
}

const BASIS_KEYS = {
  preference: 'usage.board.plans.basisPreference',
  primary_restore: 'usage.board.plans.basisPrimaryRestore',
  active_stickiness: 'usage.board.plans.usedFirstSticky',
  soft_switch: 'usage.board.plans.basisSoftSwitch',
  manual_strategy: 'usage.board.plans.basisManual',
  no_eligible_members: 'usage.board.plans.basisNoneEligible',
} as const satisfies Record<Trace['selectionBasis'], Parameters<typeof t>[0]>;

/** Why a member holds its place, in the selector's own terms. */
function memberReason(
  member: UsagePoolMember,
  trace: Trace,
  nowMs: number,
): string {
  if (member.exclusion && !member.selected) {
    return [
      planExclusionText(
        member.exclusion.reason,
        member.exclusion.retryAtMs ?? null,
        nowMs,
      ),
      t('usage.board.plans.queueSkipped'),
    ].join(' · ');
  }
  const deadline = member.candidate?.preferenceDeadlineMs ?? null;
  return [
    member.selected
      ? t(BASIS_KEYS[trace.selectionBasis])
      : member.rank === null
        ? null
        : t(
            member.rank <= 2
              ? 'usage.board.plans.usedFirstNext'
              : 'usage.board.plans.queueAfterThat',
          ),
    deadline !== null && deadline > nowMs
      ? t('usage.board.plans.queueDeadline', {
          time: formatPlanMoment(deadline, nowMs),
        })
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** A pool whose order could not be read says so in one held line; it never falls back to a guess. */
function unreadText(
  state: Exclude<UsagePoolSelectionState, Readonly<{ selection: Selection }>>,
): string {
  if (state === 'loading') return t('usage.board.plans.hintLoading');
  if (state === 'no_machine') return t('usage.board.plans.usedFirstNoMachine');
  if (state === 'choose_machine') return t('usage.board.plans.usedFirstPerMachine');
  if (state !== 'failed' && state.code === 'unsupported')
    return t('usage.board.plans.usedFirstUnsupported');
  return t('usage.board.plans.usedFirstReadFailed');
}

/**
 * One cause stated once: when two or more pools could not be read for the same reason (the machine is
 * offline for every pool), each pool keeps its heading and the cause is said once beneath them all.
 */
function readSharedUnreadCause(
  pools: readonly UsagePlanPool[],
  selections: ReadonlyMap<string, UsagePoolSelectionState>,
): string | null {
  const causes = pools.flatMap((pool) => {
    const state = selections.get(pool.key) ?? 'loading';
    return typeof state === 'string' || 'status' in state ? [unreadText(state)]
      : state.refreshError ? [unreadText(state.refreshError)] : [];
  });
  return causes.length > 1 && causes.every((cause) => cause === causes[0]) ? causes[0]! : null;
}

type PoolOrderProps = Readonly<{
  serverId: string;
  /** The query these pools were read for: its Machines filter is what a chosen Machine narrows. */
  query: UsageQuery;
  pools: readonly UsagePlanPool[];
  accounts: readonly UsagePlanAccount[];
  selections: ReadonlyMap<string, UsagePoolSelectionState>;
  nameOf: NameOf;
  nowMs: number;
  testID: string;
}>;

/**
 * "Used first" (lab `p2pool` U1): each pool's members in the selector's order with its reason, the
 * strategy named in words, and the "Why this account?" detail one press away.
 */
export function UsagePoolQueue(props: PoolOrderProps) {
  const text = usePlanText();
  if (props.pools.length === 0) return null;
  const sharedCause = readSharedUnreadCause(props.pools, props.selections);
  const named = props.pools.filter((pool) => pool.name);
  // A pool with no order to show (unread, or the selector lists no member) is a name and at most a cause; those share
  // one quiet "Used first" label instead of each repeating it as a heading with nothing under it.
  const stateOf = (pool: UsagePlanPool) => props.selections.get(pool.key) ?? 'loading';
  const bare = named.filter((pool) => readOrderedQueue(stateOf(pool)) === null);
  // Beside pools that show an order (each titled "Used first · name"), the others are simply "Other pools".
  const bareTitle = t(bare.length < named.length ? 'usage.board.plans.queueOtherTitle' : 'usage.board.plans.queueTitle');
  return (
    <View testID={props.testID} style={styles.pools}>
      {named.filter((pool) => !bare.includes(pool)).map((pool) => (
        <PoolQueue
          key={pool.key}
          {...props}
          pool={pool}
          causeBelow={sharedCause !== null}
          testID={`${props.testID}.${pool.groupId}`}
        />
      ))}
      {bare.length > 0 ? (
        <View style={styles.bareQueue}>
          {/* One unordered pool is one quiet line; the label stands over the names only for two or more, so the
              line's room is the same one the Capacity reading reserves. */}
          {bare.length > 1 ? (
            <Text accessibilityRole="header" style={[styles.quiet, text.detail]}>
              {bareTitle}
            </Text>
          ) : null}
          {bare.map((pool) => {
            const state = stateOf(pool);
            const cause = sharedCause ? null : bareQueueCause(state);
            return (
              <View key={pool.key} testID={`${props.testID}.${pool.groupId}`} style={styles.bareRow}>
                <Text style={[styles.body, text.detail]}>
                  {bare.length === 1 ? <Text accessibilityRole="header" style={[styles.quiet, text.detail]}>{`${bareTitle} · `}</Text> : null}
                  {pool.name}
                </Text>
                {cause ? <Text style={[styles.quiet, text.detail]}>{cause}</Text> : null}
                {cause && state === 'choose_machine' ? <PoolMachineChooser query={props.query} testID={`${props.testID}.chooseMachine`} /> : null}
              </View>
            );
          })}
        </View>
      ) : null}
      {sharedCause ? (
        <View style={styles.bareRow}>
          <Text testID={`${props.testID}.cause`} style={[styles.quiet, text.detail]}>
            {sharedCause}
          </Text>
          {bare.some((pool) => stateOf(pool) === 'choose_machine')
            ? <PoolMachineChooser query={props.query} testID={`${props.testID}.chooseMachine`} /> : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * Each Machine keeps its own switching order, so with several in scope the person picks whose order to
 * see. The choice narrows the one Machines filter (the page's, or the Usage page opened from elsewhere);
 * nothing here picks a Machine or merges their orders.
 */
function PoolMachineChooser(props: Readonly<{ query: UsageQuery; testID: string }>) {
  const { theme } = useUnistyles();
  const text = usePlanText();
  const drill = useUsageDrill(props.query);
  const choices = useUsagePoolMachineChoices(props.query.machines);
  const [open, setOpen] = React.useState(false);
  if (!drill.available('machines') || choices.length === 0) return null;
  return (
    <DropdownMenu
      testID={props.testID}
      open={open}
      onOpenChange={setOpen}
      items={choices.map((choice) => ({ id: choice.id, title: choice.name }))}
      // A list of Machine names, not a field: it takes the names' width so each one reads whole.
      matchTriggerWidth={false}
      onSelect={(id) => { void drill.toggle('machines', id); }}
      trigger={({ open: shown, toggle }) => (
        <HappierPressable
          testID={`${props.testID}.trigger`}
          onPress={toggle}
          accessibilityRole="button"
          expanded={shown}
          style={(state) => [
            styles.whyTrigger,
            state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null,
            focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
          ]}
        >
          <Text style={[styles.whyTriggerText, text.detail]}>{t('usage.board.plans.usedFirstChooseMachine')}</Text>
          <Icon name="caret-down" size={12} color={theme.colors.text.secondary} />
        </HappierPressable>
      )}
    />
  );
}

/** The read of a pool that has an order to show; one whose order is unread, or lists no member, is just a name. */
function readOrderedQueue(state: UsagePoolSelectionState) {
  return typeof state === 'string' || 'status' in state || state.memberStatus === 'none_known' ? null : state;
}

function bareQueueCause(state: UsagePoolSelectionState): string | null {
  if (typeof state === 'string' || 'status' in state) return unreadText(state);
  return state.refreshError ? unreadText(state.refreshError) : null;
}

function PoolQueue(
  props: PoolOrderProps & Readonly<{ pool: UsagePlanPool; causeBelow: boolean }>,
) {
  const text = usePlanText();
  const label = props.pool.name ?? null;
  const state = readOrderedQueue(props.selections.get(props.pool.key) ?? 'loading');
  if (!label || !state) return null;
  const title = `${t('usage.board.plans.queueTitle')} · ${label}`;
  const selection = state.selection;
  const trace = selection.decisionTrace;
  const strategy = getPoolStrategyPresentation(trace.strategy);
  const members = readUsagePoolMembers(props.pool, props.accounts, selection);
  return (
    <View testID={props.testID} style={styles.pool}>
      <UsagePlanSectionHead
        title={title}
        meta={[strategy.label, !props.causeBelow && state.refreshError ? unreadText(state.refreshError) : null].filter(Boolean).join(' · ')}
        action={
          <PoolWhy
            serverId={props.serverId}
            accounts={props.accounts}
            pool={props.pool}
            label={label}
            members={members}
            selection={selection}
            memberStatus={state.memberStatus}
            observedAtMs={state.observedAtMs}
            nameOf={props.nameOf}
            nowMs={props.nowMs}
            testID={`${props.testID}.why`}
          />
        }
      />
      <Text style={[styles.quiet, text.detail]}>{strategy.description}</Text>
      <View accessibilityRole="list">
        {members.map((member, index) => (
          <QueueRow
            key={member.accountId}
            member={member}
            trace={trace}
            first={index === 0}
            nameOf={props.nameOf}
            nowMs={props.nowMs}
            testID={`${props.testID}.${member.accountId}`}
          />
        ))}
      </View>
    </View>
  );
}

function QueueRow(
  props: Readonly<{
    member: UsagePoolMember;
    trace: Trace;
    first: boolean;
    nameOf: NameOf;
    nowMs: number;
    testID: string;
  }>,
) {
  const text = usePlanText();
  const { member } = props;
  const name = member.account ? props.nameOf(member.account) : null;
  const window = member.account?.headline ?? null;
  const remaining = window?.remainingFraction ?? null;
  const reason = memberReason(member, props.trace, props.nowMs);
  const left =
    remaining === null
      ? null
      : t('usage.board.plans.cellLeft', {
          percent: formatPlanPercent(remaining),
        });
  return (
    <View
      testID={props.testID}
      style={[styles.row, props.first ? null : styles.rowDivider]}
      accessibilityLabel={[
        member.rank !== null
          ? t('usage.board.plans.queuePlace', { place: member.rank })
          : null,
        name?.title ?? member.accountId,
        member.selected ? t('usage.board.plans.usedFirstInUse') : null,
        reason,
        window
          ? `${window.label}: ${left ?? t('usage.board.plans.cellUnknown')}`
          : null,
      ]
        .filter(Boolean)
        .join(', ')}
    >
      <UsagePlanRank rank={member.rank} selected={member.selected} />
      <View style={styles.rowText}>
        <View style={styles.rowTitle}>
          {name ? (
            <UsagePlanIdentity name={name} />
          ) : (
            <Text style={[styles.quiet, text.title]} numberOfLines={1}>
              {t('usage.board.plans.queueUnreadMember')}
            </Text>
          )}
          {member.selected ? (
            <StatusPill
              variant="neutral"
              hideDot
              labelVariant="phrase"
              label={t('usage.board.plans.usedFirstInUse')}
            />
          ) : null}
        </View>
        {reason ? (
          <Text style={[styles.quiet, text.detail]} numberOfLines={2}>
            {reason}
          </Text>
        ) : null}
      </View>
      {window ? (
        <View style={styles.rowMeter}>
          <Text
            style={[
              styles.rowValue,
              text.detail,
              window.tone === 'danger' ? styles.danger : null,
            ]}
            numberOfLines={1}
          >
            {left ?? t('usage.board.plans.cellUnknown')}
          </Text>
          <MeterBar
            height={4}
            tone={window.tone !== 'success' ? window.tone : 'neutral'}
            fillFraction={remaining ?? 0}
            {...(member.account?.stale ? { fillOpacity: 0.45 } : {})}
          />
        </View>
      ) : null}
    </View>
  );
}

/**
 * Now → Next → Then (lab `p2pool` U2): the same order as three steps, for a tile. Members the selector
 * left out are named on one quiet line beneath.
 */
export function UsagePoolSteps(props: PoolOrderProps) {
  const text = usePlanText();
  if (props.pools.length === 0) return null;
  const sharedCause = readSharedUnreadCause(props.pools, props.selections);
  return (
    <View testID={props.testID} style={styles.pools}>
      {props.pools.map((pool) => {
        const label = pool.name ?? null;
        const state = props.selections.get(pool.key) ?? 'loading';
        if (!label) return null;
        if (typeof state === 'string' || 'status' in state) {
          return (
            <UsagePlanSectionHead
              key={pool.key}
              title={label}
              meta={sharedCause ? null : unreadText(state)}
            />
          );
        }
        const members = readUsagePoolMembers(
          pool,
          props.accounts,
          state.selection,
        );
        if (state.memberStatus === 'none_known') {
          return <UsagePlanSectionHead key={pool.key} title={label} meta={!sharedCause && state.refreshError ? unreadText(state.refreshError) : null} />;
        }
        const steps = members
          .filter((member) => member.rank !== null)
          .slice(0, 3);
        const skipped = members.filter(
          (member) => member.rank === null && member.exclusion,
        );
        const stepKeys = [
          'usage.board.plans.stepNow',
          'usage.board.plans.usedFirstNext',
          'usage.board.plans.stepThen',
        ] as const;
        return (
          <View
            key={pool.key}
            testID={`${props.testID}.${pool.groupId}`}
            style={styles.pool}
          >
            <UsagePlanSectionHead
              title={label}
              action={<PoolWhy serverId={props.serverId} accounts={props.accounts} pool={pool} label={label}
                members={members} selection={state.selection} memberStatus={state.memberStatus} observedAtMs={state.observedAtMs}
                nameOf={props.nameOf} nowMs={props.nowMs} testID={`${props.testID}.${pool.groupId}.why`} />}
              meta={
                [getPoolStrategyPresentation(
                  state.selection.decisionTrace.strategy,
                ).label, !sharedCause && state.refreshError ? unreadText(state.refreshError) : null].filter(Boolean).join(' · ')
              }
            />
            <View style={styles.steps} accessibilityRole="list">
              {steps.map((member, index) => {
                const name = member.account
                  ? props.nameOf(member.account)
                  : null;
                const remaining =
                  member.account?.headline?.remainingFraction ?? null;
                return (
                  <View
                    key={member.accountId}
                    testID={`${props.testID}.${pool.groupId}.${member.accountId}`}
                    style={[styles.step, index > 0 ? styles.stepDivider : null]}
                    accessibilityLabel={[
                      t(stepKeys[index]!),
                      name?.title ?? member.accountId,
                      remaining === null
                        ? null
                        : t('usage.board.plans.cellLeft', {
                            percent: formatPlanPercent(remaining),
                          }),
                    ]
                      .filter(Boolean)
                      .join(', ')}
                  >
                    <Text style={[styles.quiet, text.detail]}>
                      {t(stepKeys[index]!)}
                    </Text>
                    {name ? <UsagePlanIdentity name={name} compact /> : null}
                    <MeterBar
                      height={4}
                      tone={
                        member.account?.headline &&
                        member.account.headline.tone !== 'success'
                          ? member.account.headline.tone
                          : 'neutral'
                      }
                      fillFraction={remaining ?? 0}
                    />
                  </View>
                );
              })}
            </View>
            {skipped.length > 0 ? (
              <Text style={[styles.quiet, text.detail]} numberOfLines={2}>
                {t('usage.board.plans.stepsSkipped', {
                  names: skipped
                    .map(
                      (member) =>
                        `${member.account ? props.nameOf(member.account).title : member.accountId} (${planExclusionText(member.exclusion!.reason, member.exclusion!.retryAtMs ?? null, props.nowMs)})`,
                    )
                    .join(', '),
                })}
              </Text>
            ) : null}
          </View>
        );
      })}
      {sharedCause ? (
        <Text testID={`${props.testID}.cause`} style={[styles.quiet, text.detail]}>
          {sharedCause}
        </Text>
      ) : null}
    </View>
  );
}

type WhyProps = Readonly<{
  serverId: string;
  accounts: readonly UsagePlanAccount[];
  pool: UsagePlanPool;
  label: string;
  members: readonly UsagePoolMember[];
  selection: Selection;
  memberStatus: UsagePoolMemberStatus;
  observedAtMs: number;
  nameOf: NameOf;
  nowMs: number;
  testID: string;
}>;

/** The trigger carries no detail: the trace is laid out only inside the open popover. */
function PoolWhy(props: WhyProps) {
  const { theme } = useUnistyles();
  const text = usePlanText();
  const anchorRef = React.useRef<View>(null);
  const [open, setOpen] = React.useState(false);
  const close = React.useCallback(() => setOpen(false), []);
  return (
    <View ref={anchorRef} collapsable={false}>
      <HappierPressable
        testID={props.testID}
        onPress={() => setOpen((value) => !value)}
        accessibilityRole="button"
        accessibilityLabel={t('usage.board.plans.whyTitle')}
        expanded={open}
        hitSlop={12}
        style={(state) => [
          styles.whyTrigger,
          state.pressed
            ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle }
            : null,
          focusRingStyle({
            focused: state.focused,
            color: theme.colors.border.focus,
          }),
        ]}
      >
        <Icon name="info" size={13} color={theme.colors.text.secondary} />
        <Text style={[styles.whyTriggerText, text.detail]}>
          {t('usage.board.plans.whyTitle')}
        </Text>
      </HappierPressable>
      {open ? (
        <PoolWhyPopover
          {...props}
          anchorRef={anchorRef}
          onRequestClose={close}
        />
      ) : null}
    </View>
  );
}

function PoolWhyPopover(
  props: WhyProps &
    Readonly<{
      anchorRef: React.RefObject<View | null>;
      onRequestClose: () => void;
    }>,
) {
  const text = usePlanText();
  const trace = props.selection.decisionTrace;
  const strategy = getPoolStrategyPresentation(trace.strategy);
  const selected = props.members.find((member) => member.selected) ?? null;
  const selectedName = selected?.account
    ? props.nameOf(selected.account).title
    : null;
  return (
    <Popover
      open
      autoFocusOnOpen
      anchorRef={props.anchorRef}
      focusReturnRef={props.anchorRef}
      placement="auto"
      maxWidthCap={WHY_POPOVER_WIDTH_PX}
      portal={{
        web: true,
        native: true,
        matchAnchorWidth: false,
        anchorAlign: 'end',
      }}
      onRequestClose={props.onRequestClose}
    >
      {({ maxHeight }) => (
        <FloatingOverlay maxHeight={maxHeight} scrollEnabled>
          <View testID={`${props.testID}.detail`} style={styles.why}>
            <View style={styles.whyHead}>
              <Text
                accessibilityRole="header"
                style={[styles.strong, text.title]}
              >
                {selectedName
                  ? t('usage.board.plans.whyAccount', { name: selectedName })
                  : props.memberStatus === 'all_excluded'
                    ? t('usage.board.plans.whyNone') : t('usage.board.plans.whyTitle')}
              </Text>
              <Text style={[styles.quiet, text.detail]}>
                {[
                  t('usage.board.plans.whyDecided', {
                    time: formatPlanMoment(props.observedAtMs, props.nowMs),
                  }),
                  props.label,
                ].join(' · ')}
              </Text>
            </View>
            <Text style={[styles.body, text.detail]}>
              {t(BASIS_SENTENCE_KEYS[trace.selectionBasis])}
            </Text>
            <View accessibilityRole="list">
              {props.members.map((member, index) => (
                <WhyRow
                  key={member.accountId}
                  member={member}
                  first={index === 0}
                  nameOf={props.nameOf}
                  nowMs={props.nowMs}
                  testID={`${props.testID}.candidate.${member.accountId}`}
                />
              ))}
            </View>
            <Text style={[styles.quiet, text.detail]}>
              {`${t('usage.board.plans.whyRule')}: ${strategy.label}. ${strategy.description}`}
            </Text>
            <PoolComparison {...props} />
          </View>
        </FloatingOverlay>
      )}
    </Popover>
  );
}

const EMPTY_COMPARISON: PluginUiResourceSnapshot = Object.freeze({ freshness: 'unknown', pending: 'idle', subscription: 'ended' });
const COMPARISON_STRATEGIES = ['manual', 'priority', 'least_limited', 'expiry_first'] as const;

/** The open detail owns only the question. The shared Resource and selector own its answer. */
function PoolComparison(props: WhyProps) {
  const text = usePlanText();
  const { credentials } = useAuth();
  const lifetime = captureActiveServerAccountScopeLifetime();
  const [strategy, setStrategy] = React.useState(props.selection.decisionTrace.strategy);
  const [atMs, setAtMs] = React.useState<number | null>(null);
  const [asked, setAsked] = React.useState(false);
  const [strategyOpen, setStrategyOpen] = React.useState(false);
  const [momentOpen, setMomentOpen] = React.useState(false);
  const context = React.useMemo(() => asked && credentials && lifetime?.isCurrent()
    && lifetime.scope.serverId === props.serverId ? captureUiUsageQueryAccountContext(credentials) : null,
  [asked, credentials, lifetime, props.serverId]);
  const moment = atMs ?? props.nowMs;
  const machineId = props.pool.selectorMachineId;
  const entry = React.useMemo(() => context && machineId ? getUsageQueryResourceStore(context).getEntry({
    hostRead: 'connectedServices.pools.selection.get', input: { machineId,
      group: { service: props.pool.service, groupId: props.pool.groupId }, hypothetical: { strategy, atMs: moment } },
  }) : null, [context, machineId, props.pool.service, props.pool.groupId, strategy, moment]);
  const subscribe = React.useCallback((listener: () => void) => entry?.subscribe(listener, true) ?? (() => {}), [entry]);
  const getSnapshot = React.useCallback(() => entry?.getSnapshot() ?? EMPTY_COMPARISON, [entry]);
  const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const result = React.useMemo(() => lifetime?.isCurrent() && !isPluginUiResourceReadAuthorityLost(snapshot) && snapshot.value
    ? ConnectedServicePoolSelectionGetResponseV1Schema.safeParse(JSON.parse(new TextDecoder().decode(snapshot.value.bytes))) : null,
  [lifetime, snapshot]);
  const response = result?.success ? result.data : null;
  // Only witnessed future clocks are offered; selecting one does not assert that a vendor quota refills then.
  const moments = [...new Set([
    ...props.accounts.filter(account => props.pool.accountKeys.includes(account.key)).flatMap(account => account.windows.map(window => window.resetAtMs)),
    ...props.selection.decisionTrace.orderedEligibleCandidates.map(candidate => candidate.preferenceDeadlineMs),
    ...props.selection.excluded.map(excluded => excluded.retryAtMs),
  ].filter((time): time is number => time != null && time > props.nowMs))].sort((left, right) => left - right);
  const id = `${props.testID}.comparison`;
  return <View style={styles.pool} testID={id}>
    <Text accessibilityRole="header" style={[styles.strong, text.title]}>{t('usage.board.plans.comparisonTitle')}</Text>
    <DropdownMenu testID={`${id}.strategy`} open={strategyOpen} onOpenChange={setStrategyOpen}
      selectedId={strategy} items={COMPARISON_STRATEGIES.map(value => ({ id: value, title: getPoolStrategyPresentation(value).label }))}
      itemTrigger={{ title: t('usage.board.plans.whyRule') }}
      onSelect={value => { const next = COMPARISON_STRATEGIES.find(option => option === value); if (next) { setStrategy(next); setAsked(true); } }} />
    <DropdownMenu testID={`${id}.moment`} open={momentOpen} onOpenChange={setMomentOpen}
      selectedId={atMs === null ? 'now' : String(atMs)}
      items={[{ id: 'now', title: t('usage.board.plans.stepNow') }, ...moments.map(time => ({ id: String(time), title: formatPlanMoment(time, props.nowMs) }))]}
      itemTrigger={{ title: t('usage.board.plans.comparisonMoment') }}
      onSelect={value => { if (value === 'now' || moments.includes(Number(value))) { setAtMs(value === 'now' ? null : Number(value)); setAsked(true); } }} />
    <Text style={[styles.quiet, text.detail]}>{t('usage.board.plans.comparisonNote')}</Text>
    {asked && snapshot.error ? <SurfaceFreshnessLine testID={`${id}.failed`} tone="warning"
      reason={t('usage.board.plans.usedFirstReadFailed')}
      action={{ label: t('common.retry'), onPress: async () => { await entry?.refresh(); } }} /> : null}
    {asked ? !entry ? <Text style={[styles.quiet, text.detail]}>{t('usage.board.plans.usedFirstNoMachine')}</Text>
      : response && 'status' in response ? <Text style={[styles.quiet, text.detail]}>{t('usage.board.plans.usedFirstReadFailed')}</Text>
      : response && 'group' in response ? <View accessibilityRole="list">{readUsagePoolMembers(props.pool, props.accounts, response.selection).map((member, index) =>
        <WhyRow key={member.accountId} member={member} first={index === 0} nameOf={props.nameOf} nowMs={moment} testID={`${id}.candidate.${member.accountId}`} />)}</View>
      : snapshot.error ? null : <Text style={[styles.quiet, text.detail]}>{t('usage.board.plans.hintLoading')}</Text> : null}
  </View>;
}

const BASIS_SENTENCE_KEYS = {
  preference: 'usage.board.plans.whyBasisPreference',
  primary_restore: 'usage.board.plans.whyBasisPrimaryRestore',
  active_stickiness: 'usage.board.plans.whyBasisSticky',
  soft_switch: 'usage.board.plans.whyBasisSoftSwitch',
  manual_strategy: 'usage.board.plans.whyBasisManual',
  no_eligible_members: 'usage.board.plans.whyBasisNoneEligible',
} as const satisfies Record<Trace['selectionBasis'], Parameters<typeof t>[0]>;

/** One candidate: the quota evidence the selector used (its own number and age), then its decision. */
function WhyRow(
  props: Readonly<{
    member: UsagePoolMember;
    first: boolean;
    nameOf: NameOf;
    nowMs: number;
    testID: string;
  }>,
) {
  const text = usePlanText();
  const { member } = props;
  const name = member.account ? props.nameOf(member.account) : null;
  const quota = member.evidence?.quotaEvidence ?? null;
  const deadline = member.candidate?.preferenceDeadlineMs ?? null;
  const evidence = [
    quota === null
      ? null
      : quota.status === 'stale_or_missing'
        ? t('usage.board.plans.whyEvidenceMissing')
        : quota.remainingPercent != null
          ? t('usage.board.plans.cellLeft', {
              percent: `${Math.round(quota.remainingPercent)}%`,
            })
          : null,
    quota?.capturedAtMs !== undefined
      ? t('usage.board.plans.whyChecked', {
          time: formatPlanMoment(quota.capturedAtMs, props.nowMs),
        })
      : null,
    deadline !== null
      ? t('usage.board.plans.queueDeadline', {
          time: formatPlanMoment(deadline, props.nowMs),
        })
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const decision =
    member.evidence?.decision ??
    (member.selected
      ? 'selected'
      : member.rank !== null
        ? 'eligible'
        : 'excluded');
  const exclusionReason =
    member.evidence?.exclusionReason ?? member.exclusion?.reason ?? null;
  const retryAtMs =
    member.evidence?.retryAtMs ?? member.exclusion?.retryAtMs ?? null;
  const decisionText =
    decision === 'selected'
      ? t('usage.board.plans.whySelected')
      : decision === 'eligible'
        ? t('usage.board.plans.whyEligible')
        : exclusionReason
          ? planExclusionText(exclusionReason, retryAtMs, props.nowMs)
          : t('usage.board.plans.queueSkipped');
  return (
    <View
      testID={props.testID}
      style={[styles.row, props.first ? null : styles.rowDivider]}
      accessibilityLabel={[
        name?.title ?? member.accountId,
        evidence,
        decisionText,
      ]
        .filter(Boolean)
        .join(', ')}
    >
      <UsagePlanRank rank={member.rank} selected={member.selected} />
      <View style={styles.rowText}>
        {name ? (
          <UsagePlanIdentity name={name} compact />
        ) : (
          <Text style={[styles.quiet, text.title]}>
            {t('usage.board.plans.queueUnreadMember')}
          </Text>
        )}
        {evidence ? (
          <Text style={[styles.quiet, text.detail]} numberOfLines={3}>
            {evidence}
          </Text>
        ) : null}
      </View>
      <StatusPill
        variant={decision === 'excluded' ? 'warning' : 'neutral'}
        hideDot
        labelVariant="phrase"
        labelNumberOfLines={2}
        label={decisionText}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  pools: { gap: 18 },
  pool: { gap: theme.space.s6 },
  bareQueue: { gap: theme.space.s4 },
  bareRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: theme.space.s8 },
  quiet: {
    ...Typography.default(),
    color: theme.colors.text.tertiary,
    fontVariant: ['tabular-nums'],
  },
  body: { ...Typography.default(), color: theme.colors.text.secondary },
  strong: {
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
  },
  danger: { color: theme.colors.state.danger.foreground },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s10,
    paddingVertical: theme.space.s8,
  },
  rowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
  },
  rowText: { flex: 1, minWidth: 0, gap: theme.space.s2 },
  rowTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    columnGap: theme.space.s8,
    rowGap: theme.space.s2,
  },
  rowMeter: { width: QUEUE_METER_WIDTH_PX, gap: theme.space.s4 },
  rowValue: {
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
  },
  steps: { flexDirection: 'row', alignItems: 'stretch' },
  step: { flex: 1, minWidth: 0, gap: theme.space.s4, paddingRight: theme.space.s10 },
  stepDivider: {
    paddingLeft: theme.space.s10,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: theme.colors.border.default,
  },
  whyTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
    borderRadius: theme.borderRadius.sm,
  },
  whyTriggerText: {
    ...Typography.default('medium'),
    color: theme.colors.text.secondary,
  },
  why: { paddingHorizontal: 14, paddingVertical: theme.space.s12, gap: theme.space.s10 },
  whyHead: { gap: theme.space.s2 },
}));
