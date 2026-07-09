import type { CatalogAgentId } from '@/agent/catalog/ids';
import { verifyResumeReachabilityByAgent } from '@/daemon/connectedServices/verifyResumeReachabilityByAgent';
import type { VerifyResumeReachableResult } from '@/daemon/connectedServices/verifyResumeReachableTypes';
import { resolveConnectedServiceTargetMaterializedRoot } from './materialize/resolveConnectedServiceTargetMaterializedRoot';

/**
 * Provider-agnostic spawn-time resume-reachability re-verify (K1 §2).
 *
 * This runs at the spawn path AFTER materialization has produced the REAL materialized env the vendor
 * will read, and dispatches to the provider's reachability probe through the EXISTING central
 * dispatcher (`verifyResumeReachabilityByAgent`). It deliberately holds no provider knowledge so it
 * stays clean under the connected-services core provider-branching policy; the agentId is a typed
 * value threaded from the caller.
 *
 * The materialized target root is derived from the materialized env via
 * `resolveConnectedServiceTargetMaterializedRoot`, so the probe proves the TARGET the vendor reads
 * from — not the pre-switch source and not "the import will land".
 */
export async function verifySpawnResumeReachability(params: Readonly<{
  agentId: CatalogAgentId;
  vendorResumeId: string;
  cwd: string;
  materializedEnv: Readonly<Record<string, string>>;
  candidatePersistedSessionFile?: string | null;
}>): Promise<VerifyResumeReachableResult | Readonly<{ ok: false; reason: string }>> {
  const targetMaterializedRoot = resolveConnectedServiceTargetMaterializedRoot({
    agentId: params.agentId,
    targetMaterializedEnv: params.materializedEnv,
  }) ?? '';

  return await verifyResumeReachabilityByAgent({
    agentId: params.agentId,
    input: {
      targetMaterializedRoot,
      targetMaterializedEnv: params.materializedEnv,
      vendorResumeId: params.vendorResumeId,
      cwd: params.cwd,
      candidatePersistedSessionFile: params.candidatePersistedSessionFile ?? null,
      // §2 spawn gate: prove the EXACT final path the vendor reads (not pre-materialization
      // source/staging), so a file present only in a staging/source location cannot pass the gate.
      targetStrict: true,
    },
  });
}
