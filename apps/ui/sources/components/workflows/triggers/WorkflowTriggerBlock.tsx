import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HappierPressable,
  parseHappierLocalDateTime,
  useHappierFieldValueDraft,
} from '@happier-dev/plugin-ui/presentation';

import { LocalDateTimeEditor } from '@/components/ui/dateTime/LocalDateTimeEditor';
import { FIELD_BOX_METRICS, resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Switch } from '@/components/ui/forms/Switch';
import {
  ValueFieldSelect,
  type ValueFieldSelectItem,
} from '@/components/ui/forms/ValueFieldSelect';
import { renderDropdownItemTriggerRightElement } from '@/components/ui/forms/dropdown/renderDropdownItemTriggerRightElement';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useSessionListRuntimeDeadlineNowMs } from '@/hooks/session/sessionListRuntimeClock';
import {
  WorkflowBlockActionsMenu,
  type WorkflowBlockAction,
} from '@/components/workflows/editor/WorkflowBlockActionsMenu';
import { WorkflowFieldPair } from '@/components/workflows/editor/WorkflowStepDataEditor';
import { workflowEditorStyles } from '@/components/workflows/editor/workflowEditorStyles';
import { useWorkflowExistingSessionOptions } from '@/components/workflows/screens/useWorkflowExistingSessionOptions';
import {
  resolveWorkflowSessionChoice,
  WORKFLOW_SESSION_RETRY_ITEM_ID,
  workflowSessionMenuState,
} from '@/components/workflows/presentation/workflowSessionChoice';
import { workflowSessionOptionRow } from '@/components/workflows/presentation/workflowSessionOptionRow';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { useWorkflowActionCatalog } from '@/components/workflows/presentation/useWorkflowActionCatalog';
import { ActionSubjectSelect, formatActionOperand, isActionOperandSubject, readSubjectOperand } from './ActionSubjectSelect';
import { t } from '@/text';

import {
  formatNextScheduledRunTime,
  formatTriggerInterval,
  formatTriggerSummary,
  readActionTriggerSummaryFacts,
  readNextScheduledRunRefreshAtMs,
  weekdayName,
} from './formatTriggerSummary';
import {
  buildTriggerDefinition,
  type TriggerWhenValue,
} from './sessionTriggerForm';
import { REPEAT_LABEL_KEYS, useStoredSessionItem } from './TriggerPopover';
import { TriggerPluginEventRows } from './TriggerPluginEventRows';
import {
  formatScheduleTimeInput,
  resolveOnceSchedule,
  SIMPLE_SCHEDULE_REPEATS,
} from './triggerSchedule';
import { useProposedScheduleOccurrence } from './useProposedScheduleOccurrence';
import { useTriggerScheduleCommands } from './useTriggerScheduleCommands';
import {
  readWorkflowTriggerStartId,
  type WorkflowTriggerStartOption,
} from './workflowTriggerStarts';

const styles = StyleSheet.create((theme) => ({
  block: { gap: theme.space.s4, paddingVertical: theme.space.s12 },
  // A wrapped sentence keeps its glyph and actions on its first line (the row owner's `contentAlign="start"`
  // rule): each takes the title's line height as its box and centres in it.
  firstLine: { height: Typography.variant('label', 'semiBold').lineHeight, justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s8,
    minWidth: 0,
  },
  title: {
    ...Typography.variant('label', 'semiBold'),
    color: theme.colors.text.primary,
    flexShrink: 1,
    flexGrow: 1,
  },
  actions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4, minHeight: Typography.variant('label', 'semiBold').lineHeight },
  valueLine: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: theme.space.s8,
    rowGap: theme.space.s4,
  },
  value: { ...Typography.variant('label'), color: theme.colors.text.primary },
  note: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
    flexShrink: 1,
  },
  // The field hugs its value, so its menu hangs from the field's own edge rather than the track's.
  selectBox: { flexGrow: 0, flexShrink: 1, minWidth: 0, alignSelf: 'flex-start', maxWidth: '100%' },
}));

type SessionEventKind = Extract<
  TriggerWhenValue['kind'],
  'turnEnds' | 'needsYou' | 'sessionArchived' | 'sessionStarts'
