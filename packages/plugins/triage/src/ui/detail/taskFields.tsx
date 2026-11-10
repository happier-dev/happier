import * as React from 'react';
import { TRIAGE_DATA_ACTION_EXECUTION_V1 } from '../../accountExecution.js';
import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';
import {
  Avatar, Banner, Button, DetailsPaneFooter, EmptyState, ErrorState, Form, Icon, IconButton, Item, ItemGroup, LoadingState, MarkdownEditor, Menu, Popover, PropertyList, RelationList, Row,
  ReplyQuote, ScrollArea, Stack, Status, TaskStatusGlyph, Text, Toggle,
  useAccountActorName, usePluginHostApi, usePluginHostReadiness, usePluginTranslation, usePluginUiFocusTarget, useSurfaceContext,
  type ActionFormFieldHint, type PropertyChoice, type PropertyChoiceDirectory, type PropertyNameTones,
} from '@happier-dev/plugin-ui';
import { useHostPeopleDirectory } from '@happier-dev/plugin-ui/hostApi';
import { type TriageTaskFieldChoicesV1, TriageTaskFieldsV1Schema, TriageTaskTransitionFieldValuesV1Schema, triageTaskStatusCategoryV1,
  type TriageConfiguredSourceInstanceV1, type TriageEntryLocatorV1, type TriageEntryRefV1, type TriageEntryStateV1, type TriageSourceInstanceIdV1, type TriageTaskFieldV1,
  type TriageTaskWriteResultV1, type TriageTaskCapabilitiesV1, type TriageTaskFieldsV1 } from '@happier-dev/triage-protocol/v1';
import { TRIAGE_TASKS_CREATE_ACTION_LOCAL_ID_V1, TRIAGE_TASKS_EDIT_ACTION_LOCAL_ID_V1,
  TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1, type TriageTaskDraftV1 } from '../../actions/tasksProtocol.js';
import type { TriageListRowV1 } from '../../projection/listWindow.js';
import type { TriageListWindowSnapshotV1 } from '../../projection/listWindowStore.js';
import type { TriageListTaskFactsV1 } from '../list/sections.js';
import type { TriageMountedConfiguredSourceV1 } from '../configuration/useTriageConfiguredSources.js';
import { readTriageSelectedObservationV1 } from '../window/selectedObservation.js';
import { resolveTriageSourceDescriptorV1, resolveTriageSourceTaskOperationV1 } from './sourceSurface.js';
import { useTriageTaskCommit, useTriageTaskWriteState } from './taskWrite.js';
import { defaultTriageTaskDraftPlaceV1, suggestTriageTaskDraftPlacesV1 } from '../taskDraftPlaces.js';
import { projectTriageTaskBlockersV1, projectTriageTaskPropertiesV1, triageTaskFieldTitleV1, triageTaskRelationCandidatesV1 } from './taskProperties.js';
import { projectTriageTaskDraftStatusV1 } from './taskDraftStatus.js';
import { TriageSourceMark } from '../list/sourceMark.js';
import { TriageTaskOriginLink } from './taskOrigin.js';
import { openLinkedSession } from '../../sessions/entrySessionOpen.js';
import { taskWriteMessage, type TaskWriteMessageContext } from '../taskWriteMessage.js';
import { sameTriageSourceIdentity } from '../../corpus/identity/components.js';
import { INTERNAL_TASK_SOURCE_V1 } from '../../internalTasks/identity.js';

export const TRIAGE_TASK_PROPERTIES_TEST_ID_V1 = 'triage-task-properties';
export const TRIAGE_TASK_BLOCKERS_TEST_ID_V1 = 'triage-task-blockers';
export const TRIAGE_TASK_TEXT_EDITOR_TEST_ID_V1 = 'triage-task-text-editor';
export const TRIAGE_TASK_DRAFT_TITLE_TEST_ID_V1 = 'triage-task-draft-title';
export const TRIAGE_TASK_DRAFT_CREATE_TEST_ID_V1 = 'triage-task-draft-create';
/** The draft fills its pane: its document scrolls and its Create stays pinned at the foot. */
const TASK_DRAFT_FILL_STYLE = Object.freeze({ flex: 1, minHeight: 0 });
export { useTriageTaskCommit } from './taskWrite.js';

/** Reuse the Account display owner without a profile read; unrecognized source handles stay native. */
function useTriageTaskAssigneeLabels(accountId: string | undefined) {
  const name = useAccountActorName({ kind: 'self' });
  return accountId === undefined ? undefined : new Map([[accountId, name]]);
}

const NO_PEOPLE_SCOPE = Object.freeze({ serverId: '', accountId: '' });
type TriageTaskAssigneeDirectory = Readonly<{ choices: readonly PropertyChoice[]; state: PropertyChoiceDirectory }>;

/**
 * Where a task's assignees are picked from when the source's own read carries no directory. A Happier task's people
 * are the host's (the share sheet's people owner), read only once the picker opens; any other source gets the
 * `otherwise` state it can truthfully offer. Assignees are never typed.
 */
function useTriageTaskAssigneeDirectory(input: Readonly<{
  happier: boolean;
  scope: Readonly<{ serverId: string; accountId: string }> | undefined;
  otherwise?: PropertyChoiceDirectory;
}>): TriageTaskAssigneeDirectory | undefined {
  const text = usePluginTranslation();
  const [demanded, setDemanded] = React.useState(false);
  const host = useHostPeopleDirectory({ scope: input.scope ?? NO_PEOPLE_SCOPE, enabled: input.happier && demanded && input.scope !== undefined });
  if (!input.happier) return input.otherwise === undefined ? undefined : { choices: [], state: input.otherwise };
  if (host === null || input.scope === undefined) return { choices: [], state: { status: 'unavailable',
    unavailableLabel: text('plugins.triage.tasks.assignees.noPeople', 'People can\u2019t be listed here') } };
  return {
    choices: host.people.map(person => ({ id: person.accountId, label: person.name, ...(person.handle === undefined ? {} : { subtitle: person.handle }) })),
    state: host.status === 'failed'
      ? { status: 'unavailable', unavailableLabel: text('plugins.triage.tasks.assignees.peopleFailed', 'Your people couldn\u2019t be loaded'), retry: host.retry }
      : { status: host.status === 'ready' ? 'ready' : 'loading', onOpen: () => setDemanded(true) },
  };
}

/** One assignee's mark, from Happier's person owner (never an image URL). */
function renderTriageTaskAssigneeFace(name: string): React.ReactNode {
  return <Avatar name={name} size="small" />;
}

/** The person owner's names first, then the names the people directory read for the rest. */
function withAssigneeNames(labels: ReadonlyMap<string, string | null> | undefined, directory: TriageTaskAssigneeDirectory | undefined) {
  if (directory === undefined || directory.choices.length === 0) return labels;
  const names = new Map<string, string | null>(directory.choices.map(choice => [choice.id, choice.label]));
  for (const [id, name] of labels ?? []) names.set(id, name);
  return names;
}

/** List age and other sources' health do not decide whether this source can execute. */
function useTriageTaskExecutionUnavailable(): boolean {
  const machineBound = Object.is(TRIAGE_DATA_ACTION_EXECUTION_V1.target, 'daemon');
  const readiness = usePluginHostReadiness(machineBound);
  return readiness.pending || readiness.ready === false;
}

