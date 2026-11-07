import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { MACHINE_PROCESS_INPUT_FIELDS } from './machineProcessesInputHints.js';
import { MACHINE_PROCESSES_ACTION_IDS } from './machineProcessesActionIdsV1.js';
export { MACHINE_PROCESSES_ACTION_IDS } from './machineProcessesActionIdsV1.js';
import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { subsetNarrowing, type ApprovalNarrowing } from '../../approvals/approvalNarrowing.js';
import {
  MachineProcessesListInputV1Schema, MachineProcessesGetInputV1Schema, MachineProcessesCheckInputV1Schema,
  MachineProcessesStopInputV1Schema, MachineProcessesKillInputV1Schema, MachineProcessesCleanUpInputV1Schema,
  MachineProcessesStartAgainInputV1Schema, MachineProcessesAnswerV1Schema, MachineProcessesGetResultV1Schema,
  MachineProcessesCheckResultV1Schema, MachineProcessesActionResultV1Schema, MachineProcessesCleanUpResultV1Schema,
  MachineProcessesStartAgainResultV1Schema,
} from '../../machines/processes/machineProcessesV1.js';
import { RPC_METHODS } from '../../rpc/methods.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import { actionInputServerId } from './definition.js';
export type MachineProcessesActionId = typeof MACHINE_PROCESSES_ACTION_IDS[number];
export const MachineProcessesActionIdSchema = lazyZodSchema(() => z.enum(MACHINE_PROCESSES_ACTION_IDS));
export const MACHINE_PROCESSES_ACTION_INPUT_SCHEMAS = {
  'machines.processes.list': MachineProcessesListInputV1Schema,
  'machines.processes.get': MachineProcessesGetInputV1Schema,
  'machines.processes.check': MachineProcessesCheckInputV1Schema,
  'machines.processes.stop': MachineProcessesStopInputV1Schema,
  'machines.processes.startAgain': MachineProcessesStartAgainInputV1Schema,
  'machines.processes.kill': MachineProcessesKillInputV1Schema,
  'machines.processes.leftBehind.cleanUp': MachineProcessesCleanUpInputV1Schema,
} as const;
export type MachineProcessesActionInput = z.infer<(typeof MACHINE_PROCESSES_ACTION_INPUT_SCHEMAS)[MachineProcessesActionId]>;
export const MACHINE_PROCESSES_ACTION_OUTPUT_SCHEMAS = {
  'machines.processes.list': MachineProcessesAnswerV1Schema,
  'machines.processes.get': MachineProcessesGetResultV1Schema,
  'machines.processes.check': MachineProcessesCheckResultV1Schema,
  'machines.processes.stop': MachineProcessesActionResultV1Schema,
  'machines.processes.startAgain': MachineProcessesStartAgainResultV1Schema,
  'machines.processes.kill': MachineProcessesActionResultV1Schema,
  'machines.processes.leftBehind.cleanUp': MachineProcessesCleanUpResultV1Schema,
} as const;
const refsNarrowing = subsetNarrowing({ path: 'refs', key: item => typeof item.ref === 'string' ? item.ref : '' });
const cleanUpNarrowing: ApprovalNarrowing = {
  narrow(original, chosen) {
    const source = MachineProcessesCleanUpInputV1Schema.safeParse(original);
    const selection = MachineProcessesCleanUpInputV1Schema.safeParse(chosen);
    if (!source.success || !selection.success) return null;
    // Adapt the protocol's primitive refs to the landed set-narrowing owner.
    return refsNarrowing.narrow(
      { ...source.data, refs: source.data.refs.map(ref => ({ ref })) },
      { ...selection.data, refs: selection.data.refs.map(ref => ({ ref })) },
    ) === null ? null : selection.data;
  },
};
type MachineProcessesActionSpec<Id extends MachineProcessesActionId> =
  Omit<PreNormalizedActionSpec, 'id' | 'inputSchema' | 'outputSchema'> & {
    id: Id;
    inputSchema: (typeof MACHINE_PROCESSES_ACTION_INPUT_SCHEMAS)[Id];
    outputSchema: (typeof MACHINE_PROCESSES_ACTION_OUTPUT_SCHEMAS)[Id];
  };

