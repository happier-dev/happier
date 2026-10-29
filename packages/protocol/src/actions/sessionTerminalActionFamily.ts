import { SESSION_TERMINAL_ACTION_IDS } from './sessionTerminalActionIdsV1.js';
export { SESSION_TERMINAL_ACTION_IDS } from './sessionTerminalActionIdsV1.js';
import { z } from 'zod/mini';
import { SessionTerminalTargetV1Schema, SessionTerminalWorkspaceV1Schema } from '../terminal/workspace.js';
import type { ActionInputFieldHint, PreNormalizedActionSpec } from './actionSpecs.js';
export type SessionTerminalActionId = typeof SESSION_TERMINAL_ACTION_IDS[number];
const id = z.string().check(z.trim(), z.minLength(1));
const scope = z.strictObject({ scopeId: id });
const terminal = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(scope, { terminalId: id }));
export const SESSION_TERMINAL_ACTION_INPUT_SCHEMAS = {
  'session.terminals.list': scope,
  'session.terminals.open': (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(scope, { target: SessionTerminalTargetV1Schema, title: z.optional(id) })),
  'session.terminals.split': (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(scope, { tabId: z.optional(id), target: SessionTerminalTargetV1Schema, title: z.optional(id) })),
  'session.terminals.focus': terminal,
  'session.terminals.restart': terminal,
  'session.terminals.open_in_details': terminal,
  'session.terminals.close': terminal,
  'session.terminals.close_tab': (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(scope, { tabId: id })),
  'session.terminals.close_others': (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(scope, { tabId: id })),
  'session.terminals.resize': (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(scope, { tabId: id, splitId: id, ratio: z.number().check(z.minimum(0), z.maximum(1)) })),
  'session.terminals.detach': terminal,
  'session.terminals.reorder': (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(scope, { tabId: id, index: z.number().check(z.int(), z.nonnegative()) })),
  'session.terminals.rename': (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(terminal, { title: z.nullable(id) })),
  'session.terminals.list_view': (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(scope, { showList: z.boolean() })),
  'session.terminals.run_script': (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(scope, { machineId: id, cwd: id, runTargetId: id, title: z.optional(id) })),
} as const;
const mutation = z.strictObject({ ok: z.literal(true) });
const opened = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(mutation, { terminalId: id }));
export const SESSION_TERMINAL_ACTION_OUTPUT_SCHEMAS = {
  'session.terminals.list': (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(mutation, { workspace: SessionTerminalWorkspaceV1Schema })),
  'session.terminals.open': opened,
  'session.terminals.split': opened,
  'session.terminals.focus': mutation,
  'session.terminals.restart': mutation,
  'session.terminals.open_in_details': mutation,
  'session.terminals.close': mutation,
  'session.terminals.close_tab': mutation,
  'session.terminals.close_others': mutation,
  'session.terminals.resize': mutation,
  'session.terminals.rename': mutation,
  'session.terminals.list_view': mutation,
  'session.terminals.run_script': opened,
  'session.terminals.detach': mutation,
  'session.terminals.reorder': mutation,
} as const;
const scopeHint = { path: 'scopeId', title: 'Home-qualified Session or Project scope', widget: 'text', required: true } satisfies ActionInputFieldHint;
const terminalHint = { path: 'terminalId', title: 'Terminal id', widget: 'text', required: true } satisfies ActionInputFieldHint;
const tabHint = { path: 'tabId', title: 'Terminal tab id', widget: 'text', required: true } satisfies ActionInputFieldHint;
const targetHint = { path: 'target', title: 'Shell or attachment target', widget: 'json', required: true } satisfies ActionInputFieldHint;
const titleHint = { path: 'title', title: 'Terminal title', widget: 'text' } satisfies ActionInputFieldHint;
const inputFields = {
  'session.terminals.list': [scopeHint],
  'session.terminals.open': [scopeHint, targetHint, titleHint],
  'session.terminals.split': [scopeHint, { ...tabHint, required: false }, targetHint, titleHint],
  'session.terminals.focus': [scopeHint, terminalHint],
  'session.terminals.restart': [scopeHint, terminalHint],
  'session.terminals.open_in_details': [scopeHint, terminalHint],
  'session.terminals.close': [scopeHint, terminalHint],
  'session.terminals.close_tab': [scopeHint, tabHint],
  'session.terminals.close_others': [scopeHint, tabHint],
  'session.terminals.resize': [scopeHint, tabHint,
    { path: 'splitId', title: 'Split id', widget: 'text', required: true },
    { path: 'ratio', title: 'First terminal proportion', widget: 'text', required: true }],
  'session.terminals.detach': [scopeHint, terminalHint],
  'session.terminals.reorder': [scopeHint, tabHint, { path: 'index', title: 'Zero-based tab index', widget: 'text', required: true }],
  'session.terminals.rename': [scopeHint, terminalHint, { ...titleHint, required: true, description: 'Use null to restore the default title.' }],
  'session.terminals.list_view': [scopeHint, { path: 'showList', title: 'Show terminal list', widget: 'boolean', required: true }],
  'session.terminals.run_script': [scopeHint,
    { path: 'machineId', title: 'Machine id', widget: 'text', required: true },
    { path: 'cwd', title: 'Package directory', widget: 'text', required: true },
    { path: 'runTargetId', title: 'Package script target id', widget: 'text', required: true }, titleHint],
} satisfies Record<SessionTerminalActionId, readonly ActionInputFieldHint[]>;
const voiceExamples = {
  'session.terminals.list': '{"scopeId":"home:session"}',
  'session.terminals.open': '{"scopeId":"home:session","target":{"kind":"workspace_shell"}}',
  'session.terminals.split': '{"scopeId":"home:session","target":{"kind":"workspace_shell"}}',
  'session.terminals.focus': '{"scopeId":"home:session","terminalId":"terminal-main"}',
  'session.terminals.restart': '{"scopeId":"home:session","terminalId":"terminal-main"}',
  'session.terminals.open_in_details': '{"scopeId":"home:session","terminalId":"terminal-main"}',
  'session.terminals.close': '{"scopeId":"home:session","terminalId":"terminal-main"}',
  'session.terminals.close_tab': '{"scopeId":"home:session","tabId":"tab-main"}',
  'session.terminals.close_others': '{"scopeId":"home:session","tabId":"tab-main"}',
  'session.terminals.resize': '{"scopeId":"home:session","tabId":"tab-main","splitId":"split-main","ratio":0.5}',
  'session.terminals.rename': '{"scopeId":"home:session","terminalId":"terminal-main","title":"Build"}',
  'session.terminals.list_view': '{"scopeId":"home:session","showList":true}',
  'session.terminals.run_script': '{"scopeId":"home:session","machineId":"machine-main","cwd":"/repo","runTargetId":"test"}',
  'session.terminals.detach': '{"scopeId":"home:session","terminalId":"terminal-main"}',
  'session.terminals.reorder': '{"scopeId":"home:session","tabId":"tab-main","index":0}',
} satisfies Record<SessionTerminalActionId, string>;
/** What the confirmation says before a pane close ends a shell, in the words a person uses (not the Action title again). */
const closeSummaries = {
  'session.terminals.close': 'Close this terminal. Anything running in it stops.',
  'session.terminals.close_tab': 'Close this terminal tab. Anything running in it stops.',
  'session.terminals.close_others': 'Close the other terminal tabs. Anything running in them stops.',
} as const;
function row<const T extends SessionTerminalActionId>(actionId: T, title: string) {
  // Creation and restart request pane/controller intents. The physical Machine
  // Action admits every launch with the original verified caller provenance.
  const mutatesProcess = actionId === 'session.terminals.close' || actionId === 'session.terminals.close_tab'
    || actionId === 'session.terminals.close_others';
  return {
    id: actionId, approval: { result: 'required' }, title,
    ...(mutatesProcess ? { approvalPresentation: { summary: () => closeSummaries[actionId as keyof typeof closeSummaries] } } : {}),
    description: 'Operate on the invoking mounted client terminal pane for a Home-qualified Session or an accepted requester Project checkout. Open, split and run_script return a pane member intent, not a ready shell. Restart requests the mounted controller, not a completed process restart. The Machine open/restart Actions own physical launch approval with the original caller provenance. Project shells retain their exact accepted workspace. A headless host returns unsupported_action. Closing stops owned shell terminals; attached agent terminals and borrowed views are only removed from the pane.',
    safety: mutatesProcess ? 'danger' : 'safe',
    sideEffectClass: actionId === 'session.terminals.list' ? 'read' : mutatesProcess ? 'danger' : 'external',
    executionPlacement: 'client', placements: [],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    bindings: { mcpToolName: actionId.replaceAll('.', '_'), voiceClientToolName: actionId.replaceAll('.', '_') },
    cli: { commands: [{ path: actionId.split('.'), visibility: 'canonical' }] },
    inputSchema: SESSION_TERMINAL_ACTION_INPUT_SCHEMAS[actionId], outputSchema: SESSION_TERMINAL_ACTION_OUTPUT_SCHEMAS[actionId],
    inputHints: { title, fields: inputFields[actionId] },
    examples: { voice: { argsExample: voiceExamples[actionId] } },
  } satisfies PreNormalizedActionSpec;
}
export const SESSION_TERMINAL_ACTION_SPECS = [
  row('session.terminals.list', 'List session terminal tabs'), row('session.terminals.open', 'Open session terminal tab'),
  row('session.terminals.split', 'Split session terminal tab'), row('session.terminals.focus', 'Focus session terminal'),
  row('session.terminals.restart', 'Restart mounted session terminal'), row('session.terminals.open_in_details', 'Open session terminal in Details'),
  row('session.terminals.close', 'Close session terminal'), row('session.terminals.close_others', 'Close other terminal tabs'),
  row('session.terminals.close_tab', 'Close terminal tab'), row('session.terminals.resize', 'Resize terminal split'),
  row('session.terminals.rename', 'Rename session terminal'), row('session.terminals.list_view', 'Show terminal list'),
  row('session.terminals.run_script', 'Run package script in a new terminal tab'),
  row('session.terminals.detach', 'Move split terminal to its own tab'), row('session.terminals.reorder', 'Reorder terminal tab'),
] as const;
export function isSessionTerminalActionId(value: string): value is SessionTerminalActionId {
  return (SESSION_TERMINAL_ACTION_IDS as readonly string[]).includes(value);
}