function taskSourceLinkLabel(text: ReturnType<typeof usePluginTranslation>, sourceName?: string): string {
  return sourceName === undefined ? text('plugins.triage.tasks.write.openSource', 'Open source')
    : text('plugins.triage.tasks.write.openInSource', 'Open in {source}', { source: sourceName });
}

function TaskWriteNotice({ result, checking, onCheckAgain, sourceUrl, sessionLink, context }: Readonly<{
  result: TriageTaskWriteResultV1 | null; checking?: boolean; onCheckAgain?(): Promise<unknown>; sourceUrl?: string;
  sessionLink?: 'linked' | 'failed' | 'unknown' | null;
  context?: TaskWriteMessageContext;
}>) {
  const text = usePluginTranslation();
  const host = usePluginHostApi();
  if (result === null) return null;
  if (result.kind === 'applied' && (sessionLink === 'failed' || sessionLink === 'unknown')) return <Banner tone="warning"
    title={sessionLink === 'failed' ? text('plugins.triage.tasks.write.createdNotLinked', 'The task was created, but this Session could not be linked.')
      : text('plugins.triage.tasks.write.createdLinkUnknown', 'The task was created. Its Session link is not yet confirmed.')} />;
  // A write that landed is confirmed by the change itself (the value, the row, the draft becoming the task); it is
  // said in one quiet line, never a card. Only a write that needs the reader takes the warning banner.
  if (result.kind === 'applied') return <Status tone="muted" label={taskWriteMessage(text, result, context)} />;
  return <Stack gap="small">
    <Banner tone="warning" title={taskWriteMessage(text, result, context)} />
    {result.kind !== 'uncertain' ? null : <Row gap="small" wrap>
      {onCheckAgain === undefined ? null : <Button variant="secondary" size="small" busy={checking} disabled={checking}
        title={text('plugins.triage.tasks.write.checkAgain', 'Check again')} onPress={() => { void onCheckAgain(); }} />}
      {sourceUrl === undefined ? null : <Button variant="secondary" size="small"
        title={taskSourceLinkLabel(text, context?.sourceName)} onPress={() => host.openExternalLink(sourceUrl)} />}
    </Row>}
  </Stack>;
}

const TASK_CATEGORY_WORDS = { backlog: 'Backlog', unstarted: 'To do', started: 'In progress', completed: 'Done', canceled: 'Canceled' } as const;

const TASK_STATUS_GROUP_ID = 'status';
/**
 * The source's workflow as a status menu (lab `tasks-status`): each state led by its category's own glyph, and the
 * task's current state checked. The current state is the transition whose target is where the task already is (its
 * word or its exact state), so choosing it again is not a write.
 */
function taskStatusMenu(transitions: readonly Readonly<{ id: string; label: string; state?: TriageEntryStateV1 }>[],
  current: Readonly<{ label: string | null; state?: TriageEntryStateV1 }>, groupLabel: string) {
  const currentId = transitions.find(transition => (current.label !== null && transition.label === current.label)
    || (transition.state !== undefined && current.state !== undefined && pluginJsonValuesEqual(transition.state, current.state)))?.id ?? null;
  return {
    currentId,
    items: transitions.map((transition) => {
      const category = transition.state === undefined ? null : triageTaskStatusCategoryV1(transition.state);
      return { id: transition.id, label: transition.label, kind: 'radio' as const, radioGroupId: TASK_STATUS_GROUP_ID,
        ...(category === null ? {} : { taskStatus: category }) };
    }),
    radioGroups: [{ id: TASK_STATUS_GROUP_ID, accessibilityLabel: groupLabel, selectedId: currentId }],
  };
}

type TaskTransition = Pick<NonNullable<TriageTaskCapabilitiesV1['transitions']>[number], 'id' | 'label' | 'requiredFields'>
  & Partial<Pick<NonNullable<TriageTaskCapabilitiesV1['transitions']>[number], 'state'>>;
/** Field gathering is shared by row and detail; only the native Action authorizes and writes. */
function useTaskTransitionFields(write: ReturnType<typeof useTriageTaskCommit>, address: Readonly<{
  entryRef: TriageEntryRefV1; sourceInstanceId: string; lastKnownLocator: TriageEntryLocatorV1;
}> | null, disabled: boolean, sourceName?: string) {
  const host = usePluginHostApi();
  const text = usePluginTranslation();
  const [selected, setSelected] = React.useState<TaskTransition | null>(null);
  const [draft, setDraft] = React.useState<Record<string, unknown>>({});
  const commit = async (transition: TaskTransition, fieldValues?: ReturnType<typeof TriageTaskTransitionFieldValuesV1Schema.parse>) => {
    if (disabled || address === null) return;
    const result = await write.commit(TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1, { v: 1, ...address, transitionId: transition.id,
      ...(fieldValues === undefined ? {} : { fieldValues }) }, { label: transition.label, state: transition.state });
    if (result !== undefined) setSelected(null);
    if (result !== undefined && result.kind !== 'applied') {
      void host.notify(taskWriteMessage(text, result, { sourceName, operation: 'edit', target: transition.label }), { severity: 'warning' }).catch(() => {});
    }
  };
  const fields = selected?.requiredFields ?? [];
  const unsupported = fields.some(field => field.kind === 'unsupported');
  const form = selected === null ? null : <Popover open onOpenChange={open => { if (!open && !write.busy) setSelected(null); }}
    trigger={selected.label} triggerAccessibilityLabel={selected.label} contentAccessibilityLabel={selected.label}
    sheet={{ title: selected.label }} floatingRole="panel">
    {unsupported ? <Stack gap="small">
      <Banner tone="warning" title={text('plugins.triage.tasks.transition.sourceInput', 'Complete this transition at the source to provide its required fields.')} />
      {address?.lastKnownLocator.webUrl === undefined ? null : <Button variant="secondary" title={taskSourceLinkLabel(text, sourceName)}
        onPress={() => { void host.openExternalLink(address.lastKnownLocator.webUrl!); }} />}
      <Button variant="plain" title={text('plugins.triage.tasks.cancel', 'Cancel')} onPress={() => setSelected(null)} />
    </Stack> : <Form value={draft} onChange={setDraft} disabled={disabled} busy={write.busy}
      onCancel={() => setSelected(null)} hints={{ submitLabel: selected.label, fields: fields.map((field, index): ActionFormFieldHint => ({
        path: `field${index}`, title: field.label, required: true,
        widget: field.kind === 'choice' ? 'select' : field.kind === 'choices' ? 'multiselect' : field.kind === 'number' ? 'number' : 'text',
        ...(field.kind === 'choice' || field.kind === 'choices' ? { options: field.options.map(option => ({ value: option.id, label: option.label })) } : {}),
      })) }} onSubmit={async value => {
        const parsed = TriageTaskTransitionFieldValuesV1Schema.safeParse(fields.map((field, index) => ({ fieldId: field.id, value: value[`field${index}`] })));
        if (parsed.success) await commit(selected, parsed.data);
      }} />}
  </Popover>;
  return { form, select: (transition: TaskTransition) => {
    if (disabled) return;
    if ((transition.requiredFields?.length ?? 0) > 0) { setDraft({}); setSelected(transition); }
    else void commit(transition);
  } };
}

