import { WORKSPACE_ACTION_IDS } from './workspaceActionIdsV1.js';
export { WORKSPACE_ACTION_IDS } from './workspaceActionIdsV1.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import type { ActionInputFieldHint, PreNormalizedActionSpec } from './actionSpecs.js';
import { FindOptionsSchema } from './findActionSpecs.js';
import { WorkspaceAnchorV1Schema } from '../workspace/anchors/v1.js';
import { FileChangesScopeSchema } from '../scm/fileChangesScope.js';
export type WorkspaceActionId = typeof WORKSPACE_ACTION_IDS[number];

const id = z.string().check(z.trim(), z.minLength(1));

/** Root-relative file addressing is shared by Action ingress and pane URL readers. */
export function isSafeWorkspaceFilePath(path: string): boolean {
  return path.length > 0 && !path.includes('\0') && !path.includes('\\')
    && !path.startsWith('/') && path !== '~' && !path.startsWith('~/') && !/^[A-Za-z]:(?:\/|$)/.test(path)
    && !path.includes('//') && !path.split('/').some(segment => segment === '.' || segment === '..');
}

export const WorkspaceFileTargetSchema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('session'), sessionId: id, serverId: z.optional(id) }),
  z.strictObject({ kind: z.literal('project'), workspaceRefId: id, serverId: id,
    machineId: z.optional(id), rootPath: z.optional(z.string().check(z.minLength(1))),
  }),
]));
export const WorkspaceFileOpenInputSchema = lazyZodSchema(() => z.strictObject({
  target: WorkspaceFileTargetSchema,
  path: z.string().check(z.refine(isSafeWorkspaceFilePath, { message: 'A workspace-relative file path is required' })),
  /** Exact file base when the producer's paths are not relative to the Session cwd. */
  rootPath: z.optional(z.string().check(z.minLength(1))),
  anchor: z.optional(WorkspaceAnchorV1Schema),
  anchorSource: z.optional(z.enum(['file', 'diff'])),
  view: z.optional(z.enum(['view', 'changes', 'edit'])),
  blame: z.optional(z.boolean()),
  changesScope: z.optional(FileChangesScopeSchema),
}));
export type WorkspaceFileTarget = z.infer<typeof WorkspaceFileTargetSchema>;
export type WorkspaceFileOpenInput = z.infer<typeof WorkspaceFileOpenInputSchema>;
/** Private chat launch input, consumed by the existing pane handoff; never a URL or tab field. */
export const WorkspaceChatFindSeedSchema = lazyZodSchema(() => z.strictObject({
  query: z.string().check(z.minLength(1)), options: z.optional(FindOptionsSchema),
  target: z.strictObject({ kind: z.literal('native-message'), agentId: id, remoteSessionId: id, sourceItemId: id }),
}));
export const WorkspaceProjectFileFindSeedSchema = lazyZodSchema(() => z.strictObject({
  query: z.string().check(z.minLength(1)), options: z.optional(FindOptionsSchema),
  target: z.strictObject({
    kind: z.literal('project-file'), workspaceRefId: id, serverId: id, machineId: id,
    rootPath: z.string().check(z.minLength(1)), path: z.string().check(z.minLength(1)),
    anchor: z.optional(WorkspaceAnchorV1Schema),
  }),
}));
export const WorkspaceSessionFileFindSeedSchema = lazyZodSchema(() => z.strictObject({
  query: z.string().check(z.minLength(1)), options: z.optional(FindOptionsSchema),
  target: z.strictObject({
    kind: z.literal('session-file'), sessionId: id, serverId: id, machineId: id,
    rootPath: z.string().check(z.minLength(1)),
    path: z.string().check(z.refine(isSafeWorkspaceFilePath, { message: 'A workspace-relative file path is required' })),
    anchor: z.optional(WorkspaceAnchorV1Schema),
  }),
}));
export const WorkspaceFindSeedSchema = lazyZodSchema(() => z.union([
  WorkspaceChatFindSeedSchema, WorkspaceProjectFileFindSeedSchema, WorkspaceSessionFileFindSeedSchema,
]));
export const WORKSPACE_ACTION_INPUT_SCHEMAS = {
  'workspace.files.link.get': WorkspaceFileOpenInputSchema,
  'workspace.tabs.list': z.strictObject({}),
  'workspace.tabs.open': z.strictObject({ href: z.optional(id), tabId: z.optional(id), groupId: z.optional(id),
    file: z.optional(WorkspaceFileOpenInputSchema),
    present: z.optional(z.boolean()),
    find: z.optional(WorkspaceFindSeedSchema),
    beforeTabId: z.optional(z.nullable(id)), reuseExisting: z.optional(z.boolean()),
    mode: z.optional(z.enum(['preview', 'newTab', 'splitLeft', 'splitRight', 'splitUp', 'splitDown'])),
  }).check(z.refine(data => !(data.href !== undefined && data.file !== undefined), {
    message: 'Address a destination with either href or file',
  }), z.refine(data => !data.mode?.startsWith('split') || ((data.href !== undefined || data.file !== undefined) && data.tabId === undefined), {
    message: 'A destination split requires href or file and cannot replace an existing tab',
  }), z.refine(data => !data.find || data.href !== undefined || data.file !== undefined, {
    message: 'Find launch input requires an addressed destination',
  }), z.refine(data => data.present !== false || (data.file?.target.kind === 'session'
    && (data.mode === undefined || data.mode === 'preview') && data.groupId === undefined && data.beforeTabId === undefined), {
    message: 'An unpresented open positions a preview in the foreground Session',
  })),
  'workspace.tabs.activate': z.strictObject({ tabId: id }),
  'workspace.tabs.close': z.strictObject({ tabId: id }),
  'workspace.tabs.close_others': z.strictObject({ tabId: id }),
  'workspace.tabs.close_left': z.strictObject({ tabId: id }),
  'workspace.tabs.close_right': z.strictObject({ tabId: id }),
  'workspace.tabs.close_all': z.strictObject({ groupId: z.optional(id) }),
  'workspace.tabs.closed.list': z.strictObject({}),
  'workspace.tabs.reopen': z.strictObject({ tabId: z.optional(id) }),
  'workspace.tabs.pin': z.strictObject({ tabId: id, pinned: z.boolean() }),
  'workspace.tabs.move': z.strictObject({ tabId: id, targetGroupId: id, beforeTabId: z.optional(z.nullable(id)) }),
  'workspace.tabs.reorder': z.union([
    z.strictObject({ tabId: id, index: z.number().check(z.int(), z.nonnegative()) }),
    z.strictObject({ tabId: id, beforeTabId: z.nullable(id) }),
  ]),
  'workspace.groups.focus': z.strictObject({ groupId: id }),
  'workspace.groups.maximize': z.strictObject({ groupId: id }),
  'workspace.groups.restore': z.strictObject({}),
  'workspace.split': z.strictObject({ tabId: z.optional(id), groupId: z.optional(id), direction: z.enum(['left', 'right', 'up', 'down']) }),
  'workspace.resize': z.strictObject({ splitId: id, ratio: z.number().check(z.minimum(0), z.maximum(1)) }),
} as const;

