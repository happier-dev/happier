import type { ResolvedSessionTransport } from '../cliActionDeps/types';
import type { CliActionDepsParams, CurrentMachineControlIdentity } from '../cliActionDeps/types';
import { rejectUndispatchedSessionAgentTransition } from '@happier-dev/protocol/sessions/agentTransitionEffectStage';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { readAgentStartCallerWorkDepthV1 } from '@happier-dev/protocol/account/settings/admitAgentStartV1';
import { isPermissionModeGrantedV1, resolveEffectiveApiTokenPermissionModeV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { resolveEffectivePermissionMode } from '@happier-dev/protocol/actions/permissionPrivilege';
import type { ActionExecutorDeps, ActionExecutorContext } from '@happier-dev/protocol';
import { buildTrustedHostSessionInputAdmissionV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { parsePermissionIntentAlias } from '@happier-dev/agents';
import type { buildCausalSessionInputAdmissionV1, buildPluginSessionInputAdmissionV1 } from '@/session/services/sessionInputAdmissionIdentity';
import type { setSessionArchivedState } from '@/session/services/setSessionArchivedState';
import { SessionResumeRequestV1Schema, type SessionResumeRequestV1 } from '@happier-dev/protocol/sessions/control/sessionResumeRequestV1';
import type { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import type { callMachineRpc } from '@/session/transport/rpc/machineRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { readMachineActionRpcResult } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import type { CliMachineActionCall } from '@/session/actions/cliActionDeps/machineTransport';
import type { InactiveSessionResumeResult } from '@/session/services/requestInactiveSessionResume';
type FamilyActionDeps = Pick<ActionExecutorDeps, 'sessionOpen' | 'sessionFork' | 'sessionContinueWithReplay' | 'sessionRollback' | 'checkpointCodeRollback' | 'sessionCheckpoint' | 'sessionRestore' | 'sessionContinuationInspect' | 'sessionAgentTransition' | 'sessionArchiveSet'> & Required<Pick<ActionExecutorDeps, 'sessionOpen' | 'sessionFork' | 'sessionRollback'>>;

export function createCliSessionLifecycleActionDeps(
  params: CliActionDepsParams,
  { callMachineAction, callResolvedSessionRpc, normalizeStringValue, notSupported, readCurrentMachineControlIdentity, readTransportSessionOwnerMetadata, resolveServerRequestHeaders, resolveTransportForSession, resumeInactiveSessionTransport }: Readonly<{

    callMachineAction: CliMachineActionCall;
    callResolvedSessionRpc: (sessionId: string, method: string, request: unknown, signal?: AbortSignal) => Promise<unknown>;
    normalizeStringValue: (value: unknown) => string | null;
    notSupported: () => never;
    readCurrentMachineControlIdentity: () => Promise<CurrentMachineControlIdentity>;
    readTransportSessionOwnerMetadata: (transport: ResolvedSessionTransport) => ReturnType<typeof tryDecryptSessionOwnerMetadataView>;
    resolveServerRequestHeaders: (context: ActionExecutorContext | undefined, effectActionId: string, request: Readonly<{ method: string; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
    resolveTransportForSession: (idOrPrefix: string, signal?: AbortSignal, caller?: Readonly<{ context: ActionExecutorContext; actionId: ActionId }>, expectedSessionAddress?: ActionExecutorContext['expectedSessionAddress']) => Promise<ResolvedSessionTransport | Readonly<{
    ok: false;
    code: string;
    candidates?: string[];
  }>>;
    resumeInactiveSessionTransport: (input: Readonly<{
    transport: ResolvedSessionTransport;
    localId: string;
    effectActionId: 'execution.run.start' | 'session.open' | 'session.user_action.answer';
    context?: ActionExecutorContext;
    signal?: AbortSignal;
    waitForReady?: boolean;
    approvedNewDirectoryCreation?: boolean;
    resumeRequest?: SessionResumeRequestV1;
  }>) => Promise<InactiveSessionResumeResult>;
  }>,
): FamilyActionDeps {
  return {

    sessionOpen: async ({ sessionId, serverId, resumeRequest, actionRequestId, signal, approvedNewDirectoryCreation }, context) => {
      if (!params.credentials) return notSupported();
      const exactServerId = normalizeStringValue(serverId);
      const boundServerId = normalizeStringValue(params.serverId);
      if (!exactServerId || !boundServerId || exactServerId !== boundServerId
        && !(params.machineActionDirectTargetTransport && exactServerId === params.serverIdentityId)) {
        return { ok: false, errorCode: 'session_not_found', error: 'session_not_found' };
      }
      const transport = await resolveTransportForSession(sessionId, signal,
        context ? { context, actionId: 'session.open' } : undefined);
      if (!transport.ok) {
        return { ok: false, errorCode: transport.code, error: transport.code };
      }
      if (resumeRequest) {
        const request = SessionResumeRequestV1Schema.safeParse(resumeRequest);
        const machineId = normalizeStringValue(transport.rawSession.machineId)
          ?? normalizeStringValue(readTransportSessionOwnerMetadata(transport)?.machineId);
        if (!request.success || request.data.sessionId !== transport.sessionId
          || !params.machineActionDirectTargetTransport || params.machineActionDirectTargetTransport.machineId !== machineId) {
          return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
        }
      }
      if (transport.rawSession.active === true && !resumeRequest) {
        return {
          ok: true,
          status: 'opened',
          sessionId: transport.sessionId,
          serverId: exactServerId,
          address: { serverId: exactServerId, sessionId: transport.sessionId },
        };
      }
      const localId = normalizeStringValue(actionRequestId) ?? `session.open:${transport.sessionId}`;
      const resumed = await resumeInactiveSessionTransport({
        transport,
        localId,
        effectActionId: 'session.open',
        ...(context ? { context } : {}),
        ...(resumeRequest ? { resumeRequest } : {}),
        ...(approvedNewDirectoryCreation === true || resumeRequest?.approvedNewDirectoryCreation === true
          ? { approvedNewDirectoryCreation: true } : {}),
        ...(signal ? { signal } : {}),
      });
      return resumed.ok
        ? {
            ok: true,
            status: 'opened',
            sessionId: transport.sessionId,
            serverId: exactServerId,
            address: { serverId: exactServerId, sessionId: transport.sessionId },
          }
        : { ok: false, errorCode: resumed.code, error: resumed.message,
            ...(resumed.errorDetail ? { details: { errorDetail: resumed.errorDetail } } : {}) };
    },
    sessionFork: async ({
      sessionId,
      forkPoint,
      strategy,
      replaySummaryRunner,
      replayMaxSeedChars,
      requestId,
      signal,
    }, context) => {
      if (!params.credentials) return notSupported();
      const transport = await resolveTransportForSession(sessionId, signal);
      if (!transport.ok) {
        return { ok: false, errorCode: transport.code, error: transport.code };
      }
      const metadata = readTransportSessionOwnerMetadata(transport);
      const machineId = normalizeStringValue(transport.rawSession.machineId)
        ?? normalizeStringValue(metadata?.machineId);
      if (!machineId) {
        return { ok: false, errorCode: 'machine_not_found', error: 'machine_not_found' };
      }
      return await callMachineAction({
        machineId,
        method: RPC_METHODS.SESSION_FORK,
        context,
        authority: context?.authority,
        effectActionId: 'session.fork',
        authorization: { kind: 'session.write', sessionId: transport.sessionId },
        request: {
          v: 1,
          parentSessionId: transport.sessionId,
          forkPoint,
          ...(strategy ? { strategy } : {}),
          ...(replaySummaryRunner ? { replaySummaryRunner } : {}),
          ...(replayMaxSeedChars !== undefined ? { replayMaxSeedChars } : {}),
          ...(requestId ? { requestId } : {}),
        },
        ...(signal ? { signal } : {}),
      });
    },
    sessionContinueWithReplay: async (args) => {
      if (!params.credentials) return notSupported();
      const machineId = (await readCurrentMachineControlIdentity()).machineId;
      if (!machineId) {
        return { ok: false, errorCode: 'machine_not_found', error: 'machine_not_found' };
      }
      const { signal, ...request } = args;
      const { callMachineRpc } = await import("@/session/transport/rpc/machineRpc");
      return readMachineActionRpcResult(await callMachineRpc({
        credentials: params.credentials,
        machineId,
        method: RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY,
        authorization: { kind: 'session.write', sessionId: request.replay.previousSessionId },
        request,
        // Replay preparation and startup follow their containing caller lifetime.
        timeoutMs: null,
        ...(signal ? { signal } : {}),
      }));
    },
    sessionRollback: async ({ sessionId, target, signal }) => await callResolvedSessionRpc(
      sessionId,
      SESSION_RPC_METHODS.SESSION_ROLLBACK,
      { sessionId, ...(target ? { target } : {}) },
      signal,
    ),
    checkpointCodeRollback: async ({ request, signal }) => await callResolvedSessionRpc(
      request.sessionId,
      SESSION_RPC_METHODS.SESSION_CHECKPOINT_CODE_ROLLBACK,
      request,
      signal,
    ),
    sessionCheckpoint: async ({ request, signal }) => await callResolvedSessionRpc(
      request.sessionId,
      SESSION_RPC_METHODS.SESSION_CHECKPOINT,
      request,
      signal,
    ),
    sessionRestore: async ({ request, signal }) => await callResolvedSessionRpc(
      request.sessionId,
      SESSION_RPC_METHODS.SESSION_RESTORE,
      request,
      signal,
    ),
    sessionContinuationInspect: async ({ input }) => {
      if (!params.credentials) return { status: 'answered', inspection: { type: 'unavailable', reason: 'operation_unavailable' } };
      const invocation: Parameters<typeof import('@/session/agentTransition/sessionContinuationInspection').inspectSessionContinuation>[0] = {
        credentials: params.credentials, request: { v: 1, sourceSessionId: input.sessionId, selection: input.selection },
      };
      const { inspectSessionContinuation } = await import('@/session/agentTransition/sessionContinuationInspection');
      return { status: 'answered', inspection: await inspectSessionContinuation(invocation) };
    },
    sessionAgentTransition: async ({ request, context, sessionInputSource }) => {
      if (!params.credentials || !context.actionCaller || !context.authority) return rejectUndispatchedSessionAgentTransition('forbidden');
      const root = context.externalActionExecutionAuthorization;
      if (root && (!params.externalActionMachineRequestPrivateKey || !params.externalActionMachineInstallationId)) {
        return rejectUndispatchedSessionAgentTransition('forbidden');
      }
      const caller = context.actionCaller;
      if (sessionInputSource && caller?.kind !== 'session') return rejectUndispatchedSessionAgentTransition('forbidden');
      const { buildCausalSessionInputAdmissionV1, buildPluginSessionInputAdmissionV1 } = await import("@/session/services/sessionInputAdmissionIdentity");
      const inputAdmission = sessionInputSource && caller?.kind === 'session'
        ? buildCausalSessionInputAdmissionV1({ ...sessionInputSource, callerDepth: readAgentStartCallerWorkDepthV1(caller),
            ...(context.actionRequestAttributionV1 ? { actionRequestAttributionV1: context.actionRequestAttributionV1 } : {}) })
        : caller?.kind === 'plugin'
          ? buildPluginSessionInputAdmissionV1({ caller, surface: context.surface,
              ...(context.actionRequestAttributionV1 ? { actionRequestAttributionV1: context.actionRequestAttributionV1 } : {}) })
          : caller?.kind === 'host' && (context.authority === 'present_user' || context.externalActionCredential)
            ? buildTrustedHostSessionInputAdmissionV1(context.surface)
            : undefined;
      if (context.authority !== 'present_user' && !inputAdmission) return rejectUndispatchedSessionAgentTransition('forbidden');
      let restrictedAdmission = inputAdmission;
      if (inputAdmission && context.authority !== 'present_user' && caller?.kind !== 'session') {
        const { parsePermissionIntentAlias } = await import("@happier-dev/agents");
        let ceiling = (typeof context.callerPermissionMode === 'string'
          ? parsePermissionIntentAlias(context.callerPermissionMode) : null) ?? 'default';
        const constraints = [context.callerInputConstraints, context.externalActionCredential?.grant]
          .filter(value => value !== undefined);
        if (constraints.some(constraint => !isPermissionModeGrantedV1(constraint, ceiling))) {
          const restricted = constraints.find(constraint => constraint.permissionModes !== null);
          if (!restricted || restricted.permissionModes === null) return rejectUndispatchedSessionAgentTransition('forbidden');
          const { parsePermissionIntentAlias } = await import("@happier-dev/agents");
          const permissionModes = restricted.permissionModes.filter(mode => {
            if (constraints.some(constraint => !isPermissionModeGrantedV1(constraint, mode))) return false;
            const narrowed = resolveEffectivePermissionMode({ currentMode: ceiling, admittedPermissionCeiling: mode });
            return narrowed.ok && narrowed.effectiveMode === parsePermissionIntentAlias(mode);
          });
          const granted = resolveEffectiveApiTokenPermissionModeV1({ permissionModes }, ceiling);
          if (!granted) return rejectUndispatchedSessionAgentTransition('forbidden');
          const narrowed = resolveEffectivePermissionMode({ currentMode: ceiling, admittedPermissionCeiling: granted });
          if (!narrowed.ok) return rejectUndispatchedSessionAgentTransition('forbidden');
          const canonicalCeiling = parsePermissionIntentAlias(narrowed.effectiveMode);
          if (!canonicalCeiling) return rejectUndispatchedSessionAgentTransition('forbidden');
          ceiling = canonicalCeiling;
        }
        if (constraints.some(constraint => !isPermissionModeGrantedV1(constraint, ceiling))) {
          return rejectUndispatchedSessionAgentTransition('forbidden');
        }
        restrictedAdmission = { ...inputAdmission, request: { ...inputAdmission.request, permission: {
          ...inputAdmission.request.permission, requestedPermissionCeiling: ceiling,
        } } };
      }
      const invocation: Parameters<typeof import('@/session/agentTransition/sessionAgentTransitionCoordinator').runSessionAgentTransition>[0] = {
        credentials: params.credentials, request,
        ...(params.savedSecretOperationContext ? { operationContext: params.savedSecretOperationContext } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
        ...(restrictedAdmission ? { inputAdmission: restrictedAdmission } : {}),
        ...(context.callerInputConstraints ? { callerInputConstraints: context.callerInputConstraints } : {}),
        ...(context.externalActionCredential ? { credentialInputConstraints: context.externalActionCredential.grant } : {}),
        ...(context.externalActionExecutionAuthorization ? { callerInputAuthorization: context.externalActionExecutionAuthorization } : {}),
        ...(root ? { externalAction: { context: { ...context, externalActionTarget: { kind: 'session' as const, sessionId: request.sessionId } },
          effectActionId: root.binding.actionId, installationId: params.externalActionMachineInstallationId!,
          privateKey: params.externalActionMachineRequestPrivateKey! } } : {}),
        ...(params.actionsSettingsProvider?.getAccountSettings ? { deps: { readAccountSettings: () => params.actionsSettingsProvider!.getAccountSettings!() ?? null } } : {}),
        ...(params.machineAdmissionTransport ? { machineAdmissionTransport: params.machineAdmissionTransport } : {}),
      };
      const { runSessionAgentTransition } = await import('@/session/agentTransition/sessionAgentTransitionCoordinator');
      return await runSessionAgentTransition(invocation);
    },

    sessionArchiveSet: async ({ sessionId, archived, context }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      const effectActionId = archived ? 'session.archive' : 'session.unarchive';
      const { setSessionArchivedState } = await import("@/session/services/setSessionArchivedState");
      return await setSessionArchivedState({ credentials: params.credentials, sessionId, archived: archived === true,
        ...(archived && context?.actionCaller?.kind === 'workflowRun' ? { originRunId: context.actionCaller.runId } : {}),
        ...(context?.signal ? { signal: context.signal } : {}),
        resolveAuthorizationHeaders: request => resolveServerRequestHeaders(context, effectActionId, request),
        ...(context?.externalActionExecutionAuthorization && params.externalActionMachineRequestPrivateKey
          && params.externalActionMachineInstallationId ? { externalAction: { context, effectActionId,
            privateKey: params.externalActionMachineRequestPrivateKey, installationId: params.externalActionMachineInstallationId } } : {}),
      });
    },
  };
}
