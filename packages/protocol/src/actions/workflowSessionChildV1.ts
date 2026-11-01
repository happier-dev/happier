import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { AgentStartSessionCallerV1Schema } from '../account/settings/admitAgentStartV1.js';
import { WorkflowAcceptedAuthorizationV1Schema } from '../workflows/workflowDefinitionV1.js';
import { ActionRequestAttributionV1Schema } from './actionRequestAttributionV1.js';
import type { ActionExecutorContext } from './executor/types.js';
import type { ExternalActionExecutionAuthorizationV1 } from './externalActionApi.js';

/** Installed FIN custody of one admitted Session leaf; never supplied as Action input. */
export const ExternalActionWorkflowSessionLeafV1Schema = lazyZodSchema(() => z.strictObject({
  invocationId: z.string().check(z.trim(), z.minLength(1)),
  caller: AgentStartSessionCallerV1Schema,
  authorization: WorkflowAcceptedAuthorizationV1Schema,
  workspaceWrites: z.enum(['allow', 'deny']),
  actionRequestAttributionV1: ActionRequestAttributionV1Schema,
}));
export type ExternalActionWorkflowSessionLeafV1 = z.infer<typeof ExternalActionWorkflowSessionLeafV1Schema>;

/** Captured by FIN when admitting the leaf, alongside its existing Run and requester custody. */
export type InstalledWorkflowSessionLeafAdmission = Readonly<{
  accountId: string;
  runId: string;
  invocationId: string;
  sessionId: string;
  authorization: ExternalActionWorkflowSessionLeafV1['authorization'];
  actionRequestAttributionV1: ExternalActionWorkflowSessionLeafV1['actionRequestAttributionV1'];
}>;

/** Both admitted transports consume this projection after verifying the signed root. */
export function projectExternalActionWorkflowSessionLeafContextV1(authorization: ExternalActionExecutionAuthorizationV1):
  Pick<ActionExecutorContext, 'surface' | 'authority' | 'actionCaller' | 'actionRequestId' | 'executionRunWorkflowRunId'
    | 'defaultSessionId' | 'callerPermissionMode' | 'workspaceWrites' | 'actionRequestAttributionV1'
    | 'externalActionExecutionAuthorization' | 'externalActionTarget' | 'serverIdentityId' | 'runtimeAccountId'> | undefined {
  const origin = authorization.binding.workflowActionOrigin;
  const leaf = origin?.sessionLeaf;
  if (!leaf) return undefined;
  return { surface: 'agent', authority: 'account_automation', actionCaller: leaf.caller,
    actionRequestId: origin.requestId, executionRunWorkflowRunId: origin.runId,
    defaultSessionId: leaf.caller.sessionId, callerPermissionMode: leaf.authorization.admittedPermissionCeiling,
    workspaceWrites: leaf.workspaceWrites, actionRequestAttributionV1: leaf.actionRequestAttributionV1,
    externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target,
    serverIdentityId: authorization.binding.serverIdentityId, runtimeAccountId: authorization.binding.accountId };
}
