import { deriveSkillAccountStatusesV1 } from '@happier-dev/protocol/prompts/library/skills/skillStatusV1';
import type { SkillListItemV1, SkillUnavailableItemV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';

import type { CapabilityStatus } from '@/components/capabilities/status/capabilityStatusPresentation';
import { describeCapabilityNoticeReason, readCapabilityNoticeReason } from '@/components/capabilities/status/capabilityNoticeReason';
import type { SessionSkillPlanV1 } from '@happier-dev/protocol/prompts/library/skills/resolveSessionSkillPlanV1';
import type { SessionCapabilityNoticeV1 } from '@happier-dev/protocol/sessions/messages/sessionCapabilityNoticeV1';

/**
 * A skill's statuses in P5's vocabulary, for the page, the homepage and the P8 popover. The
 * account-derivable facts come from the protocol owner (`deriveSkillAccountStatusesV1`, which the
 * `skills.list` filter uses too); device and machine facts (masked from the Found cache, offline,
 * join here as their producers land (U6.5). Usage is an Account fact owned by the protocol.
 */
export function skillStatus(
  item: SkillListItemV1 | null,
  usage?: Readonly<{ nowMs: number; usageObservedSince: number | null }>,
  session?: Readonly<{ skillId: string; plan: SessionSkillPlanV1 | null; notices: readonly SessionCapabilityNoticeV1[]; machineName: string; onFix: () => void }>,
): readonly CapabilityStatus[] {
  const statuses = (item ? deriveSkillAccountStatusesV1(item, usage) : []).map((kind): CapabilityStatus => ({
    kind,
  }));
  // Its source dropped it (the same fact "Needs a look" lists it by): the row says so in words.
  if (item?.upstream?.state === 'removed_from_source') statuses.push({ kind: 'removed' });
  const skillId = session?.skillId ?? item?.skillId;
  const planItem = session?.plan?.items.find(fact => fact.skillId === skillId);
  if (session && planItem?.state === 'masked_by_native') statuses.push({ kind: 'masked', machineName: session.machineName });
  if (session && (planItem?.state === 'unavailable' || planItem?.state === 'name_conflict')) statuses.push({
    kind: 'error', machineName: session.machineName, detail: planItem.reason, fix: { kind: 'try_again', onPress: session.onFix },
  });
  for (const notice of session?.notices ?? []) for (const fact of notice.items) {
    if (session && fact.kind === 'skill' && fact.itemId === skillId) statuses.push({ kind: 'error', machineName: session.machineName,
      ...readableNoticeDetail(fact), fix: { kind: 'try_again', onPress: session.onFix } });
  }
  return statuses;
}

function readableNoticeDetail(fact: SessionCapabilityNoticeV1['items'][number]): { detail?: string } {
  const reason = readCapabilityNoticeReason(fact);
  return reason ? { detail: describeCapabilityNoticeReason(reason) } : {};
}

/**
 * "Needs a look" (IR-80): an update is waiting, or the person changed a skill whose source changed
 * too, or its source removed it and the person must choose what to keep. Never a readiness guess,
 * an ordinary local modification, or Off alone.
 */
export function skillNeedsALook(item: SkillListItemV1): boolean {
  return deriveSkillAccountStatusesV1(item).includes('update')
    || item.upstream?.state === 'removed_from_source';
}

/** On nowhere (no rule turns it on): its row lives in the Off group (D4). */
export function isSkillOff(item: SkillListItemV1): boolean {
  return deriveSkillAccountStatusesV1(item).includes('off');
}

/** One "Needs a look" entry (IR-80), each with the one fix it offers. */
export type SkillNeedsALookEntry =
  | Readonly<{ kind: 'update' | 'removed'; key: string; item: SkillListItemV1 }>
  | Readonly<{ kind: 'masked'; key: string; item: SkillListItemV1; machineName: string }>
  | Readonly<{ kind: 'unreadable'; key: string; unavailable: SkillUnavailableItemV1 }>;

/**
 * Everything that needs the person, most blocking first (P5 order: error > update > masked): skills
 * whose content cannot be read (Try again), a waiting update or a source that dropped the skill
 * (Review / Decide), and a library skill a machine's own same-name copy wins over, known from this
 * device's Found cache (Compare). `maskedOn` maps a library skill name to that machine's name.
 */
export function buildSkillsNeedsALook(
  items: readonly SkillListItemV1[],
  unavailable: readonly SkillUnavailableItemV1[],
  maskedOn: ReadonlyMap<string, string>,
): readonly SkillNeedsALookEntry[] {
  const entries: SkillNeedsALookEntry[] = unavailable
    .filter((entry) => entry.reason === 'skill_content_unavailable')
    .map((entry) => ({ kind: 'unreadable', key: entry.skillId, unavailable: entry }));
  const listed = new Set<string>();
  for (const item of items) {
    if (!skillNeedsALook(item)) continue;
    listed.add(item.skillId);
    entries.push({ kind: item.upstream?.state === 'removed_from_source' ? 'removed' : 'update', key: item.skillId, item });
  }
  for (const item of items) {
    const machineName = maskedOn.get(item.name);
    if (machineName === undefined || listed.has(item.skillId)) continue;
    entries.push({ kind: 'masked', key: item.skillId, item, machineName });
  }
  return entries;
}
