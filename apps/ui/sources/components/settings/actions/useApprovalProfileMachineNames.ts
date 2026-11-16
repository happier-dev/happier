import * as React from 'react';

import { useAllMachines } from '@/sync/store/hooks';
import { getSettledMachineDisplayName } from '@/utils/sessions/machineDisplayNames';

const SEPARATOR = '\u0000';

/** Each visible Machine as one `id\0name` string, so an unchanged inventory keeps its identity under shallow compare. */
function selectMachineNameRows(machines: readonly Parameters<typeof getSettledMachineDisplayName>[0][]): string[] {
    return machines.map(machine => `${machine?.id ?? ''}${SEPARATOR}${getSettledMachineDisplayName(machine) ?? machine?.id ?? ''}`);
}

/** The Account's Machines by name, and which of them default my Sessions to a given profile. */
export function useApprovalProfileMachineNames(machineApprovalProfiles: Readonly<Record<string, string>> | undefined) {
    const rows = useAllMachines(selectMachineNameRows);
    return React.useMemo(() => {
        const all = rows.map(row => {
            const [id = '', name = ''] = row.split(SEPARATOR);
            return { id, name };
        }).filter(machine => machine.id.length > 0).sort((left, right) => left.name.localeCompare(right.name));
        const defaultOn = (profileId: string) => all
            .filter(machine => machineApprovalProfiles?.[machine.id] === profileId).map(machine => machine.name);
        return { all, defaultOn };
    }, [machineApprovalProfiles, rows]);
}
