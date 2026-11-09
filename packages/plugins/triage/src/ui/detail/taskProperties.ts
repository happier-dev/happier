import type { ReactNode } from 'react';
import type {
  PropertyChoice,
  PropertyListItem,
  PropertyNameTones,
  RelationListEntry,
  TaskStatusCategory,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';
import {
  triageTaskStatusCategoryV1,
  type TriageEntryRefV1,
  type TriageTaskFieldChoicesV1,
  type TriageTaskFieldV1,
  type TriageTaskFieldsV1,
} from '@happier-dev/triage-protocol/v1';
import { sameTriageSourceIdentity } from '../../corpus/identity/components.js';
import {
  triageEntryRowKey,
  type TriageListRowV1,
} from '../../projection/listWindow.js';
import { readTriageSelectedObservationV1 } from '../window/selectedObservation.js';
import type { HostTaskShareRef } from '@happier-dev/plugin-ui/hostApi';
import { internalTaskOwnerAccountIdV1, isInternalTaskReferenceV1 } from '../../internalTasks/identity.js';

type Text = ReturnType<typeof usePluginTranslation>;

/** The fields a task's property list carries; title and notes are its text, blockers its relation list. */
export const TRIAGE_TASK_PROPERTY_FIELDS_V1 = [
  'assigneeIds',
  'labelIds',
  'scopeId',
  'projectId',
  'priority',
  'dueDate',
  'estimate',
  'parent',
] as const satisfies readonly TriageTaskFieldV1[];

export const TRIAGE_TASK_FIELD_TITLES_V1 = {
  title: 'Title',
  body: 'Notes',
  assigneeIds: 'Assignees',
  labelIds: 'Labels',
  scopeId: 'Repository or project',
  projectId: 'Project',
  priority: 'Priority',
  dueDate: 'Due date',
  estimate: 'Estimate',
  parent: 'Parent',
  blockedBy: 'Blocked by',
} as const satisfies Record<TriageTaskFieldV1, string>;

export function triageTaskFieldTitleV1(
  text: Text,
  field: TriageTaskFieldV1,
): string {
  return text(
    `plugins.triage.tasks.fields.${field}`,
    TRIAGE_TASK_FIELD_TITLES_V1[field],
  );
}

/** An entry the reader can relate this task to, read from the rows the window already holds (no extra read). */
export type TriageTaskRelationCandidateV1 = Readonly<{
  key: string;
  ref: TriageEntryRefV1;
  title: string;
  designation?: string;
  status: TaskStatusCategory | null;
}>;

export function triageTaskRelationCandidatesV1(
  rows: readonly TriageListRowV1[],
): ReadonlyMap<string, TriageTaskRelationCandidateV1> {
  const candidates = new Map<string, TriageTaskRelationCandidateV1>();
  for (const row of rows) {
    const snapshot = readTriageSelectedObservationV1(row)?.observation.snapshot;
    if (snapshot === undefined) continue;
    const key = triageEntryRowKey(row.entryRef);
    candidates.set(key, {
      key,
      ref: row.entryRef,
      title: snapshot.title,
      ...(snapshot.designation === undefined
        ? {}
        : { designation: snapshot.designation }),
      status: triageTaskStatusCategoryV1(snapshot.state),
    });
  }
  return candidates;
}

function describe(
  ref: TriageEntryRefV1,
  candidates: ReadonlyMap<string, TriageTaskRelationCandidateV1>,
  text: Text,
): TriageTaskRelationCandidateV1 {
  const key = triageEntryRowKey(ref);
  return (
    candidates.get(key) ?? {
      key,
      ref,
      status: null,
      title: text(
        'plugins.triage.tasks.relations.unlisted',
        'An entry outside the current list',
      ),
    }
  );
}

function choice(candidate: TriageTaskRelationCandidateV1): PropertyChoice {
  return {
    id: candidate.key,
    label: candidate.title,
    ...(candidate.designation === undefined
      ? {}
      : { subtitle: candidate.designation }),
  };
}

/** A day as the source wrote it (`YYYY-MM-DD`, possibly with a time), read as that calendar day without a timezone. */
function calendarDay(value: string): string | null {
  const day = /^(\d{4}-\d{2}-\d{2})/.exec(value)?.[1];
  return day ?? null;
}

function formatDay(day: string, locale: string | undefined): string {
  const [year, month, date] = day.split('-').map(Number) as [
    number,
    number,
    number,
  ];
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(year, month - 1, date)));
  } catch {
    return day;
  }
}

