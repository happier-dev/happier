import * as React from 'react';
import type { ReachMachine } from '@/sync/domains/capabilities/reach/useReachProjection';
import type { SkillsLibrary } from '@/sync/domains/skills/useSkillsLibrary';
import { buildSkillsReach, resolveSkillsPresent } from './skillsCollectionModel';
import { useSkillsNeedsALook } from './status/useSkillsNeedsALook';
import { useSkillsFirstRun } from './firstRun/useSkillsFirstRun';

/** Shared held reach/attention facts; recommendation demand belongs to its displayed shelf. */
export function useSkillsHomepageModel(library: SkillsLibrary, machines: readonly ReachMachine[]) {
    const reach = React.useMemo(() => buildSkillsReach(library.items, machines), [library.items, machines]);
    const needs = useSkillsNeedsALook(library, machines);
    const { firstVisit } = useSkillsFirstRun(library.items);
    const present = React.useMemo(() => resolveSkillsPresent({ items: library.items, reach, needs: needs.length, firstVisit }),
        [firstVisit, library.items, needs.length, reach]);
    return { reach, needs, firstVisit, present };
}
