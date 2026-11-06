import type { Machine } from '@/sync/domains/state/storageTypes';
import { carryMachineActivity } from '@/sync/domains/machines/machineActivity';
import { isMachineVisibleForSelection } from '@/sync/domains/machines/identity/filterVisibleMachines';
import { resolveServerScopedMachineInventoryKeys } from '@/sync/domains/machines/resolveServerScopedMachines';
import { areMachineFactsEqual, areMachineLaunchInputsEqual } from './domains/areStoredMachinesEqual';
import { resolveVisibleMachinesForActiveServerFromState } from './domains/machines/resolveMachinesForActiveServerFromState';
import type { StorageState } from './types';

type Purpose = 'facts' | 'launch';
type Lists = Record<string, Machine[] | null>;

function createProjection(equal: (previous: Machine, next: Machine) => boolean) {
    const rows = new WeakMap<Machine, Machine>();
    const lists = new WeakMap<Machine[], Machine[]>();
    const homes = new Map<string, Machine[] | null>();
    let all: { input: Lists; value: Lists } | undefined;
    let active: Machine[] | undefined;

    const project = (input: Machine[], previous: Machine[] | null | undefined): Machine[] => {
        const cached = lists.get(input);
        if (cached) return cached;
        const visible = input.filter(isMachineVisibleForSelection);
        const next = visible.map((machine, index) => {
            const cached = rows.get(machine);
            if (cached) return cached;
            const held = previous?.[index];
            const value = held && held.id === machine.id && equal(held, machine) ? held : machine;
            if (value !== machine) carryMachineActivity(value, machine);
            rows.set(machine, value);
            return value;
        });
        const value = previous && previous.length === next.length && next.every((machine, index) => machine === previous[index])
            ? previous : visible.length === input.length && next.every((machine, index) => machine === input[index]) ? input : next;
        lists.set(input, value);
        return value;
    };
    const home = (key: string, input: Machine[] | null): Machine[] | null => {
        const value = input ? project(input, homes.get(key)) : null;
        homes.set(key, value);
        return value;
    };
    return {
        home,
        all(input: Lists): Lists {
            if (all?.input === input) return all.value;
            const entries = Object.entries(input).map(([key, machines]) => [key, home(key, machines)] as const);
            const previous = all?.value;
            const value = previous && entries.length === Object.keys(previous).length
                && entries.every(([key, machines]) => Object.hasOwn(previous, key) && previous[key] === machines)
                ? previous : Object.fromEntries(entries);
            for (const key of homes.keys()) if (!Object.hasOwn(input, key)) homes.delete(key);
            all = { input, value };
            return value;
        },
        active(input: Machine[]): Machine[] {
            active = project(input, active);
            return active;
        },
    };
}

function createOwner() {
    let serverId: string | undefined;
    let accountId: string | undefined;
    let projections = { facts: createProjection(areMachineFactsEqual), launch: createProjection(areMachineLaunchInputsEqual) };
    const projection = (state: StorageState, purpose: Purpose) => {
        const scope = state.profileScope;
        if (serverId !== scope?.serverId || accountId !== scope?.accountId) {
            serverId = scope?.serverId;
            accountId = scope?.accountId;
            projections = { facts: createProjection(areMachineFactsEqual), launch: createProjection(areMachineLaunchInputsEqual) };
        }
        return projections[purpose];
    };
    return {
        lists(state: StorageState, purpose: Purpose): Lists {
            return projection(state, purpose).all(state.machineListByServerId);
        },
        home(state: StorageState, serverId: string, purpose: Purpose): Machine[] | null {
            const selected = projection(state, purpose);
            const inventory = state.machineListByServerId;
            for (const key of resolveServerScopedMachineInventoryKeys({ serverId, machineListByServerId: inventory })) {
                const machines = inventory[key];
                if (machines) return selected.home(key, machines);
            }
            return null;
        },
        active(state: StorageState, purpose: Purpose): Machine[] {
            const selected = projection(state, purpose);
            return selected.active(resolveVisibleMachinesForActiveServerFromState(state));
        },
    };
}

const owners = new WeakMap<object, ReturnType<typeof createOwner>>();

/** One per-store presentation owner; consumers only hold its snapshots while hidden. Raw inventory remains live. */
export function machineInventoryPresentation(store: object): ReturnType<typeof createOwner> {
    let owner = owners.get(store);
    if (!owner) { owner = createOwner(); owners.set(store, owner); }
    return owner;
}
