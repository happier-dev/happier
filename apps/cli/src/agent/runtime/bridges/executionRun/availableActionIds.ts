import {
  resolveExecutionRunIntentProfile,
  resolveExecutionRunIntentProfileFromCatalog,
  type ExecutionRunProfileContributionCatalog,
} from '@/agent/executionRuns/profiles/intentRegistry';
import type { ExecutionRunController } from '@/agent/executionRuns/controllers/types';
import { buildExecutionRunProfileStartParams } from './profileStart';
import type { ExecutionRunState } from './executionRunTypes';

export function getExecutionRunAvailableActionIds(
  run: ExecutionRunState,
  controller: ExecutionRunController | null,
  catalog?: ExecutionRunProfileContributionCatalog,
): readonly string[] {
  const profile = catalog
    ? resolveExecutionRunIntentProfileFromCatalog(catalog, run.intent, run.profileId)
    : resolveExecutionRunIntentProfile(run.intent);
  if (!profile.listAvailableActionIds) return [];

  const actionIds = profile.listAvailableActionIds({
    start: buildExecutionRunProfileStartParams(run),
    structuredMeta: run.structuredMeta ?? null,
    controllerKind: controller?.kind ?? null,
  });
  return run.status === 'succeeded'
    ? actionIds
    : actionIds.filter((actionId) => actionId !== 'reviews.comments.create');
}
