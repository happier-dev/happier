import type { AgentId } from '../agent/core';
import { isRuntimeCheckedExperimentalVendorResume } from '@happier-dev/agents';
import type { ExternalSessionsProviderId } from '@happier-dev/protocol';
import type { BackendTargetRefV2 } from '@happier-dev/protocol';
import {
  resolveBackendEngineAdapterResolution as resolveBackendEngineAdapterResolutionFromRegistry,
  type EngineAdapterResolution,
  type EngineResolutionDiagnostic,
  type EngineResolutionDiagnosticCode,
  type EngineResolutionSelectedSource,
} from '../agent/runtime/registry/engineRegistry';
import { getResolvedContributionRegistry } from '../plugins/projection/registry/createResolvedContributionRegistry';
import { readBuiltInHostCatalogEntries } from './builtInHostCatalogEntries';
import { CATALOG_AGENT_IDS, DEFAULT_CATALOG_AGENT_ID } from './types';
import type {
  AgentCatalogEntry,
  CatalogAgentId,
  CatalogAgentLookupId,
  ConnectedServiceRuntimeAuthSelectionMaterializerParams,
  ConnectedServiceProviderRuntimeAuthAdapter,
  ConnectedServiceRecoveryCapabilities,
  ConnectedServiceStateSharingDescriptor,
  ConnectedServiceSwitchContinuityParams,
  ConnectedServiceSwitchContinuityResult,
  ConnectedServicesMaterializer,
  ExternalSessionProviderOps,
  ManagedServerClaimDescriptor,
  ManagedServerShutdownCleanup,
  ProviderCliLaunchSpec,
  ProviderSessionRuntimePreferences,
  ProviderSessionRuntimePreferencesParams,
  ProviderAttachOps,
  ProviderRuntimeLocalHandoffMetadataBuilder,
  SessionHandoffProviderBundleRecordExtractor,
  SessionCatalogControlAdapter,
  SessionGoalControlAdapter,
  SessionUsageLimitRecoveryControlAdapter,
  AnyTerminalRuntimeOps,
  VendorResumeSupportFn,
} from './types';
import type { ForkSurfaceV1, HandoffSurfaceV1 } from '@happier-dev/agents';
import type {
  VerifyResumeReachableInput,
  VerifyResumeReachableResult,
} from '@/backends/connectedServices/verifyResumeReachableTypes';

export type { AgentCatalogEntry, AgentChecklistContributions, CatalogAgentId, CliDetectSpec } from './types';
export type { CatalogAgentLookupId } from './types';
export type {
  EngineAdapterResolution,
  EngineResolutionDiagnostic,
  EngineResolutionDiagnosticCode,
  EngineResolutionSelectedSource,
};

function readCatalogEntriesSnapshot(): Record<string, AgentCatalogEntry> {
  const hostEntries = readBuiltInHostCatalogEntries() as Readonly<Record<string, AgentCatalogEntry>>;
  const projectedEntries = getResolvedContributionRegistry().catalogEntriesById as Record<string, AgentCatalogEntry>;
  const mergedEntries: Record<string, AgentCatalogEntry> = { ...hostEntries };
  for (const [id, projectedEntry] of Object.entries(projectedEntries)) {
    mergedEntries[id] = Object.freeze({
      ...(hostEntries[id] ?? {}),
      ...projectedEntry,
    }) as AgentCatalogEntry;
  }
  return mergedEntries;
}

const AGENT_PROXY_TARGET: Record<string, AgentCatalogEntry> = Object.create(null);

export const AGENTS: Record<string, AgentCatalogEntry> = new Proxy(AGENT_PROXY_TARGET, {
  get(_target, property) {
    if (typeof property !== 'string') {
      return Reflect.get(_target, property);
    }
    return readCatalogEntriesSnapshot()[property];
  },
  has(_target, property) {
    if (typeof property !== 'string') {
      return Reflect.has(_target, property);
    }
    return Object.prototype.hasOwnProperty.call(readCatalogEntriesSnapshot(), property);
  },
  ownKeys() {
    return Reflect.ownKeys(readCatalogEntriesSnapshot());
  },
  getOwnPropertyDescriptor(_target, property) {
    if (typeof property !== 'string') {
      return Reflect.getOwnPropertyDescriptor(_target, property);
    }
    const value = readCatalogEntriesSnapshot()[property];
    if (!value) {
      return undefined;
    }
    return {
      configurable: true,
      enumerable: true,
      writable: false,
      value,
    };
  },
});

