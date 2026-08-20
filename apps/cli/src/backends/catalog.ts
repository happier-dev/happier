import type { AgentId } from '@/agent/core';
import { AGENTS_CORE } from '@happier-dev/agents';
import {
  type ConnectedServiceId,
  type DirectSessionsProviderId,
} from '@happier-dev/protocol';
import { BUILT_IN_CATALOG_DEFINED_ACP_AGENTS } from '@/agent/acp/catalog';
import { agent as auggie } from '@/backends/auggie';
import { agent as claude } from '@/backends/claude';
import { agent as codex } from '@/backends/codex';
import { agent as copilot } from '@/backends/copilot';
import { agent as cursor } from '@/backends/cursor';
import { agent as gemini } from '@/backends/gemini';
import { agent as grok } from '@/backends/grok';
import { agent as kimi } from '@/backends/kimi';
import { agent as kilo } from '@/backends/kilo';
import { agent as opencode } from '@/backends/opencode';
import { agent as pi } from '@/backends/pi';
import { agent as qwen } from '@/backends/qwen';
import { DEFAULT_CATALOG_AGENT_ID } from './types';
import type {
  AcpForkContinuationHandler,
  AgentCatalogEntry,
  CatalogAgentId,
  ConnectedServiceStateSharingDescriptor,
  ConnectedServiceSwitchContinuityParams,
  ConnectedServiceSwitchContinuityResult,
  DirectSessionProviderOps,
  ProviderAttachOps,
  ProviderNativeForkHandler,
  SessionCatalogControlAdapter,
  SessionGoalControlAdapter,
  SessionUsageLimitRecoveryControlAdapter,
  VendorResumeSupportFn,
} from './types';
import type {
  VerifyResumeReachableInput,
  VerifyResumeReachableResult,
} from '@/backends/connectedServices/verifyResumeReachableTypes';
import type { ConnectedServiceProviderRuntimeAuthAdapter } from '@/daemon/connectedServices/runtimeAuth/types';
import type { ConnectedServiceQuotaFetcherDescriptor } from '@/daemon/connectedServices/quotas/types';
import type {
  ConnectedServiceRuntimeAuthSelectionMaterializerParams,
} from '@/daemon/connectedServices/sessionAuthSwitch/runtimeAuthSelectionMaterializerTypes';
import type { ConnectedServicesProviderMaterializer } from '@/daemon/connectedServices/materialize/providerMaterializerTypes';
import {
  buildDefaultConnectedServiceCredentialLifecycleDescriptor,
  type ConnectedServiceCredentialLifecycleDescriptor,
} from '@/daemon/connectedServices/credentials/lifecycleTypes';
import type {
  ProviderTerminalAttachmentControlProbe,
  ProviderTerminalAttachmentRetirementHook,
} from './types';

export type { AgentCatalogEntry, AgentChecklistContributions, CatalogAgentId, CliDetectSpec } from './types';

export const AGENTS: Partial<Record<CatalogAgentId, AgentCatalogEntry>> = {
  claude,
  codex,
  gemini,
  opencode,
  auggie,
  qwen,
  kimi,
  kilo,
  grok,
  ...BUILT_IN_CATALOG_DEFINED_ACP_AGENTS,
  pi,
  copilot,
  cursor,
};

export function requireCatalogEntry(agentId: CatalogAgentId): AgentCatalogEntry {
  const entry = AGENTS[agentId];
  if (!entry) throw new Error(`Missing catalog agent entry for ${agentId}`);
  return entry;
}

export function getConnectedServiceQuotaFetcherDescriptors(): ReadonlyArray<ConnectedServiceQuotaFetcherDescriptor> {
  return Object.values(AGENTS)
    .map((entry) => entry?.connectedServiceQuotaFetcherDescriptor)
    .filter((descriptor): descriptor is ConnectedServiceQuotaFetcherDescriptor => descriptor !== undefined);
}

export const notifyTerminalAttachmentRetiredThroughCatalog: ProviderTerminalAttachmentRetirementHook = async (params) => {
  const hooks = Object.values(AGENTS)
    .map((entry) => entry?.onTerminalAttachmentRetired)
    .filter((hook): hook is ProviderTerminalAttachmentRetirementHook => hook !== undefined);
  await Promise.all(hooks.map(async (hook) => await hook(params)));
};

export async function hasTerminalAttachmentControlDescriptorThroughCatalog(
  agentId: AgentId | null | undefined,
  params: Parameters<ProviderTerminalAttachmentControlProbe>[0],
): Promise<boolean> {
  const entry = AGENTS[resolveCatalogAgentId(agentId)];
  return await entry?.hasTerminalAttachmentControlDescriptor?.(params) ?? false;
}

