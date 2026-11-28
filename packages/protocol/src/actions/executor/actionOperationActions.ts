import { RPC_METHODS } from '../../rpc/methods.js';
import { createRpcCallError, readRpcErrorCode } from '../../rpc/errors.js';
import { parseCapabilitiesInvokeResponse } from '../../capabilities/invokeResponse.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import { MANAGED_ACQUIRE_ACTION_ID_V1 } from '../../machines/managed/actionIdsV1.js';
import { readActionOperationTaskQuestionV1 } from '../operations/taskQuestionV1.js';
import { ACTION_OPERATION_TASK_RESPOND_ACTION_ID_V1 } from '../operations/actionIdsV1.js';
import { TERMINAL_STREAM_MAX_READ_BYTES, TerminalStreamReadRequestSchema, TerminalStreamReadResponseSchema,
  type TerminalStreamReadResponse } from '../../terminal/stream.js';
import { ACTION_OPERATION_RPC_METHODS_V1, ACTION_OPERATION_RPC_METHODS_V2, ActionOperationListV1ResponseSchema,
  ActionOperationGetV1ResponseSchema, ActionOperationCancelV1ResponseSchema,
  type ActionOperationSnapshotV1 } from '../operations/v1.js';
import { ActionOperationActionInputSchemasV1, type ActionOperationActionIdV1,
  type ActionOperationActionInputV1 } from '../specs/actionOperations.js';