function isCatalogAgentId(value: string): value is CatalogAgentId {
  return (CATALOG_AGENT_IDS as readonly string[]).includes(value);
}

export function requireCatalogEntry(agentId: CatalogAgentLookupId): AgentCatalogEntry {
  const entry = AGENTS[agentId];
  if (!entry) throw new Error(`Missing catalog agent entry for ${agentId}`);
  return entry;
}

const cachedVendorResumeSupportPromises = new Map<CatalogAgentId, Promise<VendorResumeSupportFn>>();
const cachedExternalSessionProviderOpsPromises = new Map<ExternalSessionsProviderId, Promise<ExternalSessionProviderOps>>();
const cachedConnectedServicesMaterializerPromises = new Map<CatalogAgentId, Promise<ConnectedServicesMaterializer | null>>();
const cachedConnectedServiceRuntimeAuthAdapterPromises = new Map<CatalogAgentId, Promise<ConnectedServiceProviderRuntimeAuthAdapter | null>>();
const cachedConnectedServiceStateSharingDescriptorPromises = new Map<CatalogAgentId, Promise<ConnectedServiceStateSharingDescriptor | null>>();
const cachedConnectedServiceRecoveryCapabilitiesPromises = new Map<CatalogAgentId, Promise<ConnectedServiceRecoveryCapabilities | null>>();
const cachedManagedServerLaunchSpecPromises = new Map<CatalogAgentId, Promise<ProviderCliLaunchSpec | null>>();
const cachedManagedServerShutdownCleanupPromises = new Map<CatalogAgentId, Promise<ManagedServerShutdownCleanup | null>>();
const cachedProviderAttachOpsPromises = new Map<CatalogAgentId, Promise<ProviderAttachOps | null>>();
const cachedTerminalRuntimeOpsPromises = new Map<CatalogAgentId, Promise<AnyTerminalRuntimeOps | null>>();
const cachedForkSurfacePromises = new Map<CatalogAgentId, Promise<ForkSurfaceV1 | null>>();
const cachedSessionGoalControlAdapterPromises = new Map<CatalogAgentId, Promise<SessionGoalControlAdapter | null>>();
const cachedSessionCatalogControlAdapterPromises = new Map<CatalogAgentId, Promise<SessionCatalogControlAdapter | null>>();
const cachedSessionUsageLimitRecoveryControlAdapterPromises = new Map<CatalogAgentId, Promise<SessionUsageLimitRecoveryControlAdapter | null>>();
const cachedHandoffSurfacePromises = new Map<CatalogAgentId, Promise<HandoffSurfaceV1 | null>>();
const cachedSessionHandoffProviderBundleRecordExtractorPromises = new Map<
  CatalogAgentId,
  Promise<SessionHandoffProviderBundleRecordExtractor | null>
>();

function isExternalSessionProviderOps(value: unknown): value is ExternalSessionProviderOps {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<Record<keyof ExternalSessionProviderOps, unknown>>;
  return typeof candidate.validateSource === 'function'
    && typeof candidate.listCandidates === 'function'
    && typeof candidate.getActivity === 'function'
    && typeof candidate.pageTranscript === 'function'
    && typeof candidate.readAfterTranscript === 'function'
    && typeof candidate.resolveTakeoverSpawnOptions === 'function';
}

export async function getVendorResumeSupport(agentId?: AgentId | null): Promise<VendorResumeSupportFn> {
  const catalogId = resolveCatalogAgentId(agentId);
  const existing = cachedVendorResumeSupportPromises.get(catalogId);
  if (existing) return await existing;

  const entry = requireCatalogEntry(catalogId);
  const promise = (async () => {
    if (entry.vendorResumeSupport === 'supported') {
      return () => true;
    }
    if (entry.vendorResumeSupport === 'unsupported') {
      return () => false;
    }
    if (entry.getVendorResumeSupport) {
      return await entry.getVendorResumeSupport();
    }
    if (isRuntimeCheckedExperimentalVendorResume(catalogId)) {
      return () => true;
    }
    return () => false;
  })();

  cachedVendorResumeSupportPromises.set(catalogId, promise);
  return await promise;
}