const cachedVendorResumeSupportPromises = new Map<CatalogAgentId, Promise<VendorResumeSupportFn>>();
const cachedDirectSessionProviderOpsPromises = new Map<DirectSessionsProviderId, Promise<DirectSessionProviderOps>>();
const cachedProviderAttachOpsPromises = new Map<CatalogAgentId, Promise<ProviderAttachOps | null>>();
const cachedConnectedServiceMaterializerPromises = new Map<CatalogAgentId, Promise<ConnectedServicesProviderMaterializer | null>>();
const cachedConnectedServiceRuntimeAuthAdapterPromises = new Map<CatalogAgentId, Promise<ConnectedServiceProviderRuntimeAuthAdapter | null>>();
const cachedConnectedServiceCredentialLifecycleDescriptorPromises = new Map<CatalogAgentId, Promise<ConnectedServiceCredentialLifecycleDescriptor>>();
const cachedConnectedServiceStateSharingDescriptorPromises = new Map<CatalogAgentId, Promise<ConnectedServiceStateSharingDescriptor | null>>();
const cachedSessionCatalogControlAdapterPromises = new Map<CatalogAgentId, Promise<SessionCatalogControlAdapter | null>>();
const cachedSessionGoalControlAdapterPromises = new Map<CatalogAgentId, Promise<SessionGoalControlAdapter | null>>();
const cachedSessionUsageLimitRecoveryControlAdapterPromises = new Map<CatalogAgentId, Promise<SessionUsageLimitRecoveryControlAdapter | null>>();
const cachedAcpForkContinuationHandlerPromises = new Map<CatalogAgentId, Promise<AcpForkContinuationHandler | null>>();
const cachedProviderNativeForkHandlerPromises = new Map<CatalogAgentId, Promise<ProviderNativeForkHandler | null>>();

function getOrLoadCatalogHookPromise<TKey, TValue>(
  cache: Map<TKey, Promise<TValue>>,
  key: TKey,
  load: () => Promise<TValue>,
): Promise<TValue> {
  const existing = cache.get(key);
  if (existing) return existing;

  const promise = load();
  cache.set(key, promise);
  void promise.catch(() => {
    if (cache.get(key) === promise) {
      cache.delete(key);
    }
  });
  return promise;
}

export async function getVendorResumeSupport(agentId?: AgentId | null): Promise<VendorResumeSupportFn> {
  const catalogId = resolveCatalogAgentId(agentId);
  const entry = requireCatalogEntry(catalogId);
  return await getOrLoadCatalogHookPromise(cachedVendorResumeSupportPromises, catalogId, async () => {
    if (entry.vendorResumeSupport === 'supported') {
      return () => true;
    }
    if (entry.vendorResumeSupport === 'unsupported') {
      return () => false;
    }
    if (entry.getVendorResumeSupport) {
      return await entry.getVendorResumeSupport();
    }
    const resumeConfig = AGENTS_CORE[catalogId]?.resume;
    if (
      resumeConfig?.vendorResume === 'experimental'
      && 'experimentalResumePolicy' in resumeConfig
      && resumeConfig.experimentalResumePolicy === 'runtime_checked'
    ) {
      return () => true;
    }
    return () => false;
  });
}

export async function getDirectSessionProviderOps(providerId: DirectSessionsProviderId): Promise<DirectSessionProviderOps> {
  const entry = AGENTS[providerId];
  if (!entry?.getDirectSessionProviderOps) {
    throw new Error(`Missing direct-session provider ops for ${providerId}`);
  }

  return await getOrLoadCatalogHookPromise(
    cachedDirectSessionProviderOpsPromises,
    providerId,
    entry.getDirectSessionProviderOps,
  );
}

export async function getProviderAttachOps(agentId?: AgentId | null): Promise<ProviderAttachOps | null> {
  const catalogId = resolveCatalogAgentId(agentId);
  const entry = AGENTS[catalogId];
  return await getOrLoadCatalogHookPromise(
    cachedProviderAttachOpsPromises,
    catalogId,
    () => entry?.getProviderAttachOps ? entry.getProviderAttachOps() : Promise.resolve(null),
  );
}

export async function getConnectedServiceMaterializer(agentId?: AgentId | null): Promise<ConnectedServicesProviderMaterializer | null> {
  const catalogId = resolveCatalogAgentId(agentId);
  const entry = AGENTS[catalogId];
  return await getOrLoadCatalogHookPromise(
    cachedConnectedServiceMaterializerPromises,
    catalogId,
    () => entry?.getConnectedServiceMaterializer
      ? entry.getConnectedServiceMaterializer()
      : Promise.resolve(null),
  );
}

