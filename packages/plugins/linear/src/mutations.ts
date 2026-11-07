import type { LinearSourceContext } from './api.js';
import {
  TriageTaskCreateInputV1Schema, TriageTaskEditInputV1Schema, TriageTaskTransitionInputV1Schema,
  type TriageTaskFieldsV1, type TriageTaskWriteResultV1, type TriageSourceFailureV1,
  type TriageConfiguredSourceInstanceV1, type TriageSourceEntryLocalRefV1,
} from '@happier-dev/triage-protocol/v1';
import { settleAtMostOnceProviderWrite } from '@happier-dev/triage-sources/runtime';
import { LINEAR_CREATE_FIELDS, LINEAR_EDIT_FIELDS, LINEAR_PLUGIN_ID, LINEAR_SOURCE_ID, LinearCommentInputSchema, linearIncludesTeam, type LinearIssue } from './contracts.js';
import { failureFrom, linearFailure, record, requestLinearGraphql } from './api.js';
import { admitLinearInstance, collectLinearDetail, projectLinearIssue, readLinearIssue } from './source.js';

export type LinearWriteResult = TriageTaskWriteResultV1;
type EntryInput = Readonly<{ instance: TriageConfiguredSourceInstanceV1; localRef: TriageSourceEntryLocalRefV1 }>;
type Observation = ReturnType<typeof projectLinearIssue>;
type Dispatch = Readonly<{ kind: 'accepted'; id: string }> | Readonly<{ kind: 'unknown'; failure: TriageSourceFailureV1 }> | Readonly<{ kind: 'failed'; failure: TriageSourceFailureV1 }>;

function refusedFields(fields: TriageTaskFieldsV1, creating: boolean): string | undefined {
  const supported: readonly string[] = creating ? LINEAR_CREATE_FIELDS : LINEAR_EDIT_FIELDS;
  if (Object.keys(fields).some((field) => !supported.includes(field))) return 'linear/unsupportedField';
  if (new Set(fields.assigneeIds).size > 1) return 'linear/singleAssigneeRequired';
  if (fields.priority !== undefined && (typeof fields.priority !== 'number' || !Number.isInteger(fields.priority) || fields.priority < 0 || fields.priority > 4)) return 'linear/priorityInvalid';
  const parent = fields.parent;
  if (parent && (parent.source.pluginId !== LINEAR_PLUGIN_ID || parent.source.localId !== LINEAR_SOURCE_ID
    || parent.kindId !== 'issue' || parent.collisionScope !== 'linear')) return 'linear/parentSourceMismatch';
  return undefined;
}

function nativeFields(fields: TriageTaskFieldsV1): Record<string, unknown> {
  return {
    ...(fields.title === undefined ? {} : { title: fields.title }),
    ...(fields.body === undefined ? {} : { description: fields.body }),
    ...(fields.assigneeIds === undefined ? {} : { assigneeId: fields.assigneeIds[0] ?? null }),
    ...(fields.projectId === undefined ? {} : { projectId: fields.projectId }),
    ...(fields.priority === undefined ? {} : { priority: fields.priority }),
    ...(fields.dueDate === undefined ? {} : { dueDate: fields.dueDate }),
    ...(fields.estimate === undefined ? {} : { estimate: fields.estimate }),
    ...(fields.parent === undefined ? {} : { parentId: fields.parent?.entryId ?? null }),
  };
}

function fieldsMatch(issue: LinearIssue, fields: TriageTaskFieldsV1): boolean {
  return (fields.title === undefined || issue.title === fields.title)
    && (fields.scopeId === undefined || issue.team.id === fields.scopeId)
    && (fields.body === undefined || (issue.description === null ? '' : issue.description) === fields.body)
    && (fields.assigneeIds === undefined || (issue.assignee?.id ?? null) === (fields.assigneeIds[0] ?? null))
    && (fields.projectId === undefined || (issue.project?.id ?? null) === fields.projectId)
    && (fields.priority === undefined || issue.priority === fields.priority)
    && (fields.dueDate === undefined || issue.dueDate === fields.dueDate)
    && (fields.estimate === undefined || issue.estimate === fields.estimate)
    && (fields.parent === undefined || (issue.parent?.id ?? null) === (fields.parent?.entryId ?? null));
}

