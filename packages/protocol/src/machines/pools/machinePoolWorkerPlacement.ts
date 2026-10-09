import { ProjectWorkerStatusResultV1Schema, type ProjectWorkerStatusInputV1 } from '../../actions/specs/projectWorkers.js';
import type { ActionExecuteResult } from '../../actions/actionExecutionResult.js';
import { selectMachinePoolCandidate, type MachinePoolWorkerObservationV1 } from './machinePoolPlacement.js';
import type { MachinePoolResolveInputV1, MachinePoolResolveResultV1, MachinePoolViewV1 } from './v1.js';
import { ProjectWorkerNoAcceptanceReasonV1Schema } from '../../workspaces/projectWorkerExecutionV1.js';

/** Exact target reads through the Action front door; selection remains advisory and never wakes. */
export async function resolveMachinePoolWorkerCandidateV1(input: Readonly<{
  request: Extract<MachinePoolResolveInputV1, { purpose: 'finite' | 'service-start' }>;
  pool: MachinePoolViewV1;
  status(request: ProjectWorkerStatusInputV1): Promise<ActionExecuteResult>;
  signal?: AbortSignal;
}>): Promise<MachinePoolResolveResultV1> {
  const { request, pool } = input;
  input.signal?.throwIfAborted();
  const members = pool.pool.members.filter((member) => member.enabled && member.state === 'connected');
  const observations = new Map<string, MachinePoolWorkerObservationV1>();
  let eligibilityUnknown = false;
  await Promise.all(members.map(async (member) => {
    const outcome = await input.status({
      workspace: request.workspace,
      destination: { kind: 'machine', machineId: member.machineId },
      purpose: request.purpose,
      ...(request.memoryDemand ? { memoryDemand: request.memoryDemand } : {}),
    });
    if (!outcome.ok) { eligibilityUnknown = true; return; }
    const status = ProjectWorkerStatusResultV1Schema.safeParse(outcome.result);
    if (!status.success) { eligibilityUnknown = true; return; }
    const value = status.data;
    // A result for another Home or Machine cannot establish this member's eligibility.
    if (value.eligible && (value.candidate.serverId !== request.workspace.serverId
      || value.candidate.machineId !== member.machineId)) { eligibilityUnknown = true; return; }
    if (!value.eligible && !ProjectWorkerNoAcceptanceReasonV1Schema.safeParse(value.explanation).success) {
      eligibilityUnknown = true;
    }
    observations.set(member.machineId, { eligible: value.eligible,
      load: value.load.kind === 'known' ? { state: 'known', running: value.load.running } : { state: 'unknown' } });
  }));
  input.signal?.throwIfAborted();
  const candidate = selectMachinePoolCandidate({
    members: pool.pool.members,
    availableMachineIds: new Set(members.map((member) => member.machineId)),
    requestKey: request.requestKey,
    purpose: request.purpose,
    observations,
  });
  if (candidate) return { kind: 'resolved', poolId: request.poolId, ...candidate };
  return { kind: 'unavailable', poolId: request.poolId,
    reason: pool.pool.members.length === 0 ? 'empty'
      : pool.availability.state === 'unknown' ? 'presence_unavailable'
        : eligibilityUnknown ? 'worker_status_unavailable' : 'no_available_machine' };
}
