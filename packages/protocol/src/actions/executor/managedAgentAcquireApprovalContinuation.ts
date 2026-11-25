import { MANAGED_ACQUIRE_ACTION_ID_V1, MANAGED_GET_ACTION_ID_V1 } from '../../machines/managed/actionIdsV1.js';
import {
  ManagedAcceptedV1Schema, ManagedAcquireInputV1Schema, ManagedGetActionOutputV1Schema, unwrapManagedMachineReadV1,
} from '../../machines/managed/actionsV1.js';
import { readManagedInstallationPromptSnapshot } from '../../machines/managed/installationPrompt.js';
import { ACTION_OPERATION_GET_ACTION_ID_V1 } from '../operations/actionIdsV1.js';
import { ActionOperationGetV1ResponseSchema, readActionOperationTerminalResultV1 } from '../operations/v1.js';
import type { ActionExecutorContext, ActionExecutorDeps } from './types.js';

type ManagedAgentAcquireUpdate = Readonly<{ managedId: string; operationId: string }> & (
  { kind: 'waiting_for_machine_sign_in' }
  | { kind: 'machine_agent_session_started'; sessionId: string }
);

/** Continue the existing approval delivery using the requester's retained operation. */
export async function continueManagedAgentAcquireApproval(args: Readonly<{
  input: unknown;
  result: unknown;
  context: ActionExecutorContext;
  deps: Pick<ActionExecutorDeps, 'managedMachineAction' | 'actionOperationAction'>;
  deliver: (update: ManagedAgentAcquireUpdate) => Promise<unknown>;
}>): Promise<void> {
  const input = ManagedAcquireInputV1Schema.safeParse(args.input);
  const accepted = ManagedAcceptedV1Schema.safeParse(args.result);
  const { managedMachineAction, actionOperationAction } = args.deps;
  const { actionRequestId, ...context } = args.context;
  if (!input.success || !input.data.agentStart || !accepted.success || !accepted.data.operation
    || !context.serverId || !managedMachineAction || !actionOperationAction) return;

  const { homeId } = input.data.selection;
  const { managedId, operation: { operationId } } = accepted.data;
  const read = ManagedGetActionOutputV1Schema.safeParse(await managedMachineAction({
    actionId: MANAGED_GET_ACTION_ID_V1, input: { homeId, managedId }, context: { ...context, actionRequestId },
  }));
  if (!read.success) return;
  const machine = unwrapManagedMachineReadV1(read.data);
  if (machine.homeId !== homeId || machine.id !== managedId || !machine.controller) return;

  const operation = { serverId: context.serverId, machineId: machine.controller.machineId, operationId, waitForTerminal: true } as const;
  const reference = { managedId, operationId };
  let waitingForSignIn = true;
  let sinceRevision: number | undefined;
  for (;;) {
    const found = ActionOperationGetV1ResponseSchema.safeParse(await actionOperationAction({
      actionId: ACTION_OPERATION_GET_ACTION_ID_V1, context,
      input: { ...operation, ...(waitingForSignIn && sinceRevision === undefined ? { includeManagedPrompt: true } : {}),
        ...(sinceRevision !== undefined ? { sinceRevision } : {}) },
    }));
    if (!found.success || found.data.kind !== 'found') return;
    const snapshot = found.data.operation;
    if (snapshot.operationId !== operationId || snapshot.actionId !== MANAGED_ACQUIRE_ACTION_ID_V1
      || snapshot.scope.accountId !== context.runtimeAccountId || snapshot.scope.machineId !== operation.machineId) return;

    if (readActionOperationTerminalResultV1(snapshot)) {
      if (snapshot.state === 'succeeded' && snapshot.domainRef?.kind === 'managedMachine'
        && snapshot.domainRef.id === managedId && snapshot.domainRef.childSessionId) {
        await args.deliver({ ...reference, kind: 'machine_agent_session_started', sessionId: snapshot.domainRef.childSessionId });
      }
      return;
    }
    const prompt = readManagedInstallationPromptSnapshot(snapshot);
    if (!waitingForSignIn || sinceRevision !== undefined && snapshot.revision <= sinceRevision) return;
    if (snapshot.domainRef?.kind === 'managedMachine' && snapshot.domainRef.id === managedId
      && prompt?.kind === 'auth.approveRemoteProvisioning') {
      await args.deliver({ ...reference, kind: 'waiting_for_machine_sign_in' });
      waitingForSignIn = false;
      sinceRevision = undefined;
    } else if (prompt || snapshot.domainRef?.kind === 'systemTask' && snapshot.domainRef.prompt || sinceRevision !== undefined) {
      // An earlier setup question can still be current. Wait for subsequent revisions.
      sinceRevision = snapshot.revision;
    } else return;
  }
}
