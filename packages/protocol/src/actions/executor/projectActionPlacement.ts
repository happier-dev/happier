import { PROJECT_ACTION_INPUT_SCHEMAS_V1, ProjectWorkerNoAcceptanceFailureDetailsV1Schema,
  type PROJECT_FINITE_ACTION_RPC_METHODS_V1, type ProjectWorkerNoAcceptanceFailureDetailsV1 } from '../projectActionFamily.js';
import { ProjectDefinitionInspectOutputSchema } from '../projectDefinitionActionFamily.js';
import { ProjectWorkerActionOutputSchemasV1 } from '../specs/projectWorkers.js';
import { resolveProjectExecutionChoiceV1 } from '../../workspaces/projectWorkerPreferencesV1.js';
import { MachinePoolResolveResultV1Schema } from '../../machines/pools/v1.js';
import { resolveProjectMemoryDemandV1 } from '../../workspaces/projectSetup/projectMemoryDemandV1.js';
import type { ActionExecuteFailure, ActionExecuteResult } from '../actionExecutionResult.js';
import type { ActionExecutorContext } from './types.js';
import { ManagedMachineActionOutputSchemasV1 } from '../../machines/managed/actionsV1.js';
import { resolveManagedMachineWakeStateV1 } from '../../machines/managed/resolveMachineRetentionPolicyV1.js';

export type ProjectPlacementActionExecutorV1 = (actionId: 'projects.inspect' | 'projects.worker.preferences.get'
  | 'projects.worker.status' | 'machines.pools.resolve' | 'machines.pools.get' | 'machines.managed.list', input: unknown) => Promise<ActionExecuteResult>;

function failure(errorCode: string, details?: unknown): ActionExecuteFailure {
  return { ok: false, errorCode, error: errorCode, ...(details === undefined ? {} : { details }) };
}

/** Addresses the incumbent finite Action using the same frontdoor's SOURCE reads
 * and B6 precedence/pool owners. This neither admits nor launches the target. */
