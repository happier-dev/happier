import type { AgentId } from '../agent/core';
import type { DirectSessionsProviderId } from '@happier-dev/protocol';
import type { BackendTargetRefV2 } from '@happier-dev/protocol';
import {
  resolveBackendEngineAdapterResolution as resolveBackendEngineAdapterResolutionFromRegistry,
  type EngineAdapterResolution,
  type EngineResolutionDiagnostic,
  type EngineResolutionDiagnosticCode,
  type EngineResolutionSelectedSource,
} from '../agent/runtime/registry/engineRegistry';
import { getResolvedContributionRegistry } from '../extensions/registry/createResolvedContributionRegistry';
import { CATALOG_AGENT_IDS, DEFAULT_CATALOG_AGENT_ID } from './types';
import type {
  AcpForkContinuationHandler,
  AgentCatalogEntry,
  CatalogAgentId,
  CatalogAgentLookupId,
  ConnectedServicesMaterializer,
  DirectSessionProviderOps,
  ProviderCliLaunchSpec,
  ProviderAttachOps,
  ProviderNativeForkHandler,
  ReplayForkContinuationHandler,
  SessionHandoffProviderOps,
  AnyTerminalRuntimeOps,
  VendorResumeSupportFn,
} from './types';

export type { AgentCatalogEntry, AgentChecklistContributions, CatalogAgentId, CliDetectSpec } from './types';
export type { CatalogAgentLookupId } from './types';
export type {
  EngineAdapterResolution,
  EngineResolutionDiagnostic,
  EngineResolutionDiagnosticCode,
  EngineResolutionSelectedSource,
};

function readCatalogEntriesSnapshot(): Record<string, AgentCatalogEntry> {
  return getResolvedContributionRegistry().catalogEntriesById as Record<string, AgentCatalogEntry>;
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
const cachedDirectSessionProviderOpsPromises = new Map<DirectSessionsProviderId, Promise<DirectSessionProviderOps>>();
const cachedConnectedServicesMaterializerPromises = new Map<CatalogAgentId, Promise<ConnectedServicesMaterializer | null>>();
const cachedManagedServerLaunchSpecPromises = new Map<CatalogAgentId, Promise<ProviderCliLaunchSpec | null>>();
const cachedProviderAttachOpsPromises = new Map<CatalogAgentId, Promise<ProviderAttachOps | null>>();
const cachedTerminalRuntimeOpsPromises = new Map<CatalogAgentId, Promise<AnyTerminalRuntimeOps | null>>();
const cachedAcpForkContinuationHandlerPromises = new Map<CatalogAgentId, Promise<AcpForkContinuationHandler | null>>();
const cachedProviderNativeForkHandlerPromises = new Map<CatalogAgentId, Promise<ProviderNativeForkHandler | null>>();
const cachedReplayForkContinuationHandlerPromises = new Map<CatalogAgentId, Promise<ReplayForkContinuationHandler | null>>();
const cachedSessionHandoffProviderOpsPromises = new Map<CatalogAgentId, Promise<SessionHandoffProviderOps | null>>();

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

export async function getManagedServerLaunchSpec(agentId: CatalogAgentId): Promise<ProviderCliLaunchSpec | null> {
  const existing = cachedManagedServerLaunchSpecPromises.get(agentId);
  if (existing) return await existing;

  const entry = AGENTS[agentId];
  const promise = entry?.getManagedServerLaunchSpec ? entry.getManagedServerLaunchSpec() : Promise.resolve(null);
  cachedManagedServerLaunchSpecPromises.set(agentId, promise);
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

export async function getTerminalRuntimeOps(agentId?: AgentId | null): Promise<AnyTerminalRuntimeOps | null> {
  const catalogId = resolveCatalogAgentId(agentId);
  const existing = cachedTerminalRuntimeOpsPromises.get(catalogId);
  if (existing) return await existing;

  const entry = AGENTS[catalogId];
  const promise = entry?.getTerminalRuntimeOps ? entry.getTerminalRuntimeOps() : Promise.resolve(null);
  cachedTerminalRuntimeOpsPromises.set(catalogId, promise);
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

export async function getReplayForkContinuationHandler(agentId: CatalogAgentId): Promise<ReplayForkContinuationHandler | null> {
  const existing = cachedReplayForkContinuationHandlerPromises.get(agentId);
  if (existing) return await existing;

  const entry = AGENTS[agentId];
  const promise = entry?.getReplayForkContinuationHandler ? entry.getReplayForkContinuationHandler() : Promise.resolve(null);
  cachedReplayForkContinuationHandlerPromises.set(agentId, promise);
  return await promise;
}

export async function getSessionHandoffProviderOps(agentId?: AgentId | null): Promise<SessionHandoffProviderOps | null> {
  const catalogId = resolveCatalogAgentId(agentId);
  const existing = cachedSessionHandoffProviderOpsPromises.get(catalogId);
  if (existing) return await existing;

  const entry = AGENTS[catalogId];
  const promise = entry?.getSessionHandoffProviderOps
    ? entry.getSessionHandoffProviderOps()
    : Promise.resolve(null);
  cachedSessionHandoffProviderOpsPromises.set(catalogId, promise);
  return await promise;
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
