import type { ResolvedSessionTransport } from './types';
import type { CliActionDepsParams } from './types';
import { admitActionAgentStartV1 } from '@happier-dev/protocol/actions/executor/agentStartAdmission';
import type { logger } from '@/ui/logger';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { createCliPromptLibraryStore } from '@/settings/prompts/promptLibraryStore';
import { readSessionManagerSessionIdV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import type { ActionExecutorDeps, ActionExecutorContext } from '@happier-dev/protocol';
import { RoleActionInputSchemasV1, RoleActionOutputSchemasV1 } from '@happier-dev/protocol/prompts/roles/roleActionsV1';
import { RoleActionRefusalV1 } from '@happier-dev/protocol/prompts/roles/accountRoleActions';
import { readSessionWorkspaceWritesV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import { resolveActionAgentStartContextV1 } from '@happier-dev/protocol/actions/executor/agentStartAdmission';
import { configuration } from '@/configuration';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { createRoleActionExecutor } from '../roleActions';
import { type RoleSourceReader } from '@/session/roles/roleSources';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { resolveCliActionCallerSession } from '../resolveCliActionCallerSession';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { getActiveAccountSettingsSnapshotLifetimeToken, isActiveAccountSettingsSnapshotLifetimeCurrent, readAccountRoleOverridesFromSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { readPreparedAccountRoleOverrides } from '@/session/roles/sessionRoleContext';
import type { readSessionPreparationFailureDiagnostic } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resolveBackendTargetFromSessionMetadata } from '@/session/backendTargets/resolveBackendTargetFromSessionMetadata';
import { readCliSessionEngineBaselineV1 } from '../resolveCliAgentStartContextV1';
export function createCliRolesActionDeps(
  params: Pick<CliActionDepsParams, 'credentials' | 'getCurrentResolvedRoles' | 'getCurrentSessionMetadata' | 'getCurrentSessionBackendTarget' | 'getCurrentAppliedChildSelection' | 'getCurrentWorkspaceWrites' | 'prepareWorkspaceWritesPolicy' | 'readPluginRoles' | 'savedSecretOperationContext' | 'serverHttpBaseUrl' | 'sessionActionRpcTransport' | 'sessionId' | 'stageSessionStateMutation'>,
  { artifactCallerContext, callSessionActionRpc, isWorkflowAuthorizationCurrent, prepareAccountRoleOverrides, readRawRoleSettings, readReadyAccountRoleOverrides, readRoleSources, resolveActionCallerSession, resolveAgentStartContext, resolveServerRequestHeaders, resolveTransportForSession, roleAccountLifetimeToken, roleAccountScopeKey, roleArtifactStore, sessionList, readAccountRoleOverrides }: Readonly<{
    artifactCallerContext: (context: ActionExecutorContext) => ActionExecutorContext;
    callSessionActionRpc: (transport: ResolvedSessionTransport, method: string, input: unknown, context: ActionExecutorContext) => Promise<unknown>;
    isWorkflowAuthorizationCurrent: (context: ActionExecutorContext) => Promise<boolean>;
    prepareAccountRoleOverrides: (signal?: AbortSignal) => Promise<void>;
    readRawRoleSettings: ((options?: Readonly<{ requireCurrentNetwork: boolean }>) => Promise<Readonly<Record<string, unknown>>>) | undefined;
    readReadyAccountRoleOverrides: (signal?: AbortSignal) => ReturnType<typeof readPreparedAccountRoleOverrides>;
    readRoleSources: RoleSourceReader;
    resolveActionCallerSession: (context: ActionExecutorContext) => ReturnType<typeof resolveCliActionCallerSession>;
    resolveAgentStartContext: NonNullable<ActionExecutorDeps['resolveAgentStartContext']>;
    resolveServerRequestHeaders: (context: ActionExecutorContext | undefined, effectActionId: string, request: Readonly<{ method: string; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
    resolveTransportForSession: (idOrPrefix: string, signal?: AbortSignal, caller?: Readonly<{ context: ActionExecutorContext; actionId: ActionId }>, expectedSessionAddress?: ActionExecutorContext['expectedSessionAddress']) => Promise<ResolvedSessionTransport | Readonly<{
    ok: false;
    code: string;
    candidates?: string[];
  }>>;
    roleAccountLifetimeToken: ReturnType<typeof getActiveAccountSettingsSnapshotLifetimeToken>;
    roleAccountScopeKey: ReturnType<typeof resolveAccountSettingsScopeKeyForToken>;
    roleArtifactStore: ReturnType<typeof createCredentialedAccountArtifactStore> | undefined;
    sessionList: ActionExecutorDeps['sessionList'];
    readAccountRoleOverrides: () => ReturnType<typeof readAccountRoleOverridesFromSnapshot>;
  }>,
  readEffectiveDeps: () => ActionExecutorDeps,
): Pick<ActionExecutorDeps, 'getCurrentWorkspaceWrites' | 'roleActionExecute'> {
  return {
    getCurrentWorkspaceWrites: params.getCurrentWorkspaceWrites ?? (params.getCurrentSessionMetadata ? () => {
      const read = readAccountRoleOverrides();
      return read.status === 'ready' ? readSessionWorkspaceWritesV1(params.getCurrentSessionMetadata?.(), {
        settingsOverrides: read.overrides, settingsRoles: params.getCurrentResolvedRoles?.(),
      }) : 'deny';
    } : undefined),
    roleActionExecute: ((createHost: (sessionId: string, readMetadata: typeof params.getCurrentSessionMetadata) =>
      NonNullable<ActionExecutorDeps['roleActionExecute']>): NonNullable<ActionExecutorDeps['roleActionExecute']> =>
      async (initialRequest) => {
        const operation = async () => {
        let request = { ...initialRequest, context: artifactCallerContext(initialRequest.context) };
        const input = RoleActionInputSchemasV1[request.actionId].parse(request.input);
        if (request.context.authority !== 'present_user'
          && (request.actionId === 'session.roles.apply_to_reports' || ('sessionId' in input && input.sessionId !== params.sessionId))
          && (request.context.actionCaller?.kind !== 'workflowRun'
            && request.context.actionCaller?.kind !== 'session' || !params.sessionActionRpcTransport)) {
          throw Object.assign(new Error('role_rpc_origin_unavailable'), { code: 'role_rpc_origin_unavailable' });
        }
        await prepareAccountRoleOverrides(request.context.signal);
        if (!await isWorkflowAuthorizationCurrent(request.context)) {
          throw new RoleActionRefusalV1('run_access_denied');
        }
        let execute = createHost(params.sessionId, params.getCurrentSessionMetadata);
        if (request.context.actionCaller?.kind === 'session' && request.context.authority !== 'present_user') {
          const caller = await resolveActionCallerSession(request.context);
          if (!caller?.metadata) throw Object.assign(new Error('target_unavailable'), { code: 'target_unavailable' });
          const roleSources = await readRoleSources(request.context.signal);
          const overridesRead = await readReadyAccountRoleOverrides(request.context.signal);
          if (overridesRead.status !== 'ready') throw Object.assign(new Error('account_role_overrides_unavailable'), {
            code: 'account_role_overrides_unavailable', reason: overridesRead.reason,
          });
          const currentWrites = readSessionWorkspaceWritesV1(caller.metadata, {
            roleSourceInventory: roleSources,
            settingsOverrides: overridesRead.overrides,
          });
          request = { ...request, context: { ...request.context,
            workspaceWrites: currentWrites === 'deny' || request.context.workspaceWrites === 'deny' ? 'deny' : currentWrites } };
        }
        // The source daemon owns the authenticated origin. Expand report copies
        // there through the same role owner, rather than asking a target Session
        // to impersonate the caller's Machine on a second forwarding hop.
        if (request.actionId === 'session.roles.apply_to_reports'
          && (request.context.actionCaller?.kind === 'session' || request.context.actionCaller?.kind === 'workflowRun')
          && request.context.authority !== 'present_user') {
          const input = RoleActionInputSchemasV1['session.roles.apply_to_reports'].parse(request.input);
          const target = await resolveTransportForSession(input.sessionId, request.context.signal);
          if (!target.ok || target.rawSession.effectiveAccess?.level !== 'owner' || !params.credentials) {
            throw Object.assign(new Error('session_target_unavailable'), { code: 'session_target_unavailable' });
          }
          const metadata = tryDecryptSessionOwnerMetadataView({ credentials: params.credentials,
            accountEncryptionMode: target.accountEncryptionCurrentness.mode, rawSession: target.rawSession });
          if (!metadata) throw Object.assign(new Error('session_target_unavailable'), { code: 'session_target_unavailable' });
          execute = createHost(input.sessionId, () => metadata);
        }
        const result = await execute(request);
        if (params.credentials && (request.actionId === 'roles.list' || request.actionId === 'roles.get')
          && !(params.savedSecretOperationContext ? await params.savedSecretOperationContext.isCurrent()
            : isActiveAccountSettingsSnapshotLifetimeCurrent({ scopeKey: roleAccountScopeKey, lifetimeToken: roleAccountLifetimeToken }))) {
          throw Object.assign(new Error('account_role_overrides_unavailable'), {
            code: 'account_role_overrides_unavailable', reason: 'scope-retired',
          });
        }
        return result;
        };
        try {
          return await (params.serverHttpBaseUrl
            ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, operation) : operation());
        } catch (error) {
          const { readSessionPreparationFailureDiagnostic } = await import("@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue");
          const diagnostic = readSessionPreparationFailureDiagnostic(error);
          if (diagnostic.originalCode === 'context_source_unavailable' || diagnostic.originalCode === 'role_overrides_unavailable') {
            const { logger } = await import("@/ui/logger");
            logger.infoFile('[Session] Role Action refused', diagnostic);
          }
          throw error;
        }
      })((sessionId, readSessionMetadata) => createRoleActionExecutor({
      sessionId,
      readSessionMetadata,
      readRoleSnapshotInputs: async (metadata, context) => {
        const bound = sessionId === params.sessionId;
        const backendTarget = (bound ? params.getCurrentSessionBackendTarget?.() : undefined)
          ?? resolveBackendTargetFromSessionMetadata(metadata);
        if (!backendTarget) throw new RoleActionRefusalV1('target_unavailable');
        const appliedChildSelection = bound ? await params.getCurrentAppliedChildSelection?.() : undefined;
        const { defaultEngine } = readCliSessionEngineBaselineV1({ backendTarget, appliedChildSelection });
        const inventory = await readEffectiveDeps().agentsBackendsList({ includeDisabled: false });
        context.signal?.throwIfAborted();
        return { defaultEngine, availableAgentTargetKeys: inventory.items.filter(item => item.enabled).map(item => item.targetKey) };
      },
      stageSessionStateMutation: params.stageSessionStateMutation,
      beforeSessionMutation: async (context, targetSessionId) => {
        if (context.actionCaller?.kind !== 'workflowRun') return;
        if (!await isWorkflowAuthorizationCurrent(context)) {
          throw new RoleActionRefusalV1('run_access_denied');
        }
        const current = await resolveActionAgentStartContextV1({ resolveAgentStartContext, sessionList }, context, targetSessionId);
        const admission = admitActionAgentStartV1(context, { kind: 'session_target', targetSessionId }, current);
        if (!admission.ok) throw new RoleActionRefusalV1(admission.error.errorCode);
      },
      readRoleSources,
      readPluginRoles: params.readPluginRoles,
      prepareWorkspaceWritesPolicy: params.prepareWorkspaceWritesPolicy,
      forwardSessionRoleAction: async ({ actionId, input, context }) => {
        const request = RoleActionInputSchemasV1[actionId].parse(input);
        if (!('sessionId' in request)) throw Object.assign(new Error('session_target_unavailable'), { code: 'session_target_unavailable' });
        const transport = await resolveTransportForSession(request.sessionId, context.signal);
        if ('ok' in transport && transport.ok === false) throw Object.assign(new Error(transport.code), { code: transport.code });
        const response = await callSessionActionRpc(transport, actionId, input, context);
        if (response && typeof response === 'object' && 'ok' in response && response.ok === false) return response;
        const parsed = RoleActionOutputSchemasV1[actionId].safeParse(response);
        if (parsed.success) return parsed.data;
        throw Object.assign(new Error('session_target_unavailable'), { code: 'session_target_unavailable' });
      },
      artifactStore: roleArtifactStore,
      readSettingsOverrides: readReadyAccountRoleOverrides,
      ...(params.credentials ? {
        accountId: readAccountIdFromToken(params.credentials.token) ?? undefined,
        listReportSessions: async (leadSessionId, context) => {
          const accountId = readAccountIdFromToken(params.credentials!.token);
          if (!accountId) throw Object.assign(new Error('not_authenticated'), { code: 'not_authenticated' });
          const reportsByStorage = await Promise.all((['active', 'archived'] as const).map(async storage => {
            const reports: { sessionId: string; ownerAccountId: string }[] = [];
            let cursor: string | undefined;
            do {
              const { fetchSessionListQueryPage } = await import("@/session/transport/http/sessionsHttp");
              const read = () => fetchSessionListQueryPage({ token: params.credentials!.token,
                query: { v: 1, storage, includeInactive: true, scope: 'all_accessible', attention: 'any', audiences: [], tagIds: [],
                  underSessionId: leadSessionId, ...(cursor ? { cursor } : {}) },
                ...(context.signal ? { signal: context.signal } : {}),
                resolveAuthorizationHeaders: (request) => resolveServerRequestHeaders(context, 'session.roles.apply_to_reports', request),
              });
              const page = await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, read) : read());
              for (const session of page.sessions) {
                if (readSessionManagerSessionIdV1(session) === leadSessionId && session.effectiveAccess.level === 'owner') {
                  reports.push({ sessionId: session.id, ownerAccountId: accountId });
                }
              }
              if (page.hasNext && (!page.nextCursor || page.nextCursor === cursor)) {
                throw Object.assign(new Error('session_list_cursor_invalid'), { code: 'session_list_cursor_invalid' });
              }
              cursor = page.hasNext ? page.nextCursor ?? undefined : undefined;
            } while (cursor);
            return reports;
          }));
          return reportsByStorage.flat();
        },
        writeReportSessionRoles: async (sessionId, configuration, context) => {
          const startedAt = performance.now();
          let transportDurationMs: number | undefined;
          let rpcStartedAt: number | undefined;
          let outcome: 'ok' | 'failed' = 'failed';
          try {
            const transport = await resolveTransportForSession(sessionId, context.signal);
            transportDurationMs = Math.round(performance.now() - startedAt);
            if ('ok' in transport && transport.ok === false) throw Object.assign(new Error(transport.code), { code: transport.code });
            rpcStartedAt = performance.now();
            const result = await callSessionActionRpc(transport, SESSION_RPC_METHODS.SESSION_ROLES_CONFIGURATION_SET,
              { sessionId, configuration }, context);
            if (!result || typeof result !== 'object' || !('updated' in result) || result.updated !== true) {
              const code = result && typeof result === 'object' && 'errorCode' in result && typeof result.errorCode === 'string'
                ? result.errorCode : 'session_target_unavailable';
              throw Object.assign(new Error(code), { code });
            }
            outcome = 'ok';
          } finally {
            const { logger } = await import("@/ui/logger");
            logger.infoFile('[Session] Role Apply recipient delivery', { sessionId: params.sessionId, reportSessionId: sessionId,
              phase: rpcStartedAt === undefined ? 'transport' : 'rpc',
              transportDurationMs: transportDurationMs ?? Math.round(performance.now() - startedAt),
              ...(rpcStartedAt === undefined ? {} : { rpcDurationMs: Math.round(performance.now() - rpcStartedAt) }),
              durationMs: Math.round(performance.now() - startedAt),
              outcome: outcome === 'failed' && context.signal?.aborted ? 'cancelled' : outcome });
          }
        },
        readRawAccountSettings: readRawRoleSettings,
        mutateAccountRoleOverrides: async (mutation, context) => {
          const { createCliPromptLibraryStore } = await import("@/settings/prompts/promptLibraryStore");
          await createCliPromptLibraryStore({ credentials: params.credentials!, signal: context.signal,
            operationContext: params.savedSecretOperationContext }).mutateRoleOverride(mutation);
        },
      } : {}),
    })),
  };
}
