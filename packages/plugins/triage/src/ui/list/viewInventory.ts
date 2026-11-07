import type { TriageSourceDescriptorV1 } from '@happier-dev/triage-protocol/v1';
import type { PluginContributionIdentity } from '@happier-dev/plugin-sdk/manifest';
import { INTERNAL_TASK_SOURCE_V1 } from '../../internalTasks/identity.js';
import { sameTriageSourceIdentity } from '../../corpus/identity/components.js';

type KindReference = Readonly<{ source: PluginContributionIdentity; kindId: string }>;

/** View membership, before audience, search or facet narrowing; rows, pins and facet discovery share it. */
export type TriageListViewInventoryV1 = Readonly<{
  includesSource: (source: PluginContributionIdentity) => boolean;
  includesKind: (ref: KindReference) => boolean;
}>;

const includesPrSource = (source: PluginContributionIdentity) => !sameTriageSourceIdentity(source, INTERNAL_TASK_SOURCE_V1);
export const TRIAGE_PR_VIEW_INVENTORY_V1: TriageListViewInventoryV1 = Object.freeze({
  includesSource: includesPrSource,
  includesKind: (ref) => includesPrSource(ref.source),
});

/** Task-kind declarations remain source-owned: a GitHub issue is a task, a GitHub PR is not. */
export function planTriageTaskViewInventoryV1(
  readKinds: (source: PluginContributionIdentity) => TriageSourceDescriptorV1['kinds'] | undefined,
): TriageListViewInventoryV1 {
  return Object.freeze({
    includesSource: (source) => readKinds(source)?.some(kind => kind.task === true) === true,
    includesKind: (ref) => readKinds(ref.source)?.some(kind => kind.id === ref.kindId && kind.task === true) === true,
  } satisfies TriageListViewInventoryV1);
}