import { readActionFailureEnvelope } from './actionFailureEnvelope.js';
import { selectOperationOutput } from './selectedOutput.js';
import type { ActionExecuteFailure, ActionExecutorContext } from './types.js';

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
  context?: Pick<ActionExecutorContext, 'expectedAccountId' | 'surface'>;
  signal?: AbortSignal;
  transport: ActionOperationMachineTransportV1;
  /** Host-trusted operation snapshot already retrieved for this caller; skips redundant actionOperation.get.v2 when matching and attached to a terminal. */
  knownOperation?: ActionOperationSnapshotV1;
  openOutput?: (target: QualifiedActionOperationV1 & Readonly<{ operation: ActionOperationSnapshotV1 }>) => Promise<void>;
  copyOutput?: (output: TerminalStreamReadOkResponse) => Promise<void | ActionExecuteFailure>;
}>): Promise<unknown> {
  const copyInput = args.actionId === 'projects.execution.output.copy'
    ? ActionOperationActionInputSchemasV1['projects.execution.output.copy'].parse(args.input) : undefined;
  const input = copyInput ?? ActionOperationActionInputSchemasV1[args.actionId].parse(args.input);
  const selection = copyInput?.selection;
  if (selection?.kind === 'rendered') return failure('operation_output_selection_mapping_unavailable');
  const { serverId, machineId, ...operands } = input;
  // The signed Action header owns resource admission. Ordinary RPC input stays
  // unchanged and cannot manufacture a managed observation scope.
  const { managed: _managed, ...operationOperands } = 'managed' in operands ? operands : { ...operands, managed: undefined };
  const { environmentId: _environmentId, ...payload } = 'environmentId' in operationOperands
    ? operationOperands : { ...operationOperands, environmentId: undefined };
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
  if (args.actionId === ACTION_OPERATION_TASK_RESPOND_ACTION_ID_V1) {
    const answerInput = ActionOperationActionInputSchemasV1[ACTION_OPERATION_TASK_RESPOND_ACTION_ID_V1].parse(input);
    if (!args.context?.expectedAccountId) return failure('action_operation_unavailable');
    try {
      const found = ActionOperationGetV1ResponseSchema.safeParse(await call(ACTION_OPERATION_RPC_METHODS_V2.get, {
        operationId: answerInput.operationId,
      }));
      if (!found.success || found.data.kind !== 'found') return failure('action_operation_unavailable');
      const operation = found.data.operation;
      const domain = operation.domainRef;
      if (operation.operationId !== answerInput.operationId || operation.scope.machineId !== machineId
        || operation.scope.accountId !== args.context.expectedAccountId
        || (domain?.kind === 'machineSetup' || domain?.kind === 'machineReboot') && domain.serverId !== serverId) {
        return failure('action_operation_unavailable');
      }
      const question = readActionOperationTaskQuestionV1(operation);
      if (!question && operation.actionId === MANAGED_ACQUIRE_ACTION_ID_V1
        && 'trusted' in answerInput.answer && answerInput.answer.trusted === true
        && (domain?.kind === 'systemTask' && domain.id === answerInput.taskId && !domain.prompt
          || domain?.kind === 'managedMachine' && operation.state === 'succeeded'
            && domain.bootstrapTask?.id === answerInput.taskId && !domain.bootstrapTask.prompt)) {
        // An Inbox answer can retire the trust question while the chooser still displays it.
        // Acknowledge the retired question so the caller can read the same operation's result.
        return { kind: 'answered' };
      }
      if (question?.id !== answerInput.taskId || !sameStrictJsonValue(question.prompt, answerInput.prompt)) {
        return failure('action_operation_unavailable');
      }
      const response = parseCapabilitiesInvokeResponse(await call(RPC_METHODS.CAPABILITIES_INVOKE, {
        id: 'tool.systemTasks', method: 'respond', params: {
          taskId: question.id, expectedPromptKind: question.prompt.kind, answer: answerInput.answer,
        },
      }));
      if (!response) return failure('action_operation_unavailable');
      return response.ok ? { kind: 'answered' } : failure(response.error.code ?? 'action_operation_unavailable');
    } catch (error) {
      return failure(args.signal?.aborted ? 'cancelled' : readRpcErrorCode(error) ?? 'action_operation_unavailable');
    }
  }
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
  // Fetch under current authorization on every use unless the host caller
  // already holds a matching operation snapshot with its terminal attachment.
  // Untrusted Action inputs never supply the terminal id or attachment.
  const address = ActionOperationActionInputSchemasV1['projects.execution.output.open'].parse({
    serverId, machineId, operationId: 'operationId' in input ? input.operationId : undefined,
  });
  const known = args.knownOperation;
  const knownMatches = args.actionId !== 'projects.execution.output.open'
    && known !== undefined
    && known.operationId === address.operationId
    && known.scope.machineId === machineId
    && (!args.context?.expectedAccountId || known.scope.accountId === args.context.expectedAccountId)
    && known.domainRef?.kind === 'projectCommand'
    && typeof known.domainRef.serverId === 'string'
    && known.domainRef.serverId.trim().length > 0
    && typeof known.domainRef.machineId === 'string'
    && known.domainRef.machineId.trim().length > 0
    && typeof known.domainRef.terminalId === 'string'
    && known.domainRef.terminalId.trim().length > 0;
  let operation: ActionOperationSnapshotV1;
  if (knownMatches) {
    operation = known;
  } else {
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
    operation = found.operation;
  }
  const attachment = operation.domainRef;
  if (attachment?.kind !== 'projectCommand') return failure('operation_output_unavailable');
  if (args.actionId === 'projects.execution.output.open') {
    await args.openOutput!({ ...address, operation });
    return { kind: 'opened' };
  }
  if (!attachment.terminalId) return failure('operation_output_pending');
  const { selection: _selection, ...readOperands } = 'selection' in input ? input : { ...input, selection: undefined };
  const readInput = ActionOperationActionInputSchemasV1['projects.execution.output.read'].parse(readOperands);
  const { serverId: _serverId, machineId: _machineId, operationId: _operationId, ...cursor } = readInput;
  const rawOutput = await invoke({
    // Operation custody and execution destination are separate qualified addresses.
    serverId: attachment.serverId, machineId: attachment.machineId,
    method: RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES,
    payload: TerminalStreamReadRequestSchema.parse({ ...cursor, terminalId: attachment.terminalId,
      ...(selection?.kind === 'bytes' ? { maxBytes: Math.min(selection.endByteOffset - readInput.byteOffset,
        cursor.maxBytes ?? TERMINAL_STREAM_MAX_READ_BYTES) } : {}) }),
    ...(args.signal ? { signal: args.signal } : {}),
  });
  const outputFailure = readActionFailureEnvelope(rawOutput, { treatReturnedErrorEnvelopeAsFailure: true });
  if (outputFailure) return outputFailure;
  const output = TerminalStreamReadResponseSchema.parse(rawOutput);
  if (!output.ok) return { ok: false, errorCode: output.code, error: output.message };
  if (output.terminalId !== attachment.terminalId) return failure('operation_output_scope_mismatch');
  if (args.actionId === 'projects.execution.output.read') return output;
  const selected = selection?.kind === 'bytes'
    ? selectOperationOutput(output, { ...readInput, selection }) : { output };
  if (!args.copyOutput) return { kind: 'bytes', ...selected };
  const copied = await args.copyOutput(selected.output);
  return readActionFailureEnvelope(copied) ?? { kind: 'copied', ...selected };
}
