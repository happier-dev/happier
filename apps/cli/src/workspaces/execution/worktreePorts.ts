import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { WorktreePortAssignmentV1Schema, type WorktreePortAssignmentV1, type WorktreePortsResultV1 } from '@happier-dev/protocol/workspaces/projectSetup/worktreePortsV1';

import { reserveLoopbackPort, type LoopbackPortReservation } from '@/cloud/loopbackPort';
import { configuration } from '@/configuration';
import { writeJsonAtomicSync } from '@/utils/fs/writeJsonAtomicSync';
import { resolveCanonicalAbsolutePath } from '@/utils/path/expandHomeDirPath';
import { currentWorkspaceSource } from '@/workspaces/source/workspaceSource';

export type WorktreePortAssignment = WorktreePortAssignmentV1;
export type WorktreePortsResult = WorktreePortsResultV1;

export type WorktreePortsDemand = Readonly<{
    rootPath: string;
    slots?: number;
    listenerKeys?: readonly string[];
    signal?: AbortSignal;
}>;

export interface WorktreePortsOwner {
    assign(input: WorktreePortsDemand): Promise<WorktreePortsResult>;
    read(input: Readonly<{ rootPath: string }>): Promise<WorktreePortsResult>;
    reassign(input: WorktreePortsDemand & Readonly<{ isActive: boolean }>): Promise<WorktreePortsResult>;
    /** The settled removal producer supplies the captured physical root, which may no longer exist. */
    release(input: Readonly<{ rootPath: string }>): Promise<WorktreePortsResult>;
}

const stateSchema = z.object({
    v: z.literal(1),
    assignments: z.record(z.string(), WorktreePortAssignmentV1Schema),
}).strict();
type State = z.infer<typeof stateSchema>;
type Unavailable = Extract<WorktreePortsResult, { kind: 'unavailable' }>;

function ready(assignment: WorktreePortAssignment = { ports: [], listenerPorts: {} }): WorktreePortsResult {
    return { kind: 'ready', assignment };
}

function unavailable(reason: Unavailable['reason'], error?: unknown): Unavailable {
    const causeCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code : undefined;
    return {
        kind: 'unavailable',
        code: reason === 'cancelled' ? 'cancelled'
            : reason === 'active' ? 'project_worktree_ports_active' : 'project_worktree_ports_unavailable',
        reason,
        ...(causeCode ? { causeCode } : {}),
    };
}

function rootIdentity(rootPath: string): string {
    const canonical = resolveCanonicalAbsolutePath(rootPath);
    if (!canonical) throw new Error('Execution root must be absolute');
    return canonical.comparisonKey;
}

async function physicalRootIdentity(rootPath: string): Promise<string> {
    const canonical = resolveCanonicalAbsolutePath(rootPath);
    if (!canonical) throw new Error('Execution root must be absolute');
    return rootIdentity(await currentWorkspaceSource().realpath(canonical.path));
}

