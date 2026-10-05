import { z } from 'zod';
import { SessionTerminalTargetV1Schema, SessionTerminalWorkspaceV1Schema } from '../terminal/workspace.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';

export const SESSION_TERMINAL_ACTION_IDS = [
  'session.terminals.list', 'session.terminals.open', 'session.terminals.split',
  'session.terminals.focus', 'session.terminals.restart', 'session.terminals.open_in_details', 'session.terminals.close', 'session.terminals.close_tab', 'session.terminals.close_others', 'session.terminals.resize',
  'session.terminals.rename', 'session.terminals.list_view', 'session.terminals.run_script', 'session.terminals.detach', 'session.terminals.reorder',
] as const;
export type SessionTerminalActionId = typeof SESSION_TERMINAL_ACTION_IDS[number];
const id = z.string().trim().min(1);
const scope = z.object({ scopeId: id }).strict();
const terminal = scope.extend({ terminalId: id }).strict();
export const SESSION_TERMINAL_ACTION_INPUT_SCHEMAS = {
  'session.terminals.list': scope,
  'session.terminals.open': scope.extend({ target: SessionTerminalTargetV1Schema, title: id.optional() }).strict(),
  'session.terminals.split': scope.extend({ tabId: id.optional(), target: SessionTerminalTargetV1Schema, title: id.optional() }).strict(),
  'session.terminals.focus': terminal,
  'session.terminals.restart': terminal,
  'session.terminals.open_in_details': terminal,
  'session.terminals.close': terminal,
  'session.terminals.close_tab': scope.extend({ tabId: id }).strict(),
  'session.terminals.close_others': scope.extend({ tabId: id }).strict(),
  'session.terminals.resize': scope.extend({ tabId: id, splitId: id, ratio: z.number().finite().min(0).max(1) }).strict(),
  'session.terminals.detach': terminal,
  'session.terminals.reorder': scope.extend({ tabId: id, index: z.number().int().nonnegative() }).strict(),
  'session.terminals.rename': terminal.extend({ title: id.nullable() }).strict(),
  'session.terminals.list_view': scope.extend({ showList: z.boolean() }).strict(),
  'session.terminals.run_script': scope.extend({ machineId: id, cwd: id, runTargetId: id, title: id.optional() }).strict(),
} as const;
const mutation = z.object({ ok: z.literal(true) }).strict();
const opened = mutation.extend({ terminalId: id }).strict();
export const SESSION_TERMINAL_ACTION_OUTPUT_SCHEMAS = {
  'session.terminals.list': mutation.extend({ workspace: SessionTerminalWorkspaceV1Schema }).strict(),
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
function row<const T extends SessionTerminalActionId>(actionId: T, title: string) {
  const mutatesProcess = actionId === 'session.terminals.run_script' || actionId === 'session.terminals.open' || actionId === 'session.terminals.split'
    || actionId === 'session.terminals.close' || actionId === 'session.terminals.close_tab' || actionId === 'session.terminals.close_others' || actionId === 'session.terminals.restart';
  return {
    id: actionId, title,
    description: 'Operate on the invoking mounted client session terminal pane. Scope IDs are Home-qualified; a headless host returns unsupported_action. Closing stops owned shell terminals; attached agent terminals and borrowed views are only removed from the pane.',
    safety: mutatesProcess ? 'danger' : 'safe',
    sideEffectClass: actionId === 'session.terminals.list' ? 'read' : mutatesProcess ? 'danger' : 'external',
    executionPlacement: 'client', placements: [],
    surfaces: { ui: true, voice: true, agent: true, mcp: true, cli: true, rpc: false },
    bindings: { mcpToolName: actionId.replaceAll('.', '_'), voiceClientToolName: actionId.replaceAll('.', '_') },
    cli: { commands: [{ path: actionId.split('.'), visibility: 'canonical' }] },
    inputSchema: SESSION_TERMINAL_ACTION_INPUT_SCHEMAS[actionId], outputSchema: SESSION_TERMINAL_ACTION_OUTPUT_SCHEMAS[actionId],
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
