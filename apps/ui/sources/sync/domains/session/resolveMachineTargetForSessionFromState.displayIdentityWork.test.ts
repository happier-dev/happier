import { describe, expect, it, vi } from 'vitest';

import { resolveDisplayIdentityForSessionFromState } from './resolveMachineTargetForSessionFromState';
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

function buildState(input: Readonly<{
    sessionCount: number;
    machineCount: number;
    getProjectForSession?: (sessionId: string) => { key?: { machineId?: string; rootPath?: string } } | null;
}>) {
    const sessions: Record<string, unknown> = {};
    for (let index = 0; index < input.sessionCount; index += 1) {
        sessions[`s-${index}`] = {
            active: true,
            updatedAt: 1,
            metadata: {
                machineId: `m-${index % input.machineCount}`,
                path: `/repo/${index}`,
            },
            ownerMetadataView: null,
        };
    }
    const machines: Record<string, unknown> = {};
    for (let index = 0; index < input.machineCount; index += 1) {
        machines[`m-${index}`] = { id: `m-${index}`, active: true, activeAt: 1 };
    }
    return {
        sessions,
        machines,
        getProjectForSession: input.getProjectForSession ?? (() => null),
    };
}

function resolveEverySession(sessionCount: number): Readonly<{ constructions: number; resolved: string[] }> {
    const state = buildState({ sessionCount, machineCount: 8 });
    const resolved: string[] = [];
    const constructions = countMapConstructions(() => {
        for (let index = 0; index < sessionCount; index += 1) {
            const identity = resolveDisplayIdentityForSessionFromState({
                state: state as never,
                sessionId: `s-${index}`,
                metadata: { machineId: `m-${index % 8}`, path: `/repo/${index}` },
            });
            resolved.push(`${identity.machineId}:${identity.basePath}`);
        }
    });
    return { constructions, resolved };
}

describe('session display identity resolution work', () => {
    it('does not build a machine index per session on a store update', () => {
        const small = resolveEverySession(10);
        const large = resolveEverySession(80);

        // Rebuilding the index per session is what made this O(sessions x machines) on the hottest
        // write path; the index work must not grow with the session count.
        expect(large.constructions).toBe(small.constructions);
        expect(large.resolved[0]).toBe('m-0:/repo/0');
        expect(large.resolved[79]).toBe('m-7:/repo/79');
    });

    it('resolves each session once when a caller needs both the machine id and the path', () => {
        const getProjectForSession = vi.fn(() => null);
        const state = buildState({ sessionCount: 6, machineCount: 3, getProjectForSession });

        for (let index = 0; index < 6; index += 1) {
            resolveDisplayIdentityForSessionFromState({
                state: state as never,
                sessionId: `s-${index}`,
                metadata: { machineId: `m-${index % 3}`, path: `/repo/${index}` },
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
    const machineMap = new Map(machineList.map((machine) => [machine.id, machine] as const));

    it.each([
        ['m-plain'],
        ['m-old'],
        ['m-orphan'],
        ['m-missing'],
        ['host:legacy'],
        ['constructor'],
        ['__proto__'],
    ])('canonicalises %s the same from a record, a list and a map', (machineId) => {
        const fromList = resolveCanonicalMachineId(machineId, machineList);
        expect(resolveCanonicalMachineId(machineId, machinesById)).toEqual(fromList);
        expect(resolveCanonicalMachineId(machineId, machineMap)).toEqual(fromList);
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

    it('resolves a machine by its own id, not by the key it happens to be filed under', () => {
        const misfiled = { 'not-its-id': { id: 'm-old', active: true, replacedByMachineId: 'm-new' } };

        expect(resolveCanonicalMachineId('not-its-id', misfiled)).toEqual(
            resolveCanonicalMachineId('not-its-id', Object.values(misfiled)),
        );
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
