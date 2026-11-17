import { readRecord } from '../../inputs/inputRecords.js';
import { computeActionInputApprovalDigestV1 } from '../decisionAuthority.js';
import { sameStrictJsonValue } from '../../json/strictJsonValue.js';
import { ACTION_INVOKE_ACTION_ID_V1, type ActionId } from '../actionIds.js';
import type { ActionExecutorContext } from './types.js';
import { isPresentUserHostInvocation, isHomeAdmittedPresentUserHostInvocation, pluginActionInvokeConfirmationMismatchV1 } from '../invocationAuthority.js';
import { readExternalActionBindingAuthority } from '../externalActionBindingAuthority.js';
import { isDeploymentActionIdV1 } from '../../deployments/deploymentActionIdsV1.js';
import { admitDeploymentHomeInputV1 } from './deploymentHomeAdmission.js';

/** Bind a host's completed Confirm to the captured Account, target and normalized intent. */
export function bindPresentUserActionConfirmationV1(actionId: ActionId, input: unknown, context: ActionExecutorContext,
  reviewDigest?: string): ActionExecutorContext {
  // A supplied marker belongs to its original invocation, including legacy default-only markers.
  if (context.presentUserConfirmation || !isPresentUserHostInvocation(context)
    || !context.runtimeAccountId || !context.actionRequestId || !(context.serverIdentityId ?? context.serverId)) return context;
  const target = context.externalActionTarget;
  // The executor names a Deployment's Home before digests; the confirmation answers that same admitted intent.
  const home = isDeploymentActionIdV1(actionId) ? admitDeploymentHomeInputV1(input, context, undefined) : null;
  const admittedInput = home && 'input' in home ? home.input : input;
  return { ...context, authority: 'present_user', actionCaller: { kind: 'host' }, presentUserConfirmation: {
    actionId, inputDigest: computeActionInputApprovalDigestV1(actionId, admittedInput, context.sessionTargetsV1),
    ...(reviewDigest ? { reviewDigest } : {}), requestId: context.actionRequestId,
    accountId: context.runtimeAccountId, serverId: context.serverIdentityId ?? context.serverId!,
    target: target ? target.kind === 'session' ? { kind: 'session', sessionId: target.sessionId }
      : { kind: 'machine', machineId: target.machineId, ...(target.project ? { project: { ...target.project } } : {}) } : null,
  } };
}

/** Both a witnessed Artifact decision and a native Confirm record the same reviewed parent. */
export function recordPresentUserApprovalV1(args: Readonly<{
  actionId: ActionId;
  input: unknown;
  requestId: string;
  artifactId?: string;
  requestSurface?: ActionExecutorContext['surface'];
  decidingAccountId?: string;
  decidedAtMs?: number;
  reviewDigest?: string;
}>): NonNullable<ActionExecutorContext['presentUserApproval']> {
  return {
    ...(args.artifactId ? { artifactId: args.artifactId } : {}),
    actionId: args.actionId, requestId: args.requestId,
    inputDigest: computeActionInputApprovalDigestV1(args.actionId, args.input),
    ...(args.reviewDigest ? { reviewDigest: args.reviewDigest } : {}),
    ...(args.requestSurface ? { requestSurface: args.requestSurface } : {}),
    ...(args.decidingAccountId ? { decidingAccountId: args.decidingAccountId } : {}),
    ...(args.decidedAtMs === undefined ? {} : { decidedAtMs: args.decidedAtMs }),
  };
}

// Confirmation belongs to one invocation. Weak membership retains no completed operation or timer.
const consumedConfirmations = new WeakSet<object>();

/** Comparison categories only: never include either compared value. */
const currentIntentMismatchFields = ['account', 'binding', 'fingerprint_source', 'version', 'surface', 'child_proof'] as const;
export type CurrentIntentMismatchV1 = Readonly<{
  field: typeof currentIntentMismatchFields[number];
}>;

/** Read the owner's closed diagnostic vocabulary from a public failure envelope. */
export function readCurrentIntentMismatchFieldV1(value: unknown): CurrentIntentMismatchV1['field'] | undefined {
  return currentIntentMismatchFields.find(field => field === value);
}

/** A terminal keeps its automation floor while spending its exact in-flow confirmation. */
function isStandaloneTerminalCliConfirmation(context: ActionExecutorContext): boolean {
  const binding = context.externalActionExecutionAuthorization?.binding;
  return context.surface === 'cli' && !!binding && 'authentication' in binding
    && binding.authentication.kind === 'terminal' && !binding.sessionActionOrigin
    && !binding.workflowActionOrigin && !binding.nativeCredentialSpawnChild;
}