export async function getConnectedServiceRuntimeAuthAdapter(agentId?: AgentId | null): Promise<ConnectedServiceProviderRuntimeAuthAdapter | null> {
  const catalogId = resolveCatalogAgentId(agentId);
  const entry = AGENTS[catalogId];
  return await getOrLoadCatalogHookPromise(
    cachedConnectedServiceRuntimeAuthAdapterPromises,
    catalogId,
    () => entry?.getConnectedServiceRuntimeAuthAdapter
      ? entry.getConnectedServiceRuntimeAuthAdapter()
      : Promise.resolve(null),
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

export async function resolveConnectedServiceCredentialLifecycleDescriptor(
  agentId?: AgentId | null,
): Promise<ConnectedServiceCredentialLifecycleDescriptor> {
  const catalogId = resolveCatalogAgentId(agentId);
  const entry = AGENTS[catalogId];
  return await getOrLoadCatalogHookPromise(
    cachedConnectedServiceCredentialLifecycleDescriptorPromises,
    catalogId,
    async () => {
      const descriptor = entry?.getConnectedServiceCredentialLifecycleDescriptor
        ? await entry.getConnectedServiceCredentialLifecycleDescriptor()
        : null;
      return descriptor ?? buildDefaultConnectedServiceCredentialLifecycleDescriptor(catalogId);
    },
  );
}

export type ConnectedServiceGenerationApplicationScopeResolution =
  | Readonly<{
      status: 'supported';
      scope: 'per_session_runtime' | 'shared_group_auth_surface';
      ownerId: string;
    }>
  | Readonly<{
      status: 'unsupported' | 'unavailable';
      errorCode: string;
    }>;

/** Resolves application cardinality from the sole catalog declaration that owns the service. */
export async function resolveConnectedServiceGenerationApplicationScope(
  serviceId: ConnectedServiceId,
  agentId?: CatalogAgentId | null,
): Promise<ConnectedServiceGenerationApplicationScopeResolution> {
  const matches: ConnectedServiceCredentialLifecycleDescriptor[] = [];
  try {
    if (agentId) {
      const descriptor = await resolveConnectedServiceCredentialLifecycleDescriptor(agentId);
      if (!descriptor.serviceIds.includes(serviceId)) {
        return { status: 'unsupported', errorCode: 'generation_application_scope_service_unsupported' };
      }
      matches.push(descriptor);
    } else {
      for (const entry of Object.values(AGENTS)) {
        if (!entry) continue;
        const descriptor = await resolveConnectedServiceCredentialLifecycleDescriptor(entry.id);
        if (descriptor.serviceIds.includes(serviceId)) matches.push(descriptor);
      }
    }
  } catch {
    return { status: 'unavailable', errorCode: 'generation_application_scope_unavailable' };
  }
  if (matches.length === 0) {
    return { status: 'unsupported', errorCode: 'generation_application_scope_unsupported' };
  }
  if (matches.length !== 1) {
    return { status: 'unavailable', errorCode: 'generation_application_scope_ambiguous' };
  }
  const descriptor = matches[0]!;
  if (descriptor.generationApplicationScope === 'unsupported') {
    return { status: 'unsupported', errorCode: 'generation_application_scope_unsupported' };
  }
  if (descriptor.generationApplicationScope === 'shared_group_auth_surface') {
    if (descriptor.sharedGenerationApplicationServiceIds?.includes(serviceId) !== true) {
      return { status: 'unsupported', errorCode: 'generation_application_scope_service_unsupported' };
    }
    return { status: 'supported', scope: 'shared_group_auth_surface', ownerId: descriptor.providerId };
  }
  return { status: 'supported', scope: 'per_session_runtime', ownerId: descriptor.providerId };
}

export async function getConnectedServiceStateSharingDescriptor(agentId?: AgentId | null): Promise<ConnectedServiceStateSharingDescriptor | null> {
  const catalogId = resolveCatalogAgentId(agentId);
  const entry = AGENTS[catalogId];
  return await getOrLoadCatalogHookPromise(
    cachedConnectedServiceStateSharingDescriptorPromises,
    catalogId,
    () => entry?.getConnectedServiceStateSharingDescriptor
      ? entry.getConnectedServiceStateSharingDescriptor()
      : Promise.resolve(null),
  );
}

export async function resolveConnectedServiceSwitchContinuity(
  agentId: AgentId | null | undefined,
  params: ConnectedServiceSwitchContinuityParams,
): Promise<ConnectedServiceSwitchContinuityResult> {
  const catalogId = resolveCatalogAgentId(agentId);
  const entry = AGENTS[catalogId];
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

/**
 * Where the Agent named by `agentId` would keep its own log for `vendorResumeId`
 * on this machine, when it derives that path rather than persisting it.
 *
 * The answer is a CANDIDATE: the provider knows the naming and layout rule, not
 * whether the file survived. The caller verifies it against the filesystem
 * before naming it to anyone, exactly as it does for a persisted proof path. A
 * provider that declares no derivation answers `null`, which is the same "no
 * log" callers already handle.
 */
export async function resolveAgentNativeSessionLogPathThroughCatalog(
  agentId: AgentId | null | undefined,
  input: Readonly<{ vendorResumeId: string }>,
): Promise<string | null> {
  const catalogId = resolveCatalogAgentId(agentId);
  const entry = AGENTS[catalogId];
  if (!entry?.resolveAgentNativeSessionLogPath) return null;
  return await entry.resolveAgentNativeSessionLogPath(input) ?? null;
}

export async function getSessionGoalControlAdapter(agentId?: AgentId | null): Promise<SessionGoalControlAdapter | null> {
  const catalogId = resolveCatalogAgentId(agentId);
  const entry = AGENTS[catalogId];
  return await getOrLoadCatalogHookPromise(
    cachedSessionGoalControlAdapterPromises,
    catalogId,
    () => entry?.getSessionGoalControlAdapter ? entry.getSessionGoalControlAdapter() : Promise.resolve(null),
  );
}

export async function getSessionCatalogControlAdapter(agentId?: AgentId | null): Promise<SessionCatalogControlAdapter | null> {
  const catalogId = resolveCatalogAgentId(agentId);
  const entry = AGENTS[catalogId];
  return await getOrLoadCatalogHookPromise(
    cachedSessionCatalogControlAdapterPromises,
    catalogId,
    () => entry?.getSessionCatalogControlAdapter ? entry.getSessionCatalogControlAdapter() : Promise.resolve(null),
  );
}

export async function getSessionUsageLimitRecoveryControlAdapter(agentId?: AgentId | null): Promise<SessionUsageLimitRecoveryControlAdapter | null> {
  const catalogId = resolveCatalogAgentId(agentId);
  const entry = AGENTS[catalogId];
  return await getOrLoadCatalogHookPromise(
    cachedSessionUsageLimitRecoveryControlAdapterPromises,
    catalogId,
    () => entry?.getSessionUsageLimitRecoveryControlAdapter
      ? entry.getSessionUsageLimitRecoveryControlAdapter()
      : Promise.resolve(null),
  );
}

export async function getAcpForkContinuationHandler(agentId: CatalogAgentId): Promise<AcpForkContinuationHandler | null> {
  const entry = AGENTS[agentId];
  return await getOrLoadCatalogHookPromise(
    cachedAcpForkContinuationHandlerPromises,
    agentId,
    () => entry?.getAcpForkContinuationHandler ? entry.getAcpForkContinuationHandler() : Promise.resolve(null),
  );
}

export async function getProviderNativeForkHandler(agentId: CatalogAgentId): Promise<ProviderNativeForkHandler | null> {
  const entry = AGENTS[agentId];
  return await getOrLoadCatalogHookPromise(
    cachedProviderNativeForkHandlerPromises,
    agentId,
    () => entry?.getProviderNativeForkHandler ? entry.getProviderNativeForkHandler() : Promise.resolve(null),
  );
}

export function resolveCatalogAgentId(agentId?: AgentId | null): CatalogAgentId {
  const raw = agentId ?? DEFAULT_CATALOG_AGENT_ID;
  const base = raw.split('-')[0] as CatalogAgentId;
  if (Object.prototype.hasOwnProperty.call(AGENTS, base)) {
    return base;
  }
  return DEFAULT_CATALOG_AGENT_ID;
}

export function resolveAgentCliSubcommand(agentId?: AgentId | null): CatalogAgentId {
  const catalogId = resolveCatalogAgentId(agentId);
  return requireCatalogEntry(catalogId).cliSubcommand;
}

export function resolveCatalogAgentIdForCliSubcommand(subcommand: string): CatalogAgentId | null {
  for (const [agentId, entry] of Object.entries(AGENTS) as Array<[CatalogAgentId, AgentCatalogEntry]>) {
    if (entry.cliSubcommand === subcommand) {
      return agentId;
    }
  }
  return null;
}