export async function resolveProjectActionMachineV1(args: Readonly<{
  actionId: keyof typeof PROJECT_FINITE_ACTION_RPC_METHODS_V1;
  input: unknown;
  context: Pick<ActionExecutorContext, 'actionRequestId' | 'executionRunTargetMachineId'>;
  executeCanonicalAction?: ProjectPlacementActionExecutorV1;
  createRequestKey: () => string;
  /** Captured original Account Home; hosted principals cannot borrow an ambient wake path. */
  homeId?: string;
}>): Promise<{ ok: true; machineId: string } | ActionExecuteFailure> {
  const { actionId, context } = args;
  const parsed = PROJECT_ACTION_INPUT_SCHEMAS_V1[actionId].safeParse(args.input);
  if (!parsed.success) return failure('invalid_parameters');
  const workspace = parsed.data.workspace;
  const choice = 'choice' in parsed.data ? parsed.data.choice : undefined;
  let machineId = choice?.kind === 'workers' && choice.destination.kind === 'machine'
    ? choice.destination.machineId : workspace.machineId;
  // Script worker intent requires current SOURCE declaration permission, even
  // for an exact target. Exact ad-hoc intent retains its incumbent carrier.
  if (actionId !== 'projects.prepare' && (!choice || choice.kind === 'workers' && choice.destination.kind === 'pool'
    || actionId === 'projects.script.run' && choice?.kind === 'workers'
    || context.executionRunTargetMachineId !== undefined)) {
    const executeRead = args.executeCanonicalAction;
    if (!executeRead) return failure('project_placement_unavailable');
    const inspection = await executeRead('projects.inspect', { workspace });
    if (!inspection.ok) return inspection;
    const opened = ProjectDefinitionInspectOutputSchema.safeParse(inspection.result);
    if (!opened.success) return failure('invalid_action_output');
    if (opened.data.definition.document?.status === 'invalid') return failure('invalid_manifest');
    const manifest = opened.data.definition.document?.manifest;
    const script = actionId === 'projects.script.run' ? PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.script.run'].parse(parsed.data) : undefined;
    const named = script?.selection.kind === 'named' ? manifest?.scripts?.[script.selection.name] : undefined;
    if (script?.selection.kind === 'named' && !named) return failure('project_script_not_found');
    const address = { serverId: workspace.serverId, refId: workspace.workspaceId };
    const preference = await executeRead('projects.worker.preferences.get', { workspace: address });
    if (!preference.ok) return preference;
    const observed = ProjectWorkerActionOutputSchemasV1['projects.worker.preferences.get'].safeParse(preference.result);
    if (!observed.success) return failure('invalid_action_output');
    // Ask/primary need a freshly submitted exact choice under the current
    // target owner, never a silent SOURCE switch using an old confirmation.
    const unavailableReason = (reason: string) => observed.data.status === 'ready' && observed.data.preference.unavailable !== 'fail'
      ? 'choice_required' : reason;
    const workerRefusal = (reason: string, workerCopy?: ProjectWorkerNoAcceptanceFailureDetailsV1['workerCopy']) => {
      const details = observed.data.status === 'ready' ? ProjectWorkerNoAcceptanceFailureDetailsV1Schema.safeParse({
        kind: 'no_worker_can_accept', unavailable: observed.data.preference.unavailable, reason,
        ...(workerCopy ? { workerCopy } : {}),
      }) : null;
      return failure(reason === 'worker_copy_missing' ? reason : unavailableReason(reason), details?.success ? details.data : undefined);
    };
    const execution = actionId === 'projects.compute.exec' ? 'portable'
      : named?.execution ?? 'primary';
    const resolved = resolveProjectExecutionChoiceV1({ execution, sourceMachineId: workspace.machineId,
      adHoc: actionId === 'projects.compute.exec', invocation: choice,
      ...(script?.selection.kind === 'named' ? { scriptName: script.selection.name } : {}),
      ...(context.executionRunTargetMachineId ? { acceptedMachineId: context.executionRunTargetMachineId } : {}),
      preference: observed.data.status === 'ready' ? { status: 'ready', value: observed.data.preference } : { status: observed.data.status },
    });
    if (resolved.status === 'refused') return failure(resolved.reason);
    if (resolved.choice.kind === 'primary') machineId = workspace.machineId;
    else {
      const memoryDemand = resolveProjectMemoryDemandV1('memoryDemand' in parsed.data ? parsed.data.memoryDemand : undefined,
        named?.memoryDemand, manifest?.workspace?.memoryDemand);
      const destination = resolved.choice.destination;
      if (destination.kind === 'pool') {
        if (destination.selection === 'ask') return failure('choice_required');
        const selection = await executeRead('machines.pools.resolve', { poolId: destination.poolId,
          requestKey: context.actionRequestId ?? args.createRequestKey(), purpose: 'finite', workspace: address,
          ...(memoryDemand ? { memoryDemand } : {}),
        });
        if (!selection.ok) return selection;
        const candidate = MachinePoolResolveResultV1Schema.safeParse(selection.result);
        if (!candidate.success) return failure('invalid_action_output');
        if (candidate.data.kind !== 'resolved') return workerRefusal(candidate.data.reason);
        machineId = candidate.data.machineId;
      } else {
        if (args.homeId) {
          const inventory = await executeRead('machines.managed.list', { homeId: args.homeId });
          if (inventory.ok) {
            const rows = ManagedMachineActionOutputSchemasV1['machines.managed.list'].safeParse(inventory.result);
            if (!rows.success || rows.data.machines.some(row => row.homeId !== args.homeId)) return failure('invalid_action_output');
            const targets = rows.data.machines.filter(row => row.enrolledMachineId === destination.machineId);
            const managed = targets.length === 1 ? targets[0] : undefined;
            if (managed?.wakeOnAcceptedMessage && resolveManagedMachineWakeStateV1(managed, destination.machineId)) {
              // C52 rechecks requester/controller custody and wakes this SAME finite
              // root. Guest capability/copy/load admission belongs after Running,
              // never a pre-wake RPC to a deliberately stopped guest.
              return { ok: true, machineId: destination.machineId };
            }
          }
          // Unsupported/denied managed reads cannot authorize wake. Ordinary
          // connected workers still use their existing discriminating status read.
        }
        const status = await executeRead('projects.worker.status', { workspace: address, destination, purpose: 'finite',
          ...(memoryDemand ? { memoryDemand } : {}),
        });
        if (!status.ok) return status;
        const worker = ProjectWorkerActionOutputSchemasV1['projects.worker.status'].safeParse(status.result);
        if (!worker.success || worker.data.eligible && (worker.data.candidate.serverId !== workspace.serverId
          || worker.data.candidate.machineId !== destination.machineId)) return failure('invalid_action_output');
        if (!worker.data.eligible) {
          const facts = worker.data.workerCopy;
          if (facts && (facts.serverId !== workspace.serverId || facts.sourceWorkspaceRefId !== workspace.workspaceId
            || facts.sourceMachineId !== workspace.machineId || facts.targetMachineId !== destination.machineId)) return failure('invalid_action_output');
          return workerRefusal(worker.data.explanation, facts);
        }
        machineId = destination.machineId;
      }
    }
  }
  return { ok: true, machineId };
}
