import {
  defineProtocolArray, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject,
  defineProtocolString, defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import {
  TriageSourceFailureV1Schema, TriageListSortV1Schema, type TriageListSortFieldV1,
  TriageConfiguredSourceConnectedAccountInstanceV1Schema, TriageSourceEntryLocalRefV1Schema,
  TriageEntryLocatorV1Schema,
  TriageSourceScopeSelectionV1Schema, TriageSourceScopeUnitV1Schema,
  TriageSourceInstanceConfigurationV1Schema,
  type TriageSourceScopeUnitV1, type TriageSourceScopeSelectionV1, type TriageSourceInstanceDraftV1,
} from '@happier-dev/triage-protocol/v1';

// Public PaginationOrderBy supports these date fields; issue.sort is internal.
export const LINEAR_SORT_COLUMNS: ReadonlyMap<TriageListSortFieldV1, string> = new Map<TriageListSortFieldV1, string>([
  ['updated', 'updatedAt'], ['created', 'createdAt'],
]);

export const LINEAR_PLUGIN_ID = 'happier.linear';
export const LINEAR_SOURCE_ID = 'linear-issues';
export const LINEAR_SERVICE_ID = 'linear-account';
export const LINEAR_PURPOSE = 'linear-api';
export const LINEAR_PERSONAL_KEY = 'personal-api-key';
export const LINEAR_ORIGIN = 'https://api.linear.app';
export const LINEAR_ACTIONS = {
  listCreationPlaces: 'linear/list-creation-places',
  listInstances: 'linear/list-instances', scan: 'linear/scan', get: 'linear/get',
  detail: 'linear/detail', create: 'linear/create', edit: 'linear/edit',
  transition: 'linear/transition', comment: 'linear/comment',
  listScopeUnits: 'linear/list-scope-units',
} as const;

const text = defineProtocolString();
const id = defineProtocolString({ minLength: 1 });
const nullableText = defineProtocolUnion([text, defineProtocolLiteral(null)]);
const named = defineProtocolObject({ id, name: text }, { policy: 'additive-open/drop' });
const person = defineProtocolUnion([named, defineProtocolLiteral(null)]);
export const LinearTeamSchema = defineProtocolObject({ id, name: text, key: text }, { policy: 'additive-open/drop' });
export const LinearRelatedIssueSchema = defineProtocolObject({ id, identifier: text, title: text }, { policy: 'additive-open/drop' });
const nullableRelated = defineProtocolUnion([LinearRelatedIssueSchema, defineProtocolLiteral(null)]);
const nullableNumber = defineProtocolUnion([defineProtocolNumber(), defineProtocolLiteral(null)]);

export const LinearIssueSchema = defineProtocolObject({
  id, identifier: text, title: text, url: text, createdAt: text, updatedAt: text,
  team: LinearTeamSchema,
  state: defineProtocolObject({ id, name: text, type: text }, { policy: 'additive-open/drop' }),
  priority: defineProtocolNumber(), priorityLabel: text, assignee: person, creator: person, project: person,
  cycle: defineProtocolUnion([defineProtocolObject({ id, name: nullableText, number: defineProtocolNumber() }, { policy: 'additive-open/drop' }), defineProtocolLiteral(null)]),
  dueDate: nullableText, completedAt: nullableText.optional(), estimate: nullableNumber, parent: nullableRelated,
  description: nullableText.optional(),
  subscribers: defineProtocolObject({ nodes: defineProtocolArray(defineProtocolObject({ id }, { policy: 'additive-open/drop' })) }, { policy: 'additive-open/drop' }),
}, { policy: 'additive-open/drop' });
export type LinearIssue = ReturnType<typeof LinearIssueSchema.parse>;
export const LINEAR_CREATE_FIELDS = ['title', 'body', 'assigneeIds', 'labelIds', 'scopeId', 'projectId', 'priority', 'dueDate', 'estimate', 'parent'] as const;
export const LINEAR_EDIT_FIELDS = LINEAR_CREATE_FIELDS.filter((field) => field !== 'scopeId');

const involvement = defineProtocolUnion([
    defineProtocolLiteral('mine'), defineProtocolLiteral('assignee'), defineProtocolLiteral('author'),
    defineProtocolLiteral('subscribed'), defineProtocolLiteral('everyone'),
  ]);
const LegacyLinearConfigurationSchema = defineProtocolObject({
  v: defineProtocolLiteral(1), teamId: id, involvement,
}, { policy: 'closed' });
export const LinearConfigurationSchema = defineProtocolObject({
  v: defineProtocolLiteral(1), teams: TriageSourceScopeSelectionV1Schema, involvement,
  teamUnits: defineProtocolArray(TriageSourceScopeUnitV1Schema).optional(),
}, { policy: 'closed' });
export type LinearConfiguration = ReturnType<typeof LinearConfigurationSchema.parse>;
export function readLinearConfiguration(token: string): LinearConfiguration {
  const raw: unknown = JSON.parse(token);
  const current = LinearConfigurationSchema.safeParse(raw);
  if (current.success) return current.data;
  const legacy = LegacyLinearConfigurationSchema.parse(raw);
  return { v: 1, teams: { kind: 'selected', unitIds: [legacy.teamId] }, involvement: legacy.involvement };
}
export function linearIncludesTeam(configuration: LinearConfiguration, teamId: string): boolean {
  return configuration.teams.kind === 'all' || configuration.teams.unitIds.includes(teamId);
}
export function linearConfiguredTeamUnits(configuration: LinearConfiguration): TriageSourceScopeUnitV1[] {
  if (configuration.teams.kind === 'all') return [];
  return configuration.teams.unitIds.map((id) => {
    const unit = configuration.teamUnits?.find((candidate) => candidate.id === id);
    // Teams do not own distinct entry collision scopes. Retained labels are presentation only.
    return { id, label: unit?.label ?? id, ...(unit?.secondaryText === undefined ? {} : { secondaryText: unit.secondaryText }) };
  });
}
export function writeLinearScopeSelection(draft: TriageSourceInstanceDraftV1, teams: TriageSourceScopeSelectionV1,
  units: readonly TriageSourceScopeUnitV1[]): TriageSourceInstanceDraftV1 {
  const previous = readLinearConfiguration(draft.configuration.token);
  const configuration = LinearConfigurationSchema.parse({ ...previous, teams, teamUnits: units });
  return { ...draft, configuration: TriageSourceInstanceConfigurationV1Schema.parse({ v: 1,
    token: JSON.stringify({ ...configuration, teamUnits: linearConfiguredTeamUnits(configuration) }) }) };
}
export const LinearTeamCursorSchema = defineProtocolObject({
  v: defineProtocolLiteral(1), after: id, query: text,
}, { policy: 'closed' });
export const LinearContinuationSchema = defineProtocolObject({
  v: defineProtocolLiteral(1), digest: id, after: id, viewerId: id, sort: TriageListSortV1Schema,
  limit: defineProtocolNumber({ integer: true, minimum: 1 }),
  completedSinceMs: defineProtocolNumber({ integer: true }).optional(),
}, { policy: 'closed' });

export const LINEAR_DETAIL_SECTIONS = ['overview', 'labels', 'children', 'blocks', 'blockedBy', 'comments', 'transitions'] as const;
export const LINEAR_DETAIL_TITLES = {
  overview: 'Description', labels: 'Labels', children: 'Sub-issues', blocks: 'Blocks',
  blockedBy: 'Blocked by', comments: 'Comments', transitions: 'Workflow states',
} as const;
export const LinearDetailInputSchema = defineProtocolObject({
  v: defineProtocolLiteral(1), instance: TriageConfiguredSourceConnectedAccountInstanceV1Schema,
  localRef: TriageSourceEntryLocalRefV1Schema, lastKnownLocator: TriageEntryLocatorV1Schema.optional(),
  section: defineProtocolUnion([
    defineProtocolLiteral(LINEAR_DETAIL_SECTIONS[0]), defineProtocolLiteral(LINEAR_DETAIL_SECTIONS[1]),
    defineProtocolLiteral(LINEAR_DETAIL_SECTIONS[2]), defineProtocolLiteral(LINEAR_DETAIL_SECTIONS[3]),
    defineProtocolLiteral(LINEAR_DETAIL_SECTIONS[4]), defineProtocolLiteral(LINEAR_DETAIL_SECTIONS[5]),
    defineProtocolLiteral(LINEAR_DETAIL_SECTIONS[6]),
  ]), after: id.optional(),
}, { policy: 'closed' });
export type LinearDetailInput = ReturnType<typeof LinearDetailInputSchema.parse>;
// A comment also names who wrote it and when, so Activity can place it on the shared timeline.
export const LinearDetailEntrySchema = defineProtocolObject({
  id, title: text, body: text.optional(), author: text.optional(), atMs: defineProtocolNumber({ integer: true }).optional(),
}, { policy: 'closed' });
export const LinearDetailResultSchema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('ready'), entries: defineProtocolArray(LinearDetailEntrySchema),
    description: nullableText.optional(), continuation: id.optional(), truncated: defineProtocolLiteral(true).optional(),
  }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('failed'), failure: TriageSourceFailureV1Schema }, { policy: 'closed' }),
]);
export type LinearDetailResult = ReturnType<typeof LinearDetailResultSchema.parse>;
export const LinearCommentInputSchema = defineProtocolObject({
  v: defineProtocolLiteral(1), instance: TriageConfiguredSourceConnectedAccountInstanceV1Schema,
  localRef: TriageSourceEntryLocalRefV1Schema, lastKnownLocator: TriageEntryLocatorV1Schema.optional(),
  body: defineProtocolString({ minLength: 1 }),
}, { policy: 'closed' });
