import type { LinearSourceContext } from './api.js';
import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import { isExternalActionResultWithinResponseEnvelopeLimitV1 } from '@happier-dev/plugin-sdk/actions';
import {
  TriageGetInputV1Schema, TriageListInstancesInputV1Schema, TriageScanInputV1Schema,
  TriageListInstancesResultV1Schema, TriageGetResultV1Schema, TriageScanResultV1Schema,
  TriageEntryLocatorV1Schema, MAX_TRIAGE_TEXT_UTF8_BYTES_V1, MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1,
  TriageListScopeUnitsConnectedAccountInputV1Schema, TriageListScopeUnitsResultV1Schema,
  type TriageListScopeUnitsResultV1, type TriageListScopeUnitsInputV1,
  projectTriageDisplayTextV1,
  type TriageGetResultV1, type TriageListInstancesResultV1, type TriageScanResultV1,
  type TriageConfiguredSourceInstanceV1, type TriageSourceEntryLocalRefV1, type TriageRowFactV1,
} from '@happier-dev/triage-protocol/v1';
import { advanceCursorCycleWalkV1, type CursorCycleWalkV1, deriveTriageConfiguredSourceInstanceDigestV1, readTriageSourceAccountListingV1 } from '@happier-dev/triage-sources/runtime';
import { fitActionResultPageV1 } from '@happier-dev/triage-sources/projection/actionResultSequence';
import { fitActionResultTextV1 } from '@happier-dev/triage-sources/projection/actionResultText';
import {
  LINEAR_PLUGIN_ID, LINEAR_SOURCE_ID, LINEAR_PURPOSE, LINEAR_SERVICE_ID, LINEAR_SORT_COLUMNS, LinearTeamSchema,
  LINEAR_CREATE_FIELDS, LINEAR_EDIT_FIELDS,
  readLinearConfiguration, linearIncludesTeam, linearConfiguredTeamUnits, LinearTeamCursorSchema, LinearContinuationSchema, LinearIssueSchema,
  LinearDetailInputSchema, LinearDetailResultSchema, LinearRelatedIssueSchema,
  type LinearConfiguration, type LinearIssue, type LinearDetailResult, type LinearDetailInput,
} from './contracts.js';
import { connection, record, linearFailure, LinearRequestError, failureFrom, requestLinearGraphql, LINEAR_ISSUE_FIELDS, LINEAR_PAGE_INFO, LINEAR_PAGE_SIZE } from './api.js';

export function admitLinearInstance(instance: TriageConfiguredSourceInstanceV1, localRef?: TriageSourceEntryLocalRefV1): Readonly<{ account: ConnectedAccountRef; configuration: LinearConfiguration }> {
  if (instance.instance.source.pluginId !== LINEAR_PLUGIN_ID || instance.instance.source.localId !== LINEAR_SOURCE_ID) throw linearFailure('instanceMismatch');
  if (localRef && (localRef.kindId !== 'issue' || localRef.collisionScope !== 'linear')) throw linearFailure('entryMismatch');
  return admitLinearScopeDraft(instance);
}

function admitLinearScopeKey(key: string): void {
  // Existing per-team keys remain valid identities for reconfiguration/restoration.
  if (key !== 'linear' && !/^linear\/[^/]+$/u.test(key)) throw linearFailure('teamMismatch');
}

function admitLinearScopeDraft(draft: Pick<TriageListScopeUnitsInputV1['draft'], 'binding' | 'localInstanceKey' | 'configuration'>) {
  const binding = draft.binding;
  if (binding.purpose !== LINEAR_PURPOSE || !('account' in binding)
    || binding.account.service.pluginId !== LINEAR_PLUGIN_ID || binding.account.service.localId !== LINEAR_SERVICE_ID) throw linearFailure('instanceMismatch');
  admitLinearScopeKey(draft.localInstanceKey);
  try { return { account: binding.account, configuration: readLinearConfiguration(draft.configuration.token) }; }
  catch { throw linearFailure('configurationInvalid'); }
}