/** One receiving daemon owns mutations; independent installations remain external bind contenders. */
export function createWorktreePortsOwner(input: Readonly<{ statePath: string }>): WorktreePortsOwner {
    let sequence: Promise<unknown> = Promise.resolve();

    function serialized(operation: () => Promise<WorktreePortsResult>): Promise<WorktreePortsResult> {
        const result = sequence.then(operation);
        sequence = result.catch(() => {});
        return result;
    }

    async function load(): Promise<State | Unavailable> {
        let bytes: string;
        try {
            bytes = await readFile(input.statePath, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { v: 1, assignments: {} };
            return unavailable('state_read_failed', error);
        }
        try {
            const state = stateSchema.parse(JSON.parse(bytes));
            const retained = new Set<number>();
            for (const [root, assignment] of Object.entries(state.assignments)) {
                if (rootIdentity(root) !== root) return unavailable('state_corrupt');
                for (const port of [...assignment.ports, ...Object.values(assignment.listenerPorts)]) {
                    if (retained.has(port)) return unavailable('state_corrupt');
                    retained.add(port);
                }
            }
            return state;
        } catch {
            return unavailable('state_corrupt');
        }
    }

    function save(state: State): Unavailable | null {
        try {
            writeJsonAtomicSync(input.statePath, state);
            return null;
        } catch (error) {
            return unavailable('state_write_failed', error);
        }
    }

    async function allocate(demand: WorktreePortsDemand, replace: boolean): Promise<WorktreePortsResult> {
        if (demand.signal?.aborted) return unavailable('cancelled');
        let root: string;
        try {
            root = await physicalRootIdentity(demand.rootPath);
        } catch (error) {
            return unavailable('root_unavailable', error);
        }
        const state = await load();
        if ('kind' in state) return state;
        const previous = state.assignments[root];
        const slots = replace ? demand.slots ?? previous?.ports.length ?? 0 : demand.slots ?? 0;
        const listenerKeys = replace ? demand.listenerKeys ?? Object.keys(previous?.listenerPorts ?? {})
            : demand.listenerKeys ?? [];
        const assignment: State['assignments'][string] = {
            ports: replace ? [] : [...previous?.ports ?? []],
            listenerPorts: replace ? {} : { ...previous?.listenerPorts },
        };
        const retained = new Set(Object.values(state.assignments).flatMap(value => [
            ...value.ports, ...Object.values(value.listenerPorts),
        ]));
        const reservations: LoopbackPortReservation[] = [];
        let changed = false;
        try {
            async function select(): Promise<number> {
                // TCP's external port space is finite; logical retention can exhaust it.
                if (retained.size === 65535) throw Object.assign(new Error('TCP port space retained'), { code: 'EADDRNOTAVAIL' });
                while (true) {
                    if (demand.signal?.aborted) throw demand.signal.reason;
                    const reservation = await reserveLoopbackPort('127.0.0.1', undefined, demand.signal);
                    if (retained.has(reservation.port)) {
                        await reservation.release();
                        if (demand.signal?.aborted) throw demand.signal.reason;
                        continue;
                    }
                    reservations.push(reservation);
                    retained.add(reservation.port);
                    if (demand.signal?.aborted) throw demand.signal.reason;
                    return reservation.port;
                }
            }
            while (assignment.ports.length < slots) {
                assignment.ports.push(await select());
                changed = true;
            }
            for (const key of listenerKeys) {
                if (Object.hasOwn(assignment.listenerPorts, key)) continue;
                assignment.listenerPorts[key] = await select();
                changed = true;
            }
            if (demand.signal?.aborted) return unavailable('cancelled');
            if (!changed && !replace) return ready(assignment);
            if (!previous && assignment.ports.length === 0 && Object.keys(assignment.listenerPorts).length === 0) return ready();
            state.assignments[root] = assignment;
            return save(state) ?? ready(assignment);
        } catch (error) {
            return unavailable(demand.signal?.aborted ? 'cancelled' : 'port_selection_failed', error);
        } finally {
            await Promise.all(reservations.map(reservation => reservation.release()));
        }
    }

    return {
        assign: demand => {
            // No Project/listener demand means no root resolution, state reads or OS selection.
            if (!(demand.slots && demand.slots > 0) && !demand.listenerKeys?.length) return Promise.resolve(ready());
            return serialized(() => allocate(demand, false));
        },
        reassign: demand => demand.isActive
            ? Promise.resolve(unavailable('active')) : serialized(() => allocate(demand, true)),
        read: request => serialized(async () => {
            let root: string;
            try { root = await physicalRootIdentity(request.rootPath); }
            catch (error) { return unavailable('root_unavailable', error); }
            const state = await load();
            return 'kind' in state ? state : ready(state.assignments[root]);
        }),
        release: request => serialized(async () => {
            let root: string;
            try { root = rootIdentity(request.rootPath); }
            catch (error) { return unavailable('root_unavailable', error); }
            const state = await load();
            if ('kind' in state) return state;
            if (!Object.hasOwn(state.assignments, root)) return ready();
            delete state.assignments[root];
            return save(state) ?? ready();
        }),
    };
}

let hostOwner: WorktreePortsOwner | undefined;

export function getHostWorktreePortsOwner(): WorktreePortsOwner {
    return hostOwner ??= createWorktreePortsOwner({ statePath: join(configuration.happyHomeDir, 'worktree-ports.json') });
}
