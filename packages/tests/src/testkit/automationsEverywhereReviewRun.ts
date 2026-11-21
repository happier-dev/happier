import { expect } from 'vitest';
import { WorkflowInvocationListResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import type { TeamSetupFFixture } from './teamSetupF';

export async function reviewRunHasChildSession(
  actor: Awaited<ReturnType<TeamSetupFFixture['createAccount']>>,
  runId: string,
  expected: { parentSessionId: string; machineId: string; path: string },
) {
  // Managed Workflow child Sessions belong to the public invocation contract.
  const index = await actor.execute('workflow.run.invocations.list', { runId });
  expect(index.ok, JSON.stringify(index)).toBe(true);
  if (!index.ok) throw new Error(index.errorCode);
  if (WorkflowInvocationListResultV1Schema.parse(index.result).invocations.length === 0) return false;
  const result = await actor.execute('workflow.run.invocations.list', { runId, includeContent: true });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.errorCode);
  const execution = WorkflowInvocationListResultV1Schema.parse(result.result).invocationDetails
    ?.find(row => row.progress.invocationPath.blockId === 'review')?.progress.execution;
  if (execution?.kind !== 'session' && execution?.kind !== 'session_ready') return false;
  expect(execution.sessionId).not.toBe(expected.parentSessionId);
  expect(await actor.readSessionMetadata(execution.sessionId)).toMatchObject({
    machineId: expected.machineId, path: expected.path,
  });
  return true;
}