export type TriageTaskPropertyInputV1 = Readonly<{
  /** The fields this source accepts here (create or edit), in the source's declaration. */
  fields: readonly TriageTaskFieldV1[];
  /** The exact current values; a field without a value here is not offered (unknown is not empty). */
  values: Readonly<Partial<TriageTaskFieldsV1>>;
  /** The task itself, never offered as its own parent or blocker; absent for a draft. */
  self?: TriageEntryRefV1;
  candidates: ReadonlyMap<string, TriageTaskRelationCandidateV1>;
  /** Display names already resolved by the person owner; native ids remain the editor's values. */
  assigneeLabels?: ReadonlyMap<string, string | null>;
  /** Readable snapshot value when the source does not offer an editable assignee field. */
  assigneeLabel?: string | null;
  /** The person owner's mark for one assignee's shown name, drawn before it (lab t1: the avatar, then "You"). */
  assigneeFace?: (name: string) => ReactNode;
  /** The source's own directory for these fields: people and labels are picked from it rather than typed. */
  fieldChoices?: TriageTaskFieldChoicesV1;
  /** The labels' colours, when the source keeps them (personal tasks): chosen in the Labels editor, drawn as each chip's dot. */
  labelTones?: Readonly<{ tones: PropertyNameTones }>;
  commit(fields: TriageTaskFieldsV1): unknown;
  text: Text;
  locale?: string;
  busy?: boolean;
}>;

/** The task's typed properties, one per declared field with a known value; each change commits only its field. */
export function projectTriageTaskPropertiesV1(
  input: TriageTaskPropertyInputV1,
): PropertyListItem[] {
  const { values, text } = input;
  const label = (field: TriageTaskFieldV1) =>
    triageTaskFieldTitleV1(text, field);
  const busy = input.busy === true ? { busy: true } : {};
  const items: PropertyListItem[] = [];
  for (const field of TRIAGE_TASK_PROPERTY_FIELDS_V1) {
    if (!input.fields.includes(field) || !Object.hasOwn(values, field)) {
      if (field === 'assigneeIds' && input.assigneeLabel !== undefined) {
        items.push({ id: field, label: label(field), value: input.assigneeLabel,
          ...(input.assigneeLabel !== null && input.assigneeFace !== undefined
            ? { valueLeading: input.assigneeFace(input.assigneeLabel) } : {}) });
      }
      continue;
    }
    if (field === 'assigneeIds' || field === 'labelIds') {
      const current = values[field] ?? [];
      const shown = field === 'assigneeIds' ? current.flatMap(id => {
        const name = input.assigneeLabels?.has(id) ? input.assigneeLabels.get(id) : id;
        return name == null ? [] : [name];
      }) : current;
      const directory = input.fieldChoices?.[field];
      const person = field === 'assigneeIds';
      items.push({
        id: field,
        label: label(field),
        value: shown.length === 0 ? null : shown.join(', '),
        ...(field === 'assigneeIds' && shown.length === 1 && input.assigneeFace !== undefined
          ? { valueLeading: input.assigneeFace(shown[0]!) } : {}),
        ...busy,
        // A label's colour is kept on the name, so personal task labels stay typed names with their colours.
        editor: directory !== undefined && !(field === 'labelIds' && input.labelTones !== undefined) ? {
          kind: 'choices',
          searchable: true,
          value: current,
          // A person or label the directory no longer lists can still be removed from this task.
          choices: [...directory, ...current.filter(id => !directory.some(choice => choice.id === id)).map(id => ({ id, label: id }))]
            .map(choice => ({ ...choice, ...(person ? { person: choice.label } : {}) })),
          ...(field === 'labelIds' ? { chips: true } : {}),
          onCommit: (next) => input.commit({ [field]: [...next] }),
        } : {
          kind: 'list',
          value: current,
          onCommit: (next) => input.commit({ [field]: [...next] }),
          ...(field === 'labelIds' ? { chips: true } : {}),
          ...(field === 'labelIds' && input.labelTones !== undefined ? { tones: input.labelTones.tones } : {}),
        },
      });
    } else if (field === 'scopeId') {
      const current = values.scopeId ?? null;
      items.push({
        id: field,
        label: label(field),
        value: current,
        clearable: false,
        ...busy,
        editor: {
          kind: 'text',
          value: current,
          onCommit: (next) =>
            next === null ? undefined : input.commit({ scopeId: next.trim() }),
        },
      });
    } else if (field === 'projectId') {
      const current = values.projectId ?? null;
      items.push({
        id: field,
        label: label(field),
        value: current,
        ...busy,
        editor: {
          kind: 'text',
          value: current,
          onCommit: (next) =>
            input.commit({ projectId: next === null ? null : next.trim() }),
        },
      });
    } else if (field === 'priority') {
      const current = values.priority ?? null;
      items.push({
        id: field,
        label: label(field),
        value: current === null ? null : String(current),
        ...busy,
        editor:
          typeof current === 'string'
            ? {
                kind: 'text',
                value: current,
                onCommit: (next) =>
                  input.commit({
                    priority: next === null ? null : next.trim(),
                  }),
              }
            : {
                kind: 'number',
                value: current,
                integer: true,
                onCommit: (next) => input.commit({ priority: next }),
              },
      });
    } else if (field === 'estimate') {
      const current = values.estimate ?? null;
      items.push({
        id: field,
        label: label(field),
        value: current === null ? null : String(current),
        ...busy,
        editor: {
          kind: 'number',
          value: current,
          onCommit: (next) => input.commit({ estimate: next }),
        },
      });
    } else if (field === 'dueDate') {
      const current =
        values.dueDate == null ? null : calendarDay(values.dueDate);
      items.push({
        id: field,
        label: label(field),
        value:
          current === null
            ? (values.dueDate ?? null)
            : formatDay(current, input.locale),
        ...busy,
        editor: {
          kind: 'date',
          value: current,
          onCommit: (next) => input.commit({ dueDate: next }),
        },
      });
    } else if (field === 'parent') {
      const current =
        values.parent == null
          ? null
          : describe(values.parent, input.candidates, text);
      const self =
        input.self === undefined ? null : triageEntryRowKey(input.self);
      // A parent lives in the same source (a Linear issue's parent is a Linear issue).
      const own = input.self?.source ?? null;
      const choices = [...input.candidates.values()].filter(
        (candidate) =>
          candidate.key !== self &&
          (own === null || sameTriageSourceIdentity(candidate.ref.source, own)),
      );
      if (
        current !== null &&
        !choices.some((candidate) => candidate.key === current.key)
      )
        choices.unshift(current);
      items.push({
        id: field,
        label: label(field),
        value:
          current === null
            ? null
            : current.designation === undefined
              ? current.title
              : `${current.designation} ${current.title}`,
        ...busy,
        editor: {
          kind: 'choice',
          value: current?.key ?? null,
          choices: choices.map(choice),
          onCommit: (next) => {
            if (next === null) return input.commit({ parent: null });
            const chosen = choices.find((candidate) => candidate.key === next);
            return chosen === undefined
              ? undefined
              : input.commit({ parent: chosen.ref });
          },
        },
      });
    }
  }
  return items;
}

