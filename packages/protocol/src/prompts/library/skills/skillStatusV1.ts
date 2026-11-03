import type { SkillListItemV1 } from './skillLibraryItemV1.js';
import { resolveSkillReachV1 } from './firstPartySkillsV1.js';
export type SkillAccountStatusV1 = 'off' | 'update' | 'modified' | 'pinned' | 'unused';
const notRecentlyUsedMs = 30 * 86_400_000;
export function deriveSkillAccountStatusesV1(item: SkillListItemV1,
  input?: Readonly<{ nowMs: number; usageObservedSince: number | null }>): readonly SkillAccountStatusV1[] {
  const unused = input !== undefined && input.usageObservedSince !== null && (item.lastUsedAt !== undefined
    ? input.nowMs - item.lastUsedAt > notRecentlyUsedMs
    : input.nowMs - input.usageObservedSince > notRecentlyUsedMs
      && item.createdAt < input.nowMs - notRecentlyUsedMs);
  // Account status describes reach; display and Session owners admit features.
  // Include the built-in Everywhere default as well as explicit narrower reach.
  const defaultReach = resolveSkillReachV1(item.skillId, item.rules, { machineId: '', machinePlatform: null,
    directory: null, projectKey: null, agentId: null }, () => true);
  return [...(!item.rules.some(rule => rule.enabled) && !defaultReach.enabled ? ['off' as const] : []),
    ...(item.upstream?.state === 'update_available' ? ['update' as const] : []),
    ...(item.modified ? ['modified' as const] : []), ...(item.updatePolicy === 'pinned' ? ['pinned' as const] : []),
    ...(unused ? ['unused' as const] : [])];
}
