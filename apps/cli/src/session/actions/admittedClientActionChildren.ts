import type { ActionExecuteResult, ActionId } from '@happier-dev/protocol';
import {
  UiActionChildExecuteRequestV1Schema,
  type UiActionDispatchResultV1,
} from '@happier-dev/protocol/actions/clientDispatchV1';
import { SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';

type AdmittedClientActionParent = Readonly<{
  accountId: string;
  sessionId: string;
  executeChild: (
    actionId: ActionId,
    input: unknown,
  ) => Promise<ActionExecuteResult>;
}>;

/**
 * Session-caller parents this daemon admitted and is still awaiting from the App.
 * Membership is the still-active fact; delivery settlement removes it.
 */
const pendingParents = new Map<string, AdmittedClientActionParent>();

export function retainAdmittedClientActionParent(
  requestId: string,
  parent: AdmittedClientActionParent,
): () => void {
  pendingParents.set(requestId, parent);
  return () => {
    if (pendingParents.get(requestId) === parent)
      pendingParents.delete(requestId);
  };
}

/**
 * The App returns a declared child of a pending parent. The server-stamped actor
 * Account and the App's Session must match the parent; the daemon's own admitted
 * caller then performs ordinary admission of the child.
 */
export async function executeAdmittedClientActionChild(
  raw: unknown,
  context?: Readonly<{ machineAdmission?: unknown }>,
): Promise<UiActionDispatchResultV1> {
  const refused = (errorCode: string): UiActionDispatchResultV1 => ({
    v: 1,
    execution: { ok: false, errorCode, error: errorCode },
  });
  const request = UiActionChildExecuteRequestV1Schema.safeParse(raw);
  if (!request.success) return refused('invalid_action_input');
  const admission = SocketRpcMachineAdmissionContextV1Schema.safeParse(
    context?.machineAdmission,
  );
  const parent = pendingParents.get(request.data.parentRequestId);
  if (
    !parent ||
    !admission.success ||
    admission.data.actorAccountId !== parent.accountId ||
    request.data.sessionId !== parent.sessionId
  )
    return refused('admission_unavailable');
  const execution = await parent.executeChild(
    request.data.actionId,
    request.data.input,
  );
  return {
    v: 1,
    execution: execution.ok
      ? { ok: true, result: execution.result }
      : execution,
  };
}
