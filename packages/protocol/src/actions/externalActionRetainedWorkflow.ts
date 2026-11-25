import { AccountApiTokenEncryptionAccessV1Schema, AccountApiTokenSummaryV1Schema } from '../auth/accountApiTokens.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { WORKFLOW_RUN_START_ACTION_ID_V1 } from './actionIds.js';
import {
  ExternalActionAccountAuthenticationV1Schema, ExternalActionActionIdV1Schema, ExternalActionApiTokenServerPrincipalV1Schema,
  ExternalActionRequestEnvelopeV1Schema, ExternalActionRequestEnvelopeV2Schema, ExternalActionRequestIdV1Schema,
  ExternalActionTargetV1Schema, ExternalActionTerminalAuthenticationV1Schema, externalActionTargetsEqualV1,
  type ExternalActionExecutionAuthorizationBindingV1,
} from './externalActionApi.js';

/** Identity/routing objects are closed; opaque domain JSON retains its own schema. */
const BindingRoutingShape = () => ({
  serverIdentityId: AccountApiTokenEncryptionAccessV1Schema.shape.serverIdentityId,
  accountId: ExternalActionApiTokenServerPrincipalV1Schema.shape.accountId,
  actionId: ExternalActionActionIdV1Schema,
  requestId: ExternalActionRequestIdV1Schema,
  target: ExternalActionTargetV1Schema,
});
export const ApiTokenBindingSchema = lazyZodSchema(() => z.strictObject({
  serverIdentityId: AccountApiTokenEncryptionAccessV1Schema.shape.serverIdentityId,
  accountId: ExternalActionApiTokenServerPrincipalV1Schema.shape.accountId,
  credentialId: AccountApiTokenSummaryV1Schema.shape.tokenId,
  actionId: ExternalActionActionIdV1Schema,
  requestId: ExternalActionRequestIdV1Schema,
  target: ExternalActionTargetV1Schema,
}));
export const AccountBindingSchema = lazyZodSchema(() => z.strictObject({ ...BindingRoutingShape(),
  // Ciphertext retains the signed credential kind and epoch, never a PAT-shaped alias or human upgrade.
  authentication: z.union([z.omit(ExternalActionAccountAuthenticationV1Schema, { evidence: true }),
    z.omit(ExternalActionTerminalAuthenticationV1Schema, { evidence: true })]),
}));
const BindingSchema = lazyZodSchema(() => z.union([ApiTokenBindingSchema, AccountBindingSchema]));
export type ExternalActionEncryptionBindingV2 = Readonly<z.infer<typeof BindingSchema>>;

/** Retain only the opener's original authenticated data, never its execution credential. */
export function projectExternalActionEncryptionBindingV2(binding: ExternalActionExecutionAuthorizationBindingV1): ExternalActionEncryptionBindingV2 {
  const { serverIdentityId, accountId, actionId, requestId, target } = binding;
  return BindingSchema.parse({ serverIdentityId, accountId, actionId, requestId, target,
    ...('authentication' in binding
      ? { authentication: { kind: binding.authentication.kind, tokenEpoch: binding.authentication.tokenEpoch } }
      : { credentialId: binding.credentialId }),
  });
}

/** Original transport and noncredential AAD; current execution still needs fresh authorization. */
export const ExternalActionRetainedWorkflowRootV1Schema = lazyZodSchema(() => z.strictObject({
  binding: BindingSchema,
  envelope: z.union([ExternalActionRequestEnvelopeV1Schema, ExternalActionRequestEnvelopeV2Schema]),
}).check(z.refine(value => value.binding.actionId === WORKFLOW_RUN_START_ACTION_ID_V1
  && value.envelope.requestId === value.binding.requestId
  && value.envelope.target !== undefined
  && externalActionTargetsEqualV1(value.envelope.target, value.binding.target), {
  message: 'Retained Workflow transport must match its original binding',
})));
export type ExternalActionRetainedWorkflowRootV1 = z.infer<typeof ExternalActionRetainedWorkflowRootV1Schema>;
