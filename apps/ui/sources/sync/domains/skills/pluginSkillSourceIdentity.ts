import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { readPluginUiContributionOrigin, readPluginUiContributionSupplies } from '@/sync/domains/plugins/ui/projectionOrigins';

const skillSourceIdentity = Symbol('skillSourceIdentity');
/** A descriptive declaration revision, never an integrity digest or execution grant. */
export type PluginSkillSourceIdentity = Readonly<{ [skillSourceIdentity]: true }>;
const identity = (): PluginSkillSourceIdentity => Object.freeze({ [skillSourceIdentity]: true });
export const EMPTY_PLUGIN_SKILL_SOURCE_IDENTITY = identity();

/** Extends the declaration publication's existing Skills revision; retains only its current basis. */
export function createPluginSkillSourceIdentityPublication(skillIds?: readonly string[]) {
    let previousInput: PluginUiProjectionModel['skillsById'] | null | undefined;
    let previousFacts: readonly unknown[] = [];
    let current = EMPTY_PLUGIN_SKILL_SOURCE_IDENTITY;
    return {
        publish(projection: PluginUiProjectionModel | null): PluginSkillSourceIdentity {
            const input = projection?.skillsById ?? null;
            if (input === previousInput) return current;
            // Exactly the former revision's fields. Runtime generation is not a
            // Skills-content revision; keep it on the full source projection.
            const entries = skillIds ? skillIds.flatMap(id => input?.[id] ? [[id, input[id]] as const] : []) : Object.entries(input ?? {});
            const facts = entries.sort(([a], [b]) => a.localeCompare(b)).map(([id, entry]) => [
                id, entry.pluginVersion, entry.definition, entry.occurrenceId ?? null, entry.executionOrigin ?? null,
                readPluginUiContributionOrigin(entry)?.executionOrigin ?? null, Reflect.get(entry, 'hostCompatibility') ?? null,
                readPluginUiContributionSupplies(entry).map(supply => [supply.machineId, supply.serverId,
                    supply.occurrenceId, supply.pluginVersion, supply.executionOrigin, supply.phase, supply.interactionEnabled]),
            ]);
            if (!sameStrictJsonValue(previousFacts, facts)) current = identity();
            previousInput = input;
            previousFacts = facts;
            return current;
        },
    };
}
