import type { AgentId } from '@happier-dev/agents';
import type { ConnectedServiceId } from '@happier-dev/protocol';

import { AGENTS } from '@/agent/catalog/registry';
import { resolveCatalogAgentId } from '@/agent/catalog/resolution';
import type {
  CatalogAgentId,
  ConnectedServiceRecoveryCapabilities,
  ConnectedServiceRuntimeAuthApplyCapability,
  LegacyConnectedServiceRuntimeAuthFailureSourceInput,
  ConnectedServiceRuntimeAuthSelectionMaterializerParams,
  ConnectedServiceStateSharingDescriptor,
  ConnectedServiceSwitchContinuityParams,
  ConnectedServiceSwitchContinuityResult,
  ConnectedServiceMaterializedHomeFreshness,
  ConnectedServicesMaterializer,
  ConnectedServiceProviderRuntimeAuthAdapter,
} from '@/agent/catalog/types';
import type { ConnectedServiceMaterializedHomeRootParams } from './materialization/materializedHomeFreshness';
import type {
  VerifyResumeReachableInput,
  VerifyResumeReachableResult,
} from './verifyResumeReachableTypes';
import { getOrLoadConnectedServiceCatalogHook } from './catalogHookCache';
import { projectAgentVisibleSessionMetadata } from '@/agent/runtime/sessionMetadataVisibility';

const cachedConnectedServicesMaterializerPromises = new Map<CatalogAgentId, Promise<ConnectedServicesMaterializer | null>>();
const cachedConnectedServiceMaterializedHomeFreshnessPromises = new Map<CatalogAgentId, Promise<ConnectedServiceMaterializedHomeFreshness | null>>();
const cachedConnectedServiceRuntimeAuthAdapterPromises = new Map<CatalogAgentId, Promise<ConnectedServiceProviderRuntimeAuthAdapter | null>>();
const cachedConnectedServiceStateSharingDescriptorPromises = new Map<CatalogAgentId, Promise<ConnectedServiceStateSharingDescriptor | null>>();
const cachedConnectedServiceRecoveryCapabilitiesPromises = new Map<CatalogAgentId, Promise<ConnectedServiceRecoveryCapabilities | null>>();

export async function getConnectedServicesMaterializer(agentId: CatalogAgentId): Promise<ConnectedServicesMaterializer | null> {
  return await getOrLoadConnectedServiceCatalogHook(
    cachedConnectedServicesMaterializerPromises,
    agentId,
    () => AGENTS[agentId]?.getConnectedServicesMaterializer?.() ?? Promise.resolve(null),
  );
}

export async function getConnectedServiceMaterializedHomeFreshness(
  agentId: CatalogAgentId,
): Promise<ConnectedServiceMaterializedHomeFreshness | null> {
  return await getOrLoadConnectedServiceCatalogHook(
    cachedConnectedServiceMaterializedHomeFreshnessPromises,
    agentId,
    () => AGENTS[agentId]?.getConnectedServiceMaterializedHomeFreshness?.() ?? Promise.resolve(null),
  );
}

export function resolveConnectedServiceMaterializedHomeRoot(
  agentId: CatalogAgentId,
  params: Omit<ConnectedServiceMaterializedHomeRootParams, 'agentId'>,
): string | null {
  return AGENTS[agentId]?.resolveConnectedServiceMaterializedHomeRoot?.({
    ...params,
    agentId,
  }) ?? null;
}

export function listConnectedServiceNoRestartRequiredServiceIdsByAgentId(): ReadonlyMap<CatalogAgentId, ReadonlySet<ConnectedServiceId>> {
  const out = new Map<CatalogAgentId, ReadonlySet<ConnectedServiceId>>();
  for (const entry of Object.values(AGENTS)) {
    if (!entry?.connectedServiceNoRestartRequiredServiceIds?.length) continue;
    out.set(entry.id as CatalogAgentId, new Set(entry.connectedServiceNoRestartRequiredServiceIds));
  }
  return out;
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
  return await getOrLoadConnectedServiceCatalogHook(
    cachedConnectedServiceRuntimeAuthAdapterPromises,
    agentId,
    () => AGENTS[agentId]?.getConnectedServiceRuntimeAuthAdapter?.() ?? Promise.resolve(null),
  );
}

export async function materializeConnectedServiceRuntimeAuthSelectionThroughCatalog(
  agentId: AgentId | null | undefined,
  params: ConnectedServiceRuntimeAuthSelectionMaterializerParams,
): Promise<unknown | null> {
  const catalogId = resolveCatalogAgentId(agentId);
  const entry = AGENTS[catalogId];
  if (!entry?.materializeConnectedServiceRuntimeAuthSelection) return null;
  return await entry.materializeConnectedServiceRuntimeAuthSelection(params);
}

