import { requireExternalActionHeaders } from '@/api/externalActionHeaderRefusal';
import type { ApiMachineClientLifecycleDependencies } from '@/api/apiMachine';
import type { ApiClient } from '@/api/api';
import type { StoredCredentials } from '@/persistence';
import { readStoredCredentialsForServerId, sameStoredCredentials } from '@/persistence';
import { readInstallationIdentityIfExistsSync } from '../identity/store';
import { readAdmittedRequesterAccountReadRuntime } from "../sessionEncryption/requesterAccountActionProjection";
import { readRequesterAccountActionContext } from "@/daemon/sessionEncryption/requesterAccountActionContext";
import { MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1 } from '@happier-dev/protocol/plugins/events/machineServiceObservationV1';
import { publishDaemonHostEvent } from '@/daemon/events/publishDaemonHostEvent';
import { readProjectFiniteIngressRefusal, type ProjectFiniteActionRuntime } from '@/workspaces/projectSetup/projectFiniteAction';
import { createWorkspaceSyncWorkerPreparation } from '@/workspaces/sync/workspaceSyncPreparation';
import { createAccountServerWorkspaceWorkerPreferenceClient } from '@/api/workspaces/workspaceWorkerPreferences';
import { resolveExternalActionServerRequestHeaders } from '@/api/externalActionExecutionAuthorization';
import type { createProjectNativeIo } from '@/workspaces/projectSetup/projectNativeIo';
import type { WorkspaceSyncHandoffAdapterDeps } from '@/workspaces/sync/workspaceSyncHandoffAdapter';
import type { CurrentMachineExecutionOriginContext } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import { logger } from '@/ui/logger';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { createInvocationSavedSecretOperationContextV1, type SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { readSavedSecretMaterializerForOperation } from '@/settings/secrets/savedSecretCatalogRead';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

/** Installed composition shared by the daemon and its real ingress harness. */
export function createInstalledProjectFiniteRuntime(params: Readonly<{
  api: Pick<ApiClient, 'getMachine'>;
  credentials: StoredCredentials;
  externalActionAccountId: string | null;
  finiteServerId: string;
  finiteServerHttpBaseUrl: string;
  registeredMachineId: string;
  admission: ProjectFiniteActionRuntime['workerAdmission'];
  nativeIo: ReturnType<typeof createProjectNativeIo>;
  agentIsolation?: ProjectFiniteActionRuntime['agentIsolation'];
  plugins?: ProjectFiniteActionRuntime['plugins'];
  publishSetupSettlement?: ProjectFiniteActionRuntime['publishSetupSettlement'];
  successHomeDir: string;
  isCurrent(): Promise<boolean>;
  prepareBetween: NonNullable<WorkspaceSyncHandoffAdapterDeps['prepareBetween']>;
  resolveCurrentMachineExecutionOriginContext(signal?: AbortSignal): Promise<CurrentMachineExecutionOriginContext | null>;
}>): NonNullable<ApiMachineClientLifecycleDependencies['createProjectFiniteRuntime']> {
  const { api, credentials, externalActionAccountId, finiteServerId,
    registeredMachineId, admission, isCurrent, resolveCurrentMachineExecutionOriginContext } = params;
  const secretEnvironment = async (operationContext: SavedSecretOperationContextV1,
    bindings: Parameters<NonNullable<ProjectFiniteActionRuntime['resolveSecretEnvironment']>>[0], signal?: AbortSignal) => {
    const captured = operationContext.readSnapshot();
    if (!captured?.scopeKey) throw Object.assign(new Error('project_requester_credentials_unavailable'), { code: 'project_requester_credentials_unavailable' });
    const { snapshot, materializer } = await readSavedSecretMaterializerForOperation({ expectedScopeKey: captured.scopeKey,
      operationContext, secretSources: params.plugins?.secretSources, secretReferenceOverlay: bindings, signal });
    return { accountSettings: snapshot.rawSettings ?? snapshot.settings, settingsSecretsReadKeys: snapshot.settingsSecretsReadKeys,
      savedSecretMaterializer: materializer, ...(snapshot.savedSecretResources ? { savedSecretResources: snapshot.savedSecretResources } : {}) };
  };
  const nativeRuntime = (runtimeCurrent: () => Promise<boolean>, accountId: string) => ({
    ...(accountId === externalActionAccountId && params.publishSetupSettlement
      ? { publishSetupSettlement: params.publishSetupSettlement } : {}),
    ...(accountId === externalActionAccountId ? {
      publishMachineServiceObservation: (payload: Parameters<NonNullable<ProjectFiniteActionRuntime['publishMachineServiceObservation']>>[0]) =>
        publishDaemonHostEvent({ eventId: MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1, scope: { kind: 'account' }, payload }, () => false),
    } : {}),
    workerAdmission: admission, isCurrent: runtimeCurrent,
    nativeIo: params.nativeIo.commandIo, environmentIo: params.nativeIo.environmentIo,
    agentIsolation: params.agentIsolation,
    ...(params.plugins ? { plugins: params.plugins } : {}),
    successHomeDir: params.successHomeDir,
  });
  // One owner for Project execution preferences: the acting Account reads its
  // own rows with its own credentials and Home, never the custodian's.
  const workspaceExecutionConfig = (account: Readonly<{ credentials: StoredCredentials | null; serverHttpBaseUrl: string;
    operationContext?: SavedSecretOperationContextV1;
    createRequesterHeaders?: (request: Readonly<{ effectActionId: string; method: string; path: string; body?: unknown }>,
      signal: AbortSignal) => Promise<Readonly<Record<string, string>> | null>;
  }>): ProjectFiniteActionRuntime['resolveWorkspaceExecutionConfig'] => async (context, currentIngress, actionId) => {
    const preferenceCredentials = account.credentials;
    if (!preferenceCredentials) return null;
    const origin = await resolveCurrentMachineExecutionOriginContext(currentIngress.signal);
    if (!origin || origin.machineId !== registeredMachineId) return null;
    const authorization = currentIngress.callerInputAuthorization;
    const requestContext = { ...context, ...(authorization ? {
      externalActionExecutionAuthorization: authorization,
      externalActionTarget: authorization.binding.target,
    } : {}) };
    const installation = readInstallationIdentityIfExistsSync();
    return await createAccountServerWorkspaceWorkerPreferenceClient({
      token: preferenceCredentials.token, credentials: preferenceCredentials,
      serverHttpBaseUrl: account.serverHttpBaseUrl, signal: currentIngress.signal,
      context: requestContext, actionId,
      ...(account.operationContext ? { operationContext: account.operationContext } : {}),
      resolveRequestHeaders: async request => {
        if (account.createRequesterHeaders) return await account.createRequesterHeaders(request, currentIngress.signal);
        const result = resolveExternalActionServerRequestHeaders({ ...request,
          daemonToken: preferenceCredentials.token, serverIdentityId: origin.serverIdentityId,
          ...(installation ? { privateKey: installation.privateKey, installationId: installation.installationId } : {}),
        });
        return requireExternalActionHeaders(result);
      },
    });
  };
  return async (ports, ingress) => {
    const finiteServerHttpBaseUrl = params.finiteServerHttpBaseUrl;
    const refuse = (reason: string): null => {
      logger.debug('[ProjectFinite] Runtime resolution refused', { reason,
        ...(ingress.requesterSessionBootstrap?.getBoundSessionId()
          ? { sessionId: ingress.requesterSessionBootstrap.getBoundSessionId() } : {}) });
      return null;
    };
    if (!await isCurrent()) return refuse('installed_not_current');
    const installationId = readInstallationIdentityIfExistsSync()?.installationId;
    const session = !ingress.callerInputAuthorization ? ingress.requesterSessionBootstrap : undefined;
    if (session) {
      const runtimeCurrent = async () => {
        const reason = ingress.signal.aborted ? 'request_cancelled'
          : !await isCurrent() ? 'installed_not_current'
          : session.attribution.machineId !== registeredMachineId ? 'machine_mismatch'
          : session.attribution.installationId !== readInstallationIdentityIfExistsSync()?.installationId ? 'installation_mismatch'
          : !await isServerProfileHomeIdentity(finiteServerId, session.attribution.serverId) ? 'home_mismatch'
          : !await session.isCurrent() ? 'session_not_current'
          : !await isCurrent() ? 'installed_not_current'
          : ingress.signal.aborted ? 'request_cancelled' : null;
        if (reason) { refuse(reason); return false; }
        return true;
      };
      if (readProjectFiniteIngressRefusal(ingress)) return refuse('requester_projection_missing');
      if (!await runtimeCurrent()) return null;
      return { ...ports, ...nativeRuntime(runtimeCurrent, session.attribution.accountId), credentials: session.credentials,
        serverId: finiteServerId, machineId: registeredMachineId, accountId: session.attribution.accountId,
        serverHttpBaseUrl: session.serverHttpBaseUrl,
        sessionCustody: { serverId: session.attribution.serverId, accountId: session.attribution.accountId,
          serverHttpBaseUrl: session.serverHttpBaseUrl, isCurrent: runtimeCurrent },
        resolveSecretEnvironment: async (bindings, signal) => bindings
          ? await secretEnvironment(session.savedSecretOperationContext, bindings, signal) : undefined,
        // Ordinary Session custody does not grant the custodian's worker/source
        // routing ports. Cold native launch consumes only the installed local IO;
        // execution preferences are the requester's own Account rows.
        resolveWorkspaceExecutionConfig: workspaceExecutionConfig({ credentials: session.credentials,
          serverHttpBaseUrl: session.serverHttpBaseUrl, operationContext: session.savedSecretOperationContext }),
      };
    }
    if (!externalActionAccountId) return refuse('installed_account_unavailable');
    const requester = ingress.callerInputAuthorization && installationId
      ? readAdmittedRequesterAccountReadRuntime({ ingress, serverId: finiteServerId,
        machineId: registeredMachineId, installationId, isInstalledCurrent: isCurrent }) : null;
    if (ingress.callerInputAuthorization && !requester || !requester && readProjectFiniteIngressRefusal(ingress)) return refuse('requester_authority_unavailable');
    const currentCredentials = requester ? null : await readStoredCredentialsForServerId(finiteServerId).catch(() => null);
    if (!requester && (!currentCredentials || !sameStoredCredentials(credentials, currentCredentials)) || !await isCurrent()) return refuse('installed_credentials_not_current');
    const requesterContext = requester ? readRequesterAccountActionContext(requester.accountAuthorization) : null;
    if (requester && (!requesterContext || !await (requesterContext.isCustodyCurrent ?? requesterContext.isCurrent)())) return refuse('requester_context_not_current');
    const runtimeCurrent = requesterContext?.isCustodyCurrent
      ? async () => await isCurrent() && await requesterContext.isCustodyCurrent!() && await isCurrent()
      : requester?.isCurrent ?? isCurrent;
    const workerCredentials = requesterContext?.credentials ?? currentCredentials;
    if (!workerCredentials) return refuse('worker_credentials_unavailable');
    const accountAccess = requester ?? (currentCredentials ? { serverId: finiteServerId, machineId: registeredMachineId,
      accountId: externalActionAccountId, credentials: currentCredentials, serverHttpBaseUrl: finiteServerHttpBaseUrl } : null);
    if (!accountAccess) return refuse('account_access_unavailable');
    // Load while the original ingress still owns requester custody; publication
    // captures that context synchronously before its first network await.
    const reportPublicationUnavailable = (error: unknown) => {
      const code: unknown = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
      logger.warn('[DAEMON RUN] Requester Host Event projection unavailable (ignored)', {
        code: typeof code === 'string' ? code : 'automation_event_host_evidence_unavailable',
      });
    };
    const requesterPublisher = requester
      ? await import('@/plugins/runtime/automations/requesterMachineServicePublication')
        .then(module => module.publishRequesterMachineServiceObservation)
        .catch(error => { reportPublicationUnavailable(error); return null; }) : null;
    const publishRequesterObservation: ProjectFiniteActionRuntime['publishMachineServiceObservation'] = requester
      ? observation => {
        if (!requesterPublisher) return;
        const operationId = observation.kind === 'worktreeCreated' ? observation.creation.operationId
          : observation.kind === 'worktreeRemoved' ? observation.removal.operationId
          : observation.kind === 'projectSetupSettled' ? observation.settlement.operationId
          : observation.kind === 'backup' ? observation.operationId : undefined;
        if (!operationId) return;
        const operation = ports.operationRuntime.store.get({ accountId: accountAccess.accountId, machineId: registeredMachineId }, operationId);
        // `action.invoke` is the signed root for a contributed Action routed
        // to this native owner; the operation retains the nested effect id.
        if (operation?.requestId !== requester.accountAuthorization.binding.requestId
          || (operation.actionId !== requester.accountAuthorization.binding.actionId
            && requester.accountAuthorization.binding.actionId !== 'action.invoke')) return;
        void requesterPublisher({ publisherCredentials: credentials, authorization: requester.accountAuthorization, observation })
          .catch(reportPublicationUnavailable);
      } : undefined;
    return { ...ports, ...accountAccess, ...nativeRuntime(runtimeCurrent, accountAccess.accountId),
      ...(publishRequesterObservation ? { publishMachineServiceObservation: publishRequesterObservation } : {}),
      ...(!requester ? { resolveSecretEnvironment: async (bindings, signal) => {
        if (!bindings) return undefined;
        return await runWithServerHttpBaseUrl(accountAccess.serverHttpBaseUrl, async () => {
          const snapshot = await bootstrapAccountSettingsContext({ credentials: workerCredentials, signal,
            mode: 'blocking', publication: 'invocation', honorAccountSettingsModeEnv: false });
          const operationContext = createInvocationSavedSecretOperationContextV1({ credentials: workerCredentials, snapshot,
            machineAdmission: ingress.machineAdmission, secretSources: params.plugins?.secretSources,
            serverHttpBaseUrl: accountAccess.serverHttpBaseUrl, isCurrent: runtimeCurrent });
          return await secretEnvironment(operationContext, bindings, signal);
        });
      } } satisfies Pick<ProjectFiniteActionRuntime, 'resolveSecretEnvironment'> : {}),
      inspectSourceProjectManifest: async input => {
        const { createProjectFiniteSourceManifestInspector } = await import('./createDaemonMachineBootstrapRuntime');
        return await createProjectFiniteSourceManifestInspector({
          credentials: workerCredentials, serverId: accountAccess.serverId,
          serverHttpBaseUrl: accountAccess.serverHttpBaseUrl,
          accountId: accountAccess.accountId, ingress })(input);
      },
      ...createWorkspaceSyncWorkerPreparation({ serverId: finiteServerId,
        serverHttpBaseUrl: accountAccess.serverHttpBaseUrl, targetMachineId: registeredMachineId,
        credentials: workerCredentials,
        ...(requester ? { authorization: requester.accountAuthorization } : {}),
        prepareBetween: (request, signal) => params.prepareBetween(request, signal, requester ? ingress : undefined) }),
      resolveWorkspaceExecutionConfig: workspaceExecutionConfig({
        credentials: requesterContext?.credentials ?? currentCredentials,
        serverHttpBaseUrl: accountAccess.serverHttpBaseUrl,
        ...(requesterContext ? { operationContext: requesterContext.savedSecretOperationContext } : {}),
        ...(requester ? { createRequesterHeaders: async (request, signal) => await requester.accountAuthorization
          .requesterHttpProjection!.createRequestHeaders({ effectActionId: request.effectActionId, method: request.method,
            path: request.path, ...(request.body === undefined ? {} : { body: request.body }), signal }) } : {}),
      }),
    };
  };
}