async function dispatchMutation(input: EntryInput['instance'], operationName: string, query: string,
  variables: Record<string, unknown>, payloadName: string, entityName: string, context: LinearSourceContext): Promise<Dispatch> {
  try {
    const { account } = admitLinearInstance(input);
    const data = await requestLinearGraphql({ context, account, operationName, query, variables });
    const payload = record(data[payloadName]);
    if (payload.success !== true) throw linearFailure('writeUnconfirmed', 'unknown');
    const id = record(payload[entityName]).id;
    if (typeof id !== 'string' || !id) throw linearFailure('writeUnconfirmed', 'unknown');
    return { kind: 'accepted', id };
  } catch (error) {
    const failure = failureFrom(error, context.signal);
    // These provider refusals establish no effect. Transport loss, cancellation,
    // partial GraphQL errors and malformed success cannot establish that fact.
    return { kind: ['authentication', 'permission', 'rateLimit'].includes(failure.class) ? 'failed' : 'unknown', failure };
  }
}

async function settleWrite(dispatch: () => Promise<Dispatch>, confirm: (result: Dispatch) => Promise<LinearWriteResult>): Promise<LinearWriteResult> {
  let dispatched: Dispatch | undefined;
  const settled = await settleAtMostOnceProviderWrite<Dispatch, Observation, TriageSourceFailureV1>({
    dispatch: async () => { dispatched = await dispatch(); return dispatched; },
    mayHaveChanged: (result) => result.kind !== 'failed',
    confirm: async () => {
      const result = await confirm(dispatched!);
      return result.kind === 'applied' || result.kind === 'uncertain' ? result : { kind: 'uncertain' };
    },
  });
  if (settled.kind === 'settled') return settled.result.kind === 'failed'
    ? { kind: 'failed', failure: settled.result.failure } : { kind: 'uncertain' };
  return settled.kind === 'unchanged' ? { kind: 'uncertain', observation: settled.observation } : settled;
}

async function confirmIssue(input: EntryInput, fields: TriageTaskFieldsV1, context: LinearSourceContext,
  options: Readonly<{ stateId?: string; addedLabels?: readonly string[]; removedLabels?: readonly string[] }> = {}): Promise<LinearWriteResult> {
  try {
    const read = await readLinearIssue(input, context, true);
    const observation = projectLinearIssue(read.issue, read.viewer);
    let matches = fieldsMatch(read.issue, fields) && (options.stateId === undefined || read.issue.state.id === options.stateId);
    if (fields.labelIds !== undefined) {
      const labels = new Set((await collectLinearDetail(input, 'labels', context)).map((label) => label.id));
      matches &&= (options.addedLabels ?? fields.labelIds).every((id) => labels.has(id))
        && (options.removedLabels ?? []).every((id) => !labels.has(id));
    }
    return { kind: matches ? 'applied' : 'uncertain', observation };
  } catch (error) { return { kind: 'uncertain', failure: failureFrom(error, context.signal) }; }
}

export async function createLinearIssue(input: unknown, context: LinearSourceContext): Promise<LinearWriteResult> {
  const parsed = TriageTaskCreateInputV1Schema.parse(input);
  if (parsed.initialStatusId !== undefined) return { kind: 'refused', reason: 'linear/unsupportedField' };
  const refusal = refusedFields(parsed.fields, true);
  if (refusal || parsed.kindId !== 'issue') return { kind: 'refused', reason: refusal ?? 'linear/kindUnsupported' };
  try {
    const { account, configuration } = admitLinearInstance(parsed.instance);
    const teamId = parsed.fields.scopeId ?? (configuration.teams.kind === 'selected' && configuration.teams.unitIds.length === 1 ? configuration.teams.unitIds[0] : undefined);
    if (teamId === undefined) return { kind: 'refused', reason: 'linear/teamRequired' };
    if (!linearIncludesTeam(configuration, teamId)) return { kind: 'refused', reason: 'linear/teamMismatch' };
    const data = await requestLinearGraphql({ context, account, operationName: 'LinearTeam',
      query: 'query LinearTeam($id: String!) { team(id: $id) { id } }', variables: { id: teamId } });
    if (record(data.team).id !== teamId) throw linearFailure('teamMismatch');
    return await settleWrite(() => dispatchMutation(parsed.instance, 'LinearCreate',
      'mutation LinearCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id } } }',
      { input: { teamId, ...nativeFields(parsed.fields), ...(parsed.fields.labelIds === undefined ? {} : { labelIds: parsed.fields.labelIds }) } }, 'issueCreate', 'issue', context),
    async (result) => result.kind !== 'accepted' ? { kind: 'uncertain', ...(result.kind === 'unknown' ? { failure: result.failure } : {}) }
      : confirmIssue({ instance: parsed.instance, localRef: { kindId: 'issue', collisionScope: 'linear', entryId: result.id } }, { ...parsed.fields, scopeId: teamId }, context));
  } catch (error) { return { kind: 'failed', failure: failureFrom(error, context.signal) }; }
}

