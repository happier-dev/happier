import { resolveExecutionRunIntentProfile } from '../profiles/intentRegistry';
import type { ExecutionRunController } from '../controllers/types';
import { buildExecutionRunProfileStartParams } from './profileStart';
import type { ExecutionRunState } from './executionRunTypes';

export function getExecutionRunAvailableActionIds(
  run: ExecutionRunState,
  controller: ExecutionRunController | null,
): readonly string[] {
  const profile = resolveExecutionRunIntentProfile(run.intent);
  if (!profile.listAvailableActionIds) return [];

  return profile.listAvailableActionIds({
    start: buildExecutionRunProfileStartParams(run),
    structuredMeta: run.structuredMeta ?? null,
    controllerKind: controller?.kind ?? null,
  });
}