/** What blocks the task, as relation rows: every blocker it holds, the ones the window can name by their title. */
export function projectTriageTaskBlockersV1(
  input: Readonly<{
    blockedBy: readonly TriageEntryRefV1[];
    self?: TriageEntryRefV1;
    candidates: ReadonlyMap<string, TriageTaskRelationCandidateV1>;
    text: Text;
    commit?(fields: TriageTaskFieldsV1): unknown;
  }>,
): Readonly<{
  entries: RelationListEntry[];
  choices: PropertyChoice[];
  add(id: string): unknown;
  /** The same blockers as one property, where they are a value rather than a chapter (a draft before it exists). */
  property: PropertyListItem;
}> {
  const current = input.blockedBy.map((ref) =>
    describe(ref, input.candidates, input.text),
  );
  const held = new Set(current.map((candidate) => candidate.key));
  const self = input.self === undefined ? null : triageEntryRowKey(input.self);
  const choices = [...input.candidates.values()].filter(
    (candidate) => candidate.key !== self && !held.has(candidate.key),
  );
  return {
    entries: current.map((candidate, index) => ({
      id: candidate.key,
      title: candidate.title,
      ...(candidate.designation === undefined
        ? {}
        : { designation: candidate.designation }),
      ...(candidate.status === null ? {} : { status: candidate.status }),
      ...(input.commit === undefined
        ? {}
        : {
            onRemove: () =>
              input.commit!({
                blockedBy: input.blockedBy.filter((_, at) => at !== index),
              }),
          }),
    })),
    choices: choices.map(choice),
    add: (id) => {
      const chosen = choices.find((candidate) => candidate.key === id);
      return chosen === undefined || input.commit === undefined
        ? undefined
        : input.commit({ blockedBy: [...input.blockedBy, chosen.ref] });
    },
    property: {
      id: 'blockedBy',
      label: triageTaskFieldTitleV1(input.text, 'blockedBy'),
      value: current.length === 0 ? null : current.map((candidate) => candidate.title).join(', '),
      ...(input.commit === undefined ? {} : { editor: {
        kind: 'choices' as const,
        value: current.map((candidate) => candidate.key),
        choices: [...current, ...choices].map(choice),
        onCommit: (next: readonly string[]) => input.commit!({ blockedBy: next.flatMap((key) => {
          const chosen = [...current, ...choices].find((candidate) => candidate.key === key);
          return chosen === undefined ? [] : [chosen.ref];
        }) }),
      } }),
    },
  };
}

/**
 * The host ShareSheet's exact task identity for a selected entry, or null when it is not a Happier task or the
 * viewer's Home/Account is not known. A personal alias names the viewer as owner; an `account:` scope keeps its owner.
 */
export function readTriageTaskShareRefV1(
  entryRef: TriageEntryRefV1,
  viewer: Readonly<{ serverId?: string; accountId?: string }> | undefined,
): HostTaskShareRef | null {
  if (!isInternalTaskReferenceV1(entryRef) || viewer?.serverId === undefined || viewer.accountId === undefined) return null;
  const ownerAccountId = internalTaskOwnerAccountIdV1(entryRef, viewer.accountId);
  if (ownerAccountId === null) return null;
  return { taskId: entryRef.entryId, ownerAccountId, scope: { serverId: viewer.serverId, accountId: viewer.accountId } };
}
