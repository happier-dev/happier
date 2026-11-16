import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions';
import { createExternalActionHeaderRefusalError } from '@/api/externalActionHeaderRefusal';
import type { MachineInstallationIdentityV1 } from '@happier-dev/protocol';
import type { ExternalActionRequesterAccountContextPurposeV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { readSessionExplicitStopV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { isSessionStopPhaseRootV1 } from '@happier-dev/protocol/actions/sessionSections';
import { resolveExternalActionServerRequestHeaders } from '@/api/externalActionExecutionAuthorization';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { callMachineRpc } from '@/session/transport/rpc/machineRpc';
import { requestSessionStop } from '@/session/services/requestSessionStop';
import { resolveSessionOwningMachineId } from '@/session/services/resolveSessionOwningMachine';
import { tryReadSessionMetadataRecord } from '@/daemon/connectedServices/sessionAuthSwitch/persistedState';
import type { RequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import type { StopSessionOptions } from '@/daemon/sessions/stopSession';
import { readSessionStopRequestSource } from '@/daemon/sessions/stopSessionDiagnostics';
import type { StopSessionResult } from '@/daemon/sessions/stopSessionContract';
import type { StoredCredentials } from '@/persistence';

/** The requester Action and its native Stop share this installed physical owner. */
export function createRequesterSessionStopEffect(params: Readonly<{
  requester: RequesterAccountActionContext;
  purpose: ExternalActionRequesterAccountContextPurposeV1;
  machineId: string;
  installation: Pick<MachineInstallationIdentityV1, 'installationId' | 'privateKey'>;
  stopSession(sessionId: string, options: StopSessionOptions, resumeAdmission: undefined,
    recordExplicitIntent: () => Promise<void | false>, credentials: StoredCredentials): Promise<StopSessionResult>;
}>): NonNullable<ActionExecutorDeps['sessionStop']> {
  const { requester, purpose, installation } = params;
  const rootActionId = requester.authorization.binding.actionId;
  const headersFor = (context: ActionExecutorContext | undefined, effectActionId = rootActionId) =>
    (request: Readonly<{ method: string; path: string; body?: unknown }>) => {
      const signed = resolveExternalActionServerRequestHeaders({ context, effectActionId,
        ...request, daemonToken: requester.credentials.token,
        serverIdentityId: requester.authorization.binding.serverIdentityId,
        privateKey: installation.privateKey, installationId: installation.installationId,
      });
      if (!signed.ok) throw createExternalActionHeaderRefusalError(signed);
      return signed.headers;
    };
  // Preserve the existing receiving Stop's exact-attempt/currentness contract.
  // Archive, Delete and Section Archive admit their native Stop as the `session.stop`
  // phase; Home's Stop-phase purposes read and retire that exact Session.
  const stopPhysical = async (sessionId: string, context: ActionExecutorContext | undefined) => {
    const resolveAuthorizationHeaders = headersFor(context, isSessionStopPhaseRootV1(rootActionId) ? 'session.stop' : rootActionId);
    return await params.stopSession(sessionId, { source: readSessionStopRequestSource(context),
      transport: purpose.kind === 'machine_rpc' ? 'machine_rpc' : 'external_action', metadataContext: { credentials: requester.credentials,
      resolveAuthorizationHeaders, currentness: { verifyCurrent: () => requester.isCurrent(),
        ...(context?.signal ? { signal: context.signal } : {}) } } }, undefined, async () => {
      const rawSession = await fetchSessionByIdCompat({ reason: 'session-control', token: requester.credentials.token,
        sessionId, resolveAuthorizationHeaders, ...(context?.signal ? { signal: context.signal } : {}) });
      if (!rawSession || rawSession.id !== sessionId || !await requester.isCurrent()) {
        throw new Error('Native Stop exact Session authority unavailable');
      }
      const accountEncryptionCurrentness = await fetchAccountEncryptionCurrentness({
        credentials: requester.credentials, token: requester.credentials.token,
        authorizationHeaders: resolveAuthorizationHeaders({ method: 'GET', path: '/v1/account/encryption/currentness' }),
      });
      const owner = resolveSessionOwningMachineId({ credentials: requester.credentials, rawSession,
        accountEncryptionMode: accountEncryptionCurrentness.mode });
      if (!owner.ok || owner.machineId !== params.machineId) throw new Error('Native Stop target changed');
      if (purpose.kind === 'machine_rpc' && purpose.method === RPC_METHODS.STOP_SESSION
        && requester.authorization.binding.actionId === 'session.stop') {
        const metadata = tryReadSessionMetadataRecord({ rawSession, credentials: requester.credentials,
          accountEncryptionMode: accountEncryptionCurrentness.mode });
        const stop = readSessionExplicitStopV1FromMetadata(metadata);
        // A delayed receiving RPC cannot recreate a cleared hold or stop its
        // replacement. A local source Action owns its just-admitted intent,
        // including lifecycle/automatic Stop, which deliberately has no hold.
        if (!stop || 'status' in stop || stop.requestId !== requester.authorization.binding.requestId) return false;
      }
      if (context?.signal?.aborted || !await requester.isCurrent()) throw new Error('Native Stop requester retired');
      return undefined;
    }, requester.credentials);
  };
  return async ({ sessionId, stopIntent, context, signal }) => {
    if (purpose.kind === 'machine_rpc' && purpose.method === RPC_METHODS.STOP_SESSION) {
      if (!purpose.params || typeof purpose.params !== 'object'
        || Reflect.get(purpose.params, 'sessionId') !== sessionId
        || context?.signal?.aborted || !await requester.isCurrent()) {
        const errorCode = context?.signal?.aborted ? 'cancelled' : 'target_unavailable';
        return { ok: false, errorCode, error: errorCode };
      }
      return await runWithServerHttpBaseUrl(requester.serverHttpBaseUrl, () => stopPhysical(sessionId, context));
    }
    // The original Action still owns hold recording, target resolution and
    // inactive confirmation. Its local effect goes straight to the same native
    // owner; redispatching to the requester registrar recursively restarts it.
    return await runWithServerHttpBaseUrl(requester.serverHttpBaseUrl, () => requestSessionStop({
      credentials: requester.credentials, idOrPrefix: sessionId, stopIntent,
      actionContext: context, ...(signal ? { signal } : {}), resolveAuthorizationHeaders: headersFor(context),
      ...(context ? { externalAction: { context, effectActionId: 'session.stop',
        privateKey: installation.privateKey, installationId: installation.installationId } } : {}),
      invokeMachineRpc: request => {
        // requestSessionStop produced this exact normalized Stop operand.
        const operand = request.request as Readonly<{ sessionId: string }>;
        return request.machineId === params.machineId
          ? stopPhysical(operand.sessionId, context)
          : callMachineRpc(request);
      },
    }));
  };
}