export async function listLinearScopeUnits(input: unknown, context: LinearSourceContext): Promise<TriageListScopeUnitsResultV1> {
  const parsed = TriageListScopeUnitsConnectedAccountInputV1Schema.parse(input);
  try {
    const { account, configuration } = admitLinearScopeDraft(parsed.draft);
    if (parsed.mode === 'configured') return TriageListScopeUnitsResultV1Schema.parse({ kind: 'page', status: 'complete',
      selection: configuration.teams, units: linearConfiguredTeamUnits(configuration) });
    const query = parsed.query?.trim() ?? '';
    const cursor = parsed.cursor === undefined ? undefined : LinearTeamCursorSchema.parse(JSON.parse(parsed.cursor.token));
    if (cursor && cursor.query !== query) throw linearFailure('continuationChanged');
    const data = await requestLinearGraphql({ context, account, operationName: 'LinearTeams',
      query: `query LinearTeams($after: String, $filter: TeamFilter) { teams(first: ${LINEAR_PAGE_SIZE}, after: $after, filter: $filter) { nodes { id key name } ${LINEAR_PAGE_INFO} } }`,
      variables: { after: cursor?.after, filter: query ? { or: [{ name: { containsIgnoreCase: query } }, { key: { containsIgnoreCase: query } }] } : {} } });
    const page = connection(data.teams);
    if (page.after !== undefined && page.after === cursor?.after) throw linearFailure('cursorNotAdvancing');
    const units = page.nodes.map((raw) => {
      const team = LinearTeamSchema.parse(raw);
      return { id: team.id, label: projectTriageDisplayTextV1(team.name).value || team.id,
        ...(team.key ? { secondaryText: projectTriageDisplayTextV1(team.key).value } : {}) };
    });
    return TriageListScopeUnitsResultV1Schema.parse({ kind: 'page', selection: configuration.teams, units,
      ...(page.after === undefined ? { status: 'complete' } : { status: 'partial',
        nextCursor: { v: 1, token: JSON.stringify({ v: 1, after: page.after, query }) } }) });
  } catch (error) { return { kind: 'failed', failure: failureFrom(error, context.signal) }; }
}

async function viewerId(context: LinearSourceContext, account: ConnectedAccountRef): Promise<string> {
  const data = await requestLinearGraphql({ context, account, operationName: 'LinearViewer', query: 'query LinearViewer { viewer { id } }' });
  const id = record(data.viewer).id;
  if (typeof id !== 'string' || id.length === 0) throw linearFailure('viewerInvalid');
  return id;
}

export async function listLinearInstances(input: unknown, context: LinearSourceContext): Promise<TriageListInstancesResultV1> {
  TriageListInstancesInputV1Schema.parse(input);
  const listing = await readTriageSourceAccountListingV1({ connectedAccounts: context.services.connectedAccounts, purpose: LINEAR_PURPOSE, signal: context.signal });
  if (listing.kind === 'unbound') return { kind: 'complete', candidates: [], failures: [] };
  if (listing.kind === 'failed') return { kind: 'failed', failure: failureFrom(listing.error, context.signal) };
  const candidates = [];
  const failures = [];
  for (const listed of listing.listing.accounts) {
    const binding = { purpose: LINEAR_PURPOSE, account: listed.account };
    try {
      const data = await requestLinearGraphql({ context, account: listed.account, operationName: 'LinearWorkspace',
        query: 'query LinearWorkspace { viewer { organization { id name } } }' });
      const workspace = record(record(data.viewer).organization);
      if (typeof workspace.id !== 'string' || !workspace.id || typeof workspace.name !== 'string') throw linearFailure('responseInvalid');
      candidates.push({ v: 1 as const, binding, localInstanceKey: 'linear', keyStability: 'stable' as const,
        configuration: { v: 1 as const, token: JSON.stringify({ v: 1, teams: { kind: 'all' }, involvement: 'mine' }) },
        locator: { v: 1 as const, displayLabel: projectTriageDisplayTextV1(workspace.name).value || workspace.id } });
    } catch (error) { failures.push({ binding, failure: failureFrom(error, context.signal) }); }
  }
  return TriageListInstancesResultV1Schema.parse({
    kind: listing.listing.status === 'truncated' ? 'incomplete' : 'complete', candidates, failures,
    ...(listing.listing.status === 'truncated' ? { failure: { class: 'unknown', code: 'linear/accountListTruncated' } } : {}),
  });
}

