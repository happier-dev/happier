import { describe, expect, it } from 'vitest';

import {
    resolveDisplayIdentityForSessionFromState,
    type SessionMachineTargetState,
} from '@/sync/ops/sessionMachineTarget';
import { decodeSessionRecentPathEntry, encodeSessionRecentPathEntry } from '@/utils/sessions/recentPathEntries';

import { buildSessionRecentPathEntries } from './sessionRecentPathEntries';

/**
 * The projection the `useSessionRecentPathEntries` selector performed inline, reproduced verbatim.
 * Every case below asserts the extracted builder emits exactly what that did — that is the whole
 * correctness contract, because this decides the machine and path a session row shows.
 */
function deriveEntriesTheWaySelectorDid(state: SessionMachineTargetState): string[] {
    const entries: Array<{ key: string; createdAt: number }> = [];
    for (const [sessionId, session] of Object.entries(state.sessions ?? {})) {
        const { machineId, basePath: path } = resolveDisplayIdentityForSessionFromState({
            state,
            sessionId,
            metadata: session.metadata ?? null,
        });
        if (!machineId || !path) continue;
        const createdAt = (session as { createdAt?: number }).createdAt || 0;
        entries.push({
            key: encodeSessionRecentPathEntry({ sessionId, machineId, path, createdAt }),
            createdAt,
        });
    }
    return entries.sort((a, b) => b.createdAt - a.createdAt).map((entry) => entry.key);
}

function readIdentities(entries: readonly string[]): Array<{ sessionId: string; machineId: string; path: string }> {
    return entries.map((entry) => {
        const decoded = decodeSessionRecentPathEntry(entry);
        if (!decoded) throw new Error(`undecodable recent-path entry: ${entry}`);
        return { sessionId: decoded.sessionId, machineId: decoded.machineId, path: decoded.path };
    });
}

type StateInput = Readonly<{
    sessions: Record<string, unknown>;
    machines: Record<string, unknown>;
    projects?: Record<string, { machineId: string; path: string }>;
}>;

function buildState(input: StateInput): SessionMachineTargetState {
    return {
        sessions: input.sessions,
        machines: input.machines,
        getProjectForSession: (sessionId: string) => {
            const key = input.projects?.[sessionId];
            return key ? { key } : null;
        },
    } as SessionMachineTargetState;
}

const baseSessions = {
    's-1': { active: true, createdAt: 30, metadata: { machineId: 'm-1', path: '/repo/one' } },
    's-2': { active: true, createdAt: 20, metadata: { machineId: 'm-2', path: '/repo/two' } },
    's-3': { active: false, createdAt: 10, metadata: { machineId: 'm-1', path: '/repo/three' } },
};

const baseMachines = {
    'm-1': { id: 'm-1', active: true, metadata: { displayName: 'Laptop', host: 'laptop', homeDir: '/home/u' } },
    'm-2': { id: 'm-2', active: true, metadata: { displayName: 'Desktop', host: 'desktop', homeDir: '/home/u' } },
};

describe('session recent-path projection', () => {
    it('emits newest session first, one entry per resolvable session', () => {
        const entries = buildSessionRecentPathEntries(buildState({
            sessions: baseSessions,
            machines: baseMachines,
        }));

        expect(readIdentities(entries)).toEqual([
            { sessionId: 's-1', machineId: 'm-1', path: '/repo/one' },
            { sessionId: 's-2', machineId: 'm-2', path: '/repo/two' },
            { sessionId: 's-3', machineId: 'm-1', path: '/repo/three' },
        ]);
    });

    it.each([
        [
            'a machine renamed',
            buildState({
                sessions: baseSessions,
                machines: {
                    ...baseMachines,
                    'm-1': { ...baseMachines['m-1'], metadata: { ...baseMachines['m-1'].metadata, displayName: 'Studio' } },
                },
            }),
        ],
        [
            'a machine going offline',
            buildState({
                sessions: baseSessions,
                machines: { ...baseMachines, 'm-1': { ...baseMachines['m-1'], active: false } },
            }),
        ],
        [
            'a session moving machines',
            buildState({
                sessions: {
                    ...baseSessions,
                    's-2': { active: true, createdAt: 20, metadata: { machineId: 'm-1', path: '/repo/moved' } },
                },
                machines: baseMachines,
                projects: { 's-2': { machineId: 'm-2', path: '/repo/two' } },
            }),
        ],
        [
            'an id that normalises to its replacement',
            buildState({
                sessions: baseSessions,
                machines: {
                    ...baseMachines,
                    'm-1': { ...baseMachines['m-1'], replacedByMachineId: 'm-3' },
                    'm-3': { id: 'm-3', active: true, metadata: { displayName: 'Laptop 2' } },
                },
            }),
        ],
        [
            'an orphaned replacement target',
            buildState({
                sessions: baseSessions,
                machines: {
                    ...baseMachines,
                    'm-1': { ...baseMachines['m-1'], replacedByMachineId: 'm-gone' },
                },
            }),
        ],
        [
            'a session on a machine this viewer does not know',
            buildState({
                sessions: {
                    ...baseSessions,
                    's-4': { active: true, createdAt: 40, metadata: { machineId: 'm-unknown', path: '/repo/four' } },
                },
                machines: baseMachines,
            }),
        ],
        [
            'a session with no machine id at all',
            buildState({
                sessions: { ...baseSessions, 's-5': { active: false, createdAt: 5, metadata: { path: '/repo/five' } } },
                machines: baseMachines,
            }),
        ],
        [
            'an inactive session whose path only the project knows',
            buildState({
                sessions: { 's-6': { active: false, createdAt: 6, metadata: { machineId: 'm-1' } } },
                machines: baseMachines,
                projects: { 's-6': { machineId: 'm-1', path: '/repo/from-project' } },
            }),
        ],
        [
            'a session linked through directSessionV1 instead of a top-level machine id',
            buildState({
                sessions: {
                    's-7': {
                        active: true,
                        createdAt: 7,
                        metadata: { path: '/repo/seven', directSessionV1: { v: 1, machineId: 'm-2', providerId: 'claude' } },
                    },
                },
                machines: baseMachines,
            }),
        ],
    ])('shows what the selector-side projection showed for %s', (_case, state) => {
        expect(buildSessionRecentPathEntries(state)).toEqual(deriveEntriesTheWaySelectorDid(state));
    });
});