/** The Status cell and compact row read the same operation as the glyph and open detail. */
export function useTriageTaskStatusLabel(entryRef: TriageEntryRefV1, statusLabel: string | null) {
  const write = useTriageTaskWriteState(entryRef);
  const text = usePluginTranslation();
  const label = write.busy ? write.progress === null ? text('plugins.triage.tasks.write.saving', 'Saving…')
    : text('plugins.triage.tasks.write.moving', 'Moving to {status}…', { status: write.progress })
    : write.result?.kind === 'uncertain' ? text('plugins.triage.tasks.write.unconfirmed', 'Not yet confirmed') : statusLabel;
  return { label, uncertain: write.result?.kind === 'uncertain' };
}
export function TriageTaskStatusLabel(props: Readonly<{ entryRef: TriageEntryRefV1; statusLabel: string | null }>) {
  const { label, uncertain } = useTriageTaskStatusLabel(props.entryRef, props.statusLabel);
  return label === null ? null : <Text variant="meta" tone={uncertain ? 'warning' : 'secondary'} value={label} numberOfLines={1} />;
}

/**
 * A task row's status glyph as its control (lab `tasks-list`, decision 3): when the selected connection declares the
 * one transition that completes the task, a press completes it in one write; otherwise the glyph opens the source's
 * own workflow in place. The write is the detail's (`tasks/transition-v1`, one commit, no replay of an uncertain
 * answer); while it runs the glyph is the spinner, and an outcome other than applied is said by the host notice.
 */
export function TriageTaskRowStatusControl(props: Readonly<{
  /** The selected connection's address the list row carries (its entry, connection and locator). */
  address: Readonly<{ entryRef: TriageEntryRefV1; sourceInstanceId: TriageSourceInstanceIdV1; lastKnownLocator: TriageEntryLocatorV1 }>;
  task: TriageListTaskFactsV1;
  onApplied(): Promise<void>;
}>): React.ReactElement | null {
  const context = useSurfaceContext();
  const text = usePluginTranslation();
  const unavailable = useTriageTaskExecutionUnavailable();
  const write = useTriageTaskCommit(props.onApplied, props.address);
  const [open, setOpen] = React.useState(false);
  const { task, address } = props;
  const sourceName = resolveTriageSourceDescriptorV1(context.targetedContributions, address.entryRef.source)?.displayName;
  const disabled = unavailable || write.busy || write.checking || write.result?.kind === 'uncertain';
  const workflow = useTaskTransitionFields(write, address, disabled, sourceName);
  const declared = resolveTriageSourceTaskOperationV1(context.targetedContributions, address.entryRef.source, 'transition') !== undefined;
  const transitions = task.transitions ?? [];
  if (task.category === null || !declared || transitions.length === 0) {
    return task.category === null ? null : <TaskStatusGlyph category={task.category} />;
  }
  const category = task.category;
  const statusWord = task.statusLabel ?? text(`plugins.triage.tasks.${category}`, TASK_CATEGORY_WORDS[category]);
  const completing = category === 'completed' || category === 'canceled' ? undefined : task.completingTransitionId;
  if (write.result?.kind === 'uncertain') return <Popover open={open} onOpenChange={setOpen} trigger={statusWord}
    triggerTaskStatus={category} triggerAccessibilityLabel={`${text('plugins.triage.tasks.write.checkAgain', 'Check again')}, ${statusWord}`}>
    <TaskWriteNotice result={write.result} checking={write.checking} onCheckAgain={write.checkAgain} sourceUrl={address.lastKnownLocator.webUrl}
      context={{ sourceName, operation: 'edit', target: write.progress }} />
  </Popover>;
  // The row's line already says "Moving to Done…"; the glyph stays the status it leaves, dimmed, as the lab draws it.
  // A busy spinner here is the dotted Happier mark, which reads as a drag handle in a row that can be dragged.
  if (write.busy) return <IconButton icon={<TaskStatusGlyph category={category} />} disabled
    onPress={() => undefined}
    accessibilityLabel={text('plugins.triage.tasks.write.moving', 'Moving to {status}…', { status: write.progress ?? statusWord })} />;
  if (workflow.form !== null) return workflow.form;
  if (completing !== undefined && transitions.length === 1) {
    const transition = transitions.find(candidate => candidate.id === completing);
    return <IconButton icon={<TaskStatusGlyph category={category} />} busy={write.busy} disabled={disabled}
      accessibilityLabel={`${text('plugins.triage.tasks.complete', 'Mark as done')}, ${statusWord}`}
      onPress={() => { if (transition !== undefined) workflow.select(transition); }} />;
  }
  const transitionLabel = text('plugins.triage.tasks.transition', 'Change status');
  const menu = taskStatusMenu(transitions, { label: task.statusLabel }, transitionLabel);
  return <Menu open={open && !disabled} onOpenChange={(next) => setOpen(next && !disabled)} disabled={disabled}
    trigger={statusWord} triggerTaskStatus={category} triggerAccessibilityLabel={`${transitionLabel}, ${statusWord}`}
    items={menu.items} radioGroups={menu.radioGroups}
    onSelect={(id) => { const transition = transitions.find(candidate => candidate.id === id);
      if (transition !== undefined && id !== menu.currentId) workflow.select(transition); }} />;
}

