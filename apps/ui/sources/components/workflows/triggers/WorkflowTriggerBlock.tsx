import * as React from 'react';
import { View } from 'react-native';
import {
  AUTOMATION_SESSION_LIFECYCLE_SUBJECT_KINDS_V1,
  type AutomationSessionLifecycleSubjectV1,
} from '@happier-dev/protocol/automations/automationSessionLifecycle';
import { AutomationActionOutcomeV1Schema } from '@happier-dev/protocol/automations/automationActionIdentityV1';
import { automationSubjectKeyV1 } from '@happier-dev/protocol/automations/automationSubjectV1';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  joinHappierFacts,
  HappierFieldBoxTrigger,
  HappierPressable,
  resolveHappierFieldBoxLabel,
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
import { readServerAccountScopeOwnerLifetime, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { retryServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useAutomationSubjectPicker } from '@/sync/domains/workflows/useAutomationSubjectPicker';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { resolvePortableServerIdentityForRoutingId } from '@/sync/domains/server/resolvePortableServerIdentityForRoutingId';
import { useWorkflowActionCatalog } from '@/components/workflows/presentation/useWorkflowActionCatalog';
import { ActionSubjectSelect, formatActionOperand, isActionOperandSubject, readSubjectOperand } from './ActionSubjectSelect';
import { t } from '@/text';
import { SessionLifecycleFilterFields } from './SessionLifecycleFilterFields';

import {
  DEPLOY_OUTCOME_FIELD,
  readDeployOutcomeSelection,
  formatNextScheduledRunTime,
  formatSessionLifecycleScope,
  formatTriggerInterval,
  formatTriggerSummary,
  readActionTriggerSummaryFacts,
  readNextScheduledRunRefreshAtMs,
  weekdayName,
} from './formatTriggerSummary';
import { presentScheduleHold, type ScheduleHold } from './scheduleHoldPresentation';
import {
  buildTriggerDefinition,
  isSessionLifecycleWhen,
  type SessionLifecycleWhen,
  type TriggerWhenValue,
} from './sessionTriggerForm';
import { REPEAT_LABEL_KEYS, useStoredSessionItem } from './TriggerPopover';
import { TriggerEventStepContext, TriggerPluginEventRows, type TriggerEventStep } from './TriggerPluginEventRows';
import { useSessionPullRequestChoices } from './SessionTriggerPullRequestPicker';
import {
  formatScheduleTimeInput,
  readOnceDateTimeBound,
  resolveOnceSchedule,
  SIMPLE_SCHEDULE_REPEATS,
  type SpentOnceSchedulePresentation,
} from './triggerSchedule';
import { useProposedScheduleOccurrence } from './useProposedScheduleOccurrence';
import { useTriggerScheduleCommands } from './useTriggerScheduleCommands';
import {
  isDeployFinishedTrigger,
  readWorkflowTriggerStartId,
  type WorkflowTriggerStartOption,
  type WorkflowTriggerStartContext,
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
  fieldButton: { justifyContent: 'center' },
  // The composer Source field's value (one field, one look in both steps).
  fieldButtonValue: { ...Typography.variant('label'), flexGrow: 1, flexShrink: 1, minWidth: 0, color: theme.colors.text.primary },
}));

type SessionEventWhen = SessionLifecycleWhen;
type ScheduleWhen = Extract<TriggerWhenValue, Readonly<{ kind: 'schedule' }>>;
export type ActionWhen = Extract<TriggerWhenValue, Readonly<{ kind: 'action' }>>;

