import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HappierPressable,
  HappierRadioChoiceList,
  happierPageTextMetrics,
} from '@happier-dev/plugin-ui/presentation';
import type { MachineRetentionPolicyV1 } from '@happier-dev/protocol/account/settings/machineRetentionDefaultsV1';
import type { RetentionV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { isMachineRetainedWakeEligibleV1 } from '@happier-dev/protocol/machines/managed/resolveMachineRetentionPolicyV1';

import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import {
  LocalDateTimeEditor,
  resolveFutureLocalDateTime,
} from '@/components/ui/dateTime/LocalDateTimeEditor';
import {
  toLocalDateTimeDraft,
  type LocalDateTimeDraft,
} from '@/components/ui/dateTime/localDateTimeValue';
import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import {
  buildRetentionChoices,
  buildRetentionKindChoices,
  describeDefaultPolicy,
  describeRetention,
  describeFiniteRetention,
  retentionChoiceId,
  type RetentionEffect,
} from './managedRetentionPresentation';

export type ManagedMachineKeepControlProps = Readonly<{
  /** The effective policy: an explicit choice, or the inherited default it shows. */
  policy: MachineRetentionPolicyV1;
  /** The next policy up the chain; unavailable parent facts leave Reset disabled. */
  defaultPolicy?: MachineRetentionPolicyV1;
  /** True while nothing is chosen here, so the default applies and there is nothing to reset. */
  inherited: boolean;
  /** The category the default comes from ("Cloud billed while stopped"), named on an inherited choice. */
  categoryLabel?: string;
  /**
   * `field`: a When unused select and the wake switch as page rows (Machine defaults, phone pages).
   * `choices`: three quiet radios with the consequence beneath (the configurator receipt, a machine's
   * Keep it section).
   */
  presentation: 'field' | 'choices';
  /** The effects this provider can carry out; an unsupported one is never offered. */
  effects?: readonly RetentionEffect[];
  /** What the selected choice does, in the provider's billing words; `field` shows one line for the category. */
  consequence: (retention: RetentionV1) => string;
  /** False when the provider cannot start the same machine again, so wake is not offered. */
  canWake?: boolean;
  /** The declared native resource cannot stop and keep the same allocation. */
  finiteOnly?: boolean;
  /** A live detail cannot offer policy edits until its current native capability owner qualifies it. */
  capabilitiesAvailable?: boolean;
  /** Exact complete option identities; selection writes its returned native launch, never an inferred field. */
  nativeDuration?: Readonly<{
    value: string | null;
    choices: readonly Readonly<{ id: string; title: string; unavailableReason?: string }>[];
    onChange: (id: string) => void;
    /** The contribution-declared native input, relocated here without a second selector. */
    editor?: React.ReactNode;
  }>;
  /** Producer-returned native expiry disclosure. Omission stays explicitly unavailable. */
  nativeExpiry?: string;
  /**
   * Offers an explicit time to stop or delete at (plan 52 Explicit deadline). A deadline does not wait
   * for work to finish, so it is authored only here, where its time, effect and interruption are
   * reviewed before anything is written. Account defaults never pass it; finite-only resources
   * always use their sole native Ends control (CD12).
   */
  deadline?: boolean;
  /** Shows the "Keep it" label above the choices (the receipt); a section already titled Keep it hides it. */
  showLabel?: boolean;
  /** Local edits are synchronous; a live save returns false when it needs another review. */
  onChange: (policy: MachineRetentionPolicyV1) => void | Promise<boolean>;
  /** Retires the local proposed policy when the person cancels its review. */
  onCancel?: () => void;
  onReset: () => void | Promise<boolean>;
  disabled?: boolean;
  testID: string;
}>;

/**
 * The one Keep it / wake control (plans 51/52): Machine defaults, the configurator receipt, a preset
 * and a created machine all draw it. It never resolves policy; the caller passes the effective value
 * and the default it would reset to.
 */
export const ManagedMachineKeepControl = React.memo(
  function ManagedMachineKeepControl(props: ManagedMachineKeepControlProps) {
    if (props.finiteOnly) return <KeepFinite {...props} />;
    const wakeShown =
      props.canWake !== false && isMachineRetainedWakeEligibleV1(props.policy.retention);
    const setRetention = (retention: RetentionV1) => {
      const preserveWake = retention.kind === 'until-delete' ||
        (props.policy.retention.kind !== 'until-delete' && isMachineRetainedWakeEligibleV1(props.policy.retention));
      return props.onChange({
        retention,
        // Keep the authored wake choice for Until-delete or an existing Stop rule. A newly chosen
        // Stop retains D21's wake default; destruction and unsupported native wake stay off.
        wakeOnAcceptedMessage:
          props.canWake !== false && isMachineRetainedWakeEligibleV1(retention) &&
          (preserveWake ? props.policy.wakeOnAcceptedMessage : true),
      });
    };
    const setWake = (wake: boolean) =>
      props.onChange({
        retention: props.policy.retention,
        wakeOnAcceptedMessage: wake,
      });
    return props.presentation === 'field' ? (
      <KeepField
        {...props}
        wakeShown={wakeShown}
        setRetention={setRetention}
        setWake={setWake}
      />
    ) : (
      <KeepChoices
        {...props}
        wakeShown={wakeShown}
        setRetention={setRetention}
        setWake={setWake}
      />
    );
  },
);

function UnavailableKeepPolicy(props: ManagedMachineKeepControlProps) {
  return <>
    <Item testID={`${props.testID}:retention`} title={t('managedRetention.whenUnused')}
      subtitle={describeRetention(props.policy.retention)} mode="info" showChevron={false} />
    <SectionContentRow testID={`${props.testID}:unavailable`}>
      <Text style={styles.quiet}>{props.nativeExpiry ?? t('managedMachines.options.unavailable')}</Text>
    </SectionContentRow>
  </>;
}

function KeepFinite(props: ManagedMachineKeepControlProps) {
  const [open, setOpen] = React.useState(false);
  const duration = props.nativeDuration;
  if (props.capabilitiesAvailable === false) return <UnavailableKeepPolicy {...props} />;
  return <>
    {duration?.editor ? <SectionContentRow testID={`${props.testID}:retention`}>
      <Text style={styles.quiet}>{t('managedRetention.ends')}</Text>
      {duration.editor}
    </SectionContentRow> : duration?.choices.length ? <DropdownMenu open={open} onOpenChange={setOpen} variant="selectable" search={false}
      selectedId={duration.value} showCategoryTitles={false} matchTriggerWidth connectToTrigger rowKind="item"
      itemTrigger={{ title: t('managedRetention.ends'), showSelectedSubtitle: false,
        itemProps: { testID: `${props.testID}:retention`, disabled: props.disabled } }}
      items={duration.choices.map(choice => ({ id: choice.id, title: choice.title, disabled: choice.unavailableReason !== undefined }))}
      onSelect={id => {
        setOpen(false);
        if (!props.disabled && duration.choices.some(choice => choice.id === id && !choice.unavailableReason)) duration.onChange(id);
      }} /> : <Item testID={`${props.testID}:retention`} title={t('managedRetention.ends')}
        subtitle={props.nativeExpiry ?? t('managedMachines.options.unavailable')} mode="info" showChevron={false} />}
    <SectionContentRow testID={`${props.testID}:consequence`}>
      <Text style={styles.consequence}>{describeFiniteRetention(props.policy.retention)}</Text>
      {duration?.choices.length ? <Text style={styles.quiet}>{props.nativeExpiry ?? t('managedMachines.options.unavailable')}</Text> : null}
      {!props.inherited ? <ResetLink testID={`${props.testID}:reset`} onPress={props.onReset}
        disabled={props.disabled || !props.defaultPolicy} /> : null}
    </SectionContentRow>
  </>;
}

type InnerProps = ManagedMachineKeepControlProps &
  Readonly<{
    wakeShown: boolean;
    setRetention: (retention: RetentionV1) => void | Promise<boolean>;
    setWake: (wake: boolean) => void;
  }>;

function KeepField(props: InnerProps) {
  const [open, setOpen] = React.useState(false);
  const choices = React.useMemo(
    () =>
      buildRetentionChoices({
        current: props.policy.retention,
        effects: props.effects,
      }),
    [props.effects, props.policy.retention],
  );
  if (props.capabilitiesAvailable === false) return <UnavailableKeepPolicy {...props} />;
  return (
    <>
      <DropdownMenu
        open={open}
        onOpenChange={setOpen}
        variant="selectable"
        search={false}
        selectedId={retentionChoiceId(props.policy.retention)}
        showCategoryTitles={false}
        matchTriggerWidth
        connectToTrigger
        rowKind="item"
        itemTrigger={{
          title: t('managedRetention.whenUnused'),
          showSelectedSubtitle: false,
          itemProps: {
            testID: `${props.testID}:retention`,
            accessoryLayout: 'adaptive',
            disabled: props.disabled,
          },
        }}
        items={choices.map((choice) => ({
          id: choice.id,
          title: choice.title,
        }))}
        onSelect={(id) => {
          setOpen(false);
          const choice = choices.find((candidate) => candidate.id === id);
          if (choice) props.setRetention(choice.retention);
        }}
      />
      {props.wakeShown ? (
        <Item
          testID={`${props.testID}:wake`}
          title={t('managedRetention.wake')}
          showChevron={false}
          disabled={props.disabled}
          rightElement={
            <Switch
              testID={`${props.testID}:wake:switch`}
              accessibilityLabel={t('managedRetention.wake')}
              value={props.policy.wakeOnAcceptedMessage}
              disabled={props.disabled}
              onValueChange={props.setWake}
            />
          }
          onPress={
            props.disabled
              ? undefined
              : () => props.setWake(!props.policy.wakeOnAcceptedMessage)
          }
        />
      ) : null}
      <SectionContentRow testID={`${props.testID}:consequence`}>
        <Text style={styles.consequence}>
          {props.consequence(props.policy.retention)}
        </Text>
        {props.inherited ? null : (
          <View style={styles.footer}>
            <ResetLink
              testID={`${props.testID}:reset`}
              onPress={props.onReset}
              disabled={props.disabled || !props.defaultPolicy}
            />
            {props.defaultPolicy ? <Text style={styles.quiet} numberOfLines={1}>
              {t('managedRetention.defaultIs', {
                value: describeDefaultPolicy(props.defaultPolicy),
              })}
            </Text> : null}
          </View>
        )}
      </SectionContentRow>
    </>
  );
}

function KeepChoices(props: InnerProps) {
  const { theme } = useUnistyles();
  const radioTheme = React.useMemo(() => projectPluginUiTheme(theme), [theme]);
  const choices = React.useMemo(
    () =>
      buildRetentionKindChoices({
        current: props.policy.retention,
        effects: props.effects,
      }),
    [props.effects, props.policy.retention],
  );
  const effects = props.effects ?? DEADLINE_EFFECTS;
  const current = props.policy.retention;
  const [draft, setDraft] = React.useState<DeadlineDraft | null>(null);
  // With authoring on, one row stands for the deadline: the current one by its time, else the offer.
  const rows = React.useMemo(
    (): readonly KeepChoiceRow[] =>
      props.deadline && effects.length > 0
        ? [
            ...choices.filter((choice) => choice.retention.kind !== 'deadline'),
            {
              id: DEADLINE_CHOICE_ID,
              title:
                current.kind === 'deadline'
                  ? describeRetention(current)
                  : t('managedRetention.atTime'),
            },
          ]
        : choices,
    [choices, current, effects.length, props.deadline],
  );
  const selectedId =
    draft || (props.deadline && current.kind === 'deadline')
      ? DEADLINE_CHOICE_ID
      : retentionChoiceId(current);
  const choose = (row: KeepChoiceRow) => {
    if (row.retention) {
      setDraft(null);
      props.setRetention(row.retention);
      return;
    }
    // Choosing the deadline opens its editor; nothing is written until it is reviewed and set.
    const nowMs = Date.now();
    setDraft({
      nowMs,
      effect:
        current.kind === 'deadline' && effects.includes(current.effect)
          ? current.effect
          : effects[0]!,
      time: toLocalDateTimeDraft(
        new Date(
          current.kind === 'deadline' && current.at > nowMs
            ? current.at
            : nowMs + DEADLINE_EDIT_START_MS,
        ),
      ),
    });
  };
  // Keep the draft's owner mounted while native qualification refreshes.
  if (props.capabilitiesAvailable === false) return <UnavailableKeepPolicy {...props} />;
  return (
    <View testID={props.testID} style={styles.choices}>
      <View style={[styles.head, props.showLabel ? null : styles.headEnd]}>
        {props.showLabel ? (
          <Text style={styles.quiet}>{t('managedRetention.keepIt')}</Text>
        ) : null}
        {props.inherited ? (
          props.categoryLabel ? (
            <Text style={styles.quiet} numberOfLines={1}>
              {t('managedRetention.defaultCategory', {
                category: props.categoryLabel,
              })}
            </Text>
          ) : null
        ) : (
          <ResetLink
            testID={`${props.testID}:reset`}
            onPress={async () => {
              const saved = await props.onReset();
              if (saved !== false) setDraft(currentDraft => currentDraft === draft ? null : currentDraft);
            }}
            disabled={props.disabled || !props.defaultPolicy}
            underline
          />
        )}
      </View>
      <HappierRadioChoiceList<string>
        accessibilityLabel={t('managedRetention.keepIt')}
        options={rows}
        value={selectedId}
        disabled={props.disabled}
        theme={radioTheme}
        testIDPrefix={`${props.testID}:choice`}
        onChange={(id) => {
          const row = rows.find((candidate) => candidate.id === id);
          if (row) choose(row);
        }}
        renderTitle={(option) => <Text style={styles.choiceText}>{option.title}</Text>}
      />
      {draft ? (
        <DeadlineEditor
          draft={draft}
          effects={effects}
          disabled={props.disabled}
          testID={`${props.testID}:deadline`}
          onChange={setDraft}
          onCancel={() => { setDraft(null); props.onCancel?.(); }}
          onConfirm={async (retention) => {
            const saved = await props.setRetention(retention);
            if (saved !== false) setDraft(currentDraft => currentDraft === draft ? null : currentDraft);
          }}
        />
      ) : props.deadline && current.kind === 'deadline' ? (
        // The chosen row already says when; what stays worth saying is that it will not wait for work.
        <View style={[styles.reserved, styles.deadlineNote]} accessibilityLiveRegion="polite">
          <InterruptsNote testID={`${props.testID}:consequence`} />
        </View>
      ) : (
        // The consequence keeps its height so the actions below never move as the choice changes.
        <Text
          testID={`${props.testID}:consequence`}
          style={[styles.consequence, styles.reserved]}
          accessibilityLiveRegion="polite"
        >
          {props.consequence(props.policy.retention)}
        </Text>
      )}
      {props.wakeShown && !draft ? (
        <View style={styles.wake}>
          <View style={styles.wakeText}>
            <Text style={styles.choiceText}>{t('managedRetention.wake')}</Text>
            <Text style={styles.quiet}>{t('managedRetention.wakeHelp')}</Text>
          </View>
          <Switch
            testID={`${props.testID}:wake:switch`}
            accessibilityLabel={t('managedRetention.wake')}
            value={props.policy.wakeOnAcceptedMessage}
            disabled={props.disabled}
            onValueChange={props.setWake}
          />
        </View>
      ) : null}
    </View>
  );
}

const DEADLINE_CHOICE_ID = 'deadline';
const DEADLINE_EFFECTS: readonly RetentionEffect[] = ['stop', 'delete'];
/** An hour ahead is a place to start editing from; it is never a default answer. */
const DEADLINE_EDIT_START_MS = 60 * 60 * 1000;

type KeepChoiceRow = Readonly<{
  id: string;
  title: string;
  /** Absent on the deadline row: its value comes from the reviewed editor. */
  retention?: RetentionV1;
}>;

type DeadlineDraft = Readonly<{
  /** The instant the editor opened; a reading must be after it. */
  nowMs: number;
  effect: RetentionEffect;
  time: LocalDateTimeDraft;
}>;

/**
 * The explicit deadline's time and effect, then its consequence: what happens, when, and that it does
 * not wait for work. Set is the only write; Cancel and a past time leave the policy as it was.
 */
function DeadlineEditor(
  props: Readonly<{
    draft: DeadlineDraft;
    effects: readonly RetentionEffect[];
    disabled?: boolean;
    testID: string;
    onChange: (draft: DeadlineDraft) => void;
    onCancel: () => void;
    onConfirm: (retention: RetentionV1) => void;
  }>,
) {
  const { draft } = props;
  const at = resolveFutureLocalDateTime(draft.time, draft.nowMs);
  const retention: RetentionV1 | null =
    at === null
      ? null
      : { kind: 'deadline', at, effect: draft.effect, interrupts: true };
  return (
    <View testID={props.testID} style={styles.deadline}>
      {props.effects.length > 1 ? (
        <SegmentedTabBar<RetentionEffect>
          role="radiogroup"
          accessibilityLabel={t('managedRetention.deadlineEffect')}
          testIDPrefix={`${props.testID}:effect`}
          tabs={props.effects.map((effect) => ({
            id: effect,
            label:
              effect === 'stop'
                ? t('managedRetention.scopeStop')
                : t('managedRetention.scopeDelete'),
          }))}
          activeTabId={draft.effect}
          onSelectTab={(effect) => props.onChange({ ...draft, effect })}
          labelSize="field"
          slidingThumb
          disabled={props.disabled}
        />
      ) : null}
      <LocalDateTimeEditor
        nowMs={draft.nowMs}
        value={draft.time}
        onChange={(time) => props.onChange({ ...draft, time })}
        testIDPrefix={props.testID}
        labels={{
          date: t('managedRetention.deadlineDate'),
          time: t('managedRetention.deadlineTime'),
          pastInstant: t('managedRetention.deadlinePast'),
        }}
      />
      {/* The review keeps its height, so Set never moves while a time is being typed. */}
      <View style={styles.review} accessibilityLiveRegion="polite">
        {retention ? (
          <>
            <Text testID={`${props.testID}:review`} style={styles.reviewTitle}>
              {describeRetention(retention)}
            </Text>
            <InterruptsNote testID={`${props.testID}:interrupts`} />
          </>
        ) : null}
      </View>
      <View style={styles.deadlineActions}>
        <RoundButton
          testID={`${props.testID}:cancel`}
          size="small"
          display="inverted"
          title={t('common.cancel')}
          onPress={props.onCancel}
        />
        <RoundButton
          testID={`${props.testID}:confirm`}
          size="small"
          title={t('managedRetention.setDeadline')}
          disabled={props.disabled || retention === null}
          onPress={() => {
            if (retention) props.onConfirm(retention);
          }}
        />
      </View>
    </View>
  );
}

/** A deadline's one standing consequence: it does not wait for work to finish. */
function InterruptsNote(props: Readonly<{ testID: string }>) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.interrupts}>
      <Icon name="warning" size={14} color={theme.colors.state.warning.foreground} />
      <Text testID={props.testID} style={styles.interruptsText}>
        {t('managedRetention.interrupts')}
      </Text>
    </View>
  );
}