>;
type SessionEventWhen = Extract<
  TriggerWhenValue,
  Readonly<{ kind: SessionEventKind }>
>;
type ScheduleWhen = Extract<TriggerWhenValue, Readonly<{ kind: 'schedule' }>>;
export type ActionWhen = Extract<TriggerWhenValue, Readonly<{ kind: 'action' }>>;

/** One label/value row on the card's label track (the step cards' `WorkflowFieldPair`). */
export function TrackRow(
  props: Readonly<{
    label: string;
    trackKey: string;
    children: React.ReactNode;
  }>,
) {
  return (
    <View style={workflowEditorStyles.actionFieldRow}>
      <WorkflowFieldPair label={props.label} trackKey={props.trackKey}>
        {props.children}
      </WorkflowFieldPair>
    </View>
  );
}

/**
 * One trigger in the "When it runs" card (lab round 1116 `trig-card-*`): its sentence with its glyph,
 * its on/off switch and "…" (History, Remove); then **When** — the bordered select naming what starts
 * it — and only the rows that start needs, on the card's label track. Edits go straight to the
 * editor's draft; Save writes them.
 */
export function WorkflowTriggerBlock(
  props: Readonly<{
    testID: string;
    /** The trigger's sentence (the summary owner's), or the chosen start's name while it is not set up. */
    title: string;
    when: TriggerWhenValue | null;
    enabled: boolean;
    /** The When is not complete yet, so Save does not include it. */
    incomplete: boolean;
    /** Every start the When select offers (Time, Sessions, the Machine's plugin Events). */
    startOptions: readonly WorkflowTriggerStartOption[];
    /** The When select opened or closed: the plugin Event catalog is read while it is open. */
    onStartsOpenChange?: (open: boolean) => void;
    onSelectStart: (id: string) => void;
    onChangeWhen: (next: TriggerWhenValue) => void;
    onRemove: () => void;
    /** Absent while the trigger is not set up: there is nothing to turn on or off yet. */
    onToggleEnabled?: () => void;
    onToggleHistory?: () => void;
    history?: React.ReactNode;
    /** A saved, unedited schedule's next occurrence, as its owner computed it. */
    savedNextRunAt?: number | null;
    machineId: string | null;
    serverId: string | null;
    accountLifetime?: ServerAccountScopeLifetime | null;
    eventEdit?: Readonly<{ automationId: string; triggerId: string }>;
    initialEventSeed?: React.ComponentProps<typeof TriggerPluginEventRows>['initialEventSeed'];
    onEditSeedApplied?: React.ComponentProps<
      typeof TriggerPluginEventRows
    >['onEditSeedApplied'];
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  const { when } = props;
  const startId = when === null ? null : readWorkflowTriggerStartId(when);
  const selected =
    props.startOptions.find((option) => option.id === startId) ?? null;
  const glyph =
    selected?.glyph ??
    (when?.kind === 'prComment' ? 'git-pull-request' : 'lightning');
  const actions: WorkflowBlockAction[] = [
    ...(props.onToggleHistory
      ? [
          {
            id: 'history' as const,
            label: t('workflows.destination.history.title'),
            testID: `${props.testID}-history`,
            onSelect: props.onToggleHistory,
          },
        ]
      : []),
    {
      id: 'remove',
      label: t('workflows.triggers.card.remove'),
      destructive: true,
      onSelect: props.onRemove,
    },
  ];
  const items = React.useMemo<ValueFieldSelectItem[]>(
    () =>
      props.startOptions.map((option) => ({
        id: option.id,
        title: option.title,
        category: option.group,
        icon: (
          <Icon
            name={option.glyph}
            size={ICON_SIZE.xs}
            color={theme.colors.text.secondary}
          />
        ),
      })),
    [props.startOptions, theme.colors.text.secondary],
  );
  return (
    <View testID={props.testID} style={styles.block}>
      <View style={styles.header}>
        <View style={styles.firstLine}><Icon
          name={glyph}
          size={ICON_SIZE.xs}
          color={theme.colors.text.secondary}
        /></View>
        <Text testID={`${props.testID}-title`} style={styles.title}>
          {props.title}
        </Text>
        <View style={styles.actions}>
          <Switch
            testID={`${props.testID}-toggle`}
            value={props.enabled && !props.incomplete}
            disabled={props.onToggleEnabled === undefined}
            onValueChange={() => props.onToggleEnabled?.()}
            accessibilityLabel={props.title}
          />
          <WorkflowBlockActionsMenu
            blockLabel={props.title}
            actions={actions}
            testID={`${props.testID}-more`}
          />
        </View>
      </View>
      <TrackRow
        label={t('workflows.triggers.card.when')}
        trackKey={`${props.testID}-when`}
      >
        {startId === null ? (
          // Created from the run it follows, or from the Session whose pull request it watches; here
          // it is listed, turned off or removed.
          <Text testID={`${props.testID}-starts`} style={styles.value}>
            {when === null ? '' : formatListedWhen(when)}
          </Text>
        ) : (
          <View style={styles.selectBox}>
            <ValueFieldSelect
              testID={`${props.testID}-starts`}
              label={t('workflows.triggers.card.when')}
              items={items}
              selectedId={startId}
              onSelect={props.onSelectStart}
              searchPlaceholder={t('workflows.triggers.card.searchTriggers')}
              {...(props.onStartsOpenChange
                ? { onOpenChange: props.onStartsOpenChange }
                : {})}
            />
          </View>
        )}
      </TrackRow>
      {when?.kind === 'schedule' ? (
        <ScheduleTrackRows
          testID={props.testID}
          when={when}
          onChange={props.onChangeWhen}
          savedNextRunAt={props.savedNextRunAt}
          accountLifetime={props.accountLifetime}
        />
      ) : null}
      {when?.kind === 'pluginEvent' ? (
        <TriggerPluginEventRows
          testID={props.testID}
          when={when}
          onChange={props.onChangeWhen}
          machineId={props.machineId}
          serverId={props.serverId}
          eventEdit={props.eventEdit}
          initialEventSeed={props.initialEventSeed}
          onEditSeedApplied={props.onEditSeedApplied}
          renderEntry={(entry) => (
            <TrackRow
              label={t('workflows.triggers.card.source')}
              trackKey={`${props.testID}-source`}
            >
              <FieldButton
                testID={`${props.testID}-configure-event`}
                label={t('workflows.triggers.card.source')}
                value={entry.detail ?? t('workflows.triggers.card.setUp')}
                onPress={entry.onPress}
              />
            </TrackRow>
          )}
        />
      ) : null}
      {when?.kind === 'action' ? (
        <ActionTrackRows
          testID={props.testID}
          when={when}
          machineId={props.machineId}
          serverId={props.serverId}
          onChange={props.onChangeWhen}
        />
      ) : null}
      {when !== null &&
      (when.kind === 'turnEnds' ||
        when.kind === 'needsYou' ||
        when.kind === 'sessionArchived' ||
        when.kind === 'sessionStarts') ? (
        <SessionEventTrackRows
          testID={props.testID}
          when={when}
          serverId={props.serverId}
          onChange={props.onChangeWhen}
        />
      ) : null}
      {props.incomplete ? (
        <Text testID={`${props.testID}-incomplete`} style={styles.note}>
          {t('workflows.triggers.card.incomplete')}
        </Text>
      ) : null}
      {props.history ?? null}
    </View>
  );
}

/**
 * Before or after an Action (lab `actrig:v:before|notify|override|after`): **Action** from the catalog
 * owner's before/after choices; before adds **While it runs** (Wait for its result · Just notify) and,
 * while it waits, **If it fails** (Refuse · Let a person approve), each with the one line that says what
 * it does. After carries no wait policy (P02).
 */
function ActionTrackRows(
  props: Readonly<{
    testID: string;
    when: ActionWhen;
    machineId: string | null;
    serverId: string | null;
    onChange: (next: TriggerWhenValue) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const { when } = props;
  const catalog = useWorkflowActionCatalog(
    { kind: 'machine', machineId: props.machineId, serverId: props.serverId },
    when.phase,
  );
  const selectedId = when.actionIds.length === 1 ? (when.actionIds[0] ?? null) : null;
  // A saved subject of another matching kind (a resource's Link) reads as its own kind rather than as Any.
  const declared = catalog.specs.find((spec) => spec.id === selectedId)?.operand;
  const operand = when.subject !== undefined && !isActionOperandSubject(declared, when.subject)
    ? readSubjectOperand(when.subject) : declared;
  const items = React.useMemo<ValueFieldSelectItem[]>(() => {
    const offered = catalog.specs.map((spec) => ({
      id: spec.id,
      title: spec.title,
      ...(spec.plugin ? { category: spec.plugin.title } : {}),
      icon: (
        <Icon
          name={spec.icon ?? 'lightning'}
          size={ICON_SIZE.xs}
          color={theme.colors.text.secondary}
        />
      ),
    }));
    // A saved Action this catalog no longer offers stays choosable as it is.
    if (selectedId === null || offered.some((item) => item.id === selectedId)) return offered;
    const title = readActionTriggerSummaryFacts({ phase: when.phase, actionIds: [selectedId] }).actions[0]?.title ?? selectedId;
    return [{ id: selectedId, title }, ...offered];
  }, [catalog.specs, selectedId, theme.colors.text.secondary, when.phase]);
  return (
    <>
      <TrackRow
        label={t('workflows.triggers.card.action')}
        trackKey={`${props.testID}-action`}
      >
        <View style={styles.selectBox}>
          <ValueFieldSelect
            testID={`${props.testID}-action`}
            label={t('workflows.triggers.card.action')}
            items={items}
            selectedId={selectedId}
            placeholder={t('workflows.triggers.card.chooseAction')}
            searchPlaceholder={t('workflows.page.blocks.actionSearch')}
            emptyLabel={catalog.phase === 'ready' ? t('workflows.triggers.card.noActions')
              : catalog.phase === 'error' ? t('common.requestFailed')
              : catalog.phase === 'loading' ? t('workflows.triggers.card.actionsLoading')
              : t('common.unavailable')}
            onSelect={(id) => {
              // A chosen resource stays only while the new Action is about the same kind.
              const { subject, ...rest } = when;
              const next = catalog.specs.find((spec) => spec.id === id)?.operand;
              props.onChange(subject !== undefined && isActionOperandSubject(next, subject)
                ? { ...rest, actionIds: [id], subject } : { ...rest, actionIds: [id] });
            }}
          />
        </View>
      </TrackRow>
      {operand === undefined ? null : (
        <TrackRow
          label={formatActionOperand(operand).label}
          trackKey={`${props.testID}-subject`}
        >
          <View style={styles.selectBox}>
            <ActionSubjectSelect
              testID={`${props.testID}-subject`}
              operand={operand}
              subject={when.subject}
              machineId={props.machineId}
              serverId={props.serverId}
              onChange={(subject) => {
                const { subject: _previous, ...rest } = when;
                props.onChange(subject === undefined ? rest : { ...rest, subject });
              }}
            />
          </View>
        </TrackRow>
      )}
      <ActionWaitPolicyRows testID={props.testID} when={when} onChange={props.onChange} />
    </>
  );
}

/**
 * A before trigger's wait policy, said the same wherever a before trigger is authored (the editor's trigger
 * card, a resource's Link): **While it runs** (Wait for its result · Just notify) and, while it waits,
 * **If it fails** (Refuse · Let a person approve), each with the line that says what it does. After has none.
 */
export function ActionWaitPolicyRows(
  props: Readonly<{
    testID: string;
    when: ActionWhen;
    onChange: (next: ActionWhen) => void;
  }>,
) {
  const { when } = props;
  const waits = when.phase === 'before' && when.mode !== 'notify';
  const asks = when.onFailure === 'ask';
  return (
    <>
      {when.phase === 'before' ? (
        <TrackRow
          label={t('workflows.triggers.card.whileItRuns')}
          trackKey={`${props.testID}-mode`}
        >
          <SegmentedTabBar<'wait' | 'notify'>
            tabs={[
              { id: 'wait', label: t('workflows.triggers.card.modeWait') },
              { id: 'notify', label: t('workflows.triggers.card.modeNotify') },
            ]}
            activeTabId={waits ? 'wait' : 'notify'}
            onSelectTab={(mode) => {
              // Only a wait check has a failure decision (P02 schema).
              const { onFailure: _dropped, ...rest } = when;
              props.onChange({ ...rest, mode });
            }}
            segmentSizing="content"
            role="radiogroup"
            accessibilityLabel={t('workflows.triggers.card.whileItRuns')}
            testIDPrefix={`${props.testID}-mode`}
          />
          {/* The consequence sits under its choice, as the editor's "Runs in" does. */}
          <Text style={styles.note}>
            {t(waits ? 'workflows.triggers.card.waitNote' : 'workflows.triggers.card.notifyNote')}
          </Text>
        </TrackRow>
      ) : null}
      {waits ? (
        <TrackRow
          label={t('workflows.triggers.card.ifItFails')}
          trackKey={`${props.testID}-on-failure`}
        >
          <SegmentedTabBar<'refuse' | 'ask'>
            tabs={[
              { id: 'refuse', label: t('workflows.triggers.card.failRefuse') },
              { id: 'ask', label: t('workflows.triggers.card.failAsk') },
            ]}
            activeTabId={asks ? 'ask' : 'refuse'}
            onSelectTab={(onFailure) => props.onChange({ ...when, onFailure })}
            segmentSizing="content"
            role="radiogroup"
            accessibilityLabel={t('workflows.triggers.card.ifItFails')}
            testIDPrefix={`${props.testID}-on-failure`}
          />
          <Text style={styles.note}>
            {t(asks ? 'workflows.triggers.card.askNote' : 'workflows.triggers.card.refuseNote')}
          </Text>
        </TrackRow>
      ) : null}
    </>
  );
}

function formatListedWhen(when: TriggerWhenValue): string {
  if (when.kind === 'runLifecycle' || when.kind === 'action') return formatTriggerSummary(when);
  if (when.kind === 'prComment' || when.kind === 'ciFailed') {
    return formatTriggerSummary({
      kind: when.kind,
      ...(when.pullRequest ? { pullRequest: when.pullRequest } : {}),
    });
  }
  return '';
}

/** A value that opens its own editor, drawn as the bordered field the selects use. */
function FieldButton(
  props: Readonly<{
    testID: string;
    label: string;
    value: string;
    onPress: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  return (
    <HappierPressable
      testID={props.testID}
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel={`${props.label}: ${props.value}`}
      style={styles.selectBox}
    >
      {renderDropdownItemTriggerRightElement({
        detail: props.value,
        open: false,
        detailColor: theme.colors.text.secondary,
        chevronColor: theme.colors.text.secondary,
        field: resolveFieldBoxColors(theme),
        fieldSpan: 'content',
      })}
    </HappierPressable>
  );
}

/** Repeats and At (lab `trig-card-schedule`), through the schedule commands the trigger popover uses. */
function ScheduleTrackRows(
  props: Readonly<{
    testID: string;
    when: ScheduleWhen;
    onChange: (next: TriggerWhenValue) => void;
    savedNextRunAt?: number | null;
    accountLifetime?: ServerAccountScopeLifetime | null;
  }>,
) {
  const { when } = props;
  const schedule = when.schedule;
  const commands = useTriggerScheduleCommands(props);
  const repeatValue = when.once
    ? 'once'
    : (schedule?.repeat ??
      (when.everyMs === undefined ? 'custom' : 'interval'));
  const repeatTabs = [
    { id: 'once', label: t('workflows.triggers.once.label') },
    ...SIMPLE_SCHEDULE_REPEATS.map((repeat) => ({
      id: repeat,
      label: t(`workflows.triggers.popover.${REPEAT_LABEL_KEYS[repeat]}`),
    })),
  ];
  // A saved repeat a person doesn't pick here (an interval, every hour, an expression) leads a select of the picked ones.
  const unpicked =
    when.everyMs !== undefined ||
    repeatValue === 'custom' ||
    repeatValue === 'hourly';
  const trigger = buildTriggerDefinition({
    when,
    enabled: true,
    sessionId: null,
  });
  const proposed = useProposedScheduleOccurrence(
    props.savedNextRunAt === undefined && trigger?.kind === 'schedule'
      ? trigger.schedule
      : null,
    props.accountLifetime,
  );
  const nextRunAt =
    props.savedNextRunAt !== undefined
      ? props.savedNextRunAt
      : proposed?.status === 'ready'
        ? proposed.nextRunAt
        : null;
  const readNextRefresh = React.useCallback(
    (nowMs: number) => readNextScheduledRunRefreshAtMs(nextRunAt, nowMs),
    [nextRunAt],
  );
  const nowMs = useSessionListRuntimeDeadlineNowMs(
    readNextRefresh,
    nextRunAt !== null,
  );
  const next =
    nextRunAt !== null
      ? t('workflows.triggers.popover.nextOccurrence', {
          time: formatNextScheduledRunTime(nextRunAt, true, nowMs),
        })
      : proposed?.status === 'invalid_schedule'
        ? t('workflows.triggers.popover.invalidSchedule')
        : null;
  const note = [when.timezone, next]
    .filter(
      (part): part is string => typeof part === 'string' && part.length > 0,
    )
    .join(' · ');
  return (
    <>
      <TrackRow
        label={t('workflows.triggers.popover.repeat')}
        trackKey={`${props.testID}-repeat`}
      >
        {unpicked ? (
          <View style={styles.selectBox}>
            <ValueFieldSelect
              testID={`${props.testID}-repeat`}
              label={t('workflows.triggers.popover.repeat')}
              items={[
                {
                  id: repeatValue,
                  title:
                    when.everyMs !== undefined
                      ? formatTriggerInterval(when.everyMs)
                      : repeatValue === 'hourly'
                        ? t('workflows.triggers.popover.everyHour')
                        : t('workflows.triggers.popover.expression'),
                },
                ...repeatTabs.map((tab) => ({ id: tab.id, title: tab.label })),
              ]}
              selectedId={repeatValue}
              onSelect={commands.changeRepeat}
            />
          </View>
        ) : (
          <SegmentedTabBar<string>
            tabs={repeatTabs}
            activeTabId={repeatValue}
            onSelectTab={commands.changeRepeat}
            segmentSizing="content"
            role="radiogroup"
            accessibilityLabel={t('workflows.triggers.popover.repeat')}
            testIDPrefix={`${props.testID}-repeat`}
          />
        )}
      </TrackRow>
      {schedule?.repeat === 'weekly' ? (
        <TrackRow
          label={t('workflows.triggers.popover.day')}
          trackKey={`${props.testID}-day`}
        >
          <View style={styles.selectBox}>
            <ValueFieldSelect
              testID={`${props.testID}-day`}
              label={t('workflows.triggers.popover.day')}
              items={[1, 2, 3, 4, 5, 6, 0].map((day) => ({
                id: String(day),
                title: weekdayName(day),
              }))}
              selectedId={String(schedule.day)}
              onSelect={(id) =>
                props.onChange({
                  ...when,
                  schedule: { ...schedule, day: Number(id) },
                })
              }
            />
          </View>
        </TrackRow>
      ) : null}
      {when.once !== undefined ? (
        <>
          <TrackRow
            label={t('workflows.triggers.popover.at')}
            trackKey={`${props.testID}-at`}
          >
            <LocalDateTimeEditor
              nowMs={
                when.once.scheduledAt === undefined
                  ? Date.now()
                  : (parseHappierLocalDateTime(when.once) ??
                      when.once.scheduledAt) - 1
              }
              value={when.once}
              onChange={commands.changeOnceDateTime}
              testIDPrefix={`${props.testID}-once`}
              labels={{
                date: t('sessionsList.reminders.dateLabel'),
                time: t('sessionsList.reminders.timeLabel'),
                pastInstant: t('sessionsList.reminders.futureTimeRequired'),
              }}
            />
          </TrackRow>
          <TrackRow
            label={t('workflows.triggers.once.relative')}
            trackKey={`${props.testID}-relative`}
          >
            <TrackTextField
              testID={`${props.testID}-relative`}
              label={t('workflows.triggers.once.relative')}
              value={when.once.relative}
              onCommit={commands.commitRelative}
              error={
                when.once.relative.trim() &&
                resolveOnceSchedule(when.once) === null
                  ? t('workflows.triggers.once.relativeInvalid')
                  : null
              }
            />
          </TrackRow>
        </>
      ) : schedule === null ? (
        when.everyMs === undefined ? (
          <TrackRow
            label={t('workflows.triggers.popover.expression')}
            trackKey={`${props.testID}-expression`}
          >
            <TrackTextField
              testID={`${props.testID}-expression`}
              label={t('workflows.triggers.popover.expression')}
              value={when.expression}
              monospace
              onCommit={commands.commitExpression}
            />
          </TrackRow>
        ) : null
      ) : (
        <TrackRow
          label={t('workflows.triggers.popover.at')}
          trackKey={`${props.testID}-at`}
        >
          <View style={styles.valueLine}>
            <TrackTextField
              testID={`${props.testID}-at`}
              label={t('workflows.triggers.popover.at')}
              value={formatScheduleTimeInput(schedule)}
              clock
              onCommit={commands.commitTime}
            />
            {note.length > 0 ? <Text style={styles.note}>{note}</Text> : null}
          </View>
        </TrackRow>
      )}
    </>
  );
}

/** A text value committed on blur or Return (the shared field draft owner), with no row of its own. */
function TrackTextField(
  props: Readonly<{
    testID: string;
    label: string;
    value: string;
    onCommit: (value: string) => string | void;
    monospace?: boolean;
    clock?: boolean;
    error?: string | null;
  }>,
) {
  const field = useHappierFieldValueDraft({
    value: props.value,
    onCommit: props.onCommit,
    kind: 'text',
  });
  return (
    <FieldTextInput
      testID={props.testID}
      value={field.draft}
      onChangeText={field.change}
      accessibilityLabel={props.label}
      autoCapitalize="none"
      monospace={props.monospace}
      error={props.error ?? undefined}
      onBlur={field.commit}
      onSubmitEditing={field.commit}
      onKeyPress={(event) => {
        if (event.nativeEvent.key === 'Escape') field.cancel();
      }}
      style={props.clock ? CLOCK_FIELD_STYLE : undefined}
    />
  );
}

/** The trigger popover's clock field width (the field box owner's trigger minimum). */
const CLOCK_FIELD_STYLE = { minWidth: 0, width: FIELD_BOX_METRICS.triggerMinWidthPx } as const;

/**
 * A session event: which of your sessions, and how often (lab `trig-card-session`). The workflow
 * itself runs where the editor's Where says, in its own session.
 */
function SessionEventTrackRows(
  props: Readonly<{
    testID: string;
    when: SessionEventWhen;
    serverId: string | null;
    onChange: (next: TriggerWhenValue) => void;
  }>,
) {
  const { when } = props;
  const sourceSessionId = when.sourceSessionId;
  const [open, setOpen] = React.useState(false);
  // The editor's Home, or the active one when the host names none (as "A session…" reads it).
  const activeServerId = useActiveServerAccountScope()?.serverId ?? null;
  const serverId = props.serverId ?? activeServerId;
  // Any of your sessions, on any machine; read only while the chooser is open.
  const { existingSessions, sessionOptionsStatus, retrySessionOptions } =
    useWorkflowExistingSessionOptions({
      serverId,
      machineId: null,
      enabled: open,
      // A lifecycle source is only listened to: any visible Session, whatever its Agent.
      purpose: 'listen',
    });
  const choice = resolveWorkflowSessionChoice(
    sessionOptionsStatus,
    existingSessions.length > 0,
  );
  const menu = workflowSessionMenuState(
    choice,
    t('workflows.triggers.card.noSession'),
  );
  const stored = useStoredSessionItem({
    sessionId: sourceSessionId ?? '',
    serverId,
    offered: existingSessions.some(
      (option) => option.sessionId === sourceSessionId,
    ),
    settled: open && sessionOptionsStatus === 'ready',
  });
  const items: ValueFieldSelectItem[] = [
    ...menu.leadingItems.map((item) => ({
      id: item.id,
      title: item.title,
      ...(item.subtitle ? { subtitle: item.subtitle } : {}),
    })),
    ...(stored === null
      ? []
      : [
          {
            id: stored.id,
            title: stored.title,
            ...(stored.subtitle ? { subtitle: stored.subtitle } : {}),
            ...(stored.disabled ? { disabled: true } : {}),
          },
        ]),
    ...existingSessions.map((option) => {
      const row = workflowSessionOptionRow(option);
      return {
        id: option.sessionId,
        title: option.label,
        icon: row.icon,
        ...(row.subtitle ? { subtitle: row.subtitle } : {}),
      };
    }),
  ];
  // "This turn" exists only for a trigger bound to a turn; the others are the policy the Session's events follow.
  const howOften =
    when.kind === 'turnEnds' && when.sourceTurnId !== undefined
      ? 'thisTurn'
      : when.nextTimeOnly
        ? 'nextTime'
        : 'everyTime';
  const howOftenTabs = [
    ...(howOften === 'thisTurn'
      ? [
          {
            id: 'thisTurn' as const,
            label: t('workflows.triggers.card.howOftenKind.thisTurn'),
          },
        ]
      : []),
    {
      id: 'nextTime' as const,
      label: t('workflows.triggers.card.howOftenKind.nextTime'),
    },
    {
      id: 'everyTime' as const,
      label: t('workflows.triggers.card.howOftenKind.everyTime'),
    },
  ];
  const withSource = (sessionId: string | undefined): SessionEventWhen => {
    if (when.kind === 'turnEnds' && when.sourceTurnId !== undefined && sessionId !== sourceSessionId) {
      const { sourceSessionId: _previous, sourceTurnId: _turn, ...rest } = when;
      return { ...rest, ...(sessionId === undefined ? {} : { sourceSessionId: sessionId }), nextTimeOnly: true };
    }
    const { sourceSessionId: _previous, ...rest } = when;
    return (
      sessionId === undefined ? rest : { ...rest, sourceSessionId: sessionId }
    ) as SessionEventWhen;
  };
  return (
    <>
      <TrackRow
        label={t('workflows.triggers.card.session')}
        trackKey={`${props.testID}-session`}
      >
        <View style={styles.selectBox}>
          <ValueFieldSelect
            testID={`${props.testID}-session`}
            label={t('workflows.triggers.card.session')}
            items={items}
            selectedId={sourceSessionId ?? null}
            placeholder={t('common.choose')}
            onOpenChange={setOpen}
            {...(menu.emptyLabel === undefined
              ? {}
              : { emptyLabel: menu.emptyLabel })}
            keepsOpen={(id) => id === WORKFLOW_SESSION_RETRY_ITEM_ID}
            invalid={stored?.disabled === true}
            onSelect={(sessionId) => {
              if (sessionId === WORKFLOW_SESSION_RETRY_ITEM_ID) {
                retrySessionOptions();
                return;
              }
              if (
                existingSessions.some(
                  (option) => option.sessionId === sessionId,
                )
              )
                props.onChange(withSource(sessionId));
            }}
          />
        </View>
      </TrackRow>
      <TrackRow
        label={t('workflows.triggers.card.howOften')}
        trackKey={`${props.testID}-how-often`}
      >
        <SegmentedTabBar
          tabs={howOftenTabs}
          activeTabId={howOften}
          onSelectTab={(next) => {
            if (next === howOften || next === 'thisTurn') return;
            const { nextTimeOnly: _nextTimeOnly, ...rest } = when;
            const unbound = (
              rest.kind === 'turnEnds'
                ? (({ sourceTurnId: _turn, ...withoutTurn }) => withoutTurn)(
                    rest,
                  )
                : rest
            ) as SessionEventWhen;
            props.onChange(
              next === 'nextTime'
                ? ({ ...unbound, nextTimeOnly: true } as SessionEventWhen)
                : unbound,
            );
          }}
          segmentSizing="content"
          role="radiogroup"
          accessibilityLabel={t('workflows.triggers.card.howOften')}
          testIDPrefix={`${props.testID}-how-often`}
        />
      </TrackRow>
    </>
  );
}