export async function getExternalSessionProviderOps(providerId: ExternalSessionsProviderId): Promise<ExternalSessionProviderOps> {
  const existing = cachedExternalSessionProviderOpsPromises.get(providerId);
  if (existing) return await existing;

  const entry = AGENTS[providerId];
  const promise = (async () => {
    const resolution = await resolveBackendEngineAdapterResolutionFromRegistry(providerId);
    if (isExternalSessionProviderOps(resolution?.executionSurfaces.externalSession)) {
      return resolution.executionSurfaces.externalSession;
    }
    if (!entry?.getExternalSessionProviderOps) {
      throw new Error(`Missing direct-session provider ops for ${providerId}`);
    }
    return await entry.getExternalSessionProviderOps();
  })();
  cachedExternalSessionProviderOpsPromises.set(providerId, promise);
  return await promise;
}

export async function getConnectedServicesMaterializer(agentId: CatalogAgentId): Promise<ConnectedServicesMaterializer | null> {
  const existing = cachedConnectedServicesMaterializerPromises.get(agentId);
  if (existing) return await existing;

  const entry = AGENTS[agentId];
  const promise = entry?.getConnectedServicesMaterializer
    ? entry.getConnectedServicesMaterializer()
    : Promise.resolve(null);
  cachedConnectedServicesMaterializerPromises.set(agentId, promise);
  return await promise;
}

export async function getConnectedServiceRuntimeAuthAdapter(
  agentId: CatalogAgentId,
): Promise<ConnectedServiceProviderRuntimeAuthAdapter | null> {
  const existing = cachedConnectedServiceRuntimeAuthAdapterPromises.get(agentId);
  if (existing) return await existing;

  const entry = AGENTS[agentId];
  const promise = entry?.getConnectedServiceRuntimeAuthAdapter
    ? entry.getConnectedServiceRuntimeAuthAdapter()
    : Promise.resolve(null);
  cachedConnectedServiceRuntimeAuthAdapterPromises.set(agentId, promise);
  return await promise;
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
  const existing = cachedConnectedServiceStateSharingDescriptorPromises.get(agentId);
  if (existing) return await existing;

  const entry = AGENTS[agentId];
  const promise = entry?.getConnectedServiceStateSharingDescriptor
    ? entry.getConnectedServiceStateSharingDescriptor()
    : Promise.resolve(null);
  cachedConnectedServiceStateSharingDescriptorPromises.set(agentId, promise);
  return await promise;
}

export async function getConnectedServiceRecoveryCapabilities(
  agentId: CatalogAgentId,
): Promise<ConnectedServiceRecoveryCapabilities | null> {
  const existing = cachedConnectedServiceRecoveryCapabilitiesPromises.get(agentId);
  if (existing) return await existing;

  const entry = AGENTS[agentId];
  const promise = entry?.getConnectedServiceRecoveryCapabilities
    ? entry.getConnectedServiceRecoveryCapabilities()
    : Promise.resolve(null);
  cachedConnectedServiceRecoveryCapabilitiesPromises.set(agentId, promise);
  return await promise;
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
  return entry?.resolveConnectedServiceCandidatePersistedSessionFile?.({ metadata }) ?? null;
}

export async function resolveProviderSessionRuntimePreferences(
  agentId: AgentId | null | undefined,
  params: ProviderSessionRuntimePreferencesParams,
): Promise<ProviderSessionRuntimePreferences> {
  const catalogId = resolveCatalogAgentId(agentId);
  const entry = AGENTS[catalogId];
  return await (entry?.resolveSessionRuntimePreferences?.(params) ?? Promise.resolve({}));
}

export async function getManagedServerLaunchSpec(agentId: CatalogAgentId): Promise<ProviderCliLaunchSpec | null> {
  const existing = cachedManagedServerLaunchSpecPromises.get(agentId);
  if (existing) return await existing;

  const entry = AGENTS[agentId];
  const promise = entry?.getManagedServerLaunchSpec ? entry.getManagedServerLaunchSpec() : Promise.resolve(null);
  cachedManagedServerLaunchSpecPromises.set(agentId, promise);
  return await promise;
}

