import { RPC_METHODS } from '../../rpc/methods.js';
import { createRpcCallError } from '../../rpc/errors.js';
import { TerminalStreamReadRequestSchema, TerminalStreamReadResponseSchema,
  type TerminalStreamReadResponse } from '../../terminal/stream.js';
import { ACTION_OPERATION_RPC_METHODS_V1, ACTION_OPERATION_RPC_METHODS_V2, ActionOperationListV1ResponseSchema,
  ActionOperationGetV1ResponseSchema, ActionOperationCancelV1ResponseSchema,
  type ActionOperationSnapshotV1 } from '../operations/v1.js';
import { ActionOperationActionInputSchemasV1, type ActionOperationActionIdV1,
  type ActionOperationActionInputV1 } from '../specs/actionOperations.js';
import { readActionFailureEnvelope } from './actionFailureEnvelope.js';
import type { ActionExecuteFailure } from './types.js';

export type QualifiedActionOperationV1 = Readonly<{
  serverId: string; machineId: string; operationId: string;
}>;
export type ActionOperationMachineTransportV1 = (request: Readonly<{
  serverId: string; machineId: string; method: string; payload: unknown; signal?: AbortSignal;
}>) => Promise<unknown>;
type ActionOperationFailure = Readonly<{ ok: false; errorCode: string; error: string }>;
type TerminalStreamReadOkResponse = Extract<TerminalStreamReadResponse, { ok: true }>;
const failure = (errorCode: string): ActionOperationFailure => ({ ok: false, errorCode, error: errorCode });

/** Adapts public Actions to the incumbent operation authority and byte ring. */
export async function executeActionOperationActionV1(args: Readonly<{
  actionId: ActionOperationActionIdV1;
  input: ActionOperationActionInputV1;
  signal?: AbortSignal;
  transport: ActionOperationMachineTransportV1;
  openOutput?: (target: QualifiedActionOperationV1 & Readonly<{ operation: ActionOperationSnapshotV1 }>) => Promise<void>;
  copyOutput?: (output: TerminalStreamReadOkResponse) => Promise<void | ActionExecuteFailure>;
}>): Promise<unknown> {
  const input = ActionOperationActionInputSchemasV1[args.actionId].parse(args.input);
  const { serverId, machineId, ...payload } = input;
  const invoke: ActionOperationMachineTransportV1 = async request => {
    const raw = await args.transport(request);
    if (raw && typeof raw === 'object' && 'error' in raw && typeof raw.error === 'string'
      && !('ok' in raw) && !('type' in raw)) {
      throw createRpcCallError({ error: raw.error,
        ...('errorCode' in raw && typeof raw.errorCode === 'string' ? { errorCode: raw.errorCode } : {}),
      });
    }
    return raw;
  };
  const call = (method: string, request: unknown) => invoke({
    serverId, machineId, method, payload: request, ...(args.signal ? { signal: args.signal } : {}),
  });
  if (args.actionId === 'action.operations.list') {
    const raw = await call(ACTION_OPERATION_RPC_METHODS_V2.list, payload);
    return readActionFailureEnvelope(raw, { treatReturnedErrorEnvelopeAsFailure: true }) ?? ActionOperationListV1ResponseSchema.parse(raw);
  }
  if (args.actionId === 'action.operations.cancel') {
    const raw = await call(ACTION_OPERATION_RPC_METHODS_V1.cancel, payload);
    return readActionFailureEnvelope(raw, { treatReturnedErrorEnvelopeAsFailure: true }) ?? ActionOperationCancelV1ResponseSchema.parse(raw);
  }
  if (args.actionId === 'action.operations.get') {
    const raw = await call(ACTION_OPERATION_RPC_METHODS_V2.get, payload);
    return readActionFailureEnvelope(raw, { treatReturnedErrorEnvelopeAsFailure: true }) ?? ActionOperationGetV1ResponseSchema.parse(raw);
  }
  if (args.actionId === 'projects.execution.output.open' && !args.openOutput) return failure('client_context_required');
  // Fetch under current authorization on every use. The caller never supplies
  // the terminal id or an attachment that could retarget another command.
  const address = ActionOperationActionInputSchemasV1['projects.execution.output.open'].parse({
    serverId, machineId, operationId: 'operationId' in input ? input.operationId : undefined,
  });
  const rawOperation = await call(ACTION_OPERATION_RPC_METHODS_V2.get, {
    operationId: address.operationId,
  });
  const operationFailure = readActionFailureEnvelope(rawOperation, { treatReturnedErrorEnvelopeAsFailure: true });
  if (operationFailure) return operationFailure;
  const found = ActionOperationGetV1ResponseSchema.parse(rawOperation);
  if (found.kind === 'not_found') return failure('operation_not_found');
  if (found.operation.operationId !== address.operationId || found.operation.scope.machineId !== machineId) {
    return failure('operation_scope_mismatch');
  }
  const attachment = found.operation.domainRef;
  if (attachment?.kind !== 'projectCommand') return failure('operation_output_unavailable');
  if (args.actionId === 'projects.execution.output.open') {
    await args.openOutput!({ ...address, operation: found.operation });
    return { kind: 'opened' };
  }
  if (!attachment.terminalId) return failure('operation_output_pending');
  const readInput = ActionOperationActionInputSchemasV1['projects.execution.output.read'].parse(input);
  const { serverId: _serverId, machineId: _machineId, operationId: _operationId, ...cursor } = readInput;
  const rawOutput = await invoke({
    // Operation custody and execution destination are separate qualified addresses.
    serverId: attachment.serverId, machineId: attachment.machineId,
    method: RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES,
    payload: TerminalStreamReadRequestSchema.parse({ ...cursor, terminalId: attachment.terminalId }),
    ...(args.signal ? { signal: args.signal } : {}),
  });
  const outputFailure = readActionFailureEnvelope(rawOutput, { treatReturnedErrorEnvelopeAsFailure: true });
  if (outputFailure) return outputFailure;
  const output = TerminalStreamReadResponseSchema.parse(rawOutput);
  if (!output.ok) return { ok: false, errorCode: output.code, error: output.message };
  if (output.terminalId !== attachment.terminalId) return failure('operation_output_scope_mismatch');
  if (args.actionId === 'projects.execution.output.read') return output;
  if (!args.copyOutput) return { kind: 'bytes', output };
  const copied = await args.copyOutput(output);
  return readActionFailureEnvelope(copied) ?? { kind: 'copied', output };
}