export function projectLinearIssue(issue: LinearIssue, currentViewer: string): Extract<TriageGetResultV1, { kind: 'present' }> {
  let truncated = false;
  const text = (value: string, max = MAX_TRIAGE_TEXT_UTF8_BYTES_V1) => {
    const projection = projectTriageDisplayTextV1(value, max);
    truncated ||= projection.truncated;
    return projection.value;
  };
  const facts: TriageRowFactV1[] = [];
  const add = (id: string, label: string, value: string | undefined | null) => {
    if (!value) return;
    const projected = text(value, MAX_TRIAGE_ROW_FACT_VALUE_UTF8_BYTES_V1);
    if (projected) facts.push({ id, label, importance: 'secondary', value: { kind: 'text', value: projected } });
  };
  add('assignee', 'Assignee', issue.assignee?.name);
  add('priority', 'Priority', issue.priorityLabel);
  add('project', 'Project', issue.project?.name);
  add('cycle', 'Cycle', issue.cycle ? issue.cycle.name ?? String(issue.cycle.number) : undefined);
  add('parent', 'Parent issue', issue.parent?.identifier);
  add('due', 'Due date', issue.dueDate);
  if (issue.estimate !== null) add('estimate', 'Estimate', String(issue.estimate));
  const involvement: ('author' | 'assignee' | 'subscribed')[] = [];
  if (issue.creator?.id === currentViewer) involvement.push('author');
  if (issue.assignee?.id === currentViewer) involvement.push('assignee');
  if (issue.subscribers.nodes.some((subscriber) => subscriber.id === currentViewer)) involvement.push('subscribed');
  const locator = TriageEntryLocatorV1Schema.safeParse({ v: 1, displayPath: issue.identifier, webUrl: issue.url });
  if (!locator.success) truncated = true;
  const createdAtMs = Date.parse(issue.createdAt);
  const dueAtMs = issue.dueDate === null ? NaN : Date.parse(issue.dueDate);
  const completedAtMs = issue.completedAt == null ? NaN : Date.parse(issue.completedAt);
  const sourceUpdatedAtMs = Date.parse(issue.updatedAt);
  const observation = TriageGetResultV1Schema.parse({
    kind: 'present', localRef: { kindId: 'issue', collisionScope: 'linear', entryId: issue.id },
    locator: locator.success ? locator.data : { v: 1, displayPath: text(issue.identifier) || issue.id },
    snapshot: {
      v: 1, title: text(issue.title) || text(issue.identifier) || issue.id,
      ...(text(issue.identifier) ? { designation: text(issue.identifier) } : {}),
      scopeLabel: text(issue.team.name) || text(issue.team.key) || issue.team.id, scopeUnitId: issue.team.id,
      ...(issue.creator?.name && text(issue.creator.name) ? { authorLabel: text(issue.creator.name) } : {}),
      assigneeLabel: issue.assignee === null ? null : text(issue.assignee.name) || undefined,
      ...(Number.isFinite(createdAtMs) ? { createdAtMs } : {}),
      ...(Number.isFinite(dueAtMs) ? { dueDate: issue.dueDate } : {}),
      ...(issue.state.type === 'completed' && Number.isFinite(completedAtMs) ? { completedAtMs } : {}),
      state: linearState(issue.state), facts,
      ...(issue.parent === null ? {} : { relations: { parent: linearEntryRef(issue.parent.id) } }),
      taskCapabilities: { createFields: LINEAR_CREATE_FIELDS, editFields: LINEAR_EDIT_FIELDS },
      ...(truncated ? { projectionTruncated: true } : {}),
    },
    viewer: { involvement }, ...(Number.isFinite(sourceUpdatedAtMs) ? { sourceUpdatedAtMs } : {}),
  });
  if (observation.kind !== 'present') throw linearFailure('projectionInvalid');
  return observation;
}

