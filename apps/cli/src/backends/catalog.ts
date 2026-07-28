import type { AgentId } from '@/agent/core';
import { AGENTS_CORE } from '@happier-dev/agents';
import type { DirectSessionsProviderId } from '@happier-dev/protocol';
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
import type {
  ConnectedServiceRuntimeAuthSelectionMaterializerParams,
} from '@/daemon/connectedServices/sessionAuthSwitch/runtimeAuthSelectionMaterializerTypes';
import type { ConnectedServicesProviderMaterializer } from '@/daemon/connectedServices/materialize/providerMaterializerTypes';
import {
  buildDefaultConnectedServiceCredentialLifecycleDescriptor,
  type ConnectedServiceCredentialLifecycleDescriptor,
} from '@/daemon/connectedServices/credentials/lifecycleTypes';

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
    const resumeConfig = AGENTS_CORE[catalogId]?.resume;
    if (
      resumeConfig?.vendorResume === 'experimental'
      && 'experimentalResumePolicy' in resumeConfig
      && resumeConfig.experimentalResumePolicy === 'runtime_checked'
    ) {
      return () => true;
    }
    return () => false;
  })();

  cachedVendorResumeSupportPromises.set(catalogId, promise);
  return await promise;
}

export async function getDirectSessionProviderOps(providerId: DirectSessionsProviderId): Promise<DirectSessionProviderOps> {
  const existing = cachedDirectSessionProviderOpsPromises.get(providerId);
  if (existing) return await existing;

  const entry = AGENTS[providerId];
  if (!entry?.getDirectSessionProviderOps) {
    throw new Error(`Missing direct-session provider ops for ${providerId}`);
  }

  const promise = entry.getDirectSessionProviderOps();
  cachedDirectSessionProviderOpsPromises.set(providerId, promise);
  return await promise;
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

export async function getConnectedServiceMaterializer(agentId?: AgentId | null): Promise<ConnectedServicesProviderMaterializer | null> {
  const catalogId = resolveCatalogAgentId(agentId);
  const existing = cachedConnectedServiceMaterializerPromises.get(catalogId);
  if (existing) return await existing;

  const entry = AGENTS[catalogId];
  const promise = entry?.getConnectedServiceMaterializer
    ? entry.getConnectedServiceMaterializer()
    : Promise.resolve(null);
  cachedConnectedServiceMaterializerPromises.set(catalogId, promise);
  return await promise;
}

export async function getConnectedServiceRuntimeAuthAdapter(agentId?: AgentId | null): Promise<ConnectedServiceProviderRuntimeAuthAdapter | null> {
  const catalogId = resolveCatalogAgentId(agentId);
  const existing = cachedConnectedServiceRuntimeAuthAdapterPromises.get(catalogId);
  if (existing) return await existing;

  const entry = AGENTS[catalogId];
  const promise = entry?.getConnectedServiceRuntimeAuthAdapter
    ? entry.getConnectedServiceRuntimeAuthAdapter()
    : Promise.resolve(null);
  cachedConnectedServiceRuntimeAuthAdapterPromises.set(catalogId, promise);
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

export async function resolveConnectedServiceCredentialLifecycleDescriptor(
  agentId?: AgentId | null,
): Promise<ConnectedServiceCredentialLifecycleDescriptor> {
  const catalogId = resolveCatalogAgentId(agentId);
  const existing = cachedConnectedServiceCredentialLifecycleDescriptorPromises.get(catalogId);
  if (existing) return await existing;

  const entry = AGENTS[catalogId];
  const promise = (async () => {
    const descriptor = entry?.getConnectedServiceCredentialLifecycleDescriptor
      ? await entry.getConnectedServiceCredentialLifecycleDescriptor()
      : null;
    return descriptor ?? buildDefaultConnectedServiceCredentialLifecycleDescriptor(catalogId);
  })();
  cachedConnectedServiceCredentialLifecycleDescriptorPromises.set(catalogId, promise);
  return await promise;
}

export async function getConnectedServiceStateSharingDescriptor(agentId?: AgentId | null): Promise<ConnectedServiceStateSharingDescriptor | null> {
  const catalogId = resolveCatalogAgentId(agentId);
  const existing = cachedConnectedServiceStateSharingDescriptorPromises.get(catalogId);
  if (existing) return await existing;

  const entry = AGENTS[catalogId];
  const promise = entry?.getConnectedServiceStateSharingDescriptor
    ? entry.getConnectedServiceStateSharingDescriptor()
    : Promise.resolve(null);
  cachedConnectedServiceStateSharingDescriptorPromises.set(catalogId, promise);
  return await promise;
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

export async function getAcpForkContinuationHandler(agentId: CatalogAgentId): Promise<AcpForkContinuationHandler | null> {
  const existing = cachedAcpForkContinuationHandlerPromises.get(agentId);
  if (existing) return await existing;

  const entry = AGENTS[agentId];
  const promise = entry?.getAcpForkContinuationHandler ? entry.getAcpForkContinuationHandler() : Promise.resolve(null);
  cachedAcpForkContinuationHandlerPromises.set(agentId, promise);
  return await promise;
}

export async function getProviderNativeForkHandler(agentId: CatalogAgentId): Promise<ProviderNativeForkHandler | null> {
  const existing = cachedProviderNativeForkHandlerPromises.get(agentId);
  if (existing) return await existing;

  const entry = AGENTS[agentId];
  const promise = entry?.getProviderNativeForkHandler ? entry.getProviderNativeForkHandler() : Promise.resolve(null);
  cachedProviderNativeForkHandlerPromises.set(agentId, promise);
  return await promise;
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
