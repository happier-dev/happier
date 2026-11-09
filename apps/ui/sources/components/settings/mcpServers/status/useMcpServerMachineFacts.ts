import * as React from 'react';

import { projectReachOnMachines, type ReachMachine } from '@/sync/domains/capabilities/reach/useReachProjection';
import type { McpServerCollectionRow } from '../collection/mcpServerCollectionModel';
import type { McpServerStatusInput } from './mcpServerStatus';
import { useHeldMcpServerMachineTests } from './useMcpServerMachineTests';

const NO_TESTS = Object.freeze({});

/** Home and column consume the same reached Machines and held Tests; neither starts a Test. */
export function useMcpServerMachineFacts(machines: readonly ReachMachine[]) {
    const tests = useHeldMcpServerMachineTests();
    return React.useCallback((row: McpServerCollectionRow): Pick<McpServerStatusInput, 'tests' | 'machines'> => {
        const on = new Set(projectReachOnMachines(row.bindings, machines)
            .filter(place => place.agents.some(agent => agent.enabled)).map(place => place.machineId));
        return { tests: tests.get(row.server.id) ?? NO_TESTS,
            machines: machines.filter(machine => on.has(machine.machineId)).map(machine => ({
                machineId: machine.machineId, name: machine.name ?? machine.machineId, online: machine.online,
            })) };
    }, [machines, tests]);
}
