import { doesExternalActionConsumeRequesterAccountContentV1, projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { openManagedControllerActionCodecV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import type { CurrentMachineExecutionOriginContext } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { retainVerifiedExternalActionRequester } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { readRequesterAccountActionContext, type RequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { isOriginalOwnAccountActionCustody, readOriginalRequesterSessionCustodyId } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { prepareApiTokenDeploymentAccountProjection } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { retainApiTokenDeploymentContentAccess } from '@/auth/apiTokenDeploymentCustody';
import { openExternalActionRequestV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import type { PrepareExternalActionRequesterAccountContext, ResolveExternalActionEncryption } from './executeExternalAction';

/** Reacquire the ingress owner's private custody after decoding an approval. */
export function createDaemonApprovalExecutionAuthorizationPreparer(input: Readonly<{
  machineId: string;
  serverId: string;
  serverBaseUrl: string;
  resolveCurrentMachineExecutionOriginContext?: (signal?: AbortSignal) => Promise<CurrentMachineExecutionOriginContext | null>;
  requesterAccountContext?: RequesterAccountActionContext;
  prepareRequesterAccountContext?: PrepareExternalActionRequesterAccountContext;
  resolveEncryption?: ResolveExternalActionEncryption;
  /** Snapshot from this admitted requester's Account/Home owner, never the deciding caller's policy. */
  readAdmittedRequesterActionsSettings?: (request: Parameters<NonNullable<ActionExecutorDeps['prepareApprovalExecutionAuthorization']>>[0]) =>
    Promise<ActionExecutorContext['actionsSettings'] | null>;
  daemonWorkSignal: AbortSignal;
}>): NonNullable<ActionExecutorDeps['prepareApprovalExecutionAuthorization']> {
  const prepareRequesterContext: NonNullable<ActionExecutorDeps['prepareApprovalExecutionAuthorization']> = async ({ authorization, originalActionEnvelope, signal }) => {
    if ('credentialId' in authorization.binding) {
      // Artifact decoding drops private ports. Rebuild the same signed
      // HTTP custody used at ingress without lending Account credentials.
      const binding = authorization.binding;
      const installation = readInstallationIdentityIfExistsSync();
      const origin = await input.resolveCurrentMachineExecutionOriginContext?.(signal);
      if (!installation || installation.installationId !== binding.installationId
        || origin?.serverIdentityId !== binding.serverIdentityId
        || origin.machineId !== binding.machineId || binding.machineId !== input.machineId) return null;
      let projected = await projectExternalActionRequesterHttpAuthorization({ authorization,
        serverId: input.serverId, serverIdentityId: origin.serverIdentityId,
        serverHttpBaseUrl: input.serverBaseUrl, target: binding.target,
        installationId: installation.installationId, privateKey: installation.privateKey,
        ...(signal ? { signal } : {}),
      });
      if (!projected) return null;
      if (originalActionEnvelope?.v !== 2 || binding.accountEncryptionMode !== 'e2ee') return { authorization: projected };
      const encryption = await input.resolveEncryption?.(signal, projected);
      if (!encryption || encryption.serverIdentityId !== binding.serverIdentityId) return null;
      const opened = openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope: originalActionEnvelope, material: encryption.material,
        binding: { serverIdentityId: binding.serverIdentityId, accountId: binding.accountId,
          credentialId: binding.credentialId, actionId: binding.actionId,
          requestId: binding.requestId, target: binding.target } });
      if (!opened) return null;
      if (!opened.apiTokenContentAccess || !doesExternalActionConsumeRequesterAccountContentV1({
        actionId: binding.actionId, input: opened.input, target: binding.target,
      })) return { authorization: projected };
      // Reopen only the existing private ciphertext at its original receiver.
      // Transport keys open the envelope; the PAT alone supplies content access.
      projected = Object.defineProperties({ ...projected }, Object.getOwnPropertyDescriptors(projected));
      const releaseAccess = retainApiTokenDeploymentContentAccess(projected, opened.apiTokenContentAccess);
      const content = await prepareApiTokenDeploymentAccountProjection(projected, signal);
      if (!content) { releaseAccess(); return null; }
      return { authorization: projected, dispose: async () => { content.dispose(); releaseAccess(); } };
    }
    // Controller codecs carry no Account credentials. Reopen their exact
    // admitted root with the same purpose owner used at native ingress.
    if (authorization.requesterAccountContext
      && authorization.binding.accountId !== authorization.binding.custodianAccountId) {
      const installation = readInstallationIdentityIfExistsSync();
      if (installation && openManagedControllerActionCodecV1({ authorization, machineId: input.machineId,
          installationId: installation.installationId, serverIdentityId: authorization.binding.serverIdentityId,
          installationPrivateKey: decodeBase64(installation.privateKey, 'base64url') })) return { authorization };
    }
    // Match first admission's custody classification. Session/Workflow
    // carriers retain their existing owners rather than borrowing this
    // installation's ordinary Account credentials.
    if (!authorization.requesterAccountContext && !isOriginalOwnAccountActionCustody(authorization.binding)
      && readOriginalRequesterSessionCustodyId(authorization.binding) === null) {
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
    const { actionsSettings, ...preparedContext } = prepared;
    // Replay already treats null as absent; do not substitute host policy.
    return { ...preparedContext, ...(actionsSettings == null ? {} : { actionsSettings }) };
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
        ?.savedSecretOperationContext.readSnapshot()?.settings.actionsSettingsV1
        ?? prepared.actionsSettings
        ?? await input.readAdmittedRequesterActionsSettings?.({ ...request, authorization });
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
