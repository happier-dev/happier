import type { ConnectedAccountServiceKey, ConnectedServiceId } from '@happier-dev/protocol';
import { resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey, resolveQualifiedConnectedAccountServiceForIngressServiceId } from '@/plugins/projection/registry/connectedAccountPurposeCompatibility';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { resolveConnectedServiceNativeHomeTargetRoot } from './materialize/resolveConnectedServiceNativeHomeTarget';
import type {
  AgentConnectedAccountSwitchTransitionV1,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { AGENTS } from '@/agent/catalog/registry';
import { readCurrentCatalogHook } from '@/agent/catalog/runtimeEntry';
import { resolveCatalogAgentId } from '@/agent/catalog/resolution';
import type {
  CatalogAgentId,
  AgentCatalogEntry,
  LegacyConnectedServiceRuntimeAuthFailureSourceInput,
  ConnectedServiceStateSharingDescriptor,
  ConnectedServiceSwitchContinuityParams,
  ConnectedServiceSwitchContinuityResult,
  ConnectedServiceMaterializedHomeFreshness,
  ConnectedServiceProviderRuntimeAuthAdapter,
} from '@/agent/catalog/types';
import type { ConnectedServiceMaterializedHomeRootParams } from './materialization/materializedHomeFreshness';
import type {
  VerifyResumeReachableInput,
  VerifyResumeReachableResult,
} from './verifyResumeReachableTypes';
import { REACHABILITY_CHECK_NOT_IMPLEMENTED_REASON } from './verifyResumeReachableTypes';
import { verifyDeclaredResumeReachability } from './stateSharing/verifyDeclaredResumeFileReachability';
import type { ConnectedServiceRuntimeTarget } from './runtimeRegistry/target';
import { sanitizeConnectedServiceRuntimeFailureClassification } from './runtimeAuth/sanitizeConnectedServiceRuntimeFailureClassification';

export async function getConnectedServiceMaterializedHomeFreshness(
  agentId: CatalogAgentId,
): Promise<ConnectedServiceMaterializedHomeFreshness | null> {
  return await readCurrentCatalogHook(agentId, (entry) =>
    entry.getConnectedServiceMaterializedHomeFreshness?.() ?? Promise.resolve(null));
}

/** Resolves layout from the caller's exact catalog, acquiring lazy facts for the selected service. */
export async function resolveConnectedServiceMaterializedHomeRoot(
  agentId: CatalogAgentId,
  params: Omit<ConnectedServiceMaterializedHomeRootParams, 'agentId'>,
  catalogEntry: AgentCatalogEntry | null,
): Promise<string | null> {
  const entry = catalogEntry;
  if (entry?.id !== agentId) return null;
  const service = resolveQualifiedConnectedAccountServiceForIngressServiceId(params.serviceId);
  if (!service || !entry.connectedAccountServiceIds?.includes(buildQualifiedPluginContributionKey(service))) return null;
  let nativeHome = entry.connectedAccountNativeHome;
  if (!nativeHome) {
    const descriptor = await entry.getConnectedServiceStateSharingDescriptor?.();
    if (descriptor?.providerSupportStatus === 'supported') nativeHome = descriptor.nativeHome;
  }
  if (!nativeHome) return null;
  const selection = params.selection;
  return resolveConnectedServiceNativeHomeTargetRoot({
    agentId, activeServerDir: params.activeServerDir, nativeHome,
    target: selection?.kind === 'group' && nativeHome.groupHome !== 'selectedAccount'
      ? { kind: 'group', service, groupId: selection.groupId }
      : { kind: 'account', account: { service, accountId: selection?.kind === 'group'
          ? selection.activeProfileId : selection?.profileId ?? params.profileId } },
  });
}

export function shouldRestartConnectedServiceOnCredentialUpdate(
  agentId: CatalogAgentId,
  serviceId: ConnectedServiceId,
): boolean {
  return AGENTS[agentId]?.shouldRestartConnectedServiceOnCredentialUpdate?.(serviceId) === true;
}

export function listConnectedServiceRetainedMaterializedHomeSanitizers(): ReadonlyArray<(homeRootDir: string) => Promise<void> | void> {
  const sanitizers: Array<(homeRootDir: string) => Promise<void> | void> = [];
  for (const entry of Object.values(AGENTS)) {
    const sanitize = entry?.sanitizeRetainedConnectedServiceMaterializedHome;
    if (sanitize) sanitizers.push(sanitize);
  }
  return sanitizers;
}

export async function getConnectedServiceRuntimeAuthAdapter(
  agentId: CatalogAgentId,
): Promise<ConnectedServiceProviderRuntimeAuthAdapter | null> {
  return await readCurrentCatalogHook(agentId, (entry) =>
    entry.getConnectedServiceRuntimeAuthAdapter?.() ?? Promise.resolve(null));
}

export async function classifyConnectedServiceRuntimeFailureForTarget(input: Readonly<{
  target: ConnectedServiceRuntimeTarget; diagnostic: unknown;
}>) {
  const agentId = resolveCatalogAgentId(input.target.agentId);
  if (!agentId) return null;
  const adapter = await getConnectedServiceRuntimeAuthAdapter(agentId);
  if (!adapter) return null;
  for (const selection of input.target.connectedServiceSelections) {
    const classification = sanitizeConnectedServiceRuntimeFailureClassification(adapter.classifyRuntimeAuthFailure({
      target: { agentId, targetId: input.target.materializationKey }, error: input.diagnostic,
      selection: { ...selection },
    }));
    if (classification?.serviceId === selection.serviceId) return classification;
  }
  return null;
}

export async function getConnectedServiceStateSharingDescriptor(
  agentId: CatalogAgentId,
): Promise<ConnectedServiceStateSharingDescriptor | null> {
  return await readCurrentCatalogHook(agentId, (entry) =>
    entry.getConnectedServiceStateSharingDescriptor?.() ?? Promise.resolve(null));
}

export function resolveLegacyConnectedServiceRuntimeAuthFailureSourceRevisionThroughCatalog(
  agentId: CatalogAgentId,
  input: LegacyConnectedServiceRuntimeAuthFailureSourceInput,
): string | null {
  return AGENTS[agentId]?.resolveLegacyConnectedServiceRuntimeAuthFailureSourceRevision?.(input)
    ?? null;
}

export type ConnectedServiceGenerationApplicationScopeResolution =
  | Readonly<{
      status: 'supported';
      scope: 'per_session_runtime' | 'shared_group_auth_surface' | 'request_time_auth';
      ownerId: string;
    }>
  | Readonly<{ status: 'unsupported' | 'unavailable'; errorCode: string }>;

export async function resolveConnectedServiceGenerationApplicationScope(
  serviceId: ConnectedAccountServiceKey,
  agentId?: CatalogAgentId | null,
): Promise<ConnectedServiceGenerationApplicationScopeResolution> {
  const legacyServiceId =
    resolveFirstPartyLegacyConnectedServiceIdForQualifiedServiceKey(serviceId);
  const declaresService = (candidate: AgentCatalogEntry | null | undefined) =>
    candidate?.connectedAccountServiceIds?.includes(serviceId) === true
    || (legacyServiceId !== null && candidate?.connectedServiceIds?.includes(legacyServiceId) === true);
  let entry: AgentCatalogEntry | null;
  let ownerId: string;
  try {
    if (agentId) {
      entry = await readCurrentCatalogHook(agentId, (current) => current);
      ownerId = String(agentId);
    } else {
      const matches = Object.values(AGENTS).filter(declaresService);
      if (matches.length === 0) {
        return { status: 'unsupported', errorCode: 'generation_application_scope_unsupported' };
      }
      if (matches.length !== 1) {
        return { status: 'unavailable', errorCode: 'generation_application_scope_ambiguous' };
      }
      const owner = matches[0]!;
      ownerId = String(owner.id);
      entry = await readCurrentCatalogHook(
        owner.id as CatalogAgentId,
        (current) => current,
      );
    }
  } catch {
    return { status: 'unavailable', errorCode: 'generation_application_scope_unavailable' };
  }
  if (!entry || !declaresService(entry)) {
    return { status: 'unsupported', errorCode: 'generation_application_scope_unsupported' };
  }
  if (entry.connectedAccountGenerationApplicationScope) {
    return { status: 'supported', scope: entry.connectedAccountGenerationApplicationScope, ownerId };
  }
  if (entry.connectedAccountRequestAuthUses?.length) {
    return {
      status: 'supported',
      scope: 'request_time_auth',
      ownerId,
    };
  }
  if (await entry.getConnectedServiceRuntimeAuthAdapter?.()) {
    return {
      status: 'supported',
      scope: 'per_session_runtime',
      ownerId,
    };
  }
  return { status: 'unsupported', errorCode: 'generation_application_scope_unsupported' };
}

/** Projects the provider's predictive application capability through its current runtime. */
export async function resolveConnectedServicePredictiveSoftSwitchCapability(
  agentId: CatalogAgentId,
  selection: Parameters<ConnectedServiceProviderRuntimeAuthAdapter['materializeActiveProfile']>[0]['selection'],
): Promise<'supported' | 'supported_in_turn' | 'unsupported'> {
  try {
    const adapter = await getConnectedServiceRuntimeAuthAdapter(agentId);
    if (!adapter) return 'unsupported';
    const materialization = await adapter.materializeActiveProfile({ target: { agentId }, selection });
    if (materialization.supported !== true) return 'unsupported';
    if (materialization.supportsInTurnApply === true) return 'supported_in_turn';
    if (selection.serviceId) {
      const application = await resolveConnectedServiceGenerationApplicationScope(selection.serviceId, agentId);
      if (application.status === 'supported' && application.scope === 'request_time_auth') return 'supported';
    }
    return adapter.canHotApply({ target: { agentId }, selection }).supported === true
      ? 'supported'
      : 'unsupported';
  } catch {
    return 'unsupported';
  }
}

export async function resolveConnectedServiceSwitchContinuity(
  agentId: CatalogAgentId,
  params: ConnectedServiceSwitchContinuityParams,
): Promise<ConnectedServiceSwitchContinuityResult> {
  // Team resource authority is revision-bound and must be rematerialized from
  // the canonical V2 selection. It is never projected into the Agent's legacy
  // native/connected hot-apply transition vocabulary.
  if (
    params.previousBinding?.source === 'team_resource'
    || params.nextBinding.source === 'team_resource'
  ) {
    return { mode: 'restart_same_home' };
  }
  const current = await readCurrentCatalogHook(agentId, (entry) => Object.freeze({
    capability: entry.connectedAccountSwitchContinuity ?? null,
    serviceIds: entry.connectedAccountServiceIds ?? Object.freeze([]),
  }));
  const capability = current?.capability ?? null;
  if (!capability || !current?.serviceIds.includes(params.serviceId)) {
    return { mode: 'unsupported', reason: 'provider_unsupported' };
  }
  let transition: AgentConnectedAccountSwitchTransitionV1;
  if (params.previousBinding?.source === 'native' && params.nextBinding.source === 'connected') {
    transition = 'native_to_connected';
  } else if (params.previousBinding?.source === 'connected' && params.nextBinding.source === 'native') {
    transition = 'connected_to_native';
  } else if (
    params.previousBinding?.source === 'connected'
    && params.nextBinding.source === 'connected'
    && params.previousBinding.groupId !== null
    && params.previousBinding.groupId === params.nextBinding.groupId
  ) {
    transition = 'same_connected_group';
  } else {
    transition = 'connected_to_connected';
  }
  if (capability.supportedTransitions?.includes(transition) === true) {
    return { mode: capability.continuityMode };
  }
  const sharing = capability.providerStateSharingRequired;
  if (
    sharing?.supportedTransitions.includes(transition) === true
    && (sharing.serviceIds === undefined || sharing.serviceIds.includes(params.serviceId))
  ) {
    return { mode: 'restart_shared_state_required' };
  }
  return { mode: 'unsupported', reason: 'transition_unsupported' };
}

export async function verifyResumeReachableThroughCatalog(
  agentId: CatalogAgentId | null | undefined,
  input: VerifyResumeReachableInput,
): Promise<VerifyResumeReachableResult | null> {
  const catalogId = resolveCatalogAgentId(agentId);
  if (!catalogId) return null;
  return await readCurrentCatalogHook(catalogId, async (entry) => {
    const verifyResumeReachable = entry.verifyResumeReachable;
    if (!verifyResumeReachable) return null;
    const stateSharingDescriptor = await entry.getConnectedServiceStateSharingDescriptor?.();
    if (!stateSharingDescriptor && !input.nativeInspection) {
      return { ok: false, reason: REACHABILITY_CHECK_NOT_IMPLEMENTED_REASON };
    }
    const verify = (nativeInspection?: Parameters<typeof verifyDeclaredResumeReachability>[0]['nativeInspection']) => verifyDeclaredResumeReachability({
      targetMaterializedRoot: input.targetMaterializedRoot,
      candidatePersistedSessionFile: input.candidatePersistedSessionFile,
      stateSharingDescriptor: stateSharingDescriptor ?? undefined,
      vendorResumeId: input.vendorResumeId,
      ...(input.runtimeDescriptorV1 ? { runtimeDescriptorV1: input.runtimeDescriptorV1 } : {}),
      verifyResumeReachable,
      ...(nativeInspection ? { nativeInspection } : {}),
    });
    const adapter = input.nativeInspection ? await entry.getPreflightSessionControlsProbeAdapter?.() : undefined;
    if (!input.nativeInspection || !adapter?.withNativeInspection) return await verify();
    try {
      return await adapter.withNativeInspection({ cwd: input.nativeInspection.cwd,
        env: input.nativeInspection.environment, signal: input.nativeInspection.signal,
        ...(input.runtimeDescriptorV1 ? { runtimeDescriptorV1: input.runtimeDescriptorV1 } : {}),
      }, verify);
    } catch {
      return { ok: false, reason: 'resume_reachability_check_failed' };
    }
  });
}