export function TriageCreateTaskFields(props: Readonly<{
  sources: readonly TriageMountedConfiguredSourceV1[];
  sourcesLoaded: boolean;
  sourcesUnavailableReason: string | null;
  sourceSnapshot?: TriageListWindowSnapshotV1;
  draft?: TriageTaskDraftV1;
  /** Existing scoped handoff identity keeps uncertain creates held across pane remounts. */
  draftId?: string;
  /** Existing admitted window evidence; no lookup or provider read just to suggest Where. */
  suggestionRows?: readonly TriageListRowV1[];
  onApplied(): Promise<void>;
  onClose(): void;
  /** The source created the task: the draft becomes that task's detail in place. */
  onCreated?(created: Readonly<{ entryRef: TriageEntryRefV1; sourceInstanceId: TriageSourceInstanceIdV1 }>): void;
}>): React.ReactElement {
  const context = useSurfaceContext();
  const host = usePluginHostApi();
  const assigneeLabels = useTriageTaskAssigneeLabels(context.accountScope?.accountId);
  const text = usePluginTranslation();
  const machineUnavailable = useTriageTaskExecutionUnavailable();
  const [where, setWhere] = React.useState<string | null | undefined>(undefined);
  const [draft, setDraft] = React.useState<Record<string, unknown>>({ title: '', ...props.draft });
  const [linkSession, setLinkSession] = React.useState(props.draft?.linkSession !== undefined);
  const write = useTriageTaskCommit(props.onApplied, props.draftId === undefined ? undefined : { draftId: props.draftId });
  const origin = props.draft?.origin;
  const sessionTarget = props.draft?.linkSession ?? origin?.sessionId;
  const originContext = <Stack gap="small">
    {props.draft?.originError === undefined ? null : <TriageTaskOriginLink origin={props.draft.originError} />}
    {origin === undefined ? null : <Stack gap="small">
    {/* The message this task comes from, as one quiet line: its Session and its words, cut to the line. Pressing it
        opens that Session; the whole quote still travels with the draft. */}
    {origin.quote === undefined || origin.quote.trim() === ''
      ? <Text variant="meta" tone="secondary" value={text('plugins.triage.tasks.draft.fromSession', 'From {session}', { session: origin.sessionTitle ?? origin.sessionId })} />
      : <ReplyQuote kind="message" source={{
        state: 'available', label: origin.sessionTitle ?? text('plugins.triage.surface.actions.untitledSession', 'Untitled Session'),
        text: origin.quote,
        onPress: () => { void openLinkedSession({ execute: async (actionId, input, options) => await host.executeAction(actionId, input, options),
          sessionId: origin.sessionId, ...(origin.serverId === undefined ? {} : { serverId: origin.serverId }) }); },
      }} />}
    {origin.repository === undefined ? null : <Text variant="meta" tone="secondary"
      value={text('plugins.triage.tasks.draft.repository', 'Session repository: {repository}', { repository: origin.repository.repository })} />}
    </Stack>}
  </Stack>;
  const choices = React.useMemo(() => props.sources.flatMap((source) => {
    const descriptor = resolveTriageSourceDescriptorV1(context.targetedContributions, source.configured.instance.source);
    const operation = resolveTriageSourceTaskOperationV1(context.targetedContributions, source.configured.instance.source, 'create');
    return (descriptor?.kinds ?? []).filter((kind) => kind.task === true).map((kind) => {
      const supportsCreate = operation !== undefined && kind.taskCapabilities?.createFields?.includes('title') === true;
      return { value: JSON.stringify([source.sourceInstanceId, kind.id]), source, kind, supportsCreate,
        family: descriptor?.displayName ?? source.displayLabel, disabled: !supportsCreate || machineUnavailable };
    });
  }), [props.sources, context.targetedContributions, machineUnavailable]);
  const defaultPlace = where === undefined ? defaultTriageTaskDraftPlaceV1(choices.filter(choice => choice.supportsCreate).map(choice => ({
    source: choice.source.configured.instance.source, sourceInstanceId: choice.source.sourceInstanceId, kindId: choice.kind.id,
  })), props.sourceSnapshot) : undefined;
  const chosenValue = where === undefined && defaultPlace !== undefined
    ? JSON.stringify([defaultPlace.sourceInstanceId, defaultPlace.kindId]) : where;
  const chosen = choices.find((choice) => choice.value === chosenValue);
  // A source with a directory reads it for an existing entry; before the task exists there is none to read yet.
  const assigneeDirectory = useTriageTaskAssigneeDirectory({ scope: context.accountScope,
    happier: chosen !== undefined && sameTriageSourceIdentity(chosen.source.configured.instance.source, INTERNAL_TASK_SOURCE_V1),
    ...(chosen?.kind.taskCapabilities?.fieldChoices === true ? { otherwise: { status: 'unavailable' as const,
      unavailableLabel: text('plugins.triage.tasks.assignees.afterCreate', 'Assign people once the task is created') } } : {}) });
  const candidates = React.useMemo(() => triageTaskRelationCandidatesV1(props.suggestionRows ?? []), [props.suggestionRows]);
  const suggestions = React.useMemo(() => suggestTriageTaskDraftPlacesV1(origin?.repository, props.suggestionRows ?? [], choices.filter(choice => choice.supportsCreate).map(choice => ({
    source: choice.source.configured.instance.source, sourceInstanceId: choice.source.sourceInstanceId, kindId: choice.kind.id,
  }))), [origin?.repository, props.suggestionRows, choices]);
  const sourcesReady = props.sourcesLoaded && props.sourcesUnavailableReason === null;
  const canChoose = sourcesReady && choices.some((choice) => choice.supportsCreate);
  const titleFocus = usePluginUiFocusTarget();
  const titleReady = chosen !== undefined && canChoose && !chosen.disabled;
  React.useEffect(() => {
    if (titleReady) titleFocus.focus();
  }, [titleReady, titleFocus]);
  const fields = chosen?.kind.taskCapabilities?.createFields ?? [];
  const unsupportedBody = typeof draft.body === 'string' && draft.body.length > 0 && !fields.includes('body');
  const [placeQuery, setPlaceQuery] = React.useState('');
  // A row is what the place creates; the connection is named only where two connections would otherwise read alike.
  const placeTitle = (choice: (typeof choices)[number]) => choice.kind.displayName ?? choice.kind.id;
  const connectionShown = (choice: (typeof choices)[number]) => new Set(choices.filter(other => other.family === choice.family)
    .map(other => other.source.sourceInstanceId)).size > 1;
  const placeNote = (choice: (typeof choices)[number]) => choice.supportsCreate ? null
    : text('plugins.triage.tasks.where.cannotCreate', 'Tasks can\u2019t be created here');
  const placeSubtitle = (choice: (typeof choices)[number]) => {
    const suggested = suggestions.some(suggestion => suggestion.sourceInstanceId === choice.source.sourceInstanceId && suggestion.kindId === choice.kind.id);
    const note = placeNote(choice) ?? (suggested ? text('plugins.triage.tasks.where.suggested', 'Suggested from this Session') : null);
    const parts = [...(connectionShown(choice) ? [choice.source.displayLabel] : []), ...(note === null ? [] : [note])];
    return parts.length === 0 ? undefined : parts.join(' \u00b7 ');
  };
  const mark = (choice: (typeof choices)[number]) =>
    <TriageSourceMark source={choice.source.configured.instance.source} />;
  React.useEffect(() => {
    if (chosen !== undefined && write.result?.kind === 'applied' && write.originErrorLink === 'linked') props.onCreated?.({
      entryRef: { source: chosen.source.configured.instance.source, ...write.result.observation.localRef },
      sourceInstanceId: chosen.source.sourceInstanceId,
    });
  }, [write.result, write.originErrorLink]);
  // The draft stands in the detail's place under the pane's own "New task" title (lab `tasks-create`, decision 10):
  // first the places this task can go, one row each under its source's name; a place that cannot take tasks says so.
  // Choosing one opens its form under a single place row that leads back to the list (lab `tasks-form`), with one Create.
  if (chosen === undefined || !canChoose) {
    const query = placeQuery.trim().toLocaleLowerCase(context.locale);
    const shownChoices = query.length === 0 ? choices : choices.filter(choice => [choice.family, placeTitle(choice), ...(connectionShown(choice) ? [choice.source.displayLabel] : [])]
      .some(part => part.toLocaleLowerCase(context.locale).includes(query)));
    const families = [...new Set(shownChoices.map((choice) => choice.family))];
    return <Stack gap="none" style={TASK_DRAFT_FILL_STYLE}>
      <ScrollArea style={TASK_DRAFT_FILL_STYLE}><Stack gap="medium">
        {originContext}
        <TaskWriteNotice result={write.result} sessionLink={write.sessionLink}
          context={{ sourceName: chosen?.family, operation: 'create' }}
          sourceUrl={write.result?.kind === 'uncertain' ? write.result.observation?.locator.webUrl : undefined} />
        <Text variant="body" tone="secondary" value={text('plugins.triage.tasks.where.purpose', 'Where does it belong? It\u2019s created there and stays there.')} />
        {props.sourcesUnavailableReason !== null ? <ErrorState kind="unavailable" layout="line"
          title={text('plugins.triage.tasks.sourcesUnavailable', 'Task sources are unavailable')}
          description={props.sourcesUnavailableReason} />
          : !props.sourcesLoaded ? <LoadingState layout="line" title={text('plugins.triage.surface.sources.loading', 'Reading your sources\u2026')} />
          : !canChoose ? <EmptyState layout="line" title={text('plugins.triage.tasks.noCreateSource', 'Add a source that supports creating tasks in Sources.')} />
          : <>
            <Form.TextField presentation="field" label={text('plugins.triage.tasks.where.search', 'Search places')}
              placeholder={text('plugins.triage.tasks.where.search', 'Search places')} value={placeQuery} onChange={setPlaceQuery} />
            {families.length === 0 ? <EmptyState layout="line" title={text('plugins.triage.tasks.where.noMatch', 'No place matches')} /> : null}
            {families.map((family) => <ItemGroup key={family} title={family} surface="none">
              {shownChoices.filter((choice) => choice.family === family).map((choice) => {
                const subtitle = placeSubtitle(choice);
                const name = connectionShown(choice) ? `${placeTitle(choice)}, ${choice.source.displayLabel}` : placeTitle(choice);
                return <Item key={choice.value} icon={mark(choice)} title={placeTitle(choice)} accessibilityRole="button"
                  disabled={choice.disabled || write.busy || write.result?.kind === 'uncertain' || write.result?.kind === 'applied'}
                  accessibilityLabel={name} {...(subtitle === undefined ? {} : { accessibilityHint: subtitle, subtitle })}
                  onPress={() => { if (!choice.disabled && !write.busy && write.result?.kind !== 'uncertain' && write.result?.kind !== 'applied') {
                    setDraft(previous => ({ ...previous, initialStatusId: undefined }));
                    setWhere(choice.value);
                  } }} />;
              })}
            </ItemGroup>)}
          </>}
      </Stack></ScrollArea>
      <DetailsPaneFooter>
        <Row justify="flex-end"><Button title={text('plugins.triage.tasks.cancel', 'Cancel')} variant="plain" size="small" disabled={write.busy} onPress={props.onClose} /></Row>
      </DetailsPaneFooter>
    </Stack>;
  }
  const held = chosen.disabled || unsupportedBody || write.busy || write.result?.kind === 'uncertain' || write.result?.kind === 'applied';
  const initialStatus = projectTriageTaskDraftStatusV1({ statuses: chosen.kind.taskCapabilities?.initialStatuses,
    value: draft.initialStatusId, text, onChange: initialStatusId => setDraft(previous => ({ ...previous, initialStatusId })) });
  // The draft's typed properties are the detail's own property list, limited to what this place accepts; a change
  // here only edits the draft. Nothing is written until Create.
  const draftValues: Partial<TriageTaskFieldsV1> = {
    ...(fields.includes('assigneeIds') ? { assigneeIds: [] } : {}), ...(fields.includes('labelIds') ? { labelIds: [] } : {}),
    ...(fields.includes('blockedBy') ? { blockedBy: [] } : {}),
    ...Object.fromEntries((['scopeId', 'projectId', 'priority', 'dueDate', 'estimate', 'parent'] as const)
      .filter(field => fields.includes(field)).map(field => [field, null])),
    ...Object.fromEntries(Object.entries(draft).filter(([field]) => field !== 'title' && field !== 'body' && field !== 'initialStatusId')),
  } as Partial<TriageTaskFieldsV1>;
  const setDraftFields = (next: TriageTaskFieldsV1) => setDraft(previous => ({ ...previous, ...next }));
  const properties = projectTriageTaskPropertiesV1({ fields, values: draftValues, candidates, assigneeLabels: withAssigneeNames(assigneeLabels, assigneeDirectory),
    assigneeFace: renderTriageTaskAssigneeFace, commit: setDraftFields, text, locale: context.locale,
    ...(assigneeDirectory === undefined ? {} : { assigneeDirectory }) });
  if (initialStatus.property !== null) properties.unshift(initialStatus.property);
  const blockers = fields.includes('blockedBy')
    ? projectTriageTaskBlockersV1({ blockedBy: draftValues.blockedBy ?? [], candidates, text, commit: setDraftFields }) : null;
  const title = typeof draft.title === 'string' ? draft.title : '';
  const create = async () => {
    const trimmed = title.trim();
    if (trimmed.length === 0 || held || !sourcesReady) return;
    const chosenFields = Object.fromEntries(Object.entries(draftValues).filter(([field, value]) => fields.includes(field as TriageTaskFieldV1)
      && value !== null && value !== undefined && !(Array.isArray(value) && value.length === 0)));
    const result = await write.commit(TRIAGE_TASKS_CREATE_ACTION_LOCAL_ID_V1, { v: 1,
      source: chosen.source.configured.instance.source, sourceInstanceId: chosen.source.sourceInstanceId,
      kindId: chosen.kind.id, fields: { ...chosenFields, title: trimmed,
        ...(fields.includes('body') && typeof draft.body === 'string' && draft.body.length > 0 ? { body: draft.body } : {}),
      }, ...(initialStatus.initialStatusId === undefined ? {} : { initialStatusId: initialStatus.initialStatusId }),
      ...(sessionTarget !== undefined && linkSession ? { linkSession: sessionTarget } : {}),
      ...(props.draft?.originError === undefined ? {} : { originError: props.draft.originError }) });
    // A partial origin link stays here with its created identity; repair never resubmits Create.
    if (result?.kind === 'applied' && props.draft?.originError === undefined) props.onCreated?.({
      entryRef: { source: chosen.source.configured.instance.source, ...result.observation.localRef },
      sourceInstanceId: chosen.source.configured.instance.sourceInstanceId,
    });
  };
  const placeName = chosen.family === chosen.source.displayLabel ? chosen.family : `${chosen.family} \u00b7 ${chosen.source.displayLabel}`;
  const placeLocked = write.busy || write.result?.kind === 'uncertain' || write.result?.kind === 'applied';
  // The draft is the task's detail before it exists (lab `tasks-form`, decision 10): where it goes as one chip that
  // leads back to the places, the title and notes written in place as the document they become, then the place's own
  // properties. Create is pinned at the foot with what it does; nothing reaches the source before it.
  return <Stack gap="none" style={TASK_DRAFT_FILL_STYLE}>
    <ScrollArea style={TASK_DRAFT_FILL_STYLE}>
      <Stack gap="large">
        {originContext}
        {write.originErrorLink !== 'failed' && write.originErrorLink !== 'unknown' ? null : <Stack gap="small">
          <Banner tone="warning" title={text('plugins.triage.tasks.origin.partial', 'The task was created, but its origin link is not confirmed. Repair the link without creating another task.')} />
          <Button variant="secondary" size="small" title={text('plugins.triage.tasks.origin.repair', 'Repair origin link')}
            busy={write.busy} disabled={write.busy} onPress={() => { void write.repairOrigin(); }} />
        </Stack>}
        <Stack gap="small">
          <Row>
            <Button variant="secondary" size="small" icon={mark(chosen)} title={placeName}
              accessibilityLabel={text('plugins.triage.tasks.where.changeNamed', 'Where: {place}. Change', { place: placeName })}
              disabled={placeLocked} onPress={() => setWhere(null)} />
          </Row>
          <Form.TextField presentation="document" documentRole="title" multiline label={text('plugins.triage.tasks.taskTitle', 'Title')}
            focusTarget={titleFocus}
            placeholder={text('plugins.triage.tasks.draft.titlePlaceholder', 'Task title')} value={title} required disabled={held}
            onChange={value => setDraft(previous => ({ ...previous, title: value }))} onSubmitEditing={() => undefined}
            testID={TRIAGE_TASK_DRAFT_TITLE_TEST_ID_V1} />
          {!fields.includes('body') ? null : <MarkdownEditor presentation="document" accessibilityLabel={text('plugins.triage.tasks.body', 'Notes')}
            placeholder={text('plugins.triage.tasks.draft.notesPlaceholder', 'Add notes\u2026')} disabled={held}
            value={typeof draft.body === 'string' ? draft.body : ''} onChange={value => setDraft(previous => ({ ...previous, body: value }))} />}
        </Stack>
        {/* Before the task exists its blockers are one more value, beside its parent, not a chapter of its story. */}
        {properties.length === 0 && blockers === null ? null : <PropertyList items={blockers === null ? properties : [...properties, blockers.property]}
          disabled={held} accessibilityLabel={text('plugins.triage.tasks.properties', 'Task properties')} testID={TRIAGE_TASK_PROPERTIES_TEST_ID_V1} />}
        {sessionTarget === undefined ? null : <Item title={text('plugins.triage.tasks.draft.linkSession', 'Link this Session')}
          accessory={<Toggle label={text('plugins.triage.tasks.draft.linkSession', 'Link this Session')} value={linkSession} onChange={setLinkSession}
            disabled={placeLocked} />} />}
        <TaskWriteNotice result={write.result} sessionLink={write.sessionLink}
          context={{ sourceName: chosen.family, operation: 'create' }}
          sourceUrl={write.result?.kind === 'uncertain' ? write.result.observation?.locator.webUrl : undefined} />
        {!unsupportedBody ? null : <TaskWriteNotice result={{ kind: 'refused', reason: 'unsupportedField' }} />}
      </Stack>
    </ScrollArea>
    <DetailsPaneFooter>
      <Row gap="small" align="center">
        <Stack grow>
          <Text variant="meta" tone="secondary" numberOfLines={2}
            value={text('plugins.triage.tasks.draft.consequence', 'Nothing is sent to {place} until you create it', { place: chosen.source.displayLabel })} />
        </Stack>
        <Button title={text('plugins.triage.tasks.cancel', 'Cancel')} variant="plain" size="small" disabled={write.busy} onPress={props.onClose} />
        <Button title={text('plugins.triage.tasks.create', 'Create task')} size="small" busy={write.busy} disabled={held || title.trim().length === 0}
          onPress={create} testID={TRIAGE_TASK_DRAFT_CREATE_TEST_ID_V1} />
      </Row>
    </DetailsPaneFooter>
  </Stack>;
}

