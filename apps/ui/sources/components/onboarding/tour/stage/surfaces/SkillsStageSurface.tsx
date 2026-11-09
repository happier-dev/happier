import * as React from 'react';

import { SkillsListView } from '@/components/settings/skills/SkillsRail';
import type { SkillsHomeReach } from '@/components/settings/skills/SkillsHomeOverview';
import { buildDemoSkillMachines, buildDemoSkillsLibrary } from '@/demoMode/world/skills';

/** The production Skills collection with a synthetic personal Library. */
export function SkillsStageSurface(): React.ReactElement {
    const library = React.useMemo(buildDemoSkillsLibrary, []);
    const reach = React.useMemo<SkillsHomeReach>(() => {
        const machines = buildDemoSkillMachines();
        return {
            machines,
            placeMachines: machines.map(machine => ({ machineId: machine.machineId, name: machine.name! })),
            agentIds: [...new Set(machines.flatMap(machine => machine.agentIds))],
        };
    }, []);
    return <SkillsListView variant="page" library={library} reach={reach} />;
}
