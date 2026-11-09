import type { SkillListItemV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import type { CapabilityStatus } from '@/components/capabilities/status/capabilityStatusPresentation';
import { pickMostBlockingCapabilityStatus } from '@/components/capabilities/status/capabilityStatusPresentation';
import { defineSettingsCollectionAdapter, type SettingsCollectionRowFacts } from '../shell/settingsCollectionAdapter';
import { skillDisplayName } from './skillsCollectionModel';

export const skillsColumnAdapter = defineSettingsCollectionAdapter(['source', 'machine', 'maker']);

/** Source ids and Reach Machine ids are held producer facts, never parsed from a display label. */
export function skillColumnFacts(item: SkillListItemV1, input: Readonly<{
    sourceIds: readonly string[] | null;
    machineIds: readonly string[] | null;
    makerIds?: readonly string[];
    statuses: readonly CapabilityStatus[];
}>): SettingsCollectionRowFacts<'source' | 'machine' | 'maker'> {
    return { key: item.skillId, title: skillDisplayName(item.name, item.skillId), context: item.description ?? null,
        status: pickMostBlockingCapabilityStatus(input.statuses)?.kind ?? null,
        fields: { source: input.sourceIds, machine: input.machineIds, maker: input.makerIds ?? ['anyone'] } };
}
