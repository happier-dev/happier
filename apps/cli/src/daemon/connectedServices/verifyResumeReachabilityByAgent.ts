import type { CatalogAgentId } from '@/agent/catalog/ids';
import { verifyResumeReachableThroughCatalog } from './catalogHooks';
import {
  REACHABILITY_CHECK_NOT_IMPLEMENTED_REASON,
  type VerifyResumeReachableInput,
  type VerifyResumeReachableResult,
} from '@/daemon/connectedServices/verifyResumeReachableTypes';

export { REACHABILITY_CHECK_NOT_IMPLEMENTED_REASON } from '@/daemon/connectedServices/verifyResumeReachableTypes';

/**
 * Provider-agnostic resume-reachability dispatch (K4).
 *
 * This is the single call point used by BOTH the spawn-time gate (`verifySpawnResumeReachability`)
 * and the continuity resolver (`canResumeFromMaterializedState`). It holds NO provider knowledge:
 * the per-provider probe is resolved through the catalog hook
 * (`AgentCatalogEntry.verifyResumeReachable`, projected from the provider's catalog/plugin contribution).
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