export const WorkspaceTabsListOutputSchema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true),
  tabs: z.array(z.strictObject({
    id, groupId: id, target: z.strictObject({ kind: id, params: z.record(z.string(), z.string()) }),
    pinned: z.boolean(), preview: z.boolean(),
  })),
  groups: z.array(z.strictObject({ id, tabIds: z.array(id), activeTabId: id })),
  splits: z.array(z.strictObject({ id, axis: z.enum(['row', 'column']), ratio: z.number().check(z.minimum(0), z.maximum(1)), firstNodeId: id, secondNodeId: id })),
  rootNodeId: id,
  focusedGroupId: id, maximizedGroupId: z.nullable(id),
}));
export const WorkspaceClosedTabsListOutputSchema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true),
  tabs: z.array(z.strictObject({
    id, target: z.strictObject({ kind: id, params: z.record(z.string(), z.string()) }),
    pinned: z.boolean(), title: z.optional(z.string()),
  })),
}));
const MutationOutputSchema = lazyZodSchema(() => z.strictObject({ ok: z.literal(true) }));
export const WORKSPACE_ACTION_OUTPUT_SCHEMAS = {
  'workspace.files.link.get': lazyZodSchema(() => z.strictObject({ ok: z.literal(true), url: id })),
  'workspace.tabs.list': WorkspaceTabsListOutputSchema,
  'workspace.tabs.open': MutationOutputSchema,
  'workspace.tabs.activate': MutationOutputSchema,
  'workspace.tabs.close': MutationOutputSchema,
  'workspace.tabs.close_others': MutationOutputSchema,
  'workspace.tabs.close_left': MutationOutputSchema,
  'workspace.tabs.close_right': MutationOutputSchema,
  'workspace.tabs.close_all': MutationOutputSchema,
  'workspace.tabs.closed.list': WorkspaceClosedTabsListOutputSchema,
  'workspace.tabs.reopen': MutationOutputSchema,
  'workspace.tabs.pin': MutationOutputSchema,
  'workspace.tabs.move': MutationOutputSchema,
  'workspace.tabs.reorder': MutationOutputSchema,
  'workspace.groups.focus': MutationOutputSchema,
  'workspace.groups.maximize': MutationOutputSchema,
  'workspace.groups.restore': MutationOutputSchema,
  'workspace.split': MutationOutputSchema,
  'workspace.resize': MutationOutputSchema,
} as const;
export type WorkspaceTabsListOutput = z.infer<typeof WorkspaceTabsListOutputSchema>;
export type WorkspaceClosedTabsListOutput = z.infer<typeof WorkspaceClosedTabsListOutputSchema>;

