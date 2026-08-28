import type { CatalogAgentId } from '@/agent/catalog/ids';
import { verifyResumeReachableThroughCatalog } from './catalogHooks';
import {
  REACHABILITY_CHECK_NOT_IMPLEMENTED_REASON,
  type VerifyResumeReachableInput,
  type VerifyResumeReachableResult,
} from '@/daemon/connectedServices/verifyResumeReachableTypes';

export { REACHABILITY_CHECK_NOT_IMPLEMENTED_REASON } from '@/daemon/connectedServices/verifyResumeReachableTypes';

/**
 * Provider-agnostic resume-reachability dispatch.
 *
 * This is the single call point used by BOTH the spawn-time gate (`verifySpawnResumeReachability`)
 * and the continuity resolver (`canResumeFromMaterializedState`). The host retains the target root,
 * enumerates only declared state-sharing entries, and resolves the final path. The Agent callback
 * receives only filename/native-session-id evidence through the injected lookup operation.
 * A provider without the hook fails closed with the stable `reachability_check_not_implemented`
 * reason, preserving the previous central-switch default.
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
