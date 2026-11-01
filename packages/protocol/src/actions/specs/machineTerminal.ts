import { MACHINE_TERMINAL_ACTION_IDS } from './machineTerminalActionIdsV1.js';
export { MACHINE_TERMINAL_ACTION_IDS } from './machineTerminalActionIdsV1.js';
import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import {
  DaemonTerminalEnsureRequestSchema, DaemonTerminalEnsureResponseSchema,
  DaemonTerminalListRequestV1Schema, DaemonTerminalListResponseV1Schema,
  DaemonTerminalCloseRequestSchema, DaemonTerminalCloseResponseSchema,
  DaemonTerminalRestartRequestSchema, DaemonTerminalRestartResponseSchema,
} from '../../daemon/terminal.js';
import { TerminalStreamReadRequestSchema, TerminalStreamReadResponseSchema } from '../../terminal/stream.js';
import { TerminalStreamInputRequestSchema, TerminalStreamInputResponseSchema } from '../../terminal/input.js';
import type { ApprovalPresentationContext, PreNormalizedActionSpec } from '../actionSpecs.js';
import { actionInputServerId } from './definition.js';
import { RPC_METHODS } from '../../rpc/methods.js';
import { readRecord } from '../../inputs/inputRecords.js';
export type MachineTerminalActionId = typeof MACHINE_TERMINAL_ACTION_IDS[number];
const id = z.string().check(z.trim(), z.minLength(1));
const routing = { serverId: id, machineId: id };
export const MachineTerminalOpenInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.safeExtend(DaemonTerminalEnsureRequestSchema, routing)));
export const MachineTerminalListInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(DaemonTerminalListRequestV1Schema, routing)));
export const MACHINE_TERMINAL_ACTION_INPUT_SCHEMAS = {
  'machines.terminal.open': MachineTerminalOpenInputSchema,
  'machines.terminal.list': MachineTerminalListInputSchema,
  'machines.terminal.read': lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.safeExtend(TerminalStreamReadRequestSchema, routing))),
  'machines.terminal.write': lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(TerminalStreamInputRequestSchema, routing))),
  'machines.terminal.close': lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(DaemonTerminalCloseRequestSchema, routing))),
  'machines.terminal.restart': lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.safeExtend(DaemonTerminalRestartRequestSchema, routing))),
} as const;
export const MACHINE_TERMINAL_ACTION_OUTPUT_SCHEMAS = {
  'machines.terminal.open': DaemonTerminalEnsureResponseSchema,
  'machines.terminal.list': z.nullable(DaemonTerminalListResponseV1Schema),
  'machines.terminal.read': TerminalStreamReadResponseSchema,
  'machines.terminal.write': TerminalStreamInputResponseSchema,
  'machines.terminal.close': DaemonTerminalCloseResponseSchema,
  'machines.terminal.restart': DaemonTerminalRestartResponseSchema,
} as const;
export type MachineTerminalActionInput = z.infer<(typeof MACHINE_TERMINAL_ACTION_INPUT_SCHEMAS)[MachineTerminalActionId]>;
type MachineTerminalSpec<TId extends MachineTerminalActionId> = PreNormalizedActionSpec & Readonly<{
  id: TId; inputSchema: (typeof MACHINE_TERMINAL_ACTION_INPUT_SCHEMAS)[TId];
  outputSchema: (typeof MACHINE_TERMINAL_ACTION_OUTPUT_SCHEMAS)[TId];
}>;
/**
 * Where the terminal opens: the presenting app's readable path (`~/work/app`) when it knows the Machine's home,
 * otherwise the last folder name on any platform, or null. The approval says where, never a raw key.
 */
function terminalFolderName(input: unknown, context?: ApprovalPresentationContext): string | null {
  const record = readRecord(input);
  const workspace = readRecord(record.workspace);
  const path = typeof record.cwd === 'string' ? record.cwd : typeof workspace.rootPath === 'string' ? workspace.rootPath : '';
  if (path.trim() && context?.formatPath) return context.formatPath(path);
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? null;
}

/**
 * What approving will do, in the words a person uses. The Machine is named by its Details row; the raw terminal key and daemon vocabulary stay out of the reading.
 */