/** One label/value row on the card's label track (the step cards' `WorkflowFieldPair`). */
export function TrackRow(
  props: Readonly<{
    label: string;
    trackKey: string;
    /** `control`: the value grows beneath its first line (filter clauses), so the label stays level with that line. */
    labelAlign?: 'center' | 'control';
    children: React.ReactNode;
  }>,
) {
  return (
    <View style={workflowEditorStyles.actionFieldRow}>
      <WorkflowFieldPair label={props.label} trackKey={props.trackKey} labelAlign={props.labelAlign}>
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
    /** Why that saved occurrence waits for an earlier run, from the same trigger set read. */
    savedScheduleHold?: ScheduleHold;
    /**
     * A saved, unedited one-time schedule that already ran (`presentSpentOnceSchedule`): it reads as finished, offers no
     * on/off switch (the server keeps it enabled, so a switch would read as armed), and picking a new time runs it again.
     */
    spentOnce?: SpentOnceSchedulePresentation | null;
    /** A saved before-trigger the Home scoped to its author's own Actions on a subject they can only view (R22). */
    viewOnlySubject?: boolean;
    machineId: string | null;
    serverId: string | null;
    accountLifetime?: ServerAccountScopeLifetime | null;
    workspaceRefId?: string;
    /** The authored lifetime Session, independent of the watched source. */
    sessionId?: string;
    /** Borrowed by the existing PR picker and scope controls; carries no independent read or controller. */
    sessionContext?: WorkflowTriggerStartContext['session'];
    eventEdit?: Readonly<{ automationId: string; triggerId: string }>;
    initialEventSeed?: React.ComponentProps<typeof TriggerPluginEventRows>['initialEventSeed'];
    /** An exact native occurrence already owns its source. Save completes its enrollment. */
    nativeSourceName?: string;
    onEditSeedApplied?: React.ComponentProps<
      typeof TriggerPluginEventRows
    >['onEditSeedApplied'];
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  const { when } = props;
  // The Event's setup is its own step and replaces this block: in a popover that offers it (the sentence's chip), the
  // popover holds the step; otherwise (the Steps card) the block holds it and the setup stands in flow.
  const hostedStep = React.useContext(TriggerEventStepContext);
  const [stepping, setStepping] = React.useState(false);
  const eventStep: TriggerEventStep = hostedStep ?? { editing: stepping, onEditingChange: setStepping };
  const [namedSubject, setNamedSubject] = React.useState<Readonly<{ key: string; label: string }> | null>(null);
  const title = when?.kind === 'action' && isDeployFinishedTrigger(when)
    ? formatTriggerSummary(when, { subjectTitle: subject => namedSubject?.key === automationSubjectKeyV1(subject) ? namedSubject.label : undefined })
    : props.title;
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
  const eventRows = when?.kind === 'pluginEvent' && props.nativeSourceName === undefined ? (
    <TriggerPluginEventRows
      testID={props.testID}
      when={when}
      onChange={props.onChangeWhen}
      machineId={props.machineId}
      serverId={props.serverId}
      eventEdit={props.eventEdit}
      initialEventSeed={props.initialEventSeed}
      onEditSeedApplied={props.onEditSeedApplied}
      editing={eventStep.editing}
      onEditingChange={eventStep.onEditingChange}
      editorMaxHeight={eventStep.maxHeight}
      editorPresentation={hostedStep ? 'floating' : 'inFlow'}
      renderEntry={(entry) => (
        <TrackRow
          label={t('workflows.triggers.card.source')}
          trackKey={`${props.testID}-source`}
        >
          <View style={styles.selectBox}>
            <FieldButton
              testID={`${props.testID}-configure-event`}
              label={t('workflows.triggers.card.source')}
              value={entry.detail ?? t('workflows.triggers.card.setUp')}
              onPress={entry.onPress}
            />
          </View>
        </TrackRow>
      )}
    />
  ) : null;
  // The setup step stands alone: the When select above it would repeat the Event it sets up.
  if (eventStep.editing && eventRows) return hostedStep ? eventRows : <View testID={props.testID} style={styles.block}>{eventRows}</View>;
  return (
    <View testID={props.testID} style={styles.block}>
      <View style={styles.header}>
        <View style={styles.firstLine}><Icon
          name={glyph}
          size={ICON_SIZE.xs}
          color={theme.colors.text.secondary}
        /></View>
        <Text testID={`${props.testID}-title`} style={styles.title}>
          {title}
        </Text>
        <View style={styles.actions}>
          {props.spentOnce ? null : <Switch
            testID={`${props.testID}-toggle`}
            value={props.enabled && !props.incomplete}
            disabled={props.onToggleEnabled === undefined}
            onValueChange={() => props.onToggleEnabled?.()}
            accessibilityLabel={title}
          />}
          <WorkflowBlockActionsMenu
            blockLabel={title}
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
            {when?.kind === 'pluginEvent' ? title : when === null ? '' : formatListedWhen(when)}
          </Text>
        ) : (
          <View style={styles.selectBox}>
            <ValueFieldSelect
              testID={`${props.testID}-starts`}
              label={t('workflows.triggers.card.when')}
              items={items}
              selectedId={startId}
              placeholder={props.title || undefined}
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
          savedScheduleHold={props.savedScheduleHold}
          accountLifetime={props.accountLifetime}
          spentOnce={props.spentOnce ?? null}
          historyShown={props.history != null}
        />
      ) : null}
      {when?.kind === 'pluginEvent' && props.nativeSourceName !== undefined ? (
        <TrackRow label={t('workflows.triggers.card.source')} trackKey={`${props.testID}-source`}>
          <Text testID={`${props.testID}-native-source`} style={styles.value}>{props.nativeSourceName}</Text>
        </TrackRow>
      ) : eventRows}
      {when?.kind === 'action' ? (
        <ActionTrackRows
          testID={props.testID}
          when={when}
          onSubjectNamed={isDeployFinishedTrigger(when) ? setNamedSubject : undefined}
          viewOnlySubject={props.viewOnlySubject === true}
          workspaceRefId={props.workspaceRefId}
          machineId={props.machineId}
          serverId={props.serverId}
          onChange={props.onChangeWhen}
        />
      ) : null}
      {(when?.kind === 'prComment' || when?.kind === 'ciFailed') && props.sessionId !== undefined ? (
        <PullRequestTrackRow
          testID={props.testID}
          when={when}
          sessionId={props.sessionId}
          // The repository is the authored Session's, on the Home this editor is mounted for.
          serverId={props.accountLifetime === undefined ? props.serverId : props.accountLifetime?.scope.serverId ?? null}
          onChange={props.onChangeWhen}
        />
      ) : null}
      {when !== null && isSessionLifecycleWhen(when) ? (
        <SessionEventTrackRows
          testID={props.testID}
          when={when}
          serverId={props.serverId}
          accountLifetime={props.accountLifetime}
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
    onSubjectNamed?: (subject: Readonly<{ key: string; label: string }> | null) => void;
    /** The Home saved this before-trigger on a subject its author can only view: it runs on their own Actions (R22). */
    viewOnlySubject?: boolean;
    machineId: string | null;
    serverId: string | null;
    workspaceRefId?: string;
    onChange: (next: TriggerWhenValue) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const { when } = props;
  const [subjectName, setSubjectName] = React.useState<string | null>(null);
  const { onSubjectNamed } = props;
  const nameSubject = React.useCallback((subject: Readonly<{ key: string; label: string }> | null) => {
    setSubjectName(subject?.label ?? null);
    onSubjectNamed?.(subject);
  }, [onSubjectNamed]);
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
              if (id === selectedId) return;
              const { subject, filter, ...rest } = when;
              const next = catalog.specs.find((spec) => spec.id === id)?.operand;
              const predicates = isDeployFinishedTrigger(when)
                ? filter?.all.filter(clause => clause.field !== DEPLOY_OUTCOME_FIELD)
                : filter?.all;
              props.onChange({ ...rest, actionIds: [id],
                ...(subject !== undefined && isActionOperandSubject(next, subject) ? { subject } : {}),
                ...(predicates?.length ? { filter: { v: 1, all: predicates } } : {}),
              });
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
              onSubjectNamed={nameSubject}
              workspaceRefId={props.workspaceRefId}
              machineId={props.machineId}
              serverId={props.serverId}
              onChange={(subject) => {
                const { subject: _previous, ...rest } = when;
                props.onChange(subject === undefined ? rest : { ...rest, subject });
              }}
            />
          </View>
          {/* Under its control, as the policy rows' consequences are (DESIGN-ACCEPT-7). */}
          {props.viewOnlySubject && when.subject !== undefined ? (
            <Text testID={`${props.testID}-subject-reach`} style={styles.note}>
              {subjectName === null ? t('workflows.triggers.card.viewOnlyReachUnnamed')
                : t('workflows.triggers.card.viewOnlyReach', { subject: subjectName })}
            </Text>
          ) : null}
        </TrackRow>
      )}
      <ActionTriggerPolicyRows testID={props.testID} when={when} onChange={props.onChange} />
    </>
  );
}

