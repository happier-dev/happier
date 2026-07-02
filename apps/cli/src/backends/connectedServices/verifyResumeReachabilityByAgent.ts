import type { CatalogAgentId } from '@/backends/types';
import { verifyResumeReachableThroughCatalog } from '@/backends/catalog';
import type {
  VerifyResumeReachableInput,
  VerifyResumeReachableResult,
} from '@/backends/connectedServices/verifyResumeReachableTypes';

export const REACHABILITY_CHECK_NOT_IMPLEMENTED_REASON = 'reachability_check_not_implemented' as const;

/**
 * Provider-agnostic resume-reachability dispatch (K4).
 *
 * This is the single call point used by BOTH the spawn-time gate (`verifySpawnResumeReachability`)
 * and the continuity resolver (`canResumeFromMaterializedState`). It holds NO provider knowledge:
 * the per-provider probe is resolved through the backend catalog hook
 * (`AgentCatalogEntry.verifyResumeReachable`, implemented in each `backends/<provider>/index.ts`).
 * A provider without the hook fails closed with the stable `reachability_check_not_implemented`
 * reason, preserving the previous central-switch default. The external contract is unchanged:
 * `{ agentId, input }` in, `VerifyResumeReachableResult | { ok: false; reason: string }` out.
 */
export async function verifyResumeReachabilityByAgent(params: Readonly<{
  agentId: CatalogAgentId;
  input: VerifyResumeReachableInput;
}>): Promise<VerifyResumeReachableResult | Readonly<{ ok: false; reason: string }>> {
  const result = await verifyResumeReachableThroughCatalog(params.agentId, params.input);
  if (result === null) {
    return { ok: false, reason: REACHABILITY_CHECK_NOT_IMPLEMENTED_REASON };
  }
  return result;
}