export async function getManagedServerShutdownCleanup(
  agentId: CatalogAgentId,
): Promise<ManagedServerShutdownCleanup | null> {
  const existing = cachedManagedServerShutdownCleanupPromises.get(agentId);
  if (existing) return await existing;

  const entry = AGENTS[agentId];
  const promise = entry?.getManagedServerShutdownCleanup
    ? entry.getManagedServerShutdownCleanup()
    : Promise.resolve(null);
  cachedManagedServerShutdownCleanupPromises.set(agentId, promise);
  return await promise;
}

export async function listManagedServerClaimDescriptors(): Promise<readonly ManagedServerClaimDescriptor[]> {
  const entries = readCatalogEntriesSnapshot();
  const descriptors = await Promise.all(Object.values(entries).map(async (entry) => (
    entry.getManagedServerClaimDescriptor ? await entry.getManagedServerClaimDescriptor() : null
  )));
  return Object.freeze(descriptors.filter((descriptor): descriptor is ManagedServerClaimDescriptor => Boolean(descriptor)));
}

export async function getProviderAttachOps(agentId?: AgentId | null): Promise<ProviderAttachOps | null> {
  const catalogId = resolveCatalogAgentId(agentId);
  const existing = cachedProviderAttachOpsPromises.get(catalogId);
  if (existing) return await existing;

  const entry = AGENTS[catalogId];
  const promise = entry?.getProviderAttachOps ? entry.getProviderAttachOps() : Promise.resolve(null);
  cachedProviderAttachOpsPromises.set(catalogId, promise);
  return await promise;
}

export async function getTerminalRuntimeOps(agentId?: AgentId | null): Promise<AnyTerminalRuntimeOps | null> {
  const catalogId = resolveCatalogAgentId(agentId);
  const existing = cachedTerminalRuntimeOpsPromises.get(catalogId);
  if (existing) return await existing;

  const entry = AGENTS[catalogId];
  const promise = entry?.getTerminalRuntimeOps ? entry.getTerminalRuntimeOps() : Promise.resolve(null);
  cachedTerminalRuntimeOpsPromises.set(catalogId, promise);
  return await promise;
}

export async function getSessionGoalControlAdapter(agentId?: AgentId | null): Promise<SessionGoalControlAdapter | null> {
  const catalogId = resolveCatalogAgentId(agentId);
  const existing = cachedSessionGoalControlAdapterPromises.get(catalogId);
  if (existing) return await existing;

  const entry = AGENTS[catalogId];
  const promise = entry?.getSessionGoalControlAdapter ? entry.getSessionGoalControlAdapter() : Promise.resolve(null);
  cachedSessionGoalControlAdapterPromises.set(catalogId, promise);
  return await promise;
}

export async function getSessionCatalogControlAdapter(agentId?: AgentId | null): Promise<SessionCatalogControlAdapter | null> {
  const catalogId = resolveCatalogAgentId(agentId);
  const existing = cachedSessionCatalogControlAdapterPromises.get(catalogId);
  if (existing) return await existing;

  const entry = AGENTS[catalogId];
  const promise = entry?.getSessionCatalogControlAdapter ? entry.getSessionCatalogControlAdapter() : Promise.resolve(null);
  cachedSessionCatalogControlAdapterPromises.set(catalogId, promise);
  return await promise;
}

export async function getSessionUsageLimitRecoveryControlAdapter(agentId?: AgentId | null): Promise<SessionUsageLimitRecoveryControlAdapter | null> {
  const catalogId = resolveCatalogAgentId(agentId);
  const existing = cachedSessionUsageLimitRecoveryControlAdapterPromises.get(catalogId);
  if (existing) return await existing;

  const entry = AGENTS[catalogId];
  const promise = entry?.getSessionUsageLimitRecoveryControlAdapter
    ? entry.getSessionUsageLimitRecoveryControlAdapter()
    : Promise.resolve(null);
  cachedSessionUsageLimitRecoveryControlAdapterPromises.set(catalogId, promise);
  return await promise;
}