/**
 * A before trigger's wait policy, said the same wherever a before trigger is authored (the editor's trigger
 * card, a resource's Link): **While it runs** (Wait for its result · Just notify) and, while it waits,
 * **If it fails** (Refuse · Let a person approve). Deploy completion uses the same After trigger's
 * occurrence filter; the outcome choices are the protocol's Action evidence values.
 */
export function ActionTriggerPolicyRows(
  props: Readonly<{
    testID: string;
    when: ActionWhen;
    onChange: (next: ActionWhen) => void;
  }>,
) {
  const { when } = props;
  const waits = when.phase === 'before' && when.mode !== 'notify';
  const asks = when.onFailure === 'ask';
  if (isDeployFinishedTrigger(when)) {
    const clauses = when.filter?.all ?? [];
    const outcome = readDeployOutcomeSelection(when);
    const label = t('workflows.triggers.card.deployOutcome.label');
    return (
      <TrackRow label={label} trackKey={`${props.testID}-outcome`}>
        <View style={styles.selectBox}>
          <ValueFieldSelect
            testID={`${props.testID}-outcome`}
            label={label}
            items={[
              { id: 'any', title: t('workflows.triggers.card.deployOutcome.any') },
              ...AutomationActionOutcomeV1Schema.options.map(kind => ({
                id: kind, title: t(`workflows.triggers.card.deployOutcome.${kind}`),
              })),
            ]}
            selectedId={outcome === 'custom' ? null : outcome}
            placeholder={t('workflows.triggers.card.deployOutcome.custom')}
            onSelect={id => {
              const next = clauses.filter(clause => clause.field !== DEPLOY_OUTCOME_FIELD);
              if (id !== 'any') {
                const selected = AutomationActionOutcomeV1Schema.safeParse(id);
                if (!selected.success) return;
                next.push({ field: DEPLOY_OUTCOME_FIELD, op: 'eq', value: selected.data });
              }
              const { filter: _filter, ...rest } = when;
              props.onChange(next.length === 0 ? rest : { ...rest, filter: { v: 1, all: next } });
            }}
          />
        </View>
      </TrackRow>
    );
  }
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

const PULL_REQUEST_RETRY = 'pull-request:retry';

/** Which pull request a PR comment or CI trigger watches, from the Session's repository (read while open). */
function PullRequestTrackRow(
  props: Readonly<{
    testID: string;
    when: Extract<TriggerWhenValue, { kind: 'prComment' | 'ciFailed' }>;
    sessionId: string;
    serverId: string | null;
    onChange: (next: TriggerWhenValue) => void;
  }>,
) {
  const [open, setOpen] = React.useState(false);
  const { when, onChange } = props;
  const read = useSessionPullRequestChoices({ open, sessionId: props.sessionId, serverId: props.serverId,
    selection: when.pullRequest ?? null });
  const items = React.useMemo<ValueFieldSelectItem[]>(() => [
    ...read.choices.map((choice) => ({ id: choice.id, title: choice.title, subtitle: choice.subtitle })),
    ...(read.status === 'failed' ? [{ id: PULL_REQUEST_RETRY, title: t('common.retry'),
      subtitle: t('workflows.triggers.pullRequest.loadFailed') }] : []),
  ], [read.choices, read.status]);
  const { retry, choices } = read;
  const select = React.useCallback((id: string) => {
    if (id === PULL_REQUEST_RETRY) { retry(); return; }
    const chosen = choices.find((choice) => choice.id === id)?.selection;
    if (chosen) onChange({ ...when, pullRequest: chosen });
  }, [retry, choices, onChange, when]);
  return (
    <TrackRow label={t('workflows.triggers.pullRequest.label')} trackKey={`${props.testID}-pull-request`}>
      <View style={styles.selectBox}>
        <ValueFieldSelect
          testID={`${props.testID}-pull-request`}
          label={t('workflows.triggers.pullRequest.label')}
          items={items}
          selectedId={read.selectedId}
          placeholder={t('workflows.triggers.then.choose')}
          emptyLabel={read.status === 'loading' ? t('common.loading') : t('workflows.triggers.pullRequest.empty')}
          keepsOpen={(id) => id === PULL_REQUEST_RETRY}
          onOpenChange={setOpen}
          onSelect={select}
        />
      </View>
      <Text style={styles.note}>{t('workflows.triggers.pullRequest.description')}</Text>
    </TrackRow>
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

/**
 * A value that opens its own step (an Event's setup), drawn as the composer's Source field: the bordered field with
 * a gear, never a select's chevron. It takes its host's field width as the host's selects do; `fill` spans the row.
 */
export function FieldButton(
  props: Readonly<{
    testID: string;
    label: string;
    value: string;
    onPress: () => void;
    fill?: boolean;
  }>,
) {
  const { theme } = useUnistyles();
  const colors = resolveFieldBoxColors(theme);
  return (
    <HappierPressable
      testID={props.testID}
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel={`${props.label}: ${props.value}`}
      style={styles.fieldButton}
    >
      <HappierFieldBoxTrigger colors={colors} span={props.fill ? 'row' : 'content'}
        trailing={<Icon name="gear" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />}>
        <Text numberOfLines={1} style={[resolveHappierFieldBoxLabel({ value: props.value, placeholder: props.value, colors }).style,
          styles.fieldButtonValue]}>
          {props.value}
        </Text>
      </HappierFieldBoxTrigger>
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
    savedScheduleHold?: ScheduleHold;
    accountLifetime?: ServerAccountScopeLifetime | null;
    spentOnce: SpentOnceSchedulePresentation | null;
    /** History is open beneath and heads with how it ended, so the note keeps only the way to run it again. */
    historyShown: boolean;
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
          time: formatNextScheduledRunTime(nextRunAt, true, nowMs,
            props.savedNextRunAt !== undefined ? presentScheduleHold(props.savedScheduleHold) : null),
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
              nowMs={readOnceDateTimeBound(when.once)}
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
          {/* With History open, History states the outcome and then the instruction, after it (R12 M12). */}
          {props.spentOnce && !props.historyShown ? (
            <Text testID={`${props.testID}-spent`} style={styles.note}>
              {joinHappierFacts(props.spentOnce.line, t('workflows.triggers.once.runAgain'))}
            </Text>
          ) : null}
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
    accountLifetime?: ServerAccountScopeLifetime | null;
    onChange: (next: TriggerWhenValue) => void;
  }>,
) {
  const { when } = props;
  const [browse, setBrowse] = React.useState<AutomationSessionLifecycleSubjectV1['kind'] | null>(null);
  const [chosen, setChosen] = React.useState<{ key: string; title: string } | null>(null);
  const activeServerId = useActiveServerAccountScope()?.serverId ?? null;
  const serverId = props.accountLifetime === undefined
    ? props.serverId ?? activeServerId
    : props.accountLifetime?.scope.serverId ?? null;

  const sessionRead = useWorkflowExistingSessionOptions({
    serverId, machineId: null, enabled: browse === 'session', purpose: 'listen',
  });
  const sourceSessionId = when.subject?.kind === 'session' ? when.subject.sessionId : undefined;
  const stored = useStoredSessionItem({
    sessionId: sourceSessionId ?? '',
    serverId,
    offered: sessionRead.existingSessions.some(option => option.sessionId === sourceSessionId),
    settled: browse === 'session' && sessionRead.sessionOptionsStatus === 'ready',
  });
  const sessionMenu = workflowSessionMenuState(
    resolveWorkflowSessionChoice(sessionRead.sessionOptionsStatus, sessionRead.existingSessions.length > 0),
    t('workflows.triggers.card.noSession'),
  );

  const browsingResource = browse === 'project' || browse === 'machine';
  const { binding, resolution } = useServerCredentialAccountScopeBinding(
    browsingResource && props.accountLifetime === undefined ? serverId : null,
  );
  const fallbackLifetime = React.useMemo(() => binding ? readServerAccountScopeOwnerLifetime(binding) : null, [binding]);
  const resourceLifetime = props.accountLifetime === undefined ? fallbackLifetime : props.accountLifetime;
  const resources = useAutomationSubjectPicker({
    kind: { kind: browse === 'machine' ? 'machine' : 'project' },
    lifetime: resourceLifetime,
    demanded: browsingResource,
  });
  const accountReadFailed = resolution.kind === 'unavailable';

  const any = 'any-session';
  const back = 'scope-back';
  const retry = 'scope-retry';
  const chosenKey = when.subject === undefined ? null : automationSubjectKeyV1(when.subject);
  const sessionItems = sessionRead.existingSessions.map(option => {
    const row = workflowSessionOptionRow(option);
    return { id: option.sessionId, title: option.label, icon: row.icon, subtitle: row.subtitle };
  });
  const selectedTitle = when.subject === undefined
    ? formatSessionLifecycleScope(undefined).title
    : chosen?.key === chosenKey ? chosen.title
      : sessionItems.find(item => item.id === sourceSessionId)?.title
        ?? stored?.title ?? formatSessionLifecycleScope(when.subject).title;
  const selectedId = browse === null
    ? when.subject ? `scope-${when.subject.kind}` : any
    : sourceSessionId ?? chosenKey;
  const scopeMarks = {
    session: 'chat-circle-dots', project: 'folder', machine: 'laptop', any: 'users',
  } as const satisfies Record<AutomationSessionLifecycleSubjectV1['kind'] | 'any', React.ComponentProps<typeof Icon>['name']>;
  const scopeItem = (kind: keyof typeof scopeMarks, id: string): ValueFieldSelectItem => ({
    id,
    title: t(`workflows.triggers.card.sessionScope.${kind}.title`),
    subtitle: t(`workflows.triggers.card.sessionScope.${kind}.description`),
    icon: <Icon name={scopeMarks[kind]} />,
  });
  const items: ValueFieldSelectItem[] = browse === null ? [
    scopeItem('any', any),
    ...AUTOMATION_SESSION_LIFECYCLE_SUBJECT_KINDS_V1.map(kind => scopeItem(kind, `scope-${kind}`)),
  ] : [
    { id: back, title: t('common.back') },
    ...(browse === 'session'
      ? [...sessionMenu.leadingItems, ...sessionItems]
      : resources.status === 'error' || accountReadFailed
        ? [{ id: retry, title: t('common.retry'), subtitle: t('common.requestFailed') }]
        : resources.status === 'ready'
          ? resources.items.length > 0
            ? resources.items.map(item => ({ id: automationSubjectKeyV1(item.subject), title: item.label, subtitle: item.description }))
            : [{ id: 'scope-empty', title: t('commandMenu.empty'), disabled: true }]
          : resourceLifetime?.isCurrent() || resolution.kind === 'resolving'
            ? [{ id: 'scope-loading', title: t('common.loading'), disabled: true }]
            : [{ id: 'scope-unavailable', title: t('common.unavailable'), disabled: true }]),
    ...(browse === 'session' && sessionItems.length === 0 && sessionMenu.emptyLabel
      ? [{ id: 'scope-empty', title: sessionMenu.emptyLabel, disabled: true }] : []),
  ];
  const selectSubject = (subject: AutomationSessionLifecycleSubjectV1 | undefined, title?: string) => {
    const nextKey = subject === undefined ? null : automationSubjectKeyV1(subject);
    if (title !== undefined && nextKey !== null) setChosen({ key: nextKey, title });
    if (nextKey === chosenKey) return;
    const { subject: _previous, ...rest } = when;
    const next = subject === undefined ? rest : { ...rest, subject };
    if (next.kind === 'turnEnds' && next.sourceTurnId !== undefined) {
      const { sourceTurnId: _turn, ...unbound } = next;
      props.onChange({ ...unbound, nextTimeOnly: true });
    } else props.onChange(next);
  };

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
  return (
    <>
      <TrackRow label={t('workflows.triggers.card.source')} trackKey={`${props.testID}-session`}>
        <View style={styles.selectBox}>
          <ValueFieldSelect
            testID={`${props.testID}-session`}
            label={t('workflows.triggers.card.source')}
            items={items}
            selectedId={selectedId}
            selectedLabel={selectedTitle}
            onOpenChange={open => { if (!open) setBrowse(null); }}
            keepsOpen={id => id === back || id === retry || id === WORKFLOW_SESSION_RETRY_ITEM_ID
              || AUTOMATION_SESSION_LIFECYCLE_SUBJECT_KINDS_V1.some(kind => id === `scope-${kind}`)}
            invalid={stored?.disabled === true}
            onSelect={id => {
              if (id === any) return selectSubject(undefined);
              if (id === back) return setBrowse(null);
              if (id === retry) {
                if (accountReadFailed && serverId !== null) retryServerCredentialAccountScope(serverId);
                else void resources.reload();
                return;
              }
              if (id === WORKFLOW_SESSION_RETRY_ITEM_ID) { sessionRead.retrySessionOptions(); return; }
              const kind = AUTOMATION_SESSION_LIFECYCLE_SUBJECT_KINDS_V1.find(kind => id === `scope-${kind}`);
              if (kind !== undefined) return setBrowse(kind);
              if (browse === 'session') {
                const session = sessionRead.existingSessions.find(option => option.sessionId === id);
                const portableServerId = resolvePortableServerIdentityForRoutingId(serverId);
                if (session && portableServerId !== null) {
                  selectSubject({ kind: 'session', serverId: portableServerId, sessionId: id }, session.label);
                }
              } else {
                const option = resources.items.find(item => automationSubjectKeyV1(item.subject) === id);
                if (option?.subject.kind === 'project') selectSubject(option.subject, option.label);
                if (option?.subject.kind === 'machine') {
                  const portableServerId = resolvePortableServerIdentityForRoutingId(serverId);
                  if (portableServerId !== null) selectSubject({ ...option.subject, serverId: portableServerId }, option.label);
                }
              }
            }}
          />
        </View>
      </TrackRow>
      <TrackRow label={t('workflows.triggers.card.howOften')} trackKey={`${props.testID}-how-often`}>
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
      <TrackRow label={t('automations.form.trigger.eventFilter')} trackKey={`${props.testID}-only-when`} labelAlign="control">
        <SessionLifecycleFilterFields when={when} onChange={props.onChange} />
      </TrackRow>
    </>
  );
}