const tabIdHint = { path: 'tabId', title: 'Tab id', widget: 'text', required: true } satisfies ActionInputFieldHint;
const groupIdHint = { path: 'groupId', title: 'Pane id', widget: 'text', required: true } satisfies ActionInputFieldHint;
const beforeTabHint = { path: 'beforeTabId', title: 'Insert before tab', widget: 'text',
  description: 'The current tab anchor; null appends after the last tab.' } satisfies ActionInputFieldHint;
const inputFields = {
  'workspace.files.link.get': [{ path: 'target', title: 'File destination', widget: 'json', required: true },
    { path: 'path', title: 'Workspace-relative path', widget: 'text', required: true },
    { path: 'anchor', title: 'Line or range', widget: 'json' },
    { path: 'changesScope', title: 'Changes scope', widget: 'json' }],
  'workspace.tabs.list': [],
  'workspace.tabs.open': [
    { path: 'href', title: 'Destination', widget: 'text' }, { ...tabIdHint, required: false },
    { path: 'file', title: 'Workspace file', widget: 'json', description: 'Session or Project target, workspace-relative path, optional anchor, view, blame and Changes scope. Exclusive with href.' },
    { path: 'present', title: 'Present file', widget: 'boolean', description: 'False positions a preview in the foreground Session without navigating or presenting its pane.' },
    { path: 'find', title: 'Find target', widget: 'json', description: 'Query/options and an exact Session message, Session file or Project file target. Private launch input; not persisted in the URL or tab.' },
    { ...groupIdHint, required: false }, beforeTabHint,
    { path: 'reuseExisting', title: 'Go to an existing tab', widget: 'boolean' },
    { path: 'mode', title: 'Opening mode', widget: 'select', options: [
      { value: 'preview', label: 'Preview' }, { value: 'newTab', label: 'Keep tab' },
      { value: 'splitLeft', label: 'Split left' }, { value: 'splitRight', label: 'Split right' },
      { value: 'splitUp', label: 'Split up' }, { value: 'splitDown', label: 'Split down' },
    ] },
  ],
  'workspace.tabs.activate': [tabIdHint],
  'workspace.tabs.close': [tabIdHint],
  'workspace.tabs.close_others': [tabIdHint],
  'workspace.tabs.close_left': [tabIdHint],
  'workspace.tabs.close_right': [tabIdHint],
  'workspace.tabs.close_all': [{ ...groupIdHint, required: false }],
  'workspace.tabs.closed.list': [],
  'workspace.tabs.reopen': [{ ...tabIdHint, required: false }],
  'workspace.tabs.pin': [tabIdHint, { path: 'pinned', title: 'Keep pinned', widget: 'boolean', required: true }],
  'workspace.tabs.move': [tabIdHint, { path: 'targetGroupId', title: 'Destination pane id', widget: 'text', required: true }, beforeTabHint],
  'workspace.tabs.reorder': [tabIdHint, { ...beforeTabHint, description: 'Current tab anchor, or null to append. Use this or index.' },
    { path: 'index', title: 'Tab index', widget: 'text', description: 'Zero-based position, as an alternative to beforeTabId.' }],
  'workspace.groups.focus': [groupIdHint],
  'workspace.groups.maximize': [groupIdHint],
  'workspace.groups.restore': [],
  'workspace.split': [{ ...tabIdHint, required: false }, { ...groupIdHint, required: false },
    { path: 'direction', title: 'Split direction', widget: 'select', required: true, options: [
      { value: 'left', label: 'Left' }, { value: 'right', label: 'Right' },
      { value: 'up', label: 'Up' }, { value: 'down', label: 'Down' },
    ] }],
  'workspace.resize': [{ path: 'splitId', title: 'Split id', widget: 'text', required: true },
    { path: 'ratio', title: 'First pane proportion', widget: 'text', required: true }],
} satisfies Record<WorkspaceActionId, readonly ActionInputFieldHint[]>;

