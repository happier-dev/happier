import type { AgentId } from '@/agent/core';
import type { DirectSessionsProviderId } from '@happier-dev/protocol';
import { BUILT_IN_CATALOG_DEFINED_ACP_AGENTS } from '@/agent/acp/catalog';
import { agent as auggie } from '@/backends/auggie';
import { agent as claude } from '@/backends/claude';
import { agent as codex } from '@/backends/codex';
import { agent as copilot } from '@/backends/copilot';
import { agent as gemini } from '@/backends/gemini';
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
  DirectSessionProviderOps,
  ProviderAttachOps,
  ProviderNativeForkHandler,
  VendorResumeSupportFn,
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
  ...BUILT_IN_CATALOG_DEFINED_ACP_AGENTS,
  pi,
  copilot,
};

export function requireCatalogEntry(agentId: CatalogAgentId): AgentCatalogEntry {
  const entry = AGENTS[agentId];
  if (!entry) throw new Error(`Missing catalog agent entry for ${agentId}`);
  return entry;
}

const cachedVendorResumeSupportPromises = new Map<CatalogAgentId, Promise<VendorResumeSupportFn>>();
const cachedDirectSessionProviderOpsPromises = new Map<DirectSessionsProviderId, Promise<DirectSessionProviderOps>>();
const cachedProviderAttachOpsPromises = new Map<CatalogAgentId, Promise<ProviderAttachOps | null>>();
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