/** The task's text edits in one deliberate Save; every other field is its own typed property. */
const TASK_TEXT_FIELDS = ['title', 'body'] as const satisfies readonly TriageTaskFieldV1[];

/** One of a task's relations as a chapter of the detail's story: its list, and the source's fact about it. */
export type TriageTaskRelationChapterV1 = Readonly<{
  title: string;
  /** The relation's list. Untitled inside a story chapter that names it; titled where it stands as its own section. */
  list(placement: 'chapter' | 'section'): React.ReactElement;
  summary?: string;
}>;

/** Where the detail places a task's parts (lab t1: status leads the action row, relations are chapters). */
export type TriageEditTaskPlacementV1 = Readonly<{
  /** The task's Status button (a menu of the source's own workflow), leading the entry's one action row. */
  status: React.ReactElement | null;
  /** The task's properties and the last write's outcome, under the action row. */
  controls: React.ReactElement | null;
  /** Blocked by and Sub-tasks, as the story's numbered chapters; `null` when the source did not read that relation. */
  relations: Readonly<{ blockedBy: TriageTaskRelationChapterV1 | null; subTasks: TriageTaskRelationChapterV1 | null }>;
  /** Opens the title-and-notes editor (held while a write or read is in flight); `null` when this source cannot edit them. */
  edit: Readonly<{ open(): void; disabled: boolean }> | null;
  /** The open title-and-notes editor, shown where the notes are until it is saved or cancelled. */
  form: React.ReactElement | null;
}>;