export function linearEntryRef(entryId: string) {
  return { source: { pluginId: LINEAR_PLUGIN_ID, localId: LINEAR_SOURCE_ID }, kindId: 'issue', collisionScope: 'linear', entryId };
}

export function linearState(state: Readonly<{ type: string; name: string }>): Extract<TriageGetResultV1, { kind: 'present' }>['snapshot']['state'] {
  const nativeLabel = projectTriageDisplayTextV1(state.name).value;
  const label = nativeLabel ? { nativeLabel } : {};
  switch (state.type) {
    case 'backlog': case 'unstarted': case 'started': return { presentation: 'active', stage: state.type, ...label };
    case 'triage': return { presentation: 'active', stage: 'unstarted', ...label };
    case 'completed': return { presentation: 'resolved', completionReason: 'completed', ...label };
    case 'canceled': return { presentation: 'closed', completionReason: 'canceled', ...label };
    default: return { presentation: 'unknown', ...label };
  }
}

function involvementFilter(kind: LinearConfiguration['involvement'], viewer: string): Record<string, unknown> {
  const assignee = { assignee: { id: { eq: viewer } } };
  const author = { creator: { id: { eq: viewer } } };
  const subscribed = { subscribers: { some: { id: { eq: viewer } } } };
  return kind === 'mine' ? { or: [assignee, author, subscribed] } : kind === 'assignee' ? assignee : kind === 'author' ? author : kind === 'subscribed' ? subscribed : {};
}

export async function scanLinearSource(input: unknown, context: LinearSourceContext): Promise<TriageScanResultV1> {
  const parsed = TriageScanInputV1Schema.parse(input);
  try {
    const { account, configuration } = admitLinearInstance(parsed.instance);
    const sort = parsed.sort ?? { field: 'created', direction: 'desc' } as const;
    const column = LINEAR_SORT_COLUMNS.get(sort.field);
    if (column === undefined) throw linearFailure('sortUnsupported');
    const backward = sort.direction === 'asc';
    const digest = deriveTriageConfiguredSourceInstanceDigestV1(parsed.instance);
    const continuation = parsed.page.kind === 'continuation' ? LinearContinuationSchema.parse(JSON.parse(parsed.page.continuation.token)) : undefined;
    const completedSinceMs = parsed.completed?.kindIds.includes('issue') ? parsed.completed.sinceMs : undefined;
    if (continuation && (continuation.digest !== digest || continuation.sort.field !== sort.field
      || continuation.sort.direction !== sort.direction)) throw linearFailure('continuationChanged');
    if (continuation && continuation.completedSinceMs !== completedSinceMs) throw linearFailure('continuationChanged');
    const viewer = continuation?.viewerId ?? await viewerId(context, account);
    const limit = continuation?.limit ?? (parsed.page.kind === 'initial' ? parsed.page.limit : 1);
    const data = await requestLinearGraphql({ context, account, operationName: 'LinearIssues',
      query: `query LinearIssues($filter: IssueFilter!, ${backward ? '$before: String, $last: Int!' : '$after: String, $first: Int!'}, $viewerId: ID!) {
        issues(filter: $filter, ${backward ? 'last: $last, before: $before' : 'first: $first, after: $after'}, orderBy: ${column}) { nodes { ${LINEAR_ISSUE_FIELDS} } ${backward ? 'pageInfo { hasPreviousPage startCursor }' : LINEAR_PAGE_INFO} }
      }`, variables: { filter: { ...(configuration.teams.kind === 'all' ? {} : { team: { id: configuration.teams.unitIds.length === 1
        ? { eq: configuration.teams.unitIds[0] } : { in: configuration.teams.unitIds } } }),
        ...(completedSinceMs === undefined ? involvementFilter(configuration.involvement, viewer) : { and: [
          involvementFilter(configuration.involvement, viewer),
          { or: [{ state: { type: { neq: 'completed' } } }, { completedAt: { gte: new Date(completedSinceMs).toISOString() } }] },
        ] }) }, ...(backward ? { before: continuation?.after, last: Math.min(limit, LINEAR_PAGE_SIZE) }
          : { after: continuation?.after, first: Math.min(limit, LINEAR_PAGE_SIZE) }), viewerId: viewer } });
    const page = connection(data.issues, backward ? 'backward' : 'forward');
    const observations = [];
    let omitted = 0;
    for (const raw of page.nodes) {
      const issue = LinearIssueSchema.safeParse(raw);
      if (!issue.success) { omitted += 1; continue; }
      if (!linearIncludesTeam(configuration, issue.data.team.id)) throw linearFailure('teamMismatch');
      observations.push(projectLinearIssue(issue.data, viewer));
    }
    const evidence = omitted > 0 ? { kind: 'partial', reason: 'linear/malformedIssue', omittedItemCount: omitted }
      : page.after !== undefined ? { kind: 'partial', reason: 'linear/pageContinues' } : { kind: 'walkFinished' };
    if (page.after !== undefined) {
      if (page.after === continuation?.after) throw linearFailure('cursorNotAdvancing');
      return TriageScanResultV1Schema.parse({ kind: 'page', observations, evidence, continuation: { v: 1, token: JSON.stringify({ v: 1, digest, after: page.after, viewerId: viewer, limit, sort,
        ...(completedSinceMs === undefined ? {} : { completedSinceMs }) }) } });
    }
    return TriageScanResultV1Schema.parse({ kind: 'complete', observations, evidence });
  } catch (error) { return { kind: 'failed', failure: failureFrom(error, context.signal) }; }
}

