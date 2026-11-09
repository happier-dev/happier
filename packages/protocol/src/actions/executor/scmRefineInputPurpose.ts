import type { ExternalActionExecutionAuthorizationV1, ExternalActionMachineRpcExecutionV1 } from '../externalActionApi.js';
import { verifyExternalActionApprovalInputV1 } from '../externalActionExecutionAuthorization.js';
import { SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2, SessionPendingExecutionRunEnqueueByMachineRequestV2Schema } from '../../sessions/messages/sessionPendingExecutionRunMachineAdmissionV2.js';
import { readRecord } from '../../inputs/inputRecords.js';
import type { ActionExecutorContext } from './types.js';
import { readDeploymentRoleRootInputV1 } from './deploymentRoleChild.js';

const rootActionIds = ['scm.diffSummary.refine', 'scm.diffSummary.addOutputs', 'scm.diffSummary.discuss'] as const;
type RootActionId = typeof rootActionIds[number];

function readRootActionId(actionId: string): RootActionId | undefined {
  return rootActionIds.find(id => id === actionId);
}

function savedSessionSigningInput(authorization: ExternalActionExecutionAuthorizationV1, sessionId: string, actionId: RootActionId) {
  return { actionId, authorization, target: { kind: 'session' as const, sessionId },
    input: { purpose: 'scm.refine.saved-session.v1', machineId: authorization.binding.machineId,
      requestId: authorization.binding.requestId, requestEnvelopeDigest: authorization.binding.requestEnvelopeDigest } };
}

/** Called only after the SCM host has admitted the saved result's protected scope. */
export function bindScmRefineSavedSessionV1(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  sessionId: string;
  sign: NonNullable<ActionExecutorContext['signExternalActionApprovalInput']>;
}>): ExternalActionExecutionAuthorizationV1 {
  const { authorization, sessionId } = input;
  const actionId = readRootActionId(authorization.binding.actionId);
  if (!actionId
    || authorization.binding.target.kind === 'session' && authorization.binding.target.sessionId !== sessionId) {
    throw new TypeError('Saved Session input does not match its admitted SCM root');
  }
  // Preserve non-enumerable requester custody ports; never mutate the original root.
  const bound: ExternalActionExecutionAuthorizationV1 = Object.create(Object.getPrototypeOf(authorization),
    Object.getOwnPropertyDescriptors(authorization));
  Object.defineProperty(bound, 'scmRefineSession', { enumerable: true,
    value: { sessionId, signature: input.sign(savedSessionSigningInput(authorization, sessionId, actionId)) } });
  return bound;
}

/** The host's original saved-scope signature is independent of later packet signatures. */
export function verifyScmRefineSavedSessionV1(authorization: ExternalActionExecutionAuthorizationV1, publicKey: string | Uint8Array): boolean {
  const saved = authorization.scmRefineSession;
  const actionId = readRootActionId(authorization.binding.actionId);
  if (!actionId || !saved) return false;
  const signed = savedSessionSigningInput(authorization, saved.sessionId, actionId);
  return verifyExternalActionApprovalInputV1({ authorizationToken: authorization.token,
    actionId: signed.actionId, target: signed.target, input: signed.input, publicKey, signature: saved.signature });
}

/** One declaration for both host-child grant spending and Home's Pending purpose. */
export function isScmRefineInputPurposeV1(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  effectActionId: string;
  sessionId: unknown;
  machineId: unknown;
  localId: unknown;
  requestedAction: unknown;
  recipient: unknown;
}>): boolean {
  const { authorization } = input;
  const saved = authorization.scmRefineSession;
  return readRootActionId(authorization.binding.actionId) !== undefined && input.effectActionId === 'session.message.send'
    && saved !== undefined && input.sessionId === saved.sessionId
    && input.machineId === authorization.binding.machineId
    && input.localId === authorization.binding.requestId
    // Refine retains its explicit send-now contract. Discuss and Add outputs
    // retain ordinary composer scheduling; the Pending schema owns its grammar.
    && (authorization.binding.actionId !== 'scm.diffSummary.refine'
      || readRecord(input.requestedAction).v === 1 && readRecord(input.requestedAction).kind === 'send_now')
    && readRecord(input.recipient).kind === 'execution_run';
}

export function isScmRefineInputRpcPurposeV1(execution: ExternalActionMachineRpcExecutionV1,
  request: Readonly<{ event?: string; method: string; params?: unknown }>): boolean {
  if (request.event !== SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2
    || request.method !== request.event || execution.target.kind !== 'session') return false;
  const pending = SessionPendingExecutionRunEnqueueByMachineRequestV2Schema.safeParse(request.params);
  return pending.success && pending.data.sessionId === execution.target.sessionId
    && isScmRefineInputPurposeV1({ authorization: execution.authorization, effectActionId: execution.effectActionId,
      ...pending.data, machineId: pending.data.targetMachineId });
}

/** Only an actual host child can spend the parent; possessing its carrier does not authorize direct sends. */
export function readHostRootInputCredentialActionV1(actionId: string, input: unknown,
  context: ActionExecutorContext, hostInternal: boolean): RootActionId | NonNullable<ReturnType<typeof readDeploymentRoleRootInputV1>>['actionId'] | null {
  const deployment = readDeploymentRoleRootInputV1(context, actionId, input, hostInternal);
  if (deployment) return deployment.actionId;
  const authorization = context.externalActionExecutionAuthorization;
  const data = readRecord(input);
  return hostInternal && authorization && isScmRefineInputPurposeV1({ authorization, effectActionId: actionId,
    sessionId: data.sessionId, machineId: context.defaultSessionMachineId
      ?? (context.externalActionTarget?.kind === 'machine' ? context.externalActionTarget.machineId : undefined),
    localId: data.localId, requestedAction: data.requestedAction, recipient: data.recipient })
    ? readRootActionId(authorization.binding.actionId) ?? null : null;
}

/** SCM's private callback carries only the root bound by its admitted saved-result owner. */
export function withScmRefineInputAuthorizationV1(context: ActionExecutorContext,
  authorization: ExternalActionExecutionAuthorizationV1 | undefined): ActionExecutorContext {
  const original = context.externalActionExecutionAuthorization;
  return authorization && original && authorization.token === original.token && authorization.binding === original.binding
    ? { ...context, externalActionExecutionAuthorization: authorization } : context;
}
