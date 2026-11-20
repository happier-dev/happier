import type { CliActionDepsParams } from '../actions/cliActionDeps/types';
import type { readProjectAccountRows, ProjectAccountRowsInput } from '@/workspaces/projectAccountRows';
import type { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import { CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { ActionExecutorDeps, ActionExecutorContext } from '@happier-dev/protocol';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { getSessionStatus } from '@/session/services/getSessionStatus';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { fetchAccountProfile } from '@/api/accountProfile';
import { readSessionOperationCredentialReadinessV1 } from '@happier-dev/protocol/sessions/control/sessionReadinessV1';
import { resolveMachineRpcRoutePolicy } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import { ConnectedAccountUiProjectionEntryV1Schema } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import { TeamCredentialResourceEntitledPageV1Schema, type TeamCredentialResourceCatalogEntryV1 } from '@happier-dev/protocol/teams/credentials/resourceV1';
import type { createCliConnectedAccountCatalogStore } from '@/settings/connectedAccounts/connectedAccountCatalogStore';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type { CliProjectAdmission } from '@/session/actions/cliActionDeps/projectAdmission';
import type { CliMachineActionCall } from '@/session/actions/cliActionDeps/machineTransport';
import type { createCliMachineInventoryActionDeps } from '@/session/actions/cliActionDeps/machineInventory';
import { isPresentUserHostInvocation } from '@happier-dev/protocol/actions/invocationAuthority';

type FamilyActionDeps = Pick<ActionExecutorDeps, 'sessionStatusGet' | 'sessionWorkStateGet' | 'sessionWaitIdle'>;
export function createCliSessionStatusActionDeps(
  params: CliActionDepsParams,
  { assertProjectRequesterCurrent, callMachineAction, callResolvedSessionRpc, executionRunActionFailure, homeAccountId, isSameActionHomeId, projectAccountAdmission, projectHomeId, projectRowsAuthority, readServerFeaturesSnapshot, resolveProjectHomeIdentity, resolveServerRequestHeaders, withProjectHome, machinesAgentsList, readHomeDomainAction }: Readonly<{
    assertProjectRequesterCurrent: CliProjectAdmission['assertProjectRequesterCurrent'];
    callMachineAction: CliMachineActionCall;
    callResolvedSessionRpc: (sessionId: string, method: string, request: unknown, signal?: AbortSignal) => Promise<unknown>;
    executionRunActionFailure: (code: string, message?: string, details?: unknown) => Readonly<{ ok: false; errorCode: string; error: string; details?: unknown }>;
    homeAccountId: string | null;
    isSameActionHomeId: (serverId: string) => boolean;
    projectAccountAdmission: CliProjectAdmission['projectAccountAdmission'];
    projectHomeId: string;
    projectRowsAuthority: CliProjectAdmission['projectRowsAuthority'];
    readServerFeaturesSnapshot: () => Promise<CliServerFeaturesSnapshot | undefined>;
    resolveProjectHomeIdentity: CliProjectAdmission['resolveProjectHomeIdentity'];
    resolveServerRequestHeaders: (context: ActionExecutorContext | undefined, effectActionId: string, request: Readonly<{ method: string; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
    withProjectHome: CliProjectAdmission['withProjectHome'];
    machinesAgentsList: ReturnType<typeof createCliMachineInventoryActionDeps>['machinesAgentsList'];
    readHomeDomainAction: () => ActionExecutorDeps['homeDomainAction'];
  }>,
): FamilyActionDeps {
  return {

    sessionStatusGet: async ({ sessionId, live, readiness, includeAcceptedWorkspace, operation, credentialPurpose, credentialTeamSelection, context, signal, serverId }) => {
      const operationSignal = signal ?? context?.signal;
      operationSignal?.throwIfAborted();
      if (!params.credentials) {
        return { ok: false, code: 'not_authenticated' };
      }
      // A Session read is addressed by the captured Home identity, exactly as the widget Session validator
      // decides it; the saved profile's exact binding still proves a Home id this process was not given.
      const sessionHome = async (id?: string | null) => {
        const { isServerProfileHomeIdentity } = await import("@/server/serverProfiles");
        return !id || isSameActionHomeId(id) || await isServerProfileHomeIdentity(projectHomeId, id.trim());
      };
      if (!await sessionHome(serverId) || !await sessionHome(context?.serverId)) return executionRunActionFailure('server_scope_mismatch');
      const credentials = params.credentials;
      const effectActionId = context?.externalActionExecutionAuthorization?.binding.actionId ?? 'session.status.get';
      // Only the existing admitted host authority may use the ordinary Account
      // transport. Preserve signed/custom credentials and automation ceilings;
      // a different read token must never borrow the content credential to write.
      const ordinaryAccountRead = context !== undefined && isPresentUserHostInvocation(context)
        && params.token === credentials.token;
      const serverFeaturesSnapshot = await readServerFeaturesSnapshot();
      const { getSessionStatus } = await import("@/session/services/getSessionStatus");
      const read = () => getSessionStatus({ credentials, idOrPrefix: sessionId, live: live === true,
        ...(context?.expectedSessionAddress ? { expectedSessionAddress: context.expectedSessionAddress } : {}),
        ...(includeAcceptedWorkspace === true ? { includeAcceptedWorkspace: true, readAcceptedWorkspace: async (metadata: unknown) => {
          if (await projectAccountAdmission(serverId ?? undefined, context)) return undefined;
          try {
            await assertProjectRequesterCurrent(context);
            const [{ readProjectAccountRows }, { resolveSessionProjectKeyV1, workspaceAddressFromRefV1 }] = await Promise.all([
              import('@/workspaces/projectAccountRows'), import('@happier-dev/protocol/workspaces/workspaceRefResolutionV1'),
            ]);
            const homeId = await resolveProjectHomeIdentity();
            const workspaceId = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
              ? Reflect.get(metadata, 'workspaceId') : undefined;
            const accountId = readAccountIdFromToken(credentials.token);
            if (!context?.externalActionExecutionAuthorization && !accountId) return undefined;
            if (params.savedSecretOperationContext && (params.savedSecretOperationContext.credentials.token !== credentials.token
              || params.savedSecretOperationContext.serverHttpBaseUrl.replace(/\/+$/, '')
                !== (params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl()).replace(/\/+$/, ''))) return undefined;
            const authority: ProjectAccountRowsInput = context?.externalActionExecutionAuthorization
              ? projectRowsAuthority(context, effectActionId, operationSignal)
              : { credentials, serverId: projectHomeId, ...(operationSignal ? { signal: operationSignal } : {}),
                sessionCustody: { serverId: projectHomeId, accountId: accountId!,
                  serverHttpBaseUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
                  isCurrent: async () => !await projectAccountAdmission(serverId ?? undefined, context)
                    && (await params.savedSecretOperationContext?.isCurrent(operationSignal) ?? true) } };
            // An accepted id needs one row; older path-associated Sessions use the canonical Home-scoped census.
            const rows = await readProjectAccountRows({ ...authority,
              selection: typeof workspaceId === 'string' && workspaceId.trim()
                ? { key: { kind: 'workspace-ref', serverId: homeId, id: workspaceId.trim() } }
                : { kinds: ['workspace-ref'], serverId: homeId } });
            await assertProjectRequesterCurrent(context);
            if (await projectAccountAdmission(serverId ?? undefined, context)) return undefined;
            operationSignal?.throwIfAborted();
            const resolved = resolveSessionProjectKeyV1(metadata, homeId, rows.workspaceRefs);
            if (resolved.kind !== 'resolved' || !resolved.ref) return undefined;
            return { checkout: workspaceAddressFromRefV1(resolved.ref),
              ...(resolved.ref.repositoryIdentity ? { repository: resolved.ref.repositoryIdentity } : {}) };
          } catch {
            operationSignal?.throwIfAborted();
            // Unavailable or inadmissible private rows do not turn into a guessed checkout.
            return undefined;
          }
        } } : {}),
        ...(operation ? { operation } : {}), ...(credentialPurpose ? { credentialPurpose } : {}),
        ...(credentialTeamSelection ? { credentialTeamSelection } : {}),
        readiness: readiness === true, ...(operationSignal ? { signal: operationSignal } : {}),
        ...(serverFeaturesSnapshot ? { serverFeaturesSnapshot } : {}),
        ...(params.serverHttpBaseUrl ? { serverHttpBaseUrl: params.serverHttpBaseUrl } : {}),
        resolveAuthorizationHeaders: ordinaryAccountRead ? undefined
          : request => resolveServerRequestHeaders(context, effectActionId, request),
        ...(context?.externalActionExecutionAuthorization ? { authorization: context.externalActionExecutionAuthorization } : {}),
        // A credential-only external root has no requester Machine projection. Never use host custody instead.
        ...(!context?.externalActionCredential || context.externalActionExecutionAuthorization ? {
          readReadinessInventory: (input, providerIsolation) =>
            machinesAgentsList(input, context ?? { surface: 'cli' }, undefined, providerIsolation),
          readReadinessTeamProviderResources: async ({ teamId, resourceId }) => {
            const homeDomainAction = readHomeDomainAction();
            if (!homeDomainAction) return [];
            const { readSpawnConnectedServicesTeamResources } = await import('./sessionTeamCredentialCatalog');
            return readSpawnConnectedServicesTeamResources({
              homeDomainAction: request => homeDomainAction({ ...request, context: context ?? request.context }),
              teamIds: [teamId], resourceId, serverId, signal: operationSignal,
            });
          },
          readReadinessCredential: async ({ machineId, purpose, machineAccess, teamSelection }) => {
            const currentContext = context ?? { surface: 'cli' as const };
            const described = DaemonContributionRegistryProjectionDescribeResponseSchema.parse(await callMachineAction({
              machineId, method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
              request: { machineId, selection: 'connectedAccountAdmission' },
              context: currentContext, effectActionId: 'session.status.get', exactMachine: true,
              ...(operationSignal ? { signal: operationSignal } : {}),
            }));
            const authorizeRequest = (request: Readonly<{ method: string; path: string; body?: unknown }>) =>
              resolveServerRequestHeaders(currentContext, effectActionId, request);
            const [{ createCliConnectedAccountCatalogStore }, { fetchAccountProfile }] = await Promise.all([import("@/settings/connectedAccounts/connectedAccountCatalogStore"), import("@/api/accountProfile")]);
            const store = teamSelection ? null : createCliConnectedAccountCatalogStore({ credentials, operationContext: params.savedSecretOperationContext,
              authorizeRequest, ...(operationSignal ? { signal: operationSignal } : {}) });
            const catalog = store ? await store.readAdmittedCatalog('purposes') : null;
            if (!teamSelection && (!catalog || catalog.status !== 'ready' || catalog.record.key !== 'purposes')) return { kind: 'unknown' as const };
            const profile = teamSelection ? null : await fetchAccountProfile({ token: credentials.token, authorizeRequest,
              ...(operationSignal ? { signal: operationSignal } : {}) });
            store?.assertCurrent();
            if (profile && homeAccountId && profile.id !== homeAccountId) return { kind: 'unknown' as const };
            const team = teamSelection;
            let resource: TeamCredentialResourceCatalogEntryV1 | null = null;
            const homeDomainAction = readHomeDomainAction();
            if (team && homeDomainAction) {
              let cursor: string | null = null;
              do {
                const page = TeamCredentialResourceEntitledPageV1Schema.parse(await homeDomainAction({
                  actionId: 'teams.credentials.entitled.list', input: { teamId: team.teamId, ...(cursor ? { cursor } : {}) },
                  context: currentContext, ...(operationSignal ? { signal: operationSignal } : {}),
                }));
                resource = page.resources.find(candidate => candidate.id === team.selection.resourceId) ?? null;
                cursor = page.nextCursor;
              } while (!resource && cursor);
            }
            store?.assertCurrent();
            const descriptors = Object.values(described.projection.familiesById.connectedAccounts?.entriesById ?? {}).flatMap(entry => {
              const parsed = ConnectedAccountUiProjectionEntryV1Schema.safeParse(entry);
              return parsed.success && parsed.data.availability.state === 'available' ? [parsed.data] : [];
            });
            return readSessionOperationCredentialReadinessV1({ purpose, machineId, machineAccess, executionAccountId: profile?.id ?? homeAccountId,
              repairAccess: resolveMachineRpcRoutePolicy(CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD).sharedMachineAccess,
              bindings: catalog?.status === 'ready' && catalog.record.key === 'purposes' ? catalog.record.value : { v: 1, bindings: [] },
              ...(teamSelection ? { teamSelection } : {}),
              projection: described.projection,
              machineProvisionersById: described.projection.familiesById.machineProvisioners?.entriesById ?? {},
              accounts: profile?.connectedAccountsV4 ?? [], groups: profile?.connectedAccountGroupsV4 ?? [],
              now: Date.now(), teamResource: resource, readAuthentication: service => {
                const matching = descriptors.filter(descriptor => descriptor.pluginId === service.pluginId && descriptor.serviceId === service.localId);
                return matching.length === 1 ? matching[0]!.authentication : null;
              } });
          },
        } : {}),
      });
      return await withProjectHome(read);
    },

    sessionWorkStateGet: async ({ sessionId }) => {
      return await callResolvedSessionRpc(sessionId, SESSION_RPC_METHODS.SESSION_WORK_STATE_GET, {});
    },

	    sessionWaitIdle: async ({ sessionId, timeoutSeconds, signal }) => {
	      if (!params.credentials) {
	        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
	      }
	      const normalizedTimeoutSeconds =
	        typeof timeoutSeconds === 'number' && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
	          ? Math.min(3600, timeoutSeconds)
	          : 300;
	      const { waitForSessionIdle } = await import("@/session/services/waitForSessionIdle");
	      return await waitForSessionIdle({
	        credentials: params.credentials,
	        idOrPrefix: sessionId,
	        timeoutMs: Math.max(1, Math.floor(normalizedTimeoutSeconds * 1000)),
	        serverFeaturesSnapshot: await readServerFeaturesSnapshot(),
	        ...(signal ? { signal } : {}),
	      });
	    },
  };
}
