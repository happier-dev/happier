import type { SkillFoundListResultV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';

type FoundSkill = SkillFoundListResultV1['items'][number];
export type FoundSkillOccurrence = Readonly<{ machineId: string; item: FoundSkill }>;

/** A skill kept in several native folders or on several machines is one named choice. */
export function* foundSkillsByName(
  machineIds: readonly string[],
  results: Readonly<Record<string, Readonly<{ items: readonly FoundSkill[] }> | null>>,
  include: (item: FoundSkill) => boolean,
): IterableIterator<FoundSkillOccurrence> {
  const names = new Set<string>();
  for (const machineId of machineIds) {
    for (const item of results[machineId]?.items ?? []) {
      if (!include(item) || names.has(item.name)) continue;
      names.add(item.name);
      yield { machineId, item };
    }
  }
}
