import type { CatalogAgentId } from '@/backends/types';
import { verifyResumeReachabilityByAgent } from '@/backends/connectedServices/verifyResumeReachabilityByAgent';
import type { VerifyResumeReachableResult } from '@/backends/connectedServices/verifyResumeReachableTypes';
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
 *
 * It runs in TARGET-STRICT mode (`targetStrict: true`): the provider probe must prove the EXACT final
 * path the vendor reads after materialization (for Pi, the `PI_CODING_AGENT_DIR/sessions/--<cwd>--`
 * symlink → native), excluding pre-materialization source/staging roots. This enforces plan §2
 * ("prove the exact final path") and closes the CS-FINDING-6 false-positive where a file present only
 * in `pi-sessions` staging passed the gate while the final path Pi reads was empty.
 */
export async function verifySpawnResumeReachability(params: Readonly<{
  agentId: CatalogAgentId;
  vendorResumeId: string;
  cwd: string;
  materializedEnv: Readonly<Record<string, string>>;
  processEnv?: NodeJS.ProcessEnv;
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
      processEnv: params.processEnv,
      vendorResumeId: params.vendorResumeId,
      cwd: params.cwd,
      candidatePersistedSessionFile: params.candidatePersistedSessionFile ?? null,
      targetStrict: true,
    },
  });
}
