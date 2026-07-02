import { describe, expect, it } from 'vitest';

import type { Machine } from '@/sync/domains/state/storageTypes';
import {
    buildMachineResolutionContext,
    resolveSessionMachineRpcTarget,
    resolveSessionReachableMachineId,
} from '@/sync/domains/session/resolveSessionReachableMachineId';

function makeMachine(input: Readonly<{
    id: string;
    active: boolean;
    activeAt?: number;
    host?: string | null;
    replacedByMachineId?: string | null;
}>): Machine {
    return {
        id: input.id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: input.active,
        activeAt: input.activeAt ?? 0,
        revokedAt: null,
        replacedByMachineId: input.replacedByMachineId ?? null,
        metadata: input.host
            ? {
                host: input.host,
                platform: 'darwin',
                happyCliVersion: '0.0.0-test',
                happyHomeDir: '/tmp/.happier',
                homeDir: '/tmp',
            }
            : null,
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 1,
    };
}

describe('resolveSessionReachableMachineId', () => {
    it('returns the direct machine id when active', () => {
        const machines = [makeMachine({ id: 'm-offline', active: false }), makeMachine({ id: 'm-active', active: true })];

        expect(resolveSessionReachableMachineId({
            machineId: 'm-active',
            hostHint: null,
            machines,
        })).toBe('m-active');
    });

    it('does not resolve an offline direct machine by host', () => {
        const machines = [
            makeMachine({ id: 'm-old', active: false, activeAt: 10, host: 'mbp.local' }),
            makeMachine({ id: 'm-new', active: true, activeAt: 100, host: 'mbp.local' }),
        ];

        expect(resolveSessionReachableMachineId({
            machineId: 'm-old',
            hostHint: 'mbp.local',
            machines,
        })).toBeNull();
    });

    it('resolves an explicitly replaced machine to its active replacement', () => {
        const machines = [
            makeMachine({ id: 'm-old', active: false, activeAt: 10, host: 'MBP.local', replacedByMachineId: 'm-new' }),
            makeMachine({ id: 'm-new', active: true, activeAt: 100, host: 'other-host' }),
        ];

        expect(resolveSessionReachableMachineId({
            machineId: 'm-old',
            hostHint: 'MBP.local',
            machines,
        })).toBe('m-new');
    });

    it('does not resolve host-scoped ids to the best matching machine', () => {
        const machines = [
            makeMachine({ id: 'm-a', active: true, activeAt: 50, host: 'dev-host' }),
            makeMachine({ id: 'm-b', active: true, activeAt: 150, host: 'dev-host' }),
        ];

        expect(resolveSessionReachableMachineId({
            machineId: 'host:dev-host',
            hostHint: null,
            machines,
        })).toBeNull();
    });

    it('does not resolve unknown direct machine ids', () => {
        const machines = [makeMachine({ id: 'm-1', active: true, host: 'other-host' })];

        expect(resolveSessionReachableMachineId({
            machineId: 'm-missing',
            hostHint: null,
            machines,
        })).toBeNull();
    });
});

describe('resolveSessionMachineRpcTarget', () => {
    it('does not resolve machine id from peer sessions sharing the same path', () => {
        const machines = [
            makeMachine({ id: 'm-primary', active: true, activeAt: 200, host: 'mbp.local' }),
            makeMachine({ id: 'm-other', active: true, activeAt: 100, host: 'other.local' }),
        ];

        const target = resolveSessionMachineRpcTarget({
            sessionId: 's-current',
            sessionMachineId: null,
            sessionHostHint: null,
            sessionPath: '~/repo',
            sessionHomeDir: '/Users/tester',
            projectMachineId: null,
            projectPath: null,
            machineResolutionContext: buildMachineResolutionContext(machines),
            peerSessions: [
                {
                    id: 's-peer',
                    active: true,
                    machineId: 'm-primary',
                    hostHint: 'mbp.local',
                    path: '/Users/tester/repo',
                    homeDir: '/Users/tester',
                },
            ],
        });

        expect(target).toBeNull();
    });

    it('does not fall back to the only active machine when no ids are available', () => {
        const machines = [
            makeMachine({ id: 'm-active', active: true, activeAt: 10, host: 'mbp.local' }),
            makeMachine({ id: 'm-offline', active: false, activeAt: 1, host: 'old.local' }),
        ];

        const target = resolveSessionMachineRpcTarget({
            sessionId: 's-current',
            sessionMachineId: null,
            sessionHostHint: null,
            sessionPath: '/workspace/repo',
            sessionHomeDir: null,
            projectMachineId: null,
            projectPath: null,
            machineResolutionContext: buildMachineResolutionContext(machines),
            peerSessions: [],
        });

        expect(target).toBeNull();
    });
});
