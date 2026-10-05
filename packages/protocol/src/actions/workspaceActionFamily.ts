import { z } from 'zod';
import type { ActionInputFieldHint, PreNormalizedActionSpec } from './actionSpecs.js';

export const WORKSPACE_ACTION_IDS = [
  'workspace.tabs.list', 'workspace.tabs.open', 'workspace.tabs.activate', 'workspace.tabs.close',
  'workspace.tabs.closed.list', 'workspace.tabs.reopen',
  'workspace.tabs.pin', 'workspace.tabs.move', 'workspace.tabs.reorder', 'workspace.groups.focus', 'workspace.groups.maximize',
  'workspace.groups.restore', 'workspace.split', 'workspace.resize',
] as const;
export type WorkspaceActionId = typeof WORKSPACE_ACTION_IDS[number];

const id = z.string().trim().min(1);
export const WORKSPACE_ACTION_INPUT_SCHEMAS = {
  'workspace.tabs.list': z.object({}).strict(),
  'workspace.tabs.open': z.object({ href: id.optional(), tabId: id.optional(), groupId: id.optional(),
    beforeTabId: id.nullable().optional(), reuseExisting: z.boolean().optional(),
    mode: z.enum(['preview', 'newTab', 'splitLeft', 'splitRight', 'splitUp', 'splitDown']).optional(),
  }).strict().refine(data => !data.mode?.startsWith('split') || (data.href !== undefined && data.tabId === undefined), {
    message: 'A destination split requires href and cannot replace an existing tab',
  }),
  'workspace.tabs.activate': z.object({ tabId: id }).strict(),
  'workspace.tabs.close': z.object({ tabId: id }).strict(),
  'workspace.tabs.closed.list': z.object({}).strict(),
  'workspace.tabs.reopen': z.object({ tabId: id.optional() }).strict(),
  'workspace.tabs.pin': z.object({ tabId: id, pinned: z.boolean() }).strict(),
  'workspace.tabs.move': z.object({ tabId: id, targetGroupId: id, beforeTabId: id.nullable().optional() }).strict(),
  'workspace.tabs.reorder': z.union([
    z.object({ tabId: id, index: z.number().int().nonnegative() }).strict(),
    z.object({ tabId: id, beforeTabId: id.nullable() }).strict(),
  ]),
  'workspace.groups.focus': z.object({ groupId: id }).strict(),
  'workspace.groups.maximize': z.object({ groupId: id }).strict(),
  'workspace.groups.restore': z.object({}).strict(),
  'workspace.split': z.object({ tabId: id.optional(), groupId: id.optional(), direction: z.enum(['left', 'right', 'up', 'down']) }).strict(),
  'workspace.resize': z.object({ splitId: id, ratio: z.number().finite().min(0).max(1) }).strict(),
} as const;

export const WorkspaceTabsListOutputSchema = z.object({
  ok: z.literal(true),
  tabs: z.array(z.object({
    id, groupId: id, target: z.object({ kind: id, params: z.record(z.string(), z.string()) }).strict(),
    pinned: z.boolean(), preview: z.boolean(),
  }).strict()),
  groups: z.array(z.object({ id, tabIds: z.array(id), activeTabId: id }).strict()),
  splits: z.array(z.object({ id, axis: z.enum(['row', 'column']), ratio: z.number().finite().min(0).max(1), firstNodeId: id, secondNodeId: id }).strict()),
  rootNodeId: id,
  focusedGroupId: id, maximizedGroupId: id.nullable(),
}).strict();
export const WorkspaceClosedTabsListOutputSchema = z.object({
  ok: z.literal(true),
  tabs: z.array(z.object({
    id, target: z.object({ kind: id, params: z.record(z.string(), z.string()) }).strict(),
    pinned: z.boolean(), title: z.string().optional(),
  }).strict()),
}).strict();
const MutationOutputSchema = z.object({ ok: z.literal(true) }).strict();
export const WORKSPACE_ACTION_OUTPUT_SCHEMAS = {
  'workspace.tabs.list': WorkspaceTabsListOutputSchema,
  'workspace.tabs.open': MutationOutputSchema,
  'workspace.tabs.activate': MutationOutputSchema,
  'workspace.tabs.close': MutationOutputSchema,
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
  'workspace.tabs.list': [],
  'workspace.tabs.open': [
    { path: 'href', title: 'Destination', widget: 'text' }, { ...tabIdHint, required: false },
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
  'workspace.tabs.list': '{}',
  'workspace.tabs.open': '{"href":"/session/{{sessionId}}","groupId":"pane-main","beforeTabId":"tab-next","mode":"newTab"}',
  'workspace.tabs.activate': '{"tabId":"tab-main"}',
  'workspace.tabs.close': '{"tabId":"tab-main"}',
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

function row<const TId extends WorkspaceActionId>(actionId: TId, title: string) {
  return {
    id: actionId, title,
    description: 'Operate on the mounted client workspace in its current Home, Account and window. A headless host without that workspace returns unsupported_action.',
    safety: 'safe', sideEffectClass: actionId === 'workspace.tabs.list' || actionId === 'workspace.tabs.closed.list' ? 'read' : 'external',
    executionPlacement: 'client', placements: [],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    bindings: { mcpToolName: actionId.replaceAll('.', '_'), voiceClientToolName: actionId.replaceAll('.', '_') },
    cli: { commands: [{ path: actionId.split('.'), visibility: 'canonical' }] },
    inputSchema: WORKSPACE_ACTION_INPUT_SCHEMAS[actionId], outputSchema: WORKSPACE_ACTION_OUTPUT_SCHEMAS[actionId],
    inputHints: { title, fields: inputFields[actionId] },
    examples: { voice: { argsExample: voiceExamples[actionId] } },
  } satisfies PreNormalizedActionSpec;
}

export const WORKSPACE_ACTION_SPECS = [
  row('workspace.tabs.list', 'List workspace tabs'), row('workspace.tabs.open', 'Open workspace tab'),
  row('workspace.tabs.activate', 'Activate workspace tab'), row('workspace.tabs.close', 'Close workspace tab'),
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