export async function getForkSurface(agentId: CatalogAgentId): Promise<ForkSurfaceV1 | null> {
  const existing = cachedForkSurfacePromises.get(agentId);
  if (existing) return await existing;

  const entry = AGENTS[agentId];
  const promise = (async () => {
    const resolution = await resolveBackendEngineAdapterResolutionFromRegistry(agentId);
    if (resolution?.executionSurfaces.fork) {
      return resolution.executionSurfaces.fork;
    }
    return entry?.getForkSurface ? await entry.getForkSurface() : null;
  })();
  cachedForkSurfacePromises.set(agentId, promise);
  return await promise;
}

export async function getHandoffSurface(agentId?: AgentId | null): Promise<HandoffSurfaceV1 | null> {
  const catalogId = resolveCatalogAgentId(agentId);
  const existing = cachedHandoffSurfacePromises.get(catalogId);
  if (existing) return await existing;

  const entry = AGENTS[catalogId];
  const promise = (async () => {
    const resolution = await resolveBackendEngineAdapterResolutionFromRegistry(catalogId);
    if (resolution?.executionSurfaces.handoff) {
      return resolution.executionSurfaces.handoff;
    }
    return entry?.getHandoffSurface ? await entry.getHandoffSurface() : null;
  })();
  cachedHandoffSurfacePromises.set(catalogId, promise);
  return await promise;
}

export async function getSessionHandoffProviderBundleRecordExtractor(
  agentId?: AgentId | null,
): Promise<SessionHandoffProviderBundleRecordExtractor | null> {
  const catalogId = resolveCatalogAgentId(agentId);
  const existing = cachedSessionHandoffProviderBundleRecordExtractorPromises.get(catalogId);
  if (existing) return await existing;

  const entry = AGENTS[catalogId];
  const promise = entry?.getSessionHandoffProviderBundleRecordExtractor
    ? entry.getSessionHandoffProviderBundleRecordExtractor()
    : Promise.resolve(null);
  cachedSessionHandoffProviderBundleRecordExtractorPromises.set(catalogId, promise);
  return await promise;
}

export function buildRuntimeLocalHandoffMetadataForAgent(
  agentId: AgentId | null | undefined,
  params: Parameters<ProviderRuntimeLocalHandoffMetadataBuilder>[0],
): ReturnType<ProviderRuntimeLocalHandoffMetadataBuilder> | null {
  const catalogId = resolveCatalogAgentId(agentId);
  const entry = AGENTS[catalogId];
  return entry?.buildRuntimeLocalHandoffMetadata?.(params) ?? null;
}

export async function resolveBackendEngineAdapterResolution(
  backendId?: string | null,
  params?: Readonly<{ happyHomeDir?: string }>,
): Promise<EngineAdapterResolution | null> {
  return await resolveBackendEngineAdapterResolutionFromRegistry(backendId, params);
}

export function normalizeSessionControlPermissionModeForBackendTarget(params: Readonly<{
  backendTarget?: BackendTargetRefV2;
  permissionMode: string;
}>): string {
  const builtInAgentId = params.backendTarget?.sourceKind === 'built_in'
    ? params.backendTarget.backendId
    : null;
  if (!builtInAgentId || !isCatalogAgentId(builtInAgentId)) {
    return params.permissionMode;
  }

  const entry = AGENTS[builtInAgentId];
  if (!entry?.normalizeSessionControlPermissionMode) {
    return params.permissionMode;
  }
  return entry.normalizeSessionControlPermissionMode(params.permissionMode);
}

export function resolveCatalogAgentId(agentId?: AgentId | null): CatalogAgentId {
  const raw = agentId ?? DEFAULT_CATALOG_AGENT_ID;
  const base = raw.split('-')[0];
  if (isCatalogAgentId(base)) {
    return base;
  }
  return DEFAULT_CATALOG_AGENT_ID;
}

export function resolveAgentCliSubcommand(agentId?: AgentId | null): CatalogAgentLookupId {
  const catalogId = resolveCatalogAgentId(agentId);
  return requireCatalogEntry(catalogId).cliSubcommand;
}

export function resolveCatalogAgentIdForCliSubcommand(subcommand: string): CatalogAgentLookupId | null {
  for (const [agentId, entry] of Object.entries(AGENTS)) {
    if (entry.cliSubcommand === subcommand) {
      return agentId as CatalogAgentLookupId;
    }
  }
  return null;
}