const voiceExamples = {
  'workspace.files.link.get': '{"target":{"kind":"session","sessionId":"{{sessionId}}"},"path":"src/index.ts"}',
  'workspace.tabs.list': '{}',
  'workspace.tabs.open': '{"href":"/session/{{sessionId}}","groupId":"pane-main","beforeTabId":"tab-next","mode":"newTab"}',
  'workspace.tabs.activate': '{"tabId":"tab-main"}',
  'workspace.tabs.close': '{"tabId":"tab-main"}',
  'workspace.tabs.close_others': '{"tabId":"tab-main"}',
  'workspace.tabs.close_left': '{"tabId":"tab-main"}',
  'workspace.tabs.close_right': '{"tabId":"tab-main"}',
  'workspace.tabs.close_all': '{"groupId":"pane-main"}',
  'workspace.tabs.closed.list': '{}',
  'workspace.tabs.reopen': '{"tabId":"tab-closed"}',
  'workspace.tabs.pin': '{"tabId":"tab-main","pinned":true}',
  'workspace.tabs.move': '{"tabId":"tab-main","targetGroupId":"pane-right","beforeTabId":null}',
  'workspace.tabs.reorder': '{"tabId":"tab-main","beforeTabId":"tab-next"}',
  'workspace.groups.focus': '{"groupId":"pane-main"}',
  'workspace.groups.maximize': '{"groupId":"pane-main"}',
  'workspace.groups.restore': '{}',
  'workspace.split': '{"groupId":"pane-main","direction":"right"}',
  'workspace.resize': '{"splitId":"split-main","ratio":0.5}',
} satisfies Record<WorkspaceActionId, string>;

function row<const TId extends WorkspaceActionId>(actionId: TId, title: string,
  description = 'Operate on the mounted client workspace in its current Home, Account and window. A headless host without that workspace returns unsupported_action.') {
  return {
    id: actionId, approval: { result: 'required' }, title,
    ...(actionId === 'workspace.tabs.open' ? { toolExposure: { agent: 'direct' as const } } : {}),
    description,
    safety: 'safe', sideEffectClass: actionId === 'workspace.tabs.list' || actionId === 'workspace.tabs.closed.list' || actionId === 'workspace.files.link.get' ? 'read' : 'external',
    executionPlacement: 'client', placements: [],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    cli: { acceptsServerId: true, commands: [] },
    bindings: { mcpToolName: actionId.replaceAll('.', '_'), voiceClientToolName: actionId.replaceAll('.', '_') },
    inputSchema: WORKSPACE_ACTION_INPUT_SCHEMAS[actionId], outputSchema: WORKSPACE_ACTION_OUTPUT_SCHEMAS[actionId],
    inputHints: { title, fields: inputFields[actionId] },
    examples: { voice: { argsExample: voiceExamples[actionId] } },
  } satisfies PreNormalizedActionSpec;
}

export const WORKSPACE_ACTION_SPECS = [
  row('workspace.files.link.get', 'Get workspace file link'),
  row('workspace.tabs.list', 'List workspace tabs'), row('workspace.tabs.open', 'Open workspace tab'),
  row('workspace.tabs.activate', 'Activate workspace tab'), row('workspace.tabs.close', 'Close workspace tab'),
  row('workspace.tabs.close_others', 'Close other workspace tabs', 'Close unpinned tabs in the named tab\'s pane, keeping that tab and respecting unsaved-draft guards.'),
  row('workspace.tabs.close_left', 'Close workspace tabs to the left', 'Close unpinned tabs before the named tab in its pane, respecting unsaved-draft guards.'),
  row('workspace.tabs.close_right', 'Close workspace tabs to the right', 'Close unpinned tabs after the named tab in its pane, respecting unsaved-draft guards.'),
  row('workspace.tabs.close_all', 'Close all workspace tabs in a pane', 'Close unpinned tabs in the specified pane, or the focused pane when omitted, respecting unsaved-draft guards.'),
  row('workspace.tabs.closed.list', 'List recently closed workspace tabs'), row('workspace.tabs.reopen', 'Reopen workspace tab'),
  row('workspace.tabs.pin', 'Pin or unpin workspace tab'), row('workspace.tabs.move', 'Move workspace tab'),
  row('workspace.tabs.reorder', 'Reorder workspace tab'),
  row('workspace.groups.focus', 'Focus workspace group'), row('workspace.groups.maximize', 'Maximize workspace group'),
  row('workspace.groups.restore', 'Restore workspace groups'), row('workspace.split', 'Split workspace'),
  row('workspace.resize', 'Resize workspace split'),
] as const;

export function isWorkspaceActionId(value: string): value is WorkspaceActionId {
  return (WORKSPACE_ACTION_IDS as readonly string[]).includes(value);
}
