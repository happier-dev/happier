import type { CatalogAgentId } from '@/agent/catalog/ids';
import { verifyResumeReachabilityByAgent } from '@/daemon/connectedServices/verifyResumeReachabilityByAgent';
import type { VerifyResumeReachableResult } from '@/daemon/connectedServices/verifyResumeReachableTypes';
import { resolveConnectedServiceTargetMaterializedRoot } from './materialize/resolveConnectedServiceTargetMaterializedRoot';

/**
 * Provider-agnostic spawn-time resume-reachability re-verify (K1 §2).
 *
 * This runs at the spawn path after materialization has produced the real target
 * root the vendor will read. The host enumerates only the current Agent's
 * declared state-sharing entries; Agent code owns native correlation only.
 *
 * The materialized target root is derived from the materialized env via
 * `resolveConnectedServiceTargetMaterializedRoot`, so the probe proves the TARGET the vendor reads
 * from — not the pre-switch source and not "the import will land".
 */
export async function verifySpawnResumeReachability(params: Readonly<{
  agentId: CatalogAgentId;
  vendorResumeId: string;
  materializedEnv: Readonly<Record<string, string>>;
  runtimeDescriptorV1?: Parameters<typeof verifyResumeReachabilityByAgent>[0]['input']['runtimeDescriptorV1'];
}>): Promise<VerifyResumeReachableResult | Readonly<{ ok: false; reason: string }>> {
  const targetMaterializedRoot = resolveConnectedServiceTargetMaterializedRoot({
    agentId: params.agentId,
    targetMaterializedEnv: params.materializedEnv,
  }) ?? '';

  return await verifyResumeReachabilityByAgent({
    agentId: params.agentId,
    input: {
      targetMaterializedRoot,
      vendorResumeId: params.vendorResumeId,
      ...(params.runtimeDescriptorV1 ? { runtimeDescriptorV1: params.runtimeDescriptorV1 } : {}),
    },
  });
}
