import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createHostReviewedChildPortV1, type HostReviewedParentV1 } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionExecutorContext, ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { SocketRpcMachineAdmissionContextV1 } from '@happier-dev/protocol/socketRpc';
import { ManagedAcquireInputV1Schema, resolveManagedAcquireReviewV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { normalizeStrictJsonValue, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { readPublishedMachineRow } from '@/api/machine/readPublishedMachineRow';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

/** Translate admitted managed provenance into the single reviewed-child issuer. */
export async function invokeManagedReviewedChild(input: Readonly<{
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
  const continuation = binding?.managedContinuation;
  if (!parent || parent.actionId !== 'machines.managed.acquire' || !binding || !continuation) return null;
  const acquired = ManagedAcquireInputV1Schema.safeParse(parent.input);
  if (!acquired.success) return null;
  const controller = resolveManagedAcquireReviewV1(acquired.data).controller;
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
  let invoked = false;
  const port = createHostReviewedChildPortV1({ actionId: parent.actionId, input: acquired.data, context,
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
  const result = await port.invoke({ action: input.actionId, role: input.actionId, input: normalizeStrictJsonValue(input.actionInput) });
  return invoked ? result : null;
}