const NO_TASK_RELATIONS: TriageEditTaskPlacementV1['relations'] = Object.freeze({ blockedBy: null, subTasks: null });

/**
 * Exact editable values belong to the source read, never to the bounded display projection.
 *
 * One owner holds the editor's state; the detail decides where its two parts sit. Key it per entry instance so a
 * different entry never inherits another one's draft.
 */
export function TriageEditTaskScope(props: Readonly<{
  row: TriageListRowV1; instance?: TriageConfiguredSourceInstanceV1; disabled: boolean; onApplied(): Promise<void>;
  /** Complete edit values supplied by the mounted exact-entry read owner. */
  taskFields?: TriageTaskFieldsV1;
  /** What assignees and labels can be set to, from the same read, when the source declares a directory. */
  taskFieldChoices?: TriageTaskFieldChoicesV1;
  /** Canonical detail relationship evidence, not a second relation lookup or store. */
  linkedSessionIds?: readonly string[];
  /** The rows the window already holds: what a parent or blocker can be chosen from, and how they are named. */
  relationRows?: readonly TriageListRowV1[];
  children(placement: TriageEditTaskPlacementV1): React.ReactElement;
}>): React.ReactElement {
  const context = useSurfaceContext();
  const assigneeLabels = useTriageTaskAssigneeLabels(context.accountScope?.accountId);
  const text = usePluginTranslation();
  const executionUnavailable = useTriageTaskExecutionUnavailable();
  const selected = readTriageSelectedObservationV1(props.row);
  const descriptor = resolveTriageSourceDescriptorV1(context.targetedContributions, props.row.entryRef.source);
  const kind = descriptor?.kinds.find((kind) => kind.id === props.row.entryRef.kindId);
  const snapshot = selected?.observation.snapshot;
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState<Record<string, unknown>>({});
  const [issues, setIssues] = React.useState<Record<string, string>>({});
  const [statusOpen, setStatusOpen] = React.useState(false);
  const write = useTriageTaskCommit(props.onApplied, { entryRef: props.row.entryRef,
    sourceInstanceId: selected?.sourceInstanceId ?? '' }, props.linkedSessionIds);
  const rebaseFields = write.rebaseFields;
  const capabilities = snapshot?.taskCapabilities ?? kind?.taskCapabilities;
  const fields = capabilities?.editFields ?? [];
  const values = rebaseFields ?? props.taskFields ?? null;
  // Missing fields remain unknown; a partial exact read never grants editing of an absent value.
  const editable = values === null ? [] : fields.filter(field => Object.hasOwn(values, field));
  const readFailed = !props.disabled && fields.length > 0 && (values === null || editable.length !== fields.length);
  const workflow = useTaskTransitionFields(write, selected === null ? null : { entryRef: props.row.entryRef,
    sourceInstanceId: selected.sourceInstanceId, lastKnownLocator: selected.observation.locator },
    props.disabled || executionUnavailable || props.instance === undefined || write.busy || write.checking || write.result?.kind === 'uncertain', descriptor?.displayName);
  const candidates = React.useMemo(() => triageTaskRelationCandidatesV1(props.relationRows ?? []), [props.relationRows]);
  const labelTones = useTriageTaskLabelTones(snapshot?.labelColors, props.onApplied);
  // A source that declares a directory but whose read carried none says so and reads the entry again on request.
  const assigneeDirectory = useTriageTaskAssigneeDirectory({ scope: context.accountScope,
    happier: sameTriageSourceIdentity(props.row.entryRef.source, INTERNAL_TASK_SOURCE_V1),
    ...(capabilities?.fieldChoices === true && props.taskFieldChoices?.assigneeIds === undefined ? { otherwise: { status: 'unavailable' as const,
      unavailableLabel: text('plugins.triage.tasks.assignees.readFailed', 'The people list couldn\u2019t be read'),
      retry: () => { void props.onApplied().catch(() => undefined); } } } : {}) });
  const canEdit = kind?.task === true && fields.length > 0
    && resolveTriageSourceTaskOperationV1(context.targetedContributions, props.row.entryRef.source, 'edit') !== undefined;
  if (kind?.task !== true || selected === null || snapshot === undefined) {
    return props.children({ status: null, controls: null, relations: NO_TASK_RELATIONS, edit: null, form: null });
  }
  const transitions = resolveTriageSourceTaskOperationV1(context.targetedContributions, props.row.entryRef.source, 'transition') === undefined
    ? [] : capabilities?.transitions ?? [];
  const address = { v: 1, entryRef: props.row.entryRef, sourceInstanceId: selected.sourceInstanceId, lastKnownLocator: selected.observation.locator };
  const pending = props.disabled || executionUnavailable || props.instance === undefined || write.busy || write.checking;
  const disabled = pending || (write.result?.kind === 'uncertain' && rebaseFields === null);
  const statusDisabled = pending || write.result?.kind === 'uncertain';
  /** One deliberate change, one `tasks/edit-v1` carrying only the changed fields; the source decides it. */
  const commitFields = async (fields: TriageTaskFieldsV1) => {
    if (!canEdit || disabled || values === null) return;
    const changed = Object.fromEntries(Object.entries(fields).filter(([field, value]) => editable.includes(field as TriageTaskFieldV1)
      && !pluginJsonValuesEqual(value, values[field as TriageTaskFieldV1])));
    const parsed = TriageTaskFieldsV1Schema.safeParse(changed);
    if (!parsed.success || Object.keys(parsed.data).length === 0) return;
    await write.commit(TRIAGE_TASKS_EDIT_ACTION_LOCAL_ID_V1, { ...address, fields: parsed.data });
  };
  const textFields = editable.filter((field): field is (typeof TASK_TEXT_FIELDS)[number] => (TASK_TEXT_FIELDS as readonly string[]).includes(field));
  const openEditor = async () => {
    if (disabled || !canEdit) return;
    const current = values;
    if (current === null) return;
    setIssues({});
    setDraft(Object.fromEntries(TASK_TEXT_FIELDS.filter(field => Object.hasOwn(current, field)).map(field => [field, current[field]])));
    setEditing(true);
  };
  const checkAgain = async () => {
    if (await write.checkAgain()) setEditing(false);
  };
  // The status control says the task's current status in the source's own word ("In Review"); its menu is that
  // source's workflow. Its name keeps the operation for assistive technology.
  const currentStatus = snapshot.state.nativeLabel ?? null;
  const currentCategory = triageTaskStatusCategoryV1(snapshot.state);
  const transitionLabel = text('plugins.triage.tasks.transition', 'Change status');
  const transitionTrigger = currentStatus ?? transitionLabel;
  const transitionAccessibilityLabel = currentStatus === null ? transitionLabel : `${transitionLabel}, ${currentStatus}`;
  const statusMenu = taskStatusMenu(transitions, { label: currentStatus, state: snapshot.state }, transitionLabel);
  const valuesNotice = readFailed ? <Banner tone="warning" title={text('plugins.triage.tasks.editValuesUnavailable',
    'Some current task values could not be loaded. Only fully loaded fields can be edited.')} /> : null;
  const canEditText = canEdit && textFields.length > 0;
  // The Status button is a menu of the source's own transitions and leads the entry's one action row (lab t1); the
  // title and notes open from where the notes are. A source without a role never gets that control.
  const status = transitions.length === 0 ? null : <Menu open={statusOpen && !statusDisabled} onOpenChange={(open) => setStatusOpen(open && !statusDisabled)}
      trigger={transitionTrigger} triggerAccessibilityLabel={transitionAccessibilityLabel} triggerAppearance="control" disabled={statusDisabled}
      {...(currentCategory === null ? {} : { triggerTaskStatus: currentCategory })}
      items={statusMenu.items} radioGroups={statusMenu.radioGroups}
      onSelect={(value) => { const transition = transitions.find(candidate => candidate.id === value);
        if (transition !== undefined && value !== statusMenu.currentId) workflow.select(transition); }} />;
  const propertyValues = values ?? {};
  const propertyAssigneeLabels = new Map<string, string | null>(withAssigneeNames(assigneeLabels, assigneeDirectory));
  const assigneeIds = propertyValues.assigneeIds ?? [];
  if (assigneeIds.length === 1 && snapshot.assigneeLabel !== undefined && !propertyAssigneeLabels.has(assigneeIds[0]!)) {
    propertyAssigneeLabels.set(assigneeIds[0]!, snapshot.assigneeLabel);
  }
  const properties = projectTriageTaskPropertiesV1({ fields: editable, values: propertyValues, self: props.row.entryRef, candidates, assigneeLabels: propertyAssigneeLabels, assigneeFace: renderTriageTaskAssigneeFace,
    ...(props.taskFieldChoices === undefined ? {} : { fieldChoices: props.taskFieldChoices }),
    ...(assigneeDirectory === undefined ? {} : { assigneeDirectory }),
    ...(snapshot.assigneeLabel === undefined ? {} : { assigneeLabel: snapshot.assigneeLabel }),
    ...(labelTones === null ? {} : { labelTones }),
    commit: commitFields, text, locale: context.locale, busy: write.busy });
  const blockers = editable.includes('blockedBy') && Object.hasOwn(propertyValues, 'blockedBy')
    ? projectTriageTaskBlockersV1({ blockedBy: propertyValues.blockedBy ?? [], self: props.row.entryRef, candidates, text, commit: commitFields })
    : (snapshot.relations?.blockedBy?.length ?? 0) > 0
      ? projectTriageTaskBlockersV1({ blockedBy: snapshot.relations?.blockedBy ?? [], candidates, text }) : null;
  const subTasks = snapshot.relations?.children;
  const childEntries = (subTasks?.entries ?? []).map(ref => projectTriageTaskBlockersV1({ blockedBy: [ref], candidates, text }).entries[0]!);
  const controls = editing || (workflow.form === null && properties.length === 0 && !readFailed && write.result === null) ? null : <Stack gap="medium">
    {workflow.form}
    {properties.length === 0 ? null : <PropertyList items={properties} disabled={disabled}
      accessibilityLabel={text('plugins.triage.tasks.properties', 'Task properties')} testID={TRIAGE_TASK_PROPERTIES_TEST_ID_V1} />}
    {valuesNotice}
    <TaskWriteNotice result={write.result} sessionLink={write.sessionLink} checking={write.checking} onCheckAgain={checkAgain}
      context={{ sourceName: descriptor?.displayName, operation: 'edit', target: write.progress }}
      sourceUrl={selected.observation.locator.webUrl} />
  </Stack>;
  const openBlockers = blockers?.entries.filter(entry => entry.status !== 'completed' && entry.status !== 'canceled').length ?? 0;
  const relations: TriageEditTaskPlacementV1['relations'] = {
    blockedBy: blockers === null ? null : {
      title: triageTaskFieldTitleV1(text, 'blockedBy'),
      // The chapter says the relation's state beside its title ("1 open", "None yet"); its sheet holds only rows.
      summary: blockers.entries.length === 0 ? text('plugins.triage.tasks.relations.none', 'None yet')
        : text('plugins.triage.tasks.relations.open', '{count} open', { count: openBlockers }),
      list: (placement) => <RelationList {...(placement === 'section' ? { title: triageTaskFieldTitleV1(text, 'blockedBy') } : {})}
        accessibilityLabel={triageTaskFieldTitleV1(text, 'blockedBy')} entries={blockers.entries}
        {...(placement === 'section' ? { emptyLabel: text('plugins.triage.tasks.relations.none', 'None yet') } : {})} disabled={disabled}
        testID={TRIAGE_TASK_BLOCKERS_TEST_ID_V1}
        {...(editable.includes('blockedBy') ? { add: { label: text('plugins.triage.tasks.relations.addBlocker', 'Add a blocker'),
          choices: blockers.choices, onAdd: blockers.add } } : {})} />,
    },
    subTasks: subTasks === undefined || subTasks.total === 0 ? null : {
      ...(subTasks.completed === undefined ? {} : { summary: text('plugins.triage.tasks.relations.done', '{completed} of {total} done',
        { completed: subTasks.completed, total: subTasks.total }) }),
      title: text('plugins.triage.tasks.relations.subTasks', 'Sub-tasks'),
      list: (placement) => <RelationList {...(placement === 'section' ? { title: text('plugins.triage.tasks.relations.subTasks', 'Sub-tasks') } : {})}
        accessibilityLabel={text('plugins.triage.tasks.relations.subTasks', 'Sub-tasks')} entries={childEntries}
        {...(childEntries.length < subTasks.total ? { more: text('plugins.triage.tasks.relations.more', '{count} more at the source',
          { count: subTasks.total - childEntries.length }) } : {})} />,
    },
  };
  const saveText = async () => {
    if (!canEdit || disabled || values === null) return;
    const changed = Object.fromEntries(textFields.filter(field => !pluginJsonValuesEqual(draft[field], values[field]))
      .map(field => [field, draft[field]]));
    const fields = TriageTaskFieldsV1Schema.safeParse(changed);
    if (!fields.success) {
      setIssues(Object.fromEntries(fields.error.issues.map(issue => [String(issue.path[0]),
        text('plugins.triage.tasks.invalidField', 'Check this value before saving.')])));
      return;
    }
    if (Object.keys(fields.data).length === 0) { setEditing(false); return; }
    const result = await write.commit(TRIAGE_TASKS_EDIT_ACTION_LOCAL_ID_V1, { ...address, fields: fields.data });
    if (result?.kind === 'applied') setEditing(false);
  };
  const editText = (field: (typeof TASK_TEXT_FIELDS)[number], value: string) => { setDraft(previous => ({ ...previous, [field]: value })); setIssues({}); };
  const textHeld = disabled || !canEdit || write.busy;
  const draftTitle = typeof draft.title === 'string' ? draft.title : '';
  // The open editor is the task's own title and notes written in place, as a draft is; the notes are the host's one
  // Markdown editor (the source stores them as Markdown).
  const form = !editing ? null : <Stack gap="small" testID={TRIAGE_TASK_TEXT_EDITOR_TEST_ID_V1}>
    {valuesNotice}
    {!textFields.includes('title') ? null : <Form.TextField presentation="document" documentRole="title" multiline required
      label={triageTaskFieldTitleV1(text, 'title')} disabled={textHeld} value={draftTitle} onChange={value => editText('title', value)} />}
    {issues.title === undefined ? null : <Form.ValidationMessage message={issues.title} />}
    {!textFields.includes('body') ? null : <MarkdownEditor presentation="document" accessibilityLabel={triageTaskFieldTitleV1(text, 'body')}
      placeholder={text('plugins.triage.tasks.draft.notesPlaceholder', 'Add notes\u2026')} disabled={textHeld}
      value={typeof draft.body === 'string' ? draft.body : ''} onChange={value => editText('body', value)} />}
    {issues.body === undefined ? null : <Form.ValidationMessage message={issues.body} />}
    <Form.Actions>
      <Button title={text('plugins.triage.tasks.save', 'Save changes')} busy={write.busy}
        disabled={textHeld || (textFields.includes('title') && draftTitle.trim().length === 0)} onPress={saveText} />
      <Button title={text('plugins.triage.tasks.cancel', 'Cancel')} variant="secondary" disabled={write.busy} onPress={() => setEditing(false)} />
    </Form.Actions>
    <TaskWriteNotice result={write.result} sessionLink={write.sessionLink} checking={write.checking} onCheckAgain={checkAgain}
      context={{ sourceName: descriptor?.displayName, operation: 'edit', target: write.progress }}
      sourceUrl={selected.observation.locator.webUrl} />
  </Stack>;
  return props.children({ status, controls, relations, edit: canEditText ? { open: () => { void openEditor(); }, disabled } : null, form });
}

