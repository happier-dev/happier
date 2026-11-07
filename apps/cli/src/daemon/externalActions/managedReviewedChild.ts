import { invokeHostAdmittedSignedReviewedChildV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { isReviewedMachineSetupCodecV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { MACHINE_SETUP_APPLY_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { readRetainedVerifiedExternalActionRequester } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createHostReviewedChildPortV1, type HostReviewedParentV1, type HostReviewedChildrenPlanV1 } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionExecutorContext, ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { SocketRpcMachineAdmissionContextV1 } from '@happier-dev/protocol/socketRpc';
import { ManagedAcquireInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { normalizeStrictJsonValue, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { readPublishedMachineRow } from '@/api/machine/readPublishedMachineRow';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

/** Restore signed native child consent through the single reviewed-child issuer. */
export async function invokeAdmittedReviewedChild(input: Readonly<{
  parent?: HostReviewedParentV1;
  /** The parent's original Account holder, opened by ordinary requester custody. */
  requesterOwnedReview: boolean;
  actionId: ActionId;
  actionInput: unknown;
  context: ActionExecutorContext;
  receivingAdmission?: SocketRpcMachineAdmissionContextV1;
  execute(value: unknown, context: ActionExecutorContext): Promise<ActionExecuteResult>;
}>): Promise<ActionExecuteResult | null> {
  const { parent, context } = input;
  const binding = context.externalActionExecutionAuthorization?.binding;
  const verified = readRetainedVerifiedExternalActionRequester(context.externalActionExecutionAuthorization);
  const signedChild = binding?.workflowActionOrigin?.reviewedChild;
  // Ingress already verified this exact leaf and its original captured grant.
  // Restore only its child purpose; it supplies no parent/root consent authority.
  if (verified && binding && signedChild && isReviewedMachineSetupCodecV1(binding)
    && binding.admittedMachineRole === 'manage' && input.actionId === binding.actionId
    && binding.accountId === context.runtimeAccountId && binding.requestId === context.actionRequestId
    && binding.workflowActionOrigin?.requestId === binding.requestId
    && binding.machineId === context.defaultSessionMachineId
    && binding.serverIdentityId === context.serverIdentityId
    && binding.target.kind === 'machine' && binding.target.machineId === binding.machineId
    && sameStrictJsonValue(binding.target, context.externalActionTarget)
    && signedChild.inputDigest === computeActionInputApprovalDigestV1(MACHINE_SETUP_APPLY_ACTION_ID_V1, input.actionInput)
    && (!input.receivingAdmission || input.receivingAdmission.actorAccountId === binding.accountId
      && input.receivingAdmission.custodianAccountId === binding.custodianAccountId
      && input.receivingAdmission.machineId === binding.machineId
      && input.receivingAdmission.installationId === binding.installationId
      && input.receivingAdmission.role === binding.admittedMachineRole)) {
    return invokeHostAdmittedSignedReviewedChildV1({ context,
      child: { ...signedChild, input: normalizeStrictJsonValue(input.actionInput) },
      ...(input.receivingAdmission ? { receivingAdmission: input.receivingAdmission } : {}),
      execute: input.execute });
  }
  const continuation = binding?.managedContinuation;
  if (!parent || parent.actionId !== 'machines.managed.acquire' || !binding || !continuation) return null;
  const acquired = ManagedAcquireInputV1Schema.safeParse(parent.input);
  if (!acquired.success) return null;
  const controller = acquired.data.selection.kind === 'one-off'
    ? ('controller' in acquired.data.selection ? acquired.data.selection.controller : undefined)
    : acquired.data.controller;
  if (acquired.data.selection.homeId !== binding.serverIdentityId
    || !sameStrictJsonValue(controller, continuation.controller)) return null;
  const requester = readRequesterAccountActionContext(context.externalActionExecutionAuthorization);
  if (!requester) return null;
  // A SOURCE packet alone cannot assert consent for another Account. The
  // original Account's private invocation already has that Account's custody.
  if (!input.requesterOwnedReview) {
    if (!continuation.controller) return null;
    const controllerRow = await runWithServerHttpBaseUrl(requester.serverHttpBaseUrl, () =>
      readPublishedMachineRow(continuation.controller.machineId, requester.credentials, { signal: context.signal })).catch(() => null);
    if (controllerRow?.id !== continuation.controller.machineId
      || controllerRow.access?.custodian.accountId !== binding.accountId) return null;
  }
  const declaration = getActionSpec('machines.managed.acquire').hostReviewedChildren;
  const children = typeof declaration === 'function' ? declaration(acquired.data) : declaration ?? [];
  return invokeReviewedChild({ input, parent, parentInput: acquired.data, children, role: input.actionId });
}

async function invokeReviewedChild(params: Readonly<{
  input: Parameters<typeof invokeAdmittedReviewedChild>[0];
  parent: HostReviewedParentV1;
  parentInput: unknown;
  children: HostReviewedChildrenPlanV1['children'];
  role: string;
}>): Promise<ActionExecuteResult | null> {
  const { input, parent, children } = params;
  const { context } = input;
  let invoked = false;
  const port = createHostReviewedChildPortV1({ actionId: parent.actionId, input: params.parentInput, context,
    plan: { children }, reviewAdmitted: true,
    ...(input.receivingAdmission ? { receivingAdmission: input.receivingAdmission } : {}),
    policies: children.map(child => ({ action: child.action, role: child.role, surface: context.surface ?? 'ui' })),
    execute: async (value, childContext) => {
      invoked = true;
      return input.execute(value, childContext);
    },
  });
  // No match supplies no consent: the caller runs ordinary policy exactly
  // once. A matched child failure is returned and is never dispatched again.
  const result = await port.invoke({ action: input.actionId, role: params.role, input: normalizeStrictJsonValue(input.actionInput) });
  return invoked ? result : null;
}
