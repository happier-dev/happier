import {
  AccountApiTokensCreateActionInputV1Schema, AccountApiTokensUpdateActionInputV1Schema,
  AccountApiTokensCreateHttpInputV1Schema, AccountApiTokensUpdateHttpInputV1Schema, accountApiTokenLabelBindingV1,
} from '../../auth/accountApiTokens.js';
import { resolveApiTokenDeploymentGrantV1 } from '../../auth/apiTokenGrant.js';
import type { WorkflowApprovedOperationNativeAccountV1 } from './workflowRunActions.js';
import { createActionExecuteFailureError } from '../actionExecutionResult.js';
import type { ActionExecutorContext, ActionExecutorDeps } from './types.js';
import { z } from '../../zodRuntimePolicy.js';
import { projectNativeJsonValueForTransport, StrictJsonValueSchema } from '../../json/strictJsonValue.js';

export type ApiTokenDeploymentAuthoringHost = Readonly<{
  nativeAccount?: WorkflowApprovedOperationNativeAccountV1;
  privateLabelPrepare?: ActionExecutorDeps['privateLabelPrepare'];
  /** Chosen once by the shared initial-authoring default owner, never a saved-consent recheck. */
  initialDeployApproval?: 'automatic' | 'ask';
}>;

export type PreparedApiTokenDeploymentAuthoring = Readonly<{
  body: z.infer<typeof AccountApiTokensCreateHttpInputV1Schema> | z.infer<typeof AccountApiTokensUpdateHttpInputV1Schema>;
}>;

type AuthoringInput = Readonly<{
  actionId: 'account.apiTokens.create' | 'account.apiTokens.update';
  value: unknown;
  context: ActionExecutorContext;
  host?: ApiTokenDeploymentAuthoringHost;
}>;

export function prepareApiTokenDeploymentAuthoring(input: AuthoringInput & { actionId: 'account.apiTokens.create' }):
  Promise<{ body: z.infer<typeof AccountApiTokensCreateHttpInputV1Schema> }>;
export function prepareApiTokenDeploymentAuthoring(input: AuthoringInput & { actionId: 'account.apiTokens.update' }):
  Promise<{ body: z.infer<typeof AccountApiTokensUpdateHttpInputV1Schema> }>;
export function prepareApiTokenDeploymentAuthoring(input: AuthoringInput): Promise<PreparedApiTokenDeploymentAuthoring>;
/** Existing token host binding; person proof stays with the approved-operation owner. */
export async function prepareApiTokenDeploymentAuthoring(input: AuthoringInput): Promise<PreparedApiTokenDeploymentAuthoring> {
  // Public strict parsing happens before any native read/proof. Private HTTP
  // content cannot be smuggled through an Action invocation or approval replay.
  const authored = input.actionId === 'account.apiTokens.create'
    ? AccountApiTokensCreateActionInputV1Schema.parse(input.value)
    : AccountApiTokensUpdateActionInputV1Schema.parse(input.value);
  const schema = input.actionId === 'account.apiTokens.create'
    ? AccountApiTokensCreateHttpInputV1Schema : AccountApiTokensUpdateHttpInputV1Schema;
  const deployment = authored.deployment && authored.deployment.deployApproval === undefined
    ? { ...authored.deployment, deployApproval: authored.grant?.deployApproval ?? input.host?.initialDeployApproval }
    : authored.deployment;
  const grant = authored.grant === undefined ? undefined : resolveApiTokenDeploymentGrantV1(authored.grant, deployment);
  if (grant?.deployApproval === 'automatic' || deployment?.deployApproval === 'automatic') {
    const { prepareWorkflowApprovedOperation } = await import('./workflowRunActions.js');
    await prepareWorkflowApprovedOperation({ parent: { actionId: input.actionId,
      input: z.record(z.string(), StrictJsonValueSchema).parse(projectNativeJsonValueForTransport(authored)) },
      steps: [], context: input.context, ...(input.host?.nativeAccount ? { nativeAccount: input.host.nativeAccount } : {}) });
  }
  let label = authored.label;
  if (typeof label === 'string') {
    const accountId = input.context.runtimeAccountId ?? input.host?.nativeAccount?.accountId;
    const prepare = input.host?.privateLabelPrepare;
    if (!prepare || !accountId) {
      throw createActionExecuteFailureError({ ok: false, errorCode: 'client_required', error: 'Token label preparation requires the Account client' });
    }
    [label] = await prepare({ actionId: input.actionId, owner: { kind: 'account', accountId },
      labels: [{ binding: accountApiTokenLabelBindingV1(authored.tokenId), value: label }],
      ...(input.context.signal ? { signal: input.context.signal } : {}),
    }, input.context);
  }
  return { body: schema.parse({ ...authored, ...(label === undefined ? {} : { label }), ...(grant ? { grant } : {}),
    ...(deployment === undefined ? {} : { deployment }) }) };
}