async function updateIssue(input: EntryInput, native: Record<string, unknown>, context: LinearSourceContext,
  confirm: () => Promise<LinearWriteResult>): Promise<LinearWriteResult> {
  return settleWrite(() => dispatchMutation(input.instance, 'LinearUpdate',
    'mutation LinearUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id } } }',
    { id: input.localRef.entryId, input: native }, 'issueUpdate', 'issue', context), async () => confirm());
}

export async function editLinearIssue(input: unknown, context: LinearSourceContext): Promise<LinearWriteResult> {
  const parsed = TriageTaskEditInputV1Schema.parse(input);
  const refusal = refusedFields(parsed.fields, false);
  if (refusal) return { kind: 'refused', reason: refusal };
  try {
    await readLinearIssue(parsed, context, true);
    const before = parsed.fields.labelIds === undefined ? [] : (await collectLinearDetail(parsed, 'labels', context)).map((label) => label.id);
    const requested = new Set(parsed.fields.labelIds);
    const addedLabels = [...requested].filter((id) => !before.includes(id));
    const removedLabels = before.filter((id) => !requested.has(id));
    return await updateIssue(parsed, { ...nativeFields(parsed.fields), ...(parsed.fields.labelIds === undefined ? {} : { addedLabelIds: addedLabels, removedLabelIds: removedLabels }) }, context,
      () => confirmIssue(parsed, parsed.fields, context, { addedLabels: parsed.fields.labelIds, removedLabels }));
  } catch (error) { return { kind: 'failed', failure: failureFrom(error, context.signal) }; }
}

export async function transitionLinearIssue(input: unknown, context: LinearSourceContext): Promise<LinearWriteResult> {
  const parsed = TriageTaskTransitionInputV1Schema.parse(input);
  if ((parsed.fieldValues?.length ?? 0) > 0) return { kind: 'refused', reason: 'linear/unsupportedField' };
  try {
    const current = await readLinearIssue(parsed, context);
    const states = await collectLinearDetail(parsed, 'transitions', context);
    if (!states.some((state) => state.id === parsed.transitionId)) return { kind: 'refused', reason: 'linear/transitionUnavailable' };
    if (current.issue.state.id === parsed.transitionId) return { kind: 'applied', observation: projectLinearIssue(current.issue, current.viewer) };
    return await updateIssue(parsed, { stateId: parsed.transitionId }, context, () => confirmIssue(parsed, {}, context, { stateId: parsed.transitionId }));
  } catch (error) { return { kind: 'failed', failure: failureFrom(error, context.signal) }; }
}

export async function commentLinearIssue(input: unknown, context: LinearSourceContext): Promise<LinearWriteResult> {
  const parsed = LinearCommentInputSchema.parse(input);
  try {
    await readLinearIssue(parsed, context);
    return await settleWrite(() => dispatchMutation(parsed.instance, 'LinearComment',
      'mutation LinearComment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }',
      { input: { issueId: parsed.localRef.entryId, body: parsed.body } }, 'commentCreate', 'comment', context), async (result) => {
      if (result.kind !== 'accepted') return { kind: 'uncertain', ...(result.kind === 'unknown' ? { failure: result.failure } : {}) };
      try {
        const { account } = admitLinearInstance(parsed.instance, parsed.localRef);
        const data = await requestLinearGraphql({ context, account, operationName: 'LinearCommentRead',
          query: 'query LinearCommentRead($id: String!) { comment(id: $id) { id body issue { id } } }', variables: { id: result.id } });
        const comment = record(data.comment);
        if (comment.id !== result.id || comment.body !== parsed.body || record(comment.issue).id !== parsed.localRef.entryId) return { kind: 'uncertain' };
        return confirmIssue(parsed, {}, context);
      } catch (error) { return { kind: 'uncertain', failure: failureFrom(error, context.signal) }; }
    });
  } catch (error) { return { kind: 'failed', failure: failureFrom(error, context.signal) }; }
}
