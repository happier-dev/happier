import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { readSystemSessionMetadataFromMetadata } from '@happier-dev/protocol/sessions/metadata/systemSessionV1';
import { projectSessionSummaryV1 } from '@happier-dev/protocol/sessions/control/contract';
import { composeSessionReadinessV1, isSessionReadinessNativeSelectionV1, readSessionOperationCredentialReadinessV1,
  type SessionCredentialReadinessV1 } from '@happier-dev/protocol/sessions/control/sessionReadinessV1';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { ConnectedAccountUiProjectionEntryV1Schema } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import type { TeamCredentialResourceCatalogEntryV1 } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { projectAgentProviderBrokerApplications } from '@happier-dev/protocol/providers/catalog/brokerApplicationProjectionV1';
import { parseProviderContributionIdentityV1 } from '@happier-dev/protocol/providers/contribution-identity';
import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { resolveMachineRpcRoutePolicy } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import { CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import { resolveAgentExecutionTargetFromSessionMetadata, resolveAgentIdFromSessionMetadata } from '@happier-dev/agents/runtime/identity/resolveAgentIdFromSessionMetadata';
import { resolveAmbientProviderConnectionForModelIntent, resolvePermissionIntentFromSessionMetadata } from '@happier-dev/agents/session/state/metadataReaders';
import { readAcpConfiguredBackendV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/acpConfiguredBackendV1';
import { isDataKeyAuthCredentials, isLegacyAuthCredentials } from '@/auth/storage/tokenStorage';
import { readMachineAgentsForScope, refreshMachineAgents } from '@/agents/machineAgents/useMachineAgents';
import { loadDaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { DAEMON_AGENT_CATALOG_SECTIONS } from '@/agents/backendCatalog/agentCatalogSections';
import { CONNECTED_ACCOUNT_PURPOSE_DECLARATION_SECTIONS } from '@/sync/domains/plugins/ui/projectionSections';
import { readAdmittedConnectedAccountCatalogInContext } from '@/sync/api/account/apiConnectedAccountCatalog';
import { listEntitledTeamCredentialResources } from '@/sync/ops/teams/teamCredentialOperations';
import { buildSessionReadinessViewModel } from '@/components/sessions/model/sessionReadinessViewModel';
import { findCurrentTeamCredentialProviderModel } from '@/components/sessions/teamCredentials/teamCredentialProviderModelCurrentness';
import { resolveSessionModelSelectionDisposition } from '@/sync/domains/models/resolveSessionModelSelectionDisposition';
import { getSessionRunnerRuntimeStatusSnapshot } from '@/sync/ops/sessionRunnerRestart';
import { providerDeclarationContext, readAccountAgentProviderRequirements,
  readAccountProviderDeclarations } from '@/providers/catalog/accountProviderDeclarations';
import { readSessionConnectedServiceBindings } from '@/sync/domains/connectedServices/readSessionConnectedServiceBindings';
import { areTeamResourceConnectedServiceSelectionsEqual } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import { resolveProjectedConnectedAccountServiceKeys } from '@/sync/domains/connectedServices/qualifiedConnectedAccountServiceOptions';
import { readTeamCredentialResourceCatalogs } from '@/sync/store/teams/teamsSnapshots';
import { resolveSessionActionDefaultBackend, resolveSessionActionDefaultTargetKey } from '@/sync/domains/session/resolveSessionActionDefaultBackend';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readSessionAcceptedWorkspace } from '@/sync/domains/session/sessionAcceptedWorkspace';
import { projectUiSessionAwareness } from '@/sync/domains/session/awareness/sessionAwareness';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { resolveDisplayIdentityForSessionFromState } from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storage';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { readSessionSnapshotForAuthority, SessionSnapshotReadError } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import type { LazyActionAccountContext } from './actionAccountContext';
import { readAgentSessionCompactionAvailability } from '@/agents/backendCatalog/currentAgentCapabilities';
import { listPendingRequests, projectSessionStatusPendingRequestsV1 } from '@happier-dev/session-core/pending';
import { readPendingRequestFactsFromSession } from '@/sync/domains/session/pending/listPendingSessionRequests';

/** Status stays usable without a running Agent; detail reads are explicit and use the existing inventory. */
export function createUiSessionStatusGet(account: LazyActionAccountContext | null | undefined,
  options?: Readonly<{ refreshReadiness?: boolean; readAdmittedInventory?: boolean }>): NonNullable<ActionExecutorDeps['sessionStatusGet']> {
  return async ({ sessionId, readiness, includeAcceptedWorkspace, operation, credentialPurpose, credentialTeamSelection, serverId, signal }) => {
    if (!account) return { ok: false, code: 'not_authenticated' };
    account.assertCurrent();
    signal?.throwIfAborted();
    // The Action context names the Home by its profile id; the captured Account scope by its portable id.
    if (serverId && !areServerProfileIdentifiersEquivalent(serverId, account.serverId)) return { ok: false, code: 'server_scope_mismatch' };
    let session: Awaited<ReturnType<typeof readSessionSnapshotForAuthority>>['session'];
    try {
      ({ session } = await runWithServerRequestAuthorityForServerAccountScope({ scope: account.accountLifetime.scope,
        activeRequest: account.request }, authority => readSessionSnapshotForAuthority({ authority, sessionId,
          isCurrent: account.accountLifetime.isCurrent, signal })));
    } catch (error) {
      // The Home answered that this Session does not exist: a definite answer, unlike an unreachable Home.
      if (error instanceof SessionSnapshotReadError && error.httpStatus === 404) return { ok: false, code: 'session_not_found' };
      throw error;
    }
    account.assertCurrent();
    signal?.throwIfAborted();
    const access = session.access;
    const invocation = access ? { v: 1 as const, level: access.level, sources: access.sources ?? [], capabilities: access.capabilities,
      ...(access.audienceContext !== undefined ? { audienceContext: access.audienceContext } : {}),
      ...(access.primaryTeamId !== undefined ? { primaryTeamId: access.primaryTeamId } : {}) } : null;
    const metadata = readSessionOwnerMetadataView(session);
    const presentationMetadata = metadata ?? session.metadata;
    const system = presentationMetadata ? readSystemSessionMetadataFromMetadata({ metadata: presentationMetadata }) : null;
    const summary = projectSessionSummaryV1({ row: { ...session, ...(invocation ? { effectiveAccess: invocation } : {}) },
      metadata: presentationMetadata, permissionMode: resolvePermissionIntentFromSessionMetadata(presentationMetadata)?.intent,
      ...(system ? { systemPurpose: system.key ?? null } : {}),
      encryption: isDataKeyAuthCredentials(account.credentials) ? { type: 'dataKey' }
        : isLegacyAuthCredentials(account.credentials) ? { type: 'legacy' } : null });
    const acceptedWorkspace = includeAcceptedWorkspace === true ? readSessionAcceptedWorkspace(session, account.accountLifetime.scope, storage.getState()) : undefined;
    const agentTarget = resolveAgentExecutionTargetFromSessionMetadata(metadata);
    const pending = listPendingRequests(readPendingRequestFactsFromSession(session), []);
    const pendingRequests = projectSessionStatusPendingRequestsV1(pending);
    const result = { ok: true as const, session: summary, awareness: projectUiSessionAwareness(session, Date.now()),
      compaction: readAgentSessionCompactionAvailability({ agentId: resolveAgentIdFromSessionMetadata(metadata), metadata }),
      pendingRequests,
      agentState: session.agentState ? { controlledByUser: session.agentState.controlledByUser === true, pendingRequestsCount: pending.length } : null,
      ...(agentTarget ? { agentTarget } : {}),
      ...(acceptedWorkspace ? { acceptedWorkspace } : {}) };
    if (readiness !== true) return result;
    // Diagnostics keep stable attribution when control admission correctly refuses an offline Machine.
    const target = resolveDisplayIdentityForSessionFromState({ state: storage.getState(),
      serverId: account.serverId, sessionId, metadata, preferProvidedMetadata: true });
    const selectedMachineId = target.machineId || null;
    const agentId = resolveAgentIdFromSessionMetadata(metadata);
    const definitionId = readAcpConfiguredBackendV1FromMetadata(metadata)?.backendId;
    if (!options?.readAdmittedInventory && selectedMachineId && agentId && invocation?.capabilities.submitAgentInput) {
      try {
        await refreshMachineAgents({ serverId: account.serverId, machineId: selectedMachineId,
          accountLifetime: account.accountLifetime, agentId, ...(definitionId ? { definitionId } : {}),
          ...(options?.refreshReadiness ? { force: true } : {}), ...(signal ? { signal } : {}) });
      } catch { signal?.throwIfAborted(); }
      account.assertCurrent();
      signal?.throwIfAborted();
    }
    const inventory = selectedMachineId ? readMachineAgentsForScope(account.accountLifetime, selectedMachineId) : null;
    const agent = inventory?.agents.find(agent => agent.agentId === agentId && agent.definitionId === definitionId) ?? null;
    const targetKey = resolveSessionActionDefaultTargetKey(resolveSessionActionDefaultBackend({ session }));
    const provider = targetKey ? resolveAmbientProviderConnectionForModelIntent({ metadata, agentTargetKey: targetKey, sessionActive: session.active }) : null;
    const machine = selectedMachineId ? resolveServerScopedMachine(storage.getState(), account.serverId, selectedMachineId) : null;
    let runnerProcessIdentity: Parameters<typeof resolveSessionModelSelectionDisposition>[0]['currentRunnerProcessIdentity'] = null;
    if (session.active && metadata?.sessionModelsV1?.activeSelectionV1 && selectedMachineId && agentId && targetKey
      && inventory?.status === 'ready') {
      const runtime = await getSessionRunnerRuntimeStatusSnapshot({ sessionId, machineId: selectedMachineId,
        serverId: account.serverId, ...(signal ? { signal } : {}) });
      account.assertCurrent();
      signal?.throwIfAborted();
      runnerProcessIdentity = runtime?.state.machineId === selectedMachineId ? runtime.runnerProcessIdentity : null;
    }
    const disposition = agentId && targetKey ? resolveSessionModelSelectionDisposition({ agentId, agentTargetKey: targetKey,
      metadata, sessionActive: session.active, currentRunnerProcessIdentity: runnerProcessIdentity }) : null;
    const effectiveRoute = disposition?.contextRouteSelection ?? null;
    let teamRoute = effectiveRoute && 'source' in effectiveRoute && effectiveRoute.source === 'team_resource'
      ? { kind: 'team_credential_provider_model' as const, resourceId: effectiveRoute.resourceId, teamId: effectiveRoute.teamId,
        expectedResourceRevision: effectiveRoute.expectedResourceRevision, deliveryMode: effectiveRoute.deliveryMode,
        agentTargetKey: effectiveRoute.agentTargetKey, modelId: effectiveRoute.modelId }
      : null;
    const acceptedTeamProviderBinding = session.acceptedTeamCredentialBinding?.slot.kind === 'provider_model'
      && session.acceptedTeamCredentialBinding.resourceId !== null
      ? session.acceptedTeamCredentialBinding : null;
    if (!teamRoute && acceptedTeamProviderBinding?.teamId && disposition?.contextSelection) {
      teamRoute = { kind: 'team_credential_provider_model', resourceId: acceptedTeamProviderBinding.resourceId,
        teamId: acceptedTeamProviderBinding.teamId,
        expectedResourceRevision: acceptedTeamProviderBinding.expectedResourceRevision,
        deliveryMode: acceptedTeamProviderBinding.deliveryMode,
        agentTargetKey: disposition.contextSelection.agentTargetKey,
        modelId: disposition.contextSelection.modelId };
    }
    const acceptedBindingMatchesTeamRoute = Boolean(teamRoute && acceptedTeamProviderBinding?.teamId
      && acceptedTeamProviderBinding.resourceId === teamRoute.resourceId
      && acceptedTeamProviderBinding.teamId === teamRoute.teamId
      && acceptedTeamProviderBinding.expectedResourceRevision === teamRoute.expectedResourceRevision
      && acceptedTeamProviderBinding.deliveryMode === teamRoute.deliveryMode);
    const routeProviderConnectionId = effectiveRoute
      ? 'providerConnectionId' in effectiveRoute ? effectiveRoute.providerConnectionId
        : effectiveRoute.source === 'native' ? null : undefined
      : provider?.status === 'resolved' ? provider.providerConnectionId : undefined;
    const native = !teamRoute && !acceptedTeamProviderBinding && isSessionReadinessNativeSelectionV1({ metadata,
      providerConnectionId: routeProviderConnectionId });
    const credentialBindings = agentId ? readSessionConnectedServiceBindings({ metadata, agentId }) : null;
    const teamBindings = Object.entries(credentialBindings?.bindingsByServiceId ?? {})
      .flatMap(([serviceId, binding]) => binding.source === 'team_resource' ? [{ serviceId, binding }] : []);
    let credential: SessionCredentialReadinessV1 = acceptedTeamProviderBinding?.teamId
      ? { kind: 'team', teamId: acceptedTeamProviderBinding.teamId,
        resourceId: acceptedTeamProviderBinding.resourceId, readiness: null, recoveryAction: null }
      : { kind: operation === 'credential' ? 'unknown' : 'not_required' };
    let selection: Parameters<typeof buildSessionReadinessViewModel>[0]['selection'] = native || credentialBindings
      ? { credentialBindings } : null;
    if ((teamRoute || acceptedTeamProviderBinding || teamBindings.length > 0) && selectedMachineId) {
      let projection: PluginProjectionV2 | null = null;
      try {
        projection = (await loadDaemonMergedProjectionInputs({ machineId: selectedMachineId, serverId: account.serverId,
          accountLifetime: account.accountLifetime, sections: DAEMON_AGENT_CATALOG_SECTIONS, ...(signal ? { signal } : {}) }))?.pluginProjectionV2 ?? null;
      } catch { signal?.throwIfAborted(); }
      account.assertCurrent();
      const projectedAgent = projection?.agentsById[agentId ?? ''];
      const acceptedConnectedServiceIds = resolveProjectedConnectedAccountServiceKeys(projectedAgent?.connectedAccounts ?? []);
      const acceptedServiceIds = new Set([
        ...(agent?.signIn.connectedServices.map(service => service.serviceId) ?? []),
        ...acceptedConnectedServiceIds,
      ]);
      const relevantTeamBindings = teamBindings.filter(({ serviceId }) => acceptedServiceIds.size === 0 || acceptedServiceIds.has(serviceId));
      const resourceIds = new Set(relevantTeamBindings.map(({ binding }) => binding.resourceId));
      if (teamRoute) resourceIds.add(teamRoute.resourceId);
      if (acceptedTeamProviderBinding) resourceIds.add(acceptedTeamProviderBinding.resourceId);
      const candidateTeamIds = new Set([
        ...(teamRoute ? [teamRoute.teamId] : []),
        ...(acceptedTeamProviderBinding?.teamId ? [acceptedTeamProviderBinding.teamId] : []),
        ...(invocation?.primaryTeamId ? [invocation.primaryTeamId] : []),
        ...(invocation?.audienceContext ? [invocation.audienceContext.teamId] : []),
        ...(invocation?.sources.flatMap(source => 'teamId' in source ? [source.teamId] : []) ?? []),
        ...readTeamCredentialResourceCatalogs(account.accountLifetime.scope)
          .filter(resource => resourceIds.has(resource.id)).map(resource => resource.teamId),
      ]);
      const resources: TeamCredentialResourceCatalogEntryV1[] = [];
      let resourcesCurrent = candidateTeamIds.size > 0;
      for (const teamId of candidateTeamIds) {
        let cursor: string | null = null;
        try {
          do {
            const outcome = await listEntitledTeamCredentialResources({ scope: account.accountLifetime.scope,
              address: { serverId: account.serverId, teamId }, cursor, ...(signal ? { signal } : {}) });
            account.assertCurrent();
            if (outcome.kind !== 'succeeded') { resourcesCurrent = false; break; }
            resources.push(...outcome.value.resources.filter(resource => resourceIds.has(resource.id)));
            cursor = outcome.value.nextCursor;
          } while (cursor && ![...resourceIds].every(resourceId => resources.some(resource => resource.id === resourceId)));
        } catch { signal?.throwIfAborted(); resourcesCurrent = false; }
        if (resourceIds.size > 0 && [...resourceIds].every(resourceId => resources.some(resource => resource.id === resourceId))) break;
      }
      const routeResources: TeamCredentialResourceCatalogEntryV1[] = [];
      if (teamRoute && !acceptedBindingMatchesTeamRoute) {
        const declarationContext = providerDeclarationContext(selectedMachineId, projection);
        const requirements = readAccountAgentProviderRequirements(teamRoute.agentTargetKey, declarationContext);
        const providers = readAccountProviderDeclarations(declarationContext).flatMap(declaration => {
          const parsed = parseProviderContributionIdentityV1(declaration.contributionKey);
          return parsed ? [{ identity: parsed.identity, definition: declaration.definition }] : [];
        });
        const applications = requirements ? projectAgentProviderBrokerApplications({ providers,
          agentTargetKey: teamRoute.agentTargetKey, acceptedProtocols: requirements.acceptsProtocols }) : [];
        await Promise.all(applications.map(async application => {
          let cursor: string | null = null;
          try {
            do {
              const outcome = await listEntitledTeamCredentialResources({ scope: account.accountLifetime.scope,
                address: { serverId: account.serverId, teamId: teamRoute!.teamId }, application, cursor,
                ...(signal ? { signal } : {}) });
              account.assertCurrent();
              if (outcome.kind !== 'succeeded') return;
              routeResources.push(...outcome.value.resources.filter(resource => resource.id === teamRoute!.resourceId));
              cursor = outcome.value.nextCursor;
            } while (cursor && !routeResources.some(resource => findCurrentTeamCredentialProviderModel(resource, teamRoute!) !== null));
          } catch { signal?.throwIfAborted(); }
        }));
      }
      if (!teamRoute && !acceptedTeamProviderBinding && !disposition?.proposedSelectionV2 && disposition?.contextSelection) {
        const inferredRoutes = resources.flatMap(resource => relevantTeamBindings.flatMap(({ binding }) => (
          resource.id === binding.resourceId && resource.connectedServiceSelections.some(selection =>
            areTeamResourceConnectedServiceSelectionsEqual(selection, binding))
            ? resource.providerModels.filter(candidate => candidate.selection.deliveryMode === binding.deliveryMode
              && candidate.selection.agentTargetKey === disposition.contextSelection?.agentTargetKey
              && candidate.selection.modelId === disposition.contextSelection?.modelId).map(candidate => candidate.selection)
            : []
        )));
        const uniqueRoutes = [...new Map(inferredRoutes.map(route => [JSON.stringify(route), route])).values()];
        teamRoute = uniqueRoutes.length === 1 ? uniqueRoutes[0]! : null;
      }
      const acceptedRouteResource = acceptedBindingMatchesTeamRoute && acceptedTeamProviderBinding?.teamId
        ? resources.find(resource => resource.id === acceptedTeamProviderBinding.resourceId
          && resource.teamId === acceptedTeamProviderBinding.teamId
          && resource.resourceRevision === acceptedTeamProviderBinding.expectedResourceRevision) ?? null
        : null;
      const projectedRouteResource = teamRoute ? [...routeResources, ...resources].find(resource =>
        findCurrentTeamCredentialProviderModel(resource, teamRoute!) !== null) ?? null : null;
      const routeResource = acceptedRouteResource ?? projectedRouteResource;
      const fallbackBinding = relevantTeamBindings.length === 1 ? relevantTeamBindings[0]!.binding : null;
      const fallbackResource = fallbackBinding ? resources.find(resource => resource.id === fallbackBinding.resourceId
        && resource.connectedServiceSelections.some(selection =>
          areTeamResourceConnectedServiceSelectionsEqual(selection, fallbackBinding))) ?? null : null;
      const fallbackTeamId = fallbackResource?.teamId ?? (candidateTeamIds.size === 1 ? [...candidateTeamIds][0]! : null);
      const credentialIdentity = teamRoute ? { teamId: teamRoute.teamId, resourceId: teamRoute.resourceId }
        : acceptedTeamProviderBinding?.teamId ? { teamId: acceptedTeamProviderBinding.teamId,
          resourceId: acceptedTeamProviderBinding.resourceId }
        : fallbackBinding && fallbackTeamId ? { teamId: fallbackTeamId, resourceId: fallbackBinding.resourceId } : null;
      let providerRoute: NonNullable<Parameters<typeof buildSessionReadinessViewModel>[0]['selection']>['providerRoute'] = null;
      if (teamRoute) {
        const currentModel = projectedRouteResource ? findCurrentTeamCredentialProviderModel(projectedRouteResource, teamRoute) : null;
        const requirements = readAccountAgentProviderRequirements(teamRoute.agentTargetKey,
          providerDeclarationContext(selectedMachineId, projection));
        const routeCurrent = acceptedRouteResource !== null || currentModel?.availability === 'available';
        credential = { kind: 'team', ...credentialIdentity!,
          readiness: routeCurrent ? routeResource?.readiness ?? null : null,
          recoveryAction: routeCurrent ? routeResource?.recoveryAction ?? null : null };
        providerRoute = {
          ready: Boolean(requirements && routeCurrent
            && routeResource?.readiness.kind === 'available'),
          suppressedConnectedServiceIds: requirements?.authIsolation.suppressConnectedServiceIds ?? [],
          acceptedConnectedServiceIds,
        };
      } else if (credentialIdentity) {
        credential = { kind: 'team', ...credentialIdentity, readiness: null, recoveryAction: null };
      } else if (relevantTeamBindings.length > 0) {
        credential = { kind: 'unknown' };
      }
      selection = { credentialBindings, teamCredentialResources: resources,
        credentialBindingsReady: resourcesCurrent && (relevantTeamBindings.length === 0 || credentialIdentity !== null),
        ...(providerRoute ? { providerRoute } : {}) };
    }
    const model = buildSessionReadinessViewModel({ configured: true, operation, credential,
      credentialRequiredForConversation: Boolean(teamRoute || acceptedTeamProviderBinding || teamBindings.length > 0), machine: { scope: account.accountLifetime.scope,
      selectedMachineId, machine, requireExactSpawnReadiness: true,
      keyAvailable: inventory?.status === 'ready' ? true : 'unknown', rpcAvailable: inventory?.status === 'ready' ? true : 'unknown' },
      agent, selection,
      inventory: inventory ?? { status: 'idle', lastCheckedAt: null }, invocation,
      mayRepairAgent: machine?.access?.role === 'manage' && machine.access.accessState === 'ready' });
    if (operation === 'credential' && credentialPurpose && selectedMachineId
      && (invocation?.level === 'owner' || credentialTeamSelection && invocation?.capabilities.submitAgentInput === true)
      && model.readiness.machine?.status === 'ready') {
      try {
        const projection = (await loadDaemonMergedProjectionInputs({ machineId: selectedMachineId, serverId: account.serverId,
          accountLifetime: account.accountLifetime, signal, sections: CONNECTED_ACCOUNT_PURPOSE_DECLARATION_SECTIONS }))?.pluginProjectionV2;
        account.assertCurrent();
        const catalog = credentialTeamSelection ? null : await readAdmittedConnectedAccountCatalogInContext(account, 'purposes', signal);
        account.assertCurrent();
        if (!projection || !credentialTeamSelection && (!catalog || catalog.status !== 'ready' || catalog.record.key !== 'purposes')) return { ...result, readiness: model.readiness };
        let profile: ReturnType<typeof AccountProfileSchema.parse> | null = null;
        if (!credentialTeamSelection) {
          const response = await account.request('/v1/account/profile', { method: 'GET', signal }, { retry: 'none' });
          account.assertCurrent();
          if (!response.ok) return { ...result, readiness: model.readiness };
          profile = AccountProfileSchema.parse(await response.json());
          account.assertCurrent();
          if (profile.id !== account.accountId) return { ...result, readiness: model.readiness };
        }
        const team = credentialTeamSelection;
        let resource: TeamCredentialResourceCatalogEntryV1 | null = null;
        if (team) {
          let cursor: string | null = null;
          do {
            const outcome = await listEntitledTeamCredentialResources({ scope: account.accountLifetime.scope,
              address: { serverId: account.serverId, teamId: team.teamId }, cursor, signal });
            account.assertCurrent();
            if (outcome.kind !== 'succeeded') break;
            resource = outcome.value.resources.find(candidate => candidate.id === team.selection.resourceId) ?? null;
            cursor = outcome.value.nextCursor;
          } while (!resource && cursor);
        }
        const descriptors = Object.values(projection.familiesById.connectedAccounts?.entriesById ?? {}).flatMap(entry => {
          const parsed = ConnectedAccountUiProjectionEntryV1Schema.safeParse(entry);
          return parsed.success && parsed.data.availability.state === 'available' ? [parsed.data] : [];
        });
        const credential = readSessionOperationCredentialReadinessV1({ purpose: credentialPurpose, machineId: selectedMachineId,
          executionAccountId: account.accountId, machineAccess: machine?.access ?? null,
          repairAccess: resolveMachineRpcRoutePolicy(CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD).sharedMachineAccess,
          bindings: catalog?.status === 'ready' && catalog.record.key === 'purposes' ? catalog.record.value : { v: 1, bindings: [] },
          ...(credentialTeamSelection ? { teamSelection: credentialTeamSelection } : {}),
          projection, machineProvisionersById: projection.familiesById.machineProvisioners?.entriesById ?? {},
          accounts: profile?.connectedAccountsV4 ?? [], groups: profile?.connectedAccountGroupsV4 ?? [],
          now: Date.now(), teamResource: resource, readAuthentication: service => {
            const matching = descriptors.filter(descriptor => descriptor.pluginId === service.pluginId && descriptor.serviceId === service.localId);
            return matching.length === 1 ? matching[0]!.authentication : null;
          } });
        return { ...result, readiness: composeSessionReadinessV1({ ...model.readiness, credential }) };
      } catch { signal?.throwIfAborted(); account.assertCurrent(); }
    }
    return { ...result, readiness: model.readiness };
  };
}
