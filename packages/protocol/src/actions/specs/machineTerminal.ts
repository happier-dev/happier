import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import {
  DaemonTerminalEnsureRequestSchema, DaemonTerminalEnsureResponseSchema,
  DaemonTerminalListRequestV1Schema, DaemonTerminalListResponseV1Schema,
  DaemonTerminalCloseRequestSchema, DaemonTerminalCloseResponseSchema,
  DaemonTerminalRestartRequestSchema, DaemonTerminalRestartResponseSchema,
} from '../../daemon/terminal.js';
import { TerminalStreamReadRequestSchema, TerminalStreamReadResponseSchema } from '../../terminal/stream.js';
import { TerminalStreamInputRequestSchema, TerminalStreamInputResponseSchema } from '../../terminal/input.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import { RPC_METHODS } from '../../rpc/methods.js';

export const MACHINE_TERMINAL_ACTION_IDS = [
  'machines.terminal.open', 'machines.terminal.list', 'machines.terminal.read',
  'machines.terminal.write', 'machines.terminal.close', 'machines.terminal.restart',
] as const;
export type MachineTerminalActionId = typeof MACHINE_TERMINAL_ACTION_IDS[number];
const id = z.string().trim().min(1);
const routing = { serverId: id, machineId: id };
export const MachineTerminalOpenInputSchema = lazyZodSchema(() => DaemonTerminalEnsureRequestSchema.safeExtend(routing).strict());
export const MachineTerminalListInputSchema = lazyZodSchema(() => DaemonTerminalListRequestV1Schema.extend(routing).strict());
export const MACHINE_TERMINAL_ACTION_INPUT_SCHEMAS = {
  'machines.terminal.open': MachineTerminalOpenInputSchema,
  'machines.terminal.list': MachineTerminalListInputSchema,
  'machines.terminal.read': lazyZodSchema(() => TerminalStreamReadRequestSchema.safeExtend(routing).strict()),
  'machines.terminal.write': lazyZodSchema(() => TerminalStreamInputRequestSchema.extend(routing).strict()),
  'machines.terminal.close': lazyZodSchema(() => DaemonTerminalCloseRequestSchema.extend(routing).strict()),
  'machines.terminal.restart': lazyZodSchema(() => DaemonTerminalRestartRequestSchema.safeExtend(routing).strict()),
} as const;
export const MACHINE_TERMINAL_ACTION_OUTPUT_SCHEMAS = {
  'machines.terminal.open': DaemonTerminalEnsureResponseSchema,
  'machines.terminal.list': DaemonTerminalListResponseV1Schema.nullable(),
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
function row<TId extends MachineTerminalActionId>(actionId: TId, title: string, rpcMethod: string, read = false): MachineTerminalSpec<TId> {
  return {
    id: actionId, title,
    description: read ? 'Read only the authenticated requester’s current Machine terminals. No Session is required.'
      : 'Operate on a requester-owned Machine terminal through the canonical daemon PTY owner. Project shells retain their accepted checkout. Interactive input and resize remain under admitted terminal custody.',
    safety: read ? 'safe' : 'danger', sideEffectClass: read ? 'read' : 'danger',
    executionPlacement: 'machine', placements: [],
    surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: true, rpc: false },
    bindings: { rpcMethod, mcpToolName: actionId.replaceAll('.', '_'), voiceClientToolName: actionId.replaceAll('.', '_') },
    cli: { commands: [{ path: actionId.split('.'), visibility: 'canonical' }] },
    inputSchema: MACHINE_TERMINAL_ACTION_INPUT_SCHEMAS[actionId], outputSchema: MACHINE_TERMINAL_ACTION_OUTPUT_SCHEMAS[actionId],
    inputHints: { fields: [
      { path: 'serverId', title: 'Home ID', widget: 'text', required: true },
      { path: 'machineId', title: 'Machine ID', widget: 'text', required: true },
      ...(actionId === 'machines.terminal.open' || actionId === 'machines.terminal.restart' ? [
        { path: 'terminalKey', title: 'Terminal key', widget: 'text' as const, required: true },
        { path: 'workspace', title: 'Accepted Project checkout', widget: 'json' as const },
        { path: 'cwd', title: 'Working directory', widget: 'text' as const },
        { path: 'cols', title: 'Columns', widget: 'text' as const },
        { path: 'rows', title: 'Rows', widget: 'text' as const },
        { path: 'initialCommand', title: 'Initial command', widget: 'text' as const },
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