function ResetLink(
  props: Readonly<{
    testID: string;
    onPress: () => void;
    disabled?: boolean;
    underline?: boolean;
  }>,
) {
  return (
    <HappierPressable
      testID={props.testID}
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      hitSlop={8}
    >
      <Text style={[styles.reset, props.underline ? styles.underline : null]}>
        {t('managedRetention.resetToDefault')}
      </Text>
    </HappierPressable>
  );
}

const rowDescription = happierPageTextMetrics('rowDescription');

const styles = StyleSheet.create((theme) => ({
  consequence: {
    ...Typography.default(),
    ...rowDescription,
    color: theme.colors.text.secondary,
  },
  reserved: {
    // Two description lines: the longest consequence at the receipt's width.
    minHeight: rowDescription.lineHeight * 2,
    marginTop: 6,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 8,
  },
  quiet: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.tertiary,
    flexShrink: 1,
  },
  reset: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.primary,
  },
  underline: {
    textDecorationLine: 'underline',
    textDecorationColor: theme.colors.border.default,
  },
  choices: {
    width: '100%',
  },
  head: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 4,
  },
  headEnd: {
    justifyContent: 'flex-end',
  },
  choiceText: {
    ...Typography.default(),
    ...rowDescription,
    color: theme.colors.text.primary,
  },
  deadline: {
    gap: 12,
    marginTop: 8,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.subtle,
  },
  review: {
    // One title line and two warning lines at the receipt's width.
    minHeight: rowDescription.lineHeight * 3 + 4,
    gap: 4,
  },
  reviewTitle: {
    ...Typography.default('semiBold'),
    ...rowDescription,
    color: theme.colors.text.primary,
  },
  deadlineNote: {
    marginTop: 6,
  },
  interrupts: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
  },
  interruptsText: {
    ...Typography.default(),
    ...rowDescription,
    color: theme.colors.text.secondary,
    flex: 1,
    minWidth: 0,
  },
  deadlineActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
  },
  wake: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 8,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.subtle,
  },
  wakeText: {
    flex: 1,
    minWidth: 0,
  },
}));
