import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { WorkspaceSyncSourceExecutionV1Schema, SocketRpcMachineAdmissionContextV1Schema } from '../../rpc/socket.js';
import { RPC_METHODS } from '../../rpc/methods.js';
import { MachineInstallationProofV1Schema } from '../../machines/identity/installationIdentity.js';
import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { computeCanonicalDomainSeparatedDigest } from '../../crypto/canonicalDigest.js';
import type { ExternalActionExecutionAuthorizationBindingV1 } from '../../actions/externalActionApi.js';
import { deriveActionChildRequestIdV1 } from '../../workflows/workflowInvocationIdentityV1.js';
import { deriveSessionCreationTagV1 } from './sessionCreationIdentityV1.js';

/** The root's existing creation namespace reserves exactly one Prepare child. */
export function deriveDeploymentPrepareSessionCreationIdentityV1(binding: ExternalActionExecutionAuthorizationBindingV1): Readonly<{
  requestId: string; creationKey: string; sessionCreationTag: string;
}> | null {
  if (binding.actionId !== 'deployments.prepare') return null;
  const requestId = deriveActionChildRequestIdV1({ parentRequestId: binding.requestId,
    parentActionId: 'deployments.prepare', childActionId: 'session.spawn_new', position: 0 });
  const creationKey = `action-request:${requestId}`;
  const sessionOrigin = binding.sessionActionOrigin;
  const sessionCreationTag = sessionOrigin
    ? deriveSessionCreationTagV1({ callerCreationNamespace: JSON.stringify(['session', binding.serverIdentityId,
      binding.accountId, sessionOrigin.caller.sessionId]), creationKey })
    : null;
  return sessionCreationTag ? { requestId, creationKey, sessionCreationTag } : null;
}

/** The installed receiver binds its actual birth request to the original reviewed public child. */
export const SessionActionChildCreationProofV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  machineAdmission: SocketRpcMachineAdmissionContextV1Schema,
  sourceExecution: WorkspaceSyncSourceExecutionV1Schema,
  proof: MachineInstallationProofV1Schema,
}).check(z.refine(value => (value.sourceExecution.externalActionExecution.authorization.binding.actionId === 'discussion.second_opinion.start'
    || value.sourceExecution.externalActionExecution.authorization.binding.actionId === 'deployments.prepare')
  && value.sourceExecution.externalActionExecution.effectActionId === 'session.spawn_new'
  && value.sourceExecution.originalActionEnvelope !== undefined
  && value.sourceExecution.method === `${value.machineAdmission.machineId}:${RPC_METHODS.SESSION_SPAWN_NEW}`)));
export type SessionActionChildCreationProofV1 = z.infer<typeof SessionActionChildCreationProofV1Schema>;

export const DiscussionModelSessionCreationProofV1Schema = lazyZodSchema(() => SessionActionChildCreationProofV1Schema
  .check(z.refine(value => value.sourceExecution.externalActionExecution.authorization.binding.actionId === 'discussion.second_opinion.start')));
export type DiscussionModelSessionCreationProofV1 = z.infer<typeof DiscussionModelSessionCreationProofV1Schema>;

/** Host-private callback; credentials and installation keys never enter Session spawn data. */
export type SessionCreationAuthorizationV1 = Readonly<{
  token: string;
  prepareRequestProof?: (body: Readonly<Record<string, unknown>>) => Promise<SessionActionChildCreationProofV1>;
}>;

export function buildSessionActionChildCreationProofPayloadV1(input: Readonly<{
  machineAdmission: SessionActionChildCreationProofV1['machineAdmission'];
  sourceExecution: SessionActionChildCreationProofV1['sourceExecution'];
  body: Readonly<Record<string, unknown>>;
}>) {
  return {
    version: 1 as const, machineId: input.machineAdmission.machineId,
    installationId: input.machineAdmission.installationId, accountId: input.machineAdmission.custodianAccountId,
    sessionCreation: {
      sourceExecutionDigest: computeCanonicalDomainSeparatedDigest('happier-session-creation-source-v1', [createCanonicalJsonSigningInput(input.sourceExecution)]),
      requestBodyDigest: computeCanonicalDomainSeparatedDigest('happier-session-creation-body-v1', [createCanonicalJsonSigningInput(input.body)]),
    },
  };
}

export const buildDiscussionModelSessionCreationProofPayloadV1 = buildSessionActionChildCreationProofPayloadV1;