export async function getConnectedServiceStateSharingDescriptor(
  agentId: CatalogAgentId,
): Promise<ConnectedServiceStateSharingDescriptor | null> {
  return await getOrLoadConnectedServiceCatalogHook(
    cachedConnectedServiceStateSharingDescriptorPromises,
    agentId,
    () => AGENTS[agentId]?.getConnectedServiceStateSharingDescriptor?.() ?? Promise.resolve(null),
  );
}

export async function getConnectedServiceRecoveryCapabilities(
  agentId: CatalogAgentId,
): Promise<ConnectedServiceRecoveryCapabilities | null> {
  return await getOrLoadConnectedServiceCatalogHook(
    cachedConnectedServiceRecoveryCapabilitiesPromises,
    agentId,
    () => AGENTS[agentId]?.getConnectedServiceRecoveryCapabilities?.() ?? Promise.resolve(null),
  );
}

export async function resolveConnectedServiceRuntimeAuthApplyCapability(
  loadRecoveryCapabilities: () => Promise<ConnectedServiceRecoveryCapabilities | null>,
): Promise<ConnectedServiceRuntimeAuthApplyCapability> {
  const capabilities = await loadRecoveryCapabilities();
  return capabilities?.runtimeAuthApply ?? { directLiveHotAuth: 'unsupported' };
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
  serviceId: ConnectedServiceId,
  agentId?: CatalogAgentId | null,
): Promise<ConnectedServiceGenerationApplicationScopeResolution> {
  const matches = agentId
    ? [AGENTS[agentId]].filter((entry) => entry?.connectedServiceIds?.includes(serviceId))
    : Object.values(AGENTS).filter((entry) => entry?.connectedServiceIds?.includes(serviceId));
  if (matches.length === 0) {
    return { status: 'unsupported', errorCode: 'generation_application_scope_unsupported' };
  }
  if (matches.length !== 1) {
    return { status: 'unavailable', errorCode: 'generation_application_scope_ambiguous' };
  }
  const owner = matches[0]!;
  let capabilities: ConnectedServiceRecoveryCapabilities | null;
  try {
    capabilities = await getConnectedServiceRecoveryCapabilities(owner.id as CatalogAgentId);
  } catch {
    return { status: 'unavailable', errorCode: 'generation_application_scope_unavailable' };
  }
  const scope = capabilities?.generationApplicationScope;
  if (!capabilities || !scope || scope === 'unsupported') {
    return { status: 'unsupported', errorCode: 'generation_application_scope_unsupported' };
  }
  if (scope === 'shared_group_auth_surface') {
    if (capabilities.sharedGenerationApplicationServiceIds?.includes(serviceId) !== true) {
      return { status: 'unsupported', errorCode: 'generation_application_scope_service_unsupported' };
    }
    return { status: 'supported', scope, ownerId: String(owner.id) };
  }
  return { status: 'supported', scope, ownerId: String(owner.id) };
}

export async function resolveConnectedServiceSwitchContinuity(
  agentId: CatalogAgentId,
  params: ConnectedServiceSwitchContinuityParams,
): Promise<ConnectedServiceSwitchContinuityResult> {
  const entry = AGENTS[agentId];
  if (!entry?.resolveConnectedServiceSwitchContinuity) {
    return { mode: 'unsupported', reason: 'provider_unsupported' };
  }
  return await entry.resolveConnectedServiceSwitchContinuity(params);
}

export async function verifyResumeReachableThroughCatalog(
  agentId: AgentId | null | undefined,
  input: VerifyResumeReachableInput,
): Promise<VerifyResumeReachableResult | null> {
  const catalogId = resolveCatalogAgentId(agentId);
  const entry = AGENTS[catalogId];
  if (!entry?.verifyResumeReachable) return null;
  return await entry.verifyResumeReachable(input);
}

export function resolveConnectedServiceCandidatePersistedSessionFile(
  agentId: AgentId | null | undefined,
  metadata: unknown,
): string | null {
  const catalogId = resolveCatalogAgentId(agentId);
  const entry = AGENTS[catalogId];
  return entry?.resolveConnectedServiceCandidatePersistedSessionFile?.({
    metadata:
      metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? projectAgentVisibleSessionMetadata(
            metadata as Readonly<Record<string, unknown>>,
          )
        : metadata,
  }) ?? null;
}
