import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import type { CurrentMachineExecutionOriginContext } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { retainVerifiedExternalActionRequester } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { readRequesterAccountActionContext, type RequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { isOriginalOwnAccountActionCustody } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import type { PrepareExternalActionRequesterAccountContext } from './executeExternalAction';

/** Reacquire the ingress owner's private custody after decoding an approval. */
export function createDaemonApprovalExecutionAuthorizationPreparer(input: Readonly<{
  machineId: string;
  serverId: string;
  serverBaseUrl: string;
  resolveCurrentMachineExecutionOriginContext?: (signal?: AbortSignal) => Promise<CurrentMachineExecutionOriginContext | null>;
  requesterAccountContext?: RequesterAccountActionContext;
  prepareRequesterAccountContext?: PrepareExternalActionRequesterAccountContext;
  daemonWorkSignal: AbortSignal;
}>): NonNullable<ActionExecutorDeps['prepareApprovalExecutionAuthorization']> {
  const prepareRequesterContext: NonNullable<ActionExecutorDeps['prepareApprovalExecutionAuthorization']> = async ({ authorization, signal }) => {
    if ('credentialId' in authorization.binding) {
      // Artifact decoding drops private ports. Rebuild the same signed
      // HTTP custody used at ingress without lending Account credentials.
      const binding = authorization.binding;
      const installation = readInstallationIdentityIfExistsSync();
      const origin = await input.resolveCurrentMachineExecutionOriginContext?.(signal);
      if (!installation || installation.installationId !== binding.installationId
        || origin?.serverIdentityId !== binding.serverIdentityId
        || origin.machineId !== binding.machineId || binding.machineId !== input.machineId) return null;
      const projected = await projectExternalActionRequesterHttpAuthorization({ authorization,
        serverId: input.serverId, serverIdentityId: origin.serverIdentityId,
        serverHttpBaseUrl: input.serverBaseUrl, target: binding.target,
        installationId: installation.installationId, privateKey: installation.privateKey,
        ...(signal ? { signal } : {}),
      });
      return projected ? { authorization: projected } : null;
    }
    // Match first admission's custody classification. Session/Workflow
    // carriers retain their existing owners rather than borrowing this
    // installation's ordinary Account credentials.
    if (!authorization.requesterAccountContext && !isOriginalOwnAccountActionCustody(authorization.binding)) {
      const binding = authorization.binding;
      const requester = input.requesterAccountContext;
      if (!requester || !('authentication' in binding)
        || (binding.authentication.kind !== 'account' && binding.authentication.kind !== 'terminal')
        || binding.sessionActionOrigin || binding.workflowActionOrigin
        || binding.accountId !== requester.authorization.binding.accountId
        || binding.serverIdentityId !== requester.authorization.binding.serverIdentityId
        || binding.machineId !== input.machineId) return { authorization };
      // Stored approval provenance has no credential box. The deciding
      // invocation already holds this requester's admitted private custody;
      // rehydrate the unchanged root through the incumbent ingress owner.
      const installation = readInstallationIdentityIfExistsSync();
      if (!installation || installation.installationId !== binding.installationId) return null;
      const sealed = await requester.authorization.requesterAccountProjection?.sealRequesterAccountContext?.({
        authorization, purpose: { kind: 'external_action' },
        installationPublicKey: decodeBase64(installation.publicKey, 'base64url'),
      });
      if (!sealed) return null;
      authorization = sealed;
    }
    const prepared = await input.prepareRequesterAccountContext?.({ authorization,
      ...(signal ? { signal } : {}) });
    if (!prepared) return null;
    return prepared;
  };
  return async request => {
    const prepared = await prepareRequesterContext(request);
    if (!prepared) return null;
    try {
      let authorization = prepared.authorization;
      const binding = authorization.binding;
      const installation = readInstallationIdentityIfExistsSync();
      const origin = await input.resolveCurrentMachineExecutionOriginContext?.(request.signal);
      // Routed roots keep their incumbent native owner; they cannot acquire
      // this installed receiver's ordinary filesystem custody.
      if (!installation || installation.installationId !== binding.installationId
        || binding.machineId !== input.machineId || origin?.machineId !== binding.machineId
        || origin.serverIdentityId !== binding.serverIdentityId) return prepared;
      const isCurrent = async () => {
        if (request.signal?.aborted || input.daemonWorkSignal.aborted
          || readInstallationIdentityIfExistsSync()?.installationId !== installation.installationId) return false;
        const currentOrigin = await input.resolveCurrentMachineExecutionOriginContext?.(request.signal);
        // Preparation above is this replay's Home admission and the approval
        // owner verifies the signed actual effect; replay work keeps local cancel.
        return currentOrigin?.machineId === binding.machineId && currentOrigin.serverIdentityId === binding.serverIdentityId
          && !request.signal?.aborted && !input.daemonWorkSignal.aborted;
      };
      // Durable approval content retains the signed root, not its private HTTP
      // port. The replay owner verified that root before this preparation.
      if (!authorization.requesterHttpProjection) {
        const projected = await projectExternalActionRequesterHttpAuthorization({ authorization,
          serverId: input.serverId, serverIdentityId: origin.serverIdentityId,
          serverHttpBaseUrl: input.serverBaseUrl, target: binding.target,
          installationId: installation.installationId, privateKey: installation.privateKey,
          isCurrent, rootAdmitted: true, ...(request.signal ? { signal: request.signal } : {}),
        });
        if (!projected) { await prepared.dispose?.(); return null; }
        authorization = projected;
      }
      const actionsSettings = readRequesterAccountActionContext(authorization)
        ?.savedSecretOperationContext.readSnapshot()?.settings.actionsSettingsV1;
      return { ...prepared, ...(actionsSettings ? { actionsSettings } : {}),
        signExternalActionApprovalInput: ({ actionId, input: approvedInput, target, requesterConfirmation, sessionTargetsV1 }) =>
          signExternalActionApprovalInputV1({ authorizationToken: authorization.token,
            actionId, input: approvedInput, target, privateKey: installation.privateKey,
            ...(requesterConfirmation ? { requesterConfirmation } : {}),
            ...(sessionTargetsV1 ? { sessionTargetsV1 } : {}) }),
        authorization: retainVerifiedExternalActionRequester({ authorization, isCurrent }) };
    } catch (error) {
      await prepared.dispose?.();
      throw error;
    }
  };
}