function processSpec<const Id extends MachineProcessesActionId>([id, title, description, rpcMethod, command, sideEffectClass, safety]:
  readonly [Id, string, string, string, string, 'read' | 'write' | 'danger', 'safe' | 'danger']): MachineProcessesActionSpec<Id> {
  return {
  id, approval: safety === 'danger' ? { result: 'required' } : { result: 'none' }, title,
  description,
  contextualDefaults: { machineId: 'current_session_machine' }, safety, sideEffectClass, placements: [], executionPlacement: 'machine',
  ...(id === 'machines.processes.stop' ? { approvalPolicy: { uiConfirmation: 'direct' as const } } : {}),
  ...(id === 'machines.processes.kill' ? { approvalPolicy: { uiConfirmation: 'policy' as const } } : {}),
  toolExposure: { agent: id === 'machines.processes.list' ? 'direct' : 'discoverable_only' },
  prompting: { agentGuidance: `In a session, machineId defaults to the session's Machine; explicit input wins. ${sideEffectClass === 'read'
    ? 'Read the requester-scoped census before explaining process use. Read machines.guard.get for canonical stop candidates and why other work is kept; do not invent a competing stop heuristic.'
    : id === 'machines.processes.startAgain'
      ? 'Read the process and its way back first, then start the requested work again. Sessions resume on their next message.'
      : 'Read machines.processes.list and machines.guard.get first, then check the complete selected set. Propose once through the set Action with every requested target and its expectation, never repeat single-item effects in a loop. The person may choose a subset in the approval UI. Explain what stopping or killing ends, including working or waiting sessions; approval follows this Action’s own user setting.'}` },
    surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: false, rpc: true },
    bindings: { rpcMethod, mcpToolName: id.replaceAll('.', '_') },
    inputSchema: MACHINE_PROCESSES_ACTION_INPUT_SCHEMAS[id], outputSchema: MACHINE_PROCESSES_ACTION_OUTPUT_SCHEMAS[id],
    invocationServerIdForInput: actionInputServerId<(typeof MACHINE_PROCESSES_ACTION_INPUT_SCHEMAS)[MachineProcessesActionId]>(MACHINE_PROCESSES_ACTION_INPUT_SCHEMAS[id], input => input.serverId),
    cli: { acceptsServerId: true, commands: [{ path: ['machines', 'processes', command], visibility: 'canonical' }] },
    inputHints: { fields: [
      { path: 'serverId', title: 'Home ID', widget: 'text', required: false },
      { path: 'machineId', title: 'Machine ID', widget: 'text', description: 'Defaults to the calling session Machine; required outside a session.' },
      ...MACHINE_PROCESS_INPUT_FIELDS[id],
    ] },
    ...(id === 'machines.processes.stop' || id === 'machines.processes.kill' ? {
      approvalNarrowing: subsetNarrowing({ path: 'targets', key: item => typeof item.ref === 'string' ? item.ref : '',
        refreshable: ['expect'], ...(id === 'machines.processes.kill' ? { reducible: ['tree'] } : {}) }),
  } : id === 'machines.processes.check' ? {
    approvalNarrowing: refsNarrowing,
  } : id === 'machines.processes.leftBehind.cleanUp' ? {
      approvalNarrowing: cleanUpNarrowing,
      operation: { version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'detail' } },
    } : {}),
  };
}

function createMachineProcessesActionSpecs() {
  return [
  processSpec(['machines.processes.list', 'Read machine processes', 'What Happier started on a machine, grouped by session and owner, with memory and CPU.', RPC_METHODS.MACHINES_PROCESSES_LIST, 'list', 'read', 'safe']),
  processSpec(['machines.processes.get', 'Read a machine process', 'One process Happier started: what it is, who started it and how sure Happier is.', RPC_METHODS.MACHINES_PROCESSES_GET, 'get', 'read', 'safe']),
  processSpec(['machines.processes.check', 'Check machine processes', 'Looks again at the chosen processes right before acting, so nothing changed underneath.', RPC_METHODS.MACHINES_PROCESSES_CHECK, 'check', 'read', 'safe']),
  processSpec(['machines.processes.stop', 'Stop a process or dev server', 'Stops only what Happier started, gently, and checks again at the moment it runs.', RPC_METHODS.MACHINES_PROCESSES_STOP, 'stop', 'danger', 'danger']),
  processSpec(['machines.processes.startAgain', 'Start machine work again', 'Starts a stopped service or browser again. Stopped sessions wake on their next message.', RPC_METHODS.MACHINES_PROCESSES_START_AGAIN, 'start-again', 'write', 'safe']),
  processSpec(['machines.processes.kill', 'Force-quit processes', 'Ends processes that would not stop, after checking they are still the ones you reviewed.', RPC_METHODS.MACHINES_PROCESSES_KILL, 'kill', 'danger', 'danger']),
  processSpec(['machines.processes.leftBehind.cleanUp', 'Clean up left-behind processes', 'Ends processes left behind by sessions that already ended, and says which it skipped.', RPC_METHODS.MACHINES_PROCESSES_LEFT_BEHIND_CLEAN_UP, 'clean-up', 'danger', 'danger']),
] as const satisfies readonly PreNormalizedActionSpec[];
}

export const MACHINE_PROCESSES_ACTION_SPECS: ReturnType<typeof createMachineProcessesActionSpecs> = lazyActionSpecArray(createMachineProcessesActionSpecs);