/**
 * The six theme colours a personal task label can take (owner ruling: theme tokens, never raw values). `id` is the
 * stored catalog token, so Blue and Purple keep their released `accent`/`info` ids while drawing in the theme's own hues.
 */
const TRIAGE_TASK_LABEL_TONES_V1 = Object.freeze([
  { id: 'secondaryText', tone: 'secondary', key: 'plugins.triage.tasks.labelColour.grey', fallback: 'Grey' },
  { id: 'accent', tone: 'blue', key: 'plugins.triage.tasks.labelColour.blue', fallback: 'Blue' },
  { id: 'info', tone: 'purple', key: 'plugins.triage.tasks.labelColour.purple', fallback: 'Purple' },
  { id: 'success', tone: 'success', key: 'plugins.triage.tasks.labelColour.green', fallback: 'Green' },
  { id: 'warning', tone: 'warning', key: 'plugins.triage.tasks.labelColour.amber', fallback: 'Amber' },
  { id: 'danger', tone: 'danger', key: 'plugins.triage.tasks.labelColour.red', fallback: 'Red' },
] as const satisfies readonly Readonly<{
  id: string;
  tone: PropertyNameTones['choices'][number]['tone'];
  key: string;
  fallback: string;
}>[]);

/**
 * Label colours where the source keeps them (personal tasks carry `labelColors`): the Account's own catalog, written
 * by its set/clear Actions and shown again once the window re-reads. `null` for a source without colours.
 */
