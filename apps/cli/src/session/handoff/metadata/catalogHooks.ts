import { AGENTS } from '@/agent/catalog/registry';
import { resolveCatalogAgentId } from '@/agent/catalog/resolution';
import type {
  CatalogAgentId,
  ProviderRuntimeLocalHandoffMetadataBuilder,
} from '@/agent/catalog/types';

export function buildRuntimeLocalHandoffMetadataForAgent(
  agentId: CatalogAgentId | null | undefined,
  params: Parameters<ProviderRuntimeLocalHandoffMetadataBuilder>[0],
): ReturnType<ProviderRuntimeLocalHandoffMetadataBuilder> | null {
  const catalogId = resolveCatalogAgentId(agentId);
  const entry = catalogId ? AGENTS[catalogId] ?? null : null;
  return entry?.buildRuntimeLocalHandoffMetadata?.(params) ?? null;
}

/**
 * Where the Agent named by `agentId` would keep its own log for `vendorResumeId`
 * on this machine, when it derives that path rather than persisting it.
 *
 * The answer is a CANDIDATE: the Agent knows the naming and layout rule, not
 * whether the file survived. The caller stat-verifies before naming it to
 * anyone, exactly as it does for a persisted proof path. An Agent that declares
 * no derivation answers `null`, which is the same "no log" the host already
 * handles.
 */
export async function resolveAgentNativeSessionLogPathForAgent(
  agentId: CatalogAgentId | null | undefined,
  input: Readonly<{ vendorResumeId: string }>,
): Promise<string | null> {
  const catalogId = resolveCatalogAgentId(agentId);
  const entry = catalogId ? AGENTS[catalogId] ?? null : null;
  if (!entry?.resolveAgentNativeSessionLogPath) return null;
  return await entry.resolveAgentNativeSessionLogPath(input) ?? null;
}