function confirmationMismatch(actionId: ActionId, input: unknown, context: ActionExecutorContext,
  inputDigest?: string): CurrentIntentMismatchV1 | null {
  const confirmation = context.presentUserConfirmation;
  const binding = context.externalActionExecutionAuthorization?.binding;
  if (!confirmation || consumedConfirmations.has(confirmation) || confirmation.actionId !== actionId) return { field: 'child_proof' };
  if (!context.runtimeAccountId || confirmation.accountId !== context.runtimeAccountId
    || binding && binding.accountId !== context.runtimeAccountId) return { field: 'account' };
  if (context.externalActionCredential || context.rpcSessionAuthorization
    || binding && !((readExternalActionBindingAuthority(binding) === 'present_user'
        || isStandaloneTerminalCliConfirmation(context))
      && binding.requestId === context.actionRequestId
      && binding.actionId === actionId && sameStrictJsonValue(binding.target, context.externalActionTarget))
    || !context.actionRequestId || confirmation.requestId !== context.actionRequestId
    || confirmation.serverId !== (context.serverIdentityId ?? context.serverId)
    || !sameStrictJsonValue(confirmation.target ?? null, context.externalActionTarget ?? null)) return { field: 'binding' };
  return confirmation.inputDigest === (inputDigest ?? computeActionInputApprovalDigestV1(actionId, input, context.sessionTargetsV1))
    ? null : { field: 'fingerprint_source' };
}

/** Consume the host's completed confirmation for this exact normalized invocation. */
export function admitPresentUserConfirmationV1(actionId: ActionId, input: unknown,
  context: ActionExecutorContext): NonNullable<ActionExecutorContext['presentUserApproval']> | null {
  if ((!isPresentUserHostInvocation({ ...context, externalActionExecutionAuthorization: undefined })
      && !isStandaloneTerminalCliConfirmation(context))
    || context.actionCaller?.kind !== 'host' || confirmationMismatch(actionId, input, context)) return null;
  consumedConfirmations.add(context.presentUserConfirmation!);
  return recordPresentUserApprovalV1({ actionId, input, requestId: context.actionRequestId!,
    requestSurface: context.surface, decidingAccountId: context.runtimeAccountId, decidedAtMs: Date.now() });
}

/** The target gate consumes only this Account relay's exact already-confirmed wrapper. */
export function admitAccountActionInvokeConfirmationV1(input: unknown, context: ActionExecutorContext,
  pluginInputDigest: string | null): Readonly<{ admitted: true } | { admitted: false; mismatch: CurrentIntentMismatchV1 }> {
  const refused = (mismatch: CurrentIntentMismatchV1) => ({ admitted: false as const, mismatch });
  const binding = context.externalActionExecutionAuthorization?.binding;
  if (!binding || readExternalActionBindingAuthority(binding) !== 'present_user'
    || binding.serverIdentityId !== (context.serverIdentityId ?? context.serverId)) return refused({ field: 'binding' });
  const originMismatch = pluginActionInvokeConfirmationMismatchV1(context);
  const mismatch = context.presentUserConfirmation
    ? originMismatch ? { field: originMismatch }
      : !pluginInputDigest ? { field: 'fingerprint_source' as const }
        : confirmationMismatch(ACTION_INVOKE_ACTION_ID_V1, input, context, pluginInputDigest)
    : { field: 'child_proof' as const };
  if (!mismatch) {
    consumedConfirmations.add(context.presentUserConfirmation!);
    return { admitted: true };
  }
  // The generic host Action executor already consumed and admitted its private proof.
  const review = context.presentUserApproval;
  if (typeof readRecord(input).expectedContributorOccurrenceId !== 'string'
    || !isHomeAdmittedPresentUserHostInvocation(context, ACTION_INVOKE_ACTION_ID_V1)
    || !review || consumedConfirmations.has(review) || review.actionId !== ACTION_INVOKE_ACTION_ID_V1) return refused(mismatch);
  if (review.requestId !== context.actionRequestId) return refused({ field: 'binding' });
  if (review.decidingAccountId !== context.runtimeAccountId) return refused({ field: 'account' });
  if (review.inputDigest !== computeActionInputApprovalDigestV1(ACTION_INVOKE_ACTION_ID_V1, input)) return refused({ field: 'fingerprint_source' });
  consumedConfirmations.add(review);
  return { admitted: true };
}