function useTriageTaskLabelTones(
  colors: readonly Readonly<{ name: string; colorToken: string }>[] | undefined,
  onApplied: () => Promise<void>,
): Readonly<{ tones: PropertyNameTones }> | null {
  const host = usePluginHostApi();
  const text = usePluginTranslation();
  const scope = useSurfaceContext().accountScope;
  return React.useMemo(() => {
    if (colors === undefined || scope === undefined) return null;
    const tokenOf = (name: string) => colors.find((color) => color.name === name)?.colorToken ?? null;
    const choices = TRIAGE_TASK_LABEL_TONES_V1.map((choice) => ({ id: choice.id, tone: choice.tone, label: text(choice.key, choice.fallback) }));
    return {
      tones: {
        choices,
        valueOf: tokenOf,
        onCommit: async (name: string, colorToken: (typeof TRIAGE_TASK_LABEL_TONES_V1)[number]['id'] | null) => {
          const target = { scope: { serverId: scope.serverId, accountId: scope.accountId }, name };
          const result = await (colorToken === null
            ? host.executeAction('tasks.internal.labels.clearColor', target)
            : host.executeAction('tasks.internal.labels.setColor', { ...target, colorToken }));
          if (result.status === 'applied') void Promise.resolve().then(onApplied).catch(() => {
            host.diagnostic({ code: 'triage_task_reread_unavailable', severity: 'warning',
              message: 'The label colour was saved, but its aggregate reread was unavailable.' });
          });
          return result;
        },
      },
    };
  }, [colors, host, onApplied, scope, text]);
}
