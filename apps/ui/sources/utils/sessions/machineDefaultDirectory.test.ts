import { describe, expect, it } from 'vitest';

import type { Machine } from '@/sync/domains/state/storageTypes';

import { resolveDefaultDirectoryForMachine, resolveMachineHomeDirectory } from './machineDefaultDirectory';
import { MachineAgentIsolationOwnStatusV1Schema } from '@happier-dev/protocol';

function machine(id: string, homeDir: string | null): Machine {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: homeDir === null ? null : {
            host: `${id}.local`,
            platform: 'linux',
            happyCliVersion: '0.0.0-test',
            happyHomeDir: `${homeDir}/.happier`,
            homeDir,
        },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 1,
    };
}

const machines = [machine('machine-1', '/home/dev'), machine('machine-2', null)];

describe('default directory for a Machine', () => {
    it('uses requester home intent for first use without exposing custodian paths', () => {
        const owned: Machine = { ...machine('owned', '/home/daemon'), isShared: false,
            metadata: { ...machine('owned', '/home/daemon').metadata!,
                agentIsolation: { enabled: true, memberProvisioning: 'linuxUsersV1' } } };
        const pending = MachineAgentIsolationOwnStatusV1Schema.parse({ protection: 'setup_pending',
            status: { kind: 'member_not_prepared' } });
        const missing = MachineAgentIsolationOwnStatusV1Schema.parse({ protection: 'unavailable',
            status: { kind: 'unavailable', code: 'agent_user_missing' } });
        const target = { machineId: owned.id, machines: [owned], recentPaths: ['/home/daemon/private'] };
        expect(resolveDefaultDirectoryForMachine({ ...target, ownStatus: pending })).toBe('~');
        expect(resolveMachineHomeDirectory({ machine: owned, ownStatus: pending })).toBe('');
        expect(resolveDefaultDirectoryForMachine({ ...target, ownStatus: missing })).toBe('');
    });
    it('never defaults an owned separated Machine to daemon history before its member projection arrives', () => {
        const owned: Machine = { ...machine('owned', '/home/daemon'), isShared: false,
            metadata: { ...machine('owned', '/home/daemon').metadata!,
                agentIsolation: { enabled: true, memberProvisioning: 'linuxUsersV1' } } };
        const staleAdmin = MachineAgentIsolationOwnStatusV1Schema.parse({ protection: 'trusted_administrator',
            status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' } });
        for (const ownStatus of [undefined, staleAdmin]) {
            expect(resolveDefaultDirectoryForMachine({ machineId: owned.id, machines: [owned],
                recentPaths: ['/home/daemon'], ownStatus })).toBe('');
            expect(resolveMachineHomeDirectory({ machine: owned, ownStatus })).toBe('');
        }
    });
    it.each(['darwin', 'linux', 'win32'])('resolves a non-isolated shared %s Machine without waiting for isolation readiness', (platform) => {
        const shared: Machine = { ...machine('shared', '/shared/home'), isShared: true,
            metadata: { ...machine('shared', '/shared/home').metadata!, platform, agentIsolation: { enabled: false } } };
        const statuses = [undefined,
            MachineAgentIsolationOwnStatusV1Schema.parse({ protection: 'setup_pending', status: { kind: 'disabled' } }),
            MachineAgentIsolationOwnStatusV1Schema.parse({ protection: 'unavailable', status: { kind: 'unavailable', code: 'unsupported_platform' } }),
        ];
        for (const ownStatus of statuses) {
            expect(resolveDefaultDirectoryForMachine({ machineId: shared.id, machines: [shared], recentPaths: [], ownStatus }))
                .toBe('~');
            expect(resolveMachineHomeDirectory({ machine: shared, ownStatus })).toBe('/shared/home');
            expect(resolveDefaultDirectoryForMachine({ machineId: shared.id, machines: [shared], recentPaths: ['/shared/repo'], ownStatus }))
                .toBe('/shared/repo');
        }
    });

    it('does not substitute custodian history while member placement or its policy is unresolved', () => {
        const shared = { ...machine('shared', '/custodian/home'), isShared: true };
        for (const agentIsolation of [{ enabled: true, memberProvisioning: 'linuxUsersV1' }, { enabled: 'invalid' }] as const) {
            // Deliberately corrupt stored metadata exercises the policy reader's refusal.
            const target = { ...shared, metadata: { ...shared.metadata!, agentIsolation } as Machine['metadata'] };
            expect(resolveDefaultDirectoryForMachine({ machineId: target.id, machines: [target], recentPaths: ['/custodian/repo'] }))
                .toBe('');
            expect(resolveMachineHomeDirectory({ machine: target })).toBe('');
        }
    });

    it('uses the projected member workspace rather than automatic custodian history, and expands home from the same fact', () => {
        const ownStatus = MachineAgentIsolationOwnStatusV1Schema.parse({ protection: 'member_separated',
            status: { kind: 'effective', platform: 'linux' }, directories: { home: '/member/home', workspace: '/member/workspace' } });
        expect(resolveDefaultDirectoryForMachine({ machineId: 'machine-1', machines,
            recentPaths: ['/home/dev'], ownStatus })).toBe('/member/workspace');
        expect(resolveMachineHomeDirectory({ machine: machines[0], ownStatus })).toBe('/member/home');
    });

    it('never substitutes the custodian home when a separated older daemon omits directories', () => {
        const ownStatus = MachineAgentIsolationOwnStatusV1Schema.parse({ protection: 'member_separated',
            status: { kind: 'effective', platform: 'linux' } });
        expect(resolveDefaultDirectoryForMachine({ machineId: 'machine-1', machines,
            recentPaths: ['/home/dev'], ownStatus })).toBe('');
        expect(resolveMachineHomeDirectory({ machine: machines[0], ownStatus })).toBe('');
    });
    it('prefers the most recent folder over the home directory', () => {
        expect(resolveDefaultDirectoryForMachine({
            machineId: 'machine-1',
            machines,
            recentPaths: ['/home/dev/repo', '/home/dev/other'],
        })).toBe('/home/dev/repo');
    });

    it('leaves the home default for target-side resolution when a Machine has no history', () => {
        expect(resolveDefaultDirectoryForMachine({
            machineId: 'machine-1',
            machines,
            recentPaths: ['   '],
        })).toBe('~');
    });

    it('stays visibly unresolved when neither is known', () => {
        expect(resolveDefaultDirectoryForMachine({
            machineId: 'machine-2',
            machines,
            recentPaths: [],
        })).toBe('');
        expect(resolveDefaultDirectoryForMachine({
            machineId: null,
            machines,
            recentPaths: ['/home/dev/repo'],
        })).toBe('');
    });
});