export async function readLinearIssue(input: Readonly<{ instance: TriageConfiguredSourceInstanceV1; localRef: TriageSourceEntryLocalRefV1 }>, context: LinearSourceContext, includeDescription = false): Promise<Readonly<{ issue: LinearIssue; viewer: string }>> {
  const { account, configuration } = admitLinearInstance(input.instance, input.localRef);
  const viewer = await viewerId(context, account);
  const data = await requestLinearGraphql({ context, account, operationName: 'LinearIssue', query: `query LinearIssue($id: String!, $viewerId: ID!) { issue(id: $id) { ${LINEAR_ISSUE_FIELDS} ${includeDescription ? 'description' : ''} } }`, variables: { id: input.localRef.entryId, viewerId: viewer } });
  if (data.issue === null) throw linearFailure('notFoundUnverified', 'unknown');
  const decoded = LinearIssueSchema.safeParse(data.issue);
  if (!decoded.success) throw linearFailure('responseInvalid');
  const issue = decoded.data;
  if (issue.id !== input.localRef.entryId || !linearIncludesTeam(configuration, issue.team.id)) throw linearFailure('entryMismatch');
  return { issue, viewer };
}

export async function getLinearEntry(input: unknown, context: LinearSourceContext): Promise<TriageGetResultV1> {
  const parsed = TriageGetInputV1Schema.parse(input);
  try {
    const read = await readLinearIssue(parsed, context, true);
    const observation = projectLinearIssue(read.issue, read.viewer);
    const children = await collectLinearDetail(parsed, 'children', context).catch(() => undefined);
    const blockedBy = await collectLinearDetail(parsed, 'blockedBy', context).catch(() => undefined);
    const states = await collectLinearDetail(parsed, 'transitions', context).catch(() => undefined);
    const labels = await collectLinearDetail(parsed, 'labels', context).catch(() => undefined);
    const taskFields = {
      title: read.issue.title,
      ...(read.issue.description === undefined ? {} : { body: read.issue.description ?? '' }),
      assigneeIds: read.issue.assignee === null ? [] : [read.issue.assignee.id],
      ...(labels === undefined ? {} : { labelIds: labels.map(label => label.id) }),
      projectId: read.issue.project?.id ?? null, priority: read.issue.priority,
      dueDate: read.issue.dueDate, estimate: read.issue.estimate,
      parent: read.issue.parent === null ? null : linearEntryRef(read.issue.parent.id),
    };
    const enriched = { ...observation, taskFields, snapshot: { ...observation.snapshot,
      relations: { ...observation.snapshot.relations,
        ...(children === undefined ? {} : { children: { total: children.length, entries: children.map((entry) => linearEntryRef(entry.id)), complete: true as const } }),
        ...(blockedBy === undefined ? {} : { blockedBy: blockedBy.map((entry) => linearEntryRef(entry.id)) }),
      },
      taskCapabilities: { ...observation.snapshot.taskCapabilities, ...(states === undefined ? {} : {
        transitions: states.map((state) => ({ id: state.id, label: projectTriageDisplayTextV1(state.title).value || state.id,
          state: linearState({ type: state.body ?? '', name: state.title }) })),
      }) },
    } };
    context.signal.throwIfAborted();
    if (isExternalActionResultWithinResponseEnvelopeLimitV1(enriched)) return TriageGetResultV1Schema.parse(enriched);
    // The native detail Action still pages every relation. A snapshot that cannot
    // carry the complete references omits that optional fact rather than lying.
    return TriageGetResultV1Schema.parse({ ...observation, snapshot: { ...observation.snapshot, projectionTruncated: true,
      relations: { ...observation.snapshot.relations, ...(children === undefined ? {} : { children: { total: children.length } }) },
    } });
  }
  catch (error) { return { kind: 'unresolved', localRef: parsed.localRef, failure: failureFrom(error, context.signal) }; }
}

