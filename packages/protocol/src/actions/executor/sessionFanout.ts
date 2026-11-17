import type { ActionId } from '../actionIds.js';
import type { ActionExecuteResult } from '../actionExecutionResult.js';
import type { ActionExecutorContext, ActionExecutorDeps, ActionSessionAddress } from './types.js';
import { readRecord } from '../../inputs/inputRecords.js';
import { projectActionFailureCauseV1 } from '../actionExecutionResult.js';

/** Machine placement comes from the existing authorized Session status reader.
 * Any unknown placement retains sequential behavior for that whole Home.
 * This is scheduling only; each leaf keeps its ordinary effect admission.
 */
export async function runActionSessionFanout(args: Readonly<{
  actionId: ActionId;
  targets: readonly ActionSessionAddress[];
  context: ActionExecutorContext;
  deps: ActionExecutorDeps;
  execute: (target: ActionSessionAddress, position: number) => Promise<ActionExecuteResult>;
}>) {
  const groups = new Map<string, number[]>();
  const machines = await Promise.all(args.targets.map(async target => {
    if (args.targets.length === 1 || args.context.signal?.aborted || !args.deps.sessionStatusGet) return null;
    try {
      const status = await args.deps.sessionStatusGet({ sessionId: target.sessionId, serverId: target.serverId,
        context: { ...args.context, serverId: target.serverId }, ...(args.context.signal ? { signal: args.context.signal } : {}) });
      const machineId = readRecord(readRecord(status).session).machineId;
      return typeof machineId === 'string' && machineId.trim() ? machineId : null;
    } catch (error) {
      // Missing placement must not replace the leaf's typed domain outcome.
      args.deps.recordActionOutputDiagnostic?.({ source: 'action.session_fanout.placement',
        phase: 'action.session_fanout.placement', issues: [],
        failureCause: projectActionFailureCauseV1(error, 'action.session_fanout.placement', { allowUnknownErrorCode: false }) });
      return null;
    }
  }));
  const unknownPlacementHomes = new Set(args.targets.filter((_, position) => machines[position] === null).map(target => target.serverId));
  for (const [position, target] of args.targets.entries()) {
    const key = JSON.stringify([target.serverId, unknownPlacementHomes.has(target.serverId) ? null : machines[position]]);
    const group = groups.get(key);
    if (group) group.push(position);
    else groups.set(key, [position]);
  }
  const results: Array<{ target: ActionSessionAddress; result: ActionExecuteResult }> = new Array(args.targets.length);
  await Promise.all([...groups.values()].map(async positions => {
    for (const position of positions) {
      const target = args.targets[position];
      const result = await args.execute(target, position);
      results[position] = { target, result };
      args.context.onSessionTargetResult?.({ actionId: args.actionId, position, target, result });
    }
  }));
  return results;
}
