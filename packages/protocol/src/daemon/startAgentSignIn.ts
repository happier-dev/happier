import { AgentSignInPrepareResponseSchema, machineAgentSignInTerminalKey, type AgentSignInPrepareRequest, type MachinesAgentsSignInStartOutput, type MachinesAgentsSignInCancelInput, type MachinesAgentsSignInCancelOutput } from './agentSignIn.js';
import type { ConnectedAccountAttemptResponse, ConnectedAccountDaemonCommand } from '../connect/connectedAccountDaemonRpcV1.js';
import type { DaemonTerminalEnsureRequest, DaemonTerminalEnsureResponse, DaemonTerminalCloseResponse, DaemonTerminalListResponseV1 } from './terminal.js';

/** One sequence; the existing terminal and Connected Account owners retain execution. */
export async function startMachineAgentSignIn(
  input: AgentSignInPrepareRequest & { machineId: string },
  operations: Readonly<{
    prepare(request: AgentSignInPrepareRequest): Promise<unknown>;
    beginConnect(command: ConnectedAccountDaemonCommand): Promise<ConnectedAccountAttemptResponse>;
    ensureTerminal(request: DaemonTerminalEnsureRequest): Promise<DaemonTerminalEnsureResponse>;
    closeTerminal(terminalId: string): Promise<DaemonTerminalCloseResponse>;
    signal?: AbortSignal;
  }>,
): Promise<MachinesAgentsSignInStartOutput> {
  const { machineId, ...request } = input;
  const cancelled = { ok: false as const, errorCode: 'sign_in_cancelled', error: 'Sign-in cancelled' };
  if (operations.signal?.aborted) return cancelled;
  const prepared = AgentSignInPrepareResponseSchema.parse(await operations.prepare(request));
  if ('ok' in prepared) return prepared;
  if (operations.signal?.aborted) return cancelled;
  if (prepared.method === 'connected') return await operations.beginConnect(prepared.command);
  const terminalKey = machineAgentSignInTerminalKey(machineId, request.agentId);
  // Acquisition must retain its response even after cancellation: only that
  // response identifies the process that needs closing. The daemon owns reuse
  // and initial dimensions; visual attachment is not launch admission.
  const ensured = await operations.ensureTerminal({ terminalKey, launch: prepared.launch });
  if (!ensured.ok) return ensured;
  if (operations.signal?.aborted) {
    const closed = await operations.closeTerminal(ensured.terminalId);
    return closed.ok ? cancelled : closed;
  }
  return { terminalKey, terminalId: ensured.terminalId };
}

/** Close only the process acquired by this sign-in, never a newer terminal with the same key. */
export async function cancelMachineAgentSignIn(
  input: MachinesAgentsSignInCancelInput,
  operations: Readonly<{
    listTerminals(): Promise<DaemonTerminalListResponseV1 | null>;
    closeTerminal(terminalId: string): Promise<DaemonTerminalCloseResponse>;
    signal?: AbortSignal;
  }>,
): Promise<MachinesAgentsSignInCancelOutput> {
  operations.signal?.throwIfAborted();
  const listed = await operations.listTerminals();
  operations.signal?.throwIfAborted();
  if (!listed) return { ok: false, errorCode: 'sign_in_unavailable', error: 'Terminal listing is unavailable.' };
  if (!listed.ok) return listed;
  const key = machineAgentSignInTerminalKey(input.machineId, input.agentId);
  if (!listed.terminals.some((terminal) => terminal.terminalId === input.terminalId && terminal.terminalKey === key)) {
    return { ok: false, errorCode: 'sign_in_terminal_changed', error: 'The acquired sign-in terminal is no longer current.' };
  }
  return await operations.closeTerminal(input.terminalId);
}

export async function restartMachineAgentSignIn(
  input: MachinesAgentsSignInCancelInput,
  operations: Parameters<typeof startMachineAgentSignIn>[1] & Parameters<typeof cancelMachineAgentSignIn>[1],
): Promise<MachinesAgentsSignInStartOutput> {
  const closed = await cancelMachineAgentSignIn(input, operations);
  if (!closed.ok) return closed;
  return await startMachineAgentSignIn({ machineId: input.machineId, agentId: input.agentId, method: 'native' }, operations);
}