export async function collectLinearDetail(input: Readonly<{ instance: TriageConfiguredSourceInstanceV1; localRef: TriageSourceEntryLocalRefV1 }>, section: LinearDetailInput['section'], context: LinearSourceContext): Promise<Extract<LinearDetailResult, { kind: 'ready' }>['entries']> {
  const entries = [];
  let after: string | undefined;
  let walk: CursorCycleWalkV1 | null = null;
  do {
    const result = await readLinearDetail({ v: 1, instance: input.instance, localRef: input.localRef, section, ...(after === undefined ? {} : { after }) }, context);
    if (result.kind === 'failed') throw new LinearRequestError(result.failure);
    if (result.truncated) throw linearFailure('detailIncomplete');
    entries.push(...result.entries);
    after = result.continuation;
    if (after !== undefined) {
      const next = advanceCursorCycleWalkV1(walk, after);
      if (next.kind === 'revisited') throw linearFailure('cursorNotAdvancing');
      walk = next.walk;
    }
  } while (after !== undefined);
  return entries;
}

export async function readLinearDetail(input: unknown, context: LinearSourceContext): Promise<LinearDetailResult> {
  const parsed = LinearDetailInputSchema.parse(input);
  try {
    const { account, configuration } = admitLinearInstance(parsed.instance, parsed.localRef);
    const field = parsed.section === 'blocks' ? 'relations' : parsed.section === 'blockedBy' ? 'inverseRelations' : parsed.section;
    const selections = {
      overview: 'description', labels: 'id name', children: 'id identifier title',
      blocks: 'type issue { id identifier title } relatedIssue { id identifier title }',
      blockedBy: 'type issue { id identifier title } relatedIssue { id identifier title }',
      comments: 'id body createdAt user { name }', transitions: 'id name type',
    };
    const selection = parsed.section === 'overview' ? 'description priorityLabel dueDate estimate assignee { name } project { name } cycle { name number } parent { identifier }'
      : parsed.section === 'transitions' ? `team { id states(first: ${LINEAR_PAGE_SIZE}, after: $after) { nodes { ${selections.transitions} } ${LINEAR_PAGE_INFO} } }`
      : `${field}(first: ${LINEAR_PAGE_SIZE}, after: $after) { nodes { ${selections[parsed.section]} } ${LINEAR_PAGE_INFO} }`;
    const data = await requestLinearGraphql({ context, account, operationName: 'LinearDetail', query: `query LinearDetail($id: String!${parsed.section === 'overview' ? '' : ', $after: String'}) { issue(id: $id) { id team { id } ${selection} } }`, variables: { id: parsed.localRef.entryId, ...(parsed.section === 'overview' ? {} : { after: parsed.after }) } });
    const native = record(data.issue);
    const teamId = record(native.team).id;
    if (native.id !== parsed.localRef.entryId || typeof teamId !== 'string' || !linearIncludesTeam(configuration, teamId)) throw linearFailure('entryMismatch');
    if (parsed.section === 'overview') {
      if (native.description !== null && typeof native.description !== 'string') throw linearFailure('responseInvalid');
      const named = (value: unknown): string | undefined => {
        if (value === null || value === undefined) return undefined;
        const node = record(value);
        return typeof node.name === 'string' ? node.name : typeof node.identifier === 'string' ? node.identifier
          : typeof node.number === 'number' ? String(node.number) : undefined;
      };
      const fields = [
        ['assignee', 'Assignee', named(native.assignee)], ['priority', 'Priority', native.priorityLabel], ['project', 'Project', named(native.project)],
        ['cycle', 'Cycle', named(native.cycle)], ['parent', 'Parent issue', named(native.parent)],
        ['due', 'Due date', native.dueDate], ['estimate', 'Estimate', native.estimate],
      ];
      const entries = fields.flatMap(([id, label, value]) => typeof id === 'string' && typeof label === 'string'
        && (typeof value === 'string' || typeof value === 'number') ? [{ id, title: label, body: String(value) }] : []);
      return fitActionResultTextV1(native.description ?? '', (description, truncated) => ({ kind: 'ready' as const, entries, description, ...(truncated ? { truncated: true as const } : {}) }));
    }
    const page = connection(parsed.section === 'transitions' ? record(native.team).states : native[field]);
    const entries = page.nodes.flatMap((node) => {
      const row = record(node);
      if (parsed.section === 'blocks' || parsed.section === 'blockedBy') {
        if (row.type !== 'blocks') return [];
        const related = LinearRelatedIssueSchema.parse(parsed.section === 'blocks' ? row.relatedIssue : row.issue);
        return [{ id: related.id, title: `${related.identifier} · ${related.title}` }];
      }
      if (parsed.section === 'children') {
        const child = LinearRelatedIssueSchema.parse(row);
        return [{ id: child.id, title: `${child.identifier} · ${child.title}` }];
      }
      if (typeof row.id !== 'string') throw linearFailure('responseInvalid');
      if (parsed.section === 'comments') {
        if (typeof row.body !== 'string' || typeof row.createdAt !== 'string') throw linearFailure('responseInvalid');
        const user = row.user === null ? undefined : record(row.user).name;
        return [{ id: row.id, title: `${typeof user === 'string' ? user : 'Linear'} · ${row.createdAt}`, body: row.body }];
      }
      if (typeof row.name !== 'string') throw linearFailure('responseInvalid');
      return [{ id: row.id, title: row.name, ...(parsed.section === 'transitions' && typeof row.type === 'string' ? { body: row.type } : {}) }];
    });
    if (page.after !== undefined && page.after === parsed.after) throw linearFailure('cursorNotAdvancing');
    const fitted = fitActionResultPageV1(entries, page.after, (included, omitted, continuation, continuationOmitted) => ({
      kind: 'ready' as const, entries: included, ...(continuation === undefined ? {} : { continuation }),
      ...(omitted > 0 || continuationOmitted ? { truncated: true as const } : {}),
    }));
    return LinearDetailResultSchema.parse(fitted.result);
  } catch (error) { return { kind: 'failed', failure: failureFrom(error, context.signal) }; }
}
