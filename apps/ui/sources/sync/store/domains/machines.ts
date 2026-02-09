import type { Machine, Session } from '../../storageTypes';
import type { Settings } from '../../settings';
import type { SessionListViewItem } from '../../sessionListViewData';
import { buildSessionListViewDataWithServerScope } from '../buildSessionListViewDataWithServerScope';
import { setActiveServerSessionListCache } from '../sessionListCache';

import type { StoreGet, StoreSet } from './_shared';

export type MachinesDomain = {
    machines: Record<string, Machine>;
    applyMachines: (machines: Machine[], replace?: boolean) => void;
};

type MachinesDomainDependencies = Readonly<{
    sessions: Record<string, Session>;
    settings: Settings;
    sessionListViewData: SessionListViewItem[] | null;
    sessionListViewDataByServerId: Record<string, SessionListViewItem[] | null>;
}>;

export function createMachinesDomain<S extends MachinesDomain & MachinesDomainDependencies>({
    set,
}: {
    set: StoreSet<S>;
    get: StoreGet<S>;
}): MachinesDomain {
    return {
        machines: {},
        applyMachines: (machines, replace = false) =>
            set((state) => {
                let mergedMachines: Record<string, Machine>;

                if (replace) {
                    mergedMachines = {};
                    machines.forEach((machine) => {
                        mergedMachines[machine.id] = machine;
                    });
                } else {
                    mergedMachines = { ...state.machines };
                    machines.forEach((machine) => {
                        mergedMachines[machine.id] = machine;
                    });
                }

                const sessionListViewData = buildSessionListViewDataWithServerScope({
                    sessions: state.sessions,
                    machines: mergedMachines,
                    groupInactiveSessionsByProject: state.settings.groupInactiveSessionsByProject,
                });

                return {
                    ...state,
                    machines: mergedMachines,
                    sessionListViewData,
                    sessionListViewDataByServerId: setActiveServerSessionListCache(
                        state.sessionListViewDataByServerId,
                        sessionListViewData,
                    ),
                };
            }),
    };
}
