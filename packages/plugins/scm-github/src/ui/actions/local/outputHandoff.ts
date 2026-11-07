import type { PluginActionInputById, PluginActionResultById } from '@happier-dev/plugin-sdk/actions';
import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';
import { TriageSessionHandoffInputV1Schema, TriageSessionHandoffEvidenceV1Schema,
  type TriageSessionHandoffInputV1, type TriageSessionHandoffEvidenceV1 } from '@happier-dev/triage-protocol/v1';
import { requestTriageSessionHandoffV1, type TriageSessionHandoffHostV1 } from '@happier-dev/triage-sources/runtime';

/** No read/send on mount. Caller supplies the explicit output owner's copy receipt. */
export async function handoffSelectedLocalActOutputV1(host: TriageSessionHandoffHostV1, input: Readonly<{
  repository: Extract<TriageSessionHandoffInputV1['context'], { kind: 'repository' }>['repository'];
  configuredActionId: TriageSessionHandoffInputV1['configuredActionId'];
  workspace: PluginActionInputById['projects.compute.exec']['workspace'];
  copied: Readonly<{ request: PluginActionInputById['projects.execution.output.copy']; result: PluginActionResultById['projects.execution.output.copy'] }>;
  evidence: unknown;
  hostedEvidence?: Extract<TriageSessionHandoffEvidenceV1, { kind: 'hostedCi' }>;
  sessionChoice?: TriageSessionHandoffInputV1['sessionChoice'];
  agentChoice?: TriageSessionHandoffInputV1['agentChoice']; delivery?: TriageSessionHandoffInputV1['delivery'];
}>, options: Readonly<{ signal?: AbortSignal }> = {}) {
  const evidence = TriageSessionHandoffEvidenceV1Schema.parse(input.evidence);
  if (evidence.kind !== 'localTerminal') throw new TypeError('local_terminal_evidence_required');
  const { request, result } = input.copied;
  const ref = { serverId: request.serverId, machineId: request.machineId, operationId: request.operationId };
  if (!pluginJsonValuesEqual(ref, evidence.operationRef) || result.output.ok !== true) throw new TypeError('local_output_copy_mismatch');
  const gaps = evidence.coverage.gaps || result.output.droppedBeforeByteOffset > request.byteOffset
    || result.output.frames.some(frame => frame.t === 'gap' || frame.t === 'legacyOnly');
  const local = { ...evidence, coverage: { complete: evidence.coverage.complete && !gaps, gaps } };
  const handoff = TriageSessionHandoffInputV1Schema.parse({ task: 'fix', configuredActionId: input.configuredActionId,
    context: { kind: 'repository', repository: input.repository, workspace: input.workspace },
    evidence: [local, ...(input.hostedEvidence ? [input.hostedEvidence] : [])],
    sessionChoice: input.sessionChoice ?? { kind: 'configured' }, agentChoice: input.agentChoice ?? { kind: 'configured' },
    delivery: input.delivery ?? 'configured',
  });
  // 05 owns selection, approval, escaped external-content framing and every recovery arm.
  return await requestTriageSessionHandoffV1(host, handoff, options);
}
