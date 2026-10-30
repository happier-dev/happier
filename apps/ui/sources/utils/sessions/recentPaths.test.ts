import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Machine, Session } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';

import { getRecentPathsForMachine } from './recentPaths';

function createMachine(id: string, overrides: Partial<Machine> = {}): Machine {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 10,
        revokedAt: null,
        metadata: {
            host: 'host.local',
            platform: 'darwin',
            happyCliVersion: '0.0.0-test',
            happyHomeDir: '/Users/test/.happier',
            homeDir: '/Users/test',
        },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 1,
        ...overrides,
    };
}

function createSession(input: Readonly<{
    id: string;
    machineId: string;
    path: string;
    updatedAt?: number;
    active?: boolean;
}>): Session {
    return {
        id: input.id,
        seq: 1,
        createdAt: 1,
        updatedAt: input.updatedAt ?? 1,
        active: input.active ?? true,
        activeAt: 1,
        metadata: {
            machineId: input.machineId,
            path: input.path,
            homeDir: '/Users/test',
            host: 'host.local',
            flavor: 'claude',
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    };
}

function replacedBy(targetMachineId: string): Partial<Machine> {
    return {
        active: false,
        activeAt: 1,
        replacedByMachineId: targetMachineId,
        replacedAt: 100,
        replacementReason: 'manual_repair',
        replacementSource: 'manual',
    };
}

describe('getRecentPathsForMachine', () => {
    let previousState: ReturnType<typeof storage.getState>;
    beforeEach(() => {
        previousState = storage.getState();
        storage.setState({
            sessions: {},
            machines: { 'machine-target': createMachine('machine-target') },
            sessionListRowsByServerId: {},
            machineListByServerId: {},
        });
    });
    afterEach(() => storage.setState(previousState, true));

    it('includes paths from explicitly replaced old machines for the current machine', () => {
        const session = createSession({
            id: 'session-1',
            machineId: 'machine-old',
            path: '/Users/test/workspace/stale',
            updatedAt: 25,
            active: false,
        });
        // Another host: only the explicit replacement, not same-locality routing, can attribute the path.
        const target = createMachine('machine-target');
        storage.setState({
            machines: {
                'machine-old': createMachine('machine-old', replacedBy('machine-target')),
                'machine-target': { ...target, metadata: { ...target.metadata!, host: 'target.local' } },
            },
            sessions: { 'session-1': session },
        });

        expect(getRecentPathsForMachine({
            machineId: 'machine-target',
            recentMachinePaths: [],
            sessions: [session],
        })).toEqual(['/Users/test/workspace/stale']);
    });

    it('does not attribute a stale machine\'s session to a same-host machine with an empty home', () => {
        const session = createSession({
            id: 'session-1',
            machineId: 'machine-old',
            path: '/Users/test/workspace/stale',
            updatedAt: 25,
            active: false,
        });
        // Same host but an empty homeDir: locality is unknown, so neither replacement nor same-locality routing applies.
        const target = createMachine('machine-target');
        storage.setState({
            machines: {
                'machine-old': createMachine('machine-old', { active: false, activeAt: 1 }),
                'machine-target': { ...target, metadata: { ...target.metadata!, homeDir: '' } },
            },
            sessions: { 'session-1': session },
        });

        expect(getRecentPathsForMachine({
            machineId: 'machine-target',
            recentMachinePaths: [],
            sessions: [session],
        })).toEqual([]);
    });

    it('canonicalizes local recent path entries through explicit machine replacement', () => {
        storage.setState({
            machines: {
                'machine-old': createMachine('machine-old', replacedBy('machine-target')),
                'machine-target': createMachine('machine-target'),
            },
        });

        expect(getRecentPathsForMachine({
            machineId: 'machine-target',
            recentMachinePaths: [{ machineId: 'machine-old', path: '/Users/test/workspace/local' }],
            sessions: [],
        })).toEqual(['/Users/test/workspace/local']);
    });

    it('keeps recent paths stable when same-host activeAt values flip', () => {
        const session = createSession({
            id: 'session-1',
            machineId: 'machine-b',
            path: '/Users/test/workspace/other',
            updatedAt: 25,
        });
        const recentMachinePaths = [{ machineId: 'machine-target', path: '/Users/test/workspace/current' }];
        storage.setState({
            machines: {
                'machine-target': createMachine('machine-target', { activeAt: 100 }),
                'machine-b': createMachine('machine-b', { activeAt: 200 }),
            },
            sessions: { 'session-1': session },
        });

        const first = getRecentPathsForMachine({ machineId: 'machine-target', recentMachinePaths, sessions: [session] });

        storage.setState({
            machines: {
                'machine-target': createMachine('machine-target', { activeAt: 300 }),
                'machine-b': createMachine('machine-b', { activeAt: 100 }),
            },
        });

        const second = getRecentPathsForMachine({ machineId: 'machine-target', recentMachinePaths, sessions: [session] });

        expect(first).toEqual(['/Users/test/workspace/current']);
        expect(second).toEqual(first);
    });

    it('never offers a no-folder session’s private folder as a recent folder', () => {
        const folder = createSession({ id: 'folder', machineId: 'machine-target', path: '/Users/test/repo', updatedAt: 5 });
        const chat = createSession({ id: 'chat', machineId: 'machine-target', path: '/Users/test/.happier/servers/s/session-directories/abc', updatedAt: 9 });
        const managedChat: Session = { ...chat, metadata: { ...chat.metadata!, sessionDirectoryV1: { v: 1, kind: 'managed' } } as Session['metadata'] };

        const paths = getRecentPathsForMachine({
            machineId: 'machine-target',
            recentMachinePaths: [],
            sessions: [folder, managedChat],
            preferProvidedSessionMetadata: true,
        });

        expect(paths).toEqual(['/Users/test/repo']);
    });
});
