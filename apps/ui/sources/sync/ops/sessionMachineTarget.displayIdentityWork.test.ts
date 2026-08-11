import { describe, expect, it, vi } from 'vitest';

import { resolveDisplayIdentityForSessionFromState, type SessionMachineTargetState } from './sessionMachineTarget';
import { resolveCanonicalMachineId } from '@/sync/domains/machines/identity/resolveCanonicalMachineId';
import { resolveSessionDisplayTarget } from '@/sync/domains/machines/identity/resolveSessionMachineTargets';

/**
 * The store write path resolves a display target once per session, so anything this resolution
 * allocates is multiplied by the session count on every store update. These are work counts, not
 * timings: they stay true under any machine load.
 */
function countMapConstructions(run: () => void): number {
    const RealMap = globalThis.Map;
    let constructions = 0;
    class CountingMap<K, V> extends RealMap<K, V> {
        constructor(entries?: Iterable<readonly [K, V]> | null) {
            super(entries);
            constructions += 1;
        }
    }
    (globalThis as { Map: unknown }).Map = CountingMap;
    try {
        run();
    } finally {
        (globalThis as { Map: unknown }).Map = RealMap;
    }
    return constructions;
}

function buildMachinesById(count: number): Record<string, { id: string; active: boolean }> {
    const machines: Record<string, { id: string; active: boolean }> = {};
    for (let index = 0; index < count; index += 1) {
        const id = `m-${index}`;
        machines[id] = { id, active: true };
    }
    return machines;
}

function buildState(input: Readonly<{
    sessionCount: number;
    machineCount: number;
    getProjectForSession?: (sessionId: string) => { key?: { machineId?: string; path?: string } } | null;
}>): SessionMachineTargetState {
    const sessions: Record<string, { active: boolean; metadata: { machineId: string; path: string } }> = {};
    for (let index = 0; index < input.sessionCount; index += 1) {
        sessions[`s-${index}`] = {
            active: true,
            metadata: {
                machineId: `m-${index % input.machineCount}`,
                path: `/repo/${index}`,
            },
        };
    }
    return {
        sessions,
        machines: buildMachinesById(input.machineCount),
        getProjectForSession: input.getProjectForSession ?? (() => null),
    } as SessionMachineTargetState;
}

describe('session display identity resolution work', () => {
    it('builds no machine index while resolving every session on a store update', () => {
        const sessionCount = 40;
        const state = buildState({ sessionCount, machineCount: 8 });

        const resolved: string[] = [];
        const constructions = countMapConstructions(() => {
            for (let index = 0; index < sessionCount; index += 1) {
                const sessionId = `s-${index}`;
                const identity = resolveDisplayIdentityForSessionFromState({
                    state,
                    sessionId,
                    metadata: state.sessions?.[sessionId]?.metadata ?? null,
                });
                resolved.push(`${identity.machineId}:${identity.basePath}`);
            }
        });

        // The store already holds machines as an id-keyed record; rebuilding an index per session
        // is what made this O(sessions x machines) on the hottest write path.
        expect(constructions).toBe(0);
        expect(resolved[0]).toBe('m-0:/repo/0');
        expect(resolved[sessionCount - 1]).toBe(`m-${(sessionCount - 1) % 8}:/repo/${sessionCount - 1}`);
    });

    it('resolves each session once when a caller needs both the machine id and the path', () => {
        const getProjectForSession = vi.fn(() => null);
        const state = buildState({ sessionCount: 6, machineCount: 3, getProjectForSession });

        for (let index = 0; index < 6; index += 1) {
            resolveDisplayIdentityForSessionFromState({
                state,
                sessionId: `s-${index}`,
                metadata: state.sessions?.[`s-${index}`]?.metadata ?? null,
            });
        }

        // Two per session means the machine id and the path each ran their own full resolution.
        expect(getProjectForSession).toHaveBeenCalledTimes(6);
    });
});

describe('machine collection shapes resolve identically', () => {
    const machinesById = {
        'm-plain': { id: 'm-plain', active: true },
        'm-old': { id: 'm-old', active: true, replacedByMachineId: 'm-new' },
        'm-new': { id: 'm-new', active: true },
        'm-orphan': { id: 'm-orphan', active: true, replacedByMachineId: 'm-gone' },
    } as const;
    const machineList = Object.values(machinesById);

    it.each([
        ['m-plain'],
        ['m-old'],
        ['m-orphan'],
        ['m-missing'],
        ['host:legacy'],
    ])('canonicalises %s the same from a record and from a list', (machineId) => {
        expect(resolveCanonicalMachineId(machineId, machinesById))
            .toEqual(resolveCanonicalMachineId(machineId, machineList));
    });

    it('resolves the replacement chain and reports the reason', () => {
        expect(resolveCanonicalMachineId('m-old', machinesById)).toEqual({
            machineId: 'm-new',
            reason: 'replacement',
            chain: ['m-old', 'm-new'],
        });
        expect(resolveCanonicalMachineId('m-orphan', machinesById)).toEqual({
            machineId: 'm-orphan',
            reason: 'missingReplacementTarget',
            chain: ['m-orphan'],
        });
    });

    it.each([
        ['constructor'],
        ['toString'],
        ['__proto__'],
    ])('treats the inherited property %s as an unknown machine, exactly as a list does', (machineId) => {
        expect(resolveCanonicalMachineId(machineId, machinesById))
            .toEqual(resolveCanonicalMachineId(machineId, machineList));
    });

    it('resolves a machine by its own id, not by the key it happens to be filed under', () => {
        const misfiled = { 'not-its-id': { id: 'm-old', active: true, replacedByMachineId: 'm-new' } };

        // A list finds nothing under 'not-its-id' because it matches on `machine.id`; the record
        // form answers the same rather than canonicalising a machine it was asked about by a key.
        expect(resolveCanonicalMachineId('not-its-id', misfiled)).toEqual(
            resolveCanonicalMachineId('not-its-id', Object.values(misfiled)),
        );
        expect(resolveCanonicalMachineId('not-its-id', misfiled)).toEqual({
            machineId: 'not-its-id',
            reason: 'direct',
            chain: ['not-its-id'],
        });
    });

    it('resolves the same display target from a record and from a list', () => {
        const input = {
            sessionActive: true,
            sessionMachineId: 'm-old',
            sessionPath: '/repo',
            projectMachineId: null,
            projectPath: null,
        } as const;

        const fromRecord = resolveSessionDisplayTarget({ ...input, machines: machinesById as never });
        const fromList = resolveSessionDisplayTarget({ ...input, machines: machineList as never });

        expect(fromRecord).toEqual(fromList);
        expect(fromRecord).toEqual({
            machineId: 'm-new',
            basePath: '/repo',
            originMachineId: 'm-old',
            replaced: true,
        });
    });
});