function describeMachineTerminalApprovalSummary(actionId: MachineTerminalActionId, input: unknown, context?: ApprovalPresentationContext): string | null {
  const folder = terminalFolderName(input, context);
  const where = folder ? ` in “${folder}”` : '';
  switch (actionId) {
    case 'machines.terminal.open': return `Open a terminal${where}.`;
    case 'machines.terminal.restart': return `Restart the terminal${where}. Anything running in it stops.`;
    case 'machines.terminal.close': return 'Close a terminal. Anything running in it stops.';
    case 'machines.terminal.write': return 'Type into a terminal.';
    default: return null;
  }
}
function row<TId extends MachineTerminalActionId>(actionId: TId, title: string, rpcMethod: string, read = false): MachineTerminalSpec<TId> {
  return {
    id: actionId, approval: actionId === 'machines.terminal.open' || actionId === 'machines.terminal.restart' ? { result: 'required', flow: 'deferred' } : { result: 'required' },
    requiredAuthority: actionId === 'machines.terminal.open' || actionId === 'machines.terminal.restart' ? 'account_automation' : 'present_user',
    ...(actionId === 'machines.terminal.close' ? { confirmVerb: { key: 'common.close', fallback: 'Close' } }
      : actionId === 'machines.terminal.restart' ? { confirmVerb: { key: 'localServices.effectReview.restart', fallback: 'Restart' } } : {}),
    // Open/restart also route typed package scripts through the finite Project
    // Action. Interactive observation/control remains a present-person effect.
    approvalPolicy: { uiConfirmation: actionId === 'machines.terminal.open' || actionId === 'machines.terminal.write' ? 'direct' : 'policy' }, title,
    // The terminal key is how the daemon finds its terminal and its size is the client's pane; people know the terminal by its folder and Machine.
    approvalPresentation: { summary: (input: unknown, context?: ApprovalPresentationContext) => describeMachineTerminalApprovalSummary(actionId, input, context),
      technicalInputPaths: ['terminalKey', 'cols', 'rows'] },
    description: read ? 'Read only the authenticated requester’s current Machine terminals. No Session is required.'
      : 'Operate on a requester-owned Machine terminal through the canonical daemon PTY owner. Project shells retain their accepted checkout. Interactive input and resize remain under admitted terminal custody.',
    safety: read ? 'safe' : 'danger', sideEffectClass: read ? 'read' : 'danger',
    executionPlacement: 'machine', placements: [],
    surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: true, rpc: false },
    bindings: { rpcMethod, mcpToolName: actionId.replaceAll('.', '_'), voiceClientToolName: actionId.replaceAll('.', '_') },
    cli: { commands: [{ path: actionId.split('.'), visibility: 'canonical' }] },
    inputSchema: MACHINE_TERMINAL_ACTION_INPUT_SCHEMAS[actionId], outputSchema: MACHINE_TERMINAL_ACTION_OUTPUT_SCHEMAS[actionId],
    invocationServerIdForInput: actionInputServerId<(typeof MACHINE_TERMINAL_ACTION_INPUT_SCHEMAS)[MachineTerminalActionId]>(MACHINE_TERMINAL_ACTION_INPUT_SCHEMAS[actionId], input => input.serverId),
    inputHints: { fields: [
      { path: 'serverId', title: 'Home ID', widget: 'text', required: true },
      { path: 'machineId', title: 'Machine ID', widget: 'text', required: true },
      ...(actionId === 'machines.terminal.open' || actionId === 'machines.terminal.restart' ? [
        { path: 'terminalKey', title: 'Terminal key', widget: 'text' as const, required: true },
        { path: 'workspace', title: 'Accepted Project checkout', widget: 'json' as const },
        { path: 'cwd', title: 'Working directory', widget: 'text' as const },
        { path: 'cols', title: 'Columns', widget: 'text' as const },
        { path: 'rows', title: 'Rows', widget: 'text' as const },
        { path: 'launch', title: 'Launch intent', widget: 'json' as const },
        { path: 'sessionId', title: 'Owning Session ID', widget: 'text' as const },
      ] : actionId === 'machines.terminal.list' ? [] : [{ path: 'terminalId', title: 'Terminal ID', widget: 'text' as const, required: true }]),
      ...(actionId === 'machines.terminal.read' ? [
        { path: 'byteOffset', title: 'Byte offset', widget: 'text' as const, required: true },
        { path: 'maxBytes', title: 'Maximum bytes', widget: 'text' as const },
        { path: 'maxFrames', title: 'Maximum frames', widget: 'text' as const },
      ] : actionId === 'machines.terminal.write' ? [
        { path: 'event', title: 'Typed terminal input', widget: 'json' as const, required: true },
      ] : []),
    ] },
  };
}
export const MACHINE_TERMINAL_ACTION_SPECS = [
  row('machines.terminal.open', 'Open machine terminal', RPC_METHODS.DAEMON_TERMINAL_ENSURE),
  row('machines.terminal.list', 'List machine terminals', RPC_METHODS.DAEMON_TERMINAL_LIST, true),
  row('machines.terminal.read', 'Read machine terminal', RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES, true),
  row('machines.terminal.write', 'Write machine terminal', RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT),
  row('machines.terminal.close', 'Close machine terminal', RPC_METHODS.DAEMON_TERMINAL_CLOSE),
  row('machines.terminal.restart', 'Restart machine terminal', RPC_METHODS.DAEMON_TERMINAL_RESTART),
] as const;
export function isMachineTerminalActionId(value: string): value is MachineTerminalActionId {
  return (MACHINE_TERMINAL_ACTION_IDS as readonly string[]).includes(value);
}
