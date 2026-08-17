import { beforeEach, describe, expect, it, vi } from 'vitest';

const areServerProfileIdentifiersEquivalentMock = vi.hoisted(() =>
    vi.fn((left: string | null | undefined, right: string | null | undefined) => String(left ?? '').trim() === String(right ?? '').trim())
);
const resolveServerProfileForPortableIdentityMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    areServerProfileIdentifiersEquivalent: (
        left: string | null | undefined,
        right: string | null | undefined,
    ) => areServerProfileIdentifiersEquivalentMock(left, right),
    resolveServerProfileForPortableIdentity: (
        serverIdentityId: string | null | undefined,
    ) => resolveServerProfileForPortableIdentityMock(serverIdentityId),
}));

type TestMachine = Readonly<{
    id: string;
    activeAt?: number;
    revokedAt?: number | null;
}>;

function createMachine(id: string, activeAt: number): TestMachine {
    return { id, activeAt, revokedAt: null };
}

describe('resolveServerScopedMachines', () => {
    beforeEach(() => {
        areServerProfileIdentifiersEquivalentMock.mockImplementation(
            (left, right) => String(left ?? '').trim() === String(right ?? '').trim(),
        );
        resolveServerProfileForPortableIdentityMock.mockReset();
    });

    it('prefers live active-server machines over a stale scoped cache when the requested server id is an active-server alias', async () => {
        areServerProfileIdentifiersEquivalentMock.mockImplementation((left, right) => {
            const ids = new Set([String(left ?? '').trim(), String(right ?? '').trim()]);
            return ids.has('localhost-53288') && ids.has('srv_identity');
        });

        const { resolveServerScopedMachines } = await import('./resolveServerScopedMachines');
        const freshMachine = createMachine('machine-live', 200);
        const staleMachine = createMachine('machine-stale', 100);

        expect(resolveServerScopedMachines({
            serverId: 'srv_identity',
            activeServerId: 'localhost-53288',
            activeMachines: [freshMachine],
            machineListByServerId: {
                srv_identity: [staleMachine],
            },
        })).toEqual([freshMachine]);
    });

    it('returns only the requested machine from the resolved server scope when machine ids repeat across servers', async () => {
        const module = await import('./resolveServerScopedMachines');
        const resolver = module as unknown as Readonly<{
            resolveExactServerScopedMachine?: (params: Readonly<{
                machineId: string;
                serverId: string;
                activeServerId: string;
                activeMachines: ReadonlyArray<TestMachine>;
                machineListByServerId: Readonly<Record<string, ReadonlyArray<TestMachine>>>;
            }>) => TestMachine | null;
        }>;
        const activeMachine = createMachine('machine-shared', 200);
        const remoteMachine = createMachine('machine-shared', 100);

        expect(resolver.resolveExactServerScopedMachine?.({
            machineId: 'machine-shared',
            serverId: 'server-b',
            activeServerId: 'server-a',
            activeMachines: [activeMachine],
            machineListByServerId: { 'server-b': [remoteMachine] },
        })).toBe(remoteMachine);
    });

    it('routes a portable administration target through this device local profile without falling back to an active duplicate machine id', async () => {
        const module = await import('./resolveServerScopedMachines');
        const resolver = module as unknown as Readonly<{
            resolvePortableMachineAdministrationTarget?: (params: Readonly<{
                target: Readonly<{ serverIdentityId: string; machineId: string }>;
                activeServerId: string;
                activeMachines: ReadonlyArray<TestMachine>;
                machineListByServerId: Readonly<Record<string, ReadonlyArray<TestMachine>>>;
            }>) => unknown;
        }>;
        const remoteProfile = {
            id: 'device-local-server-b',
            name: 'Server B',
            serverUrl: 'https://b.example.test',
            serverIdentityId: 'srv_server_b',
            createdAt: 1,
            updatedAt: 1,
            lastUsedAt: 1,
        };
        const activeDuplicate = createMachine('machine-shared', 200);
        const remoteDuplicate = createMachine('machine-shared', 100);
        resolveServerProfileForPortableIdentityMock.mockReturnValue({
            kind: 'resolved',
            serverIdentityId: 'srv_server_b',
            profile: remoteProfile,
        });

        expect(resolver.resolvePortableMachineAdministrationTarget?.({
            target: { serverIdentityId: 'srv_server_b', machineId: 'machine-shared' },
            activeServerId: 'device-local-server-a',
            activeMachines: [activeDuplicate],
            machineListByServerId: {
                'device-local-server-b': [remoteDuplicate],
            },
        })).toEqual({
            kind: 'resolved',
            target: { serverIdentityId: 'srv_server_b', machineId: 'machine-shared' },
            serverId: 'device-local-server-b',
            profile: remoteProfile,
            machine: remoteDuplicate,
        });
    });

    it('resolves a non-active portable target from the canonical identity cache key instead of falsely reporting it missing', async () => {
        const { resolvePortableMachineAdministrationTarget } = await import('./resolveServerScopedMachines');
        const profile = {
            id: 'device-local-server-b',
            name: 'Server B',
            serverUrl: 'https://b.example.test',
            serverIdentityId: 'srv_server_b',
            legacyServerIds: ['legacy-server-b'],
            createdAt: 1,
            updatedAt: 1,
            lastUsedAt: 1,
        };
        const exactMachine = createMachine('machine-b', 100);
        resolveServerProfileForPortableIdentityMock.mockReturnValue({
            kind: 'resolved',
            serverIdentityId: 'srv_server_b',
            profile,
        });

        expect(resolvePortableMachineAdministrationTarget({
            target: { serverIdentityId: 'srv_server_b', machineId: 'machine-b' },
            activeServerId: 'device-local-server-a',
            activeMachines: [],
            machineListByServerId: {
                srv_server_b: [exactMachine],
            },
        })).toEqual({
            kind: 'resolved',
            target: { serverIdentityId: 'srv_server_b', machineId: 'machine-b' },
            serverId: 'device-local-server-b',
            profile,
            machine: exactMachine,
        });
    });

    it('returns an exact revoked row to Administration instead of applying the visible-machine filter', async () => {
        const { resolvePortableMachineAdministrationTarget } = await import('./resolveServerScopedMachines');
        const profile = {
            id: 'device-local-server-b',
            name: 'Server B',
            serverUrl: 'https://b.example.test',
            serverIdentityId: 'srv_server_b',
            createdAt: 1,
            updatedAt: 1,
            lastUsedAt: 1,
        };
        const revoked = { id: 'machine-revoked', activeAt: 50, revokedAt: 90 };
        resolveServerProfileForPortableIdentityMock.mockReturnValue({
            kind: 'resolved',
            serverIdentityId: 'srv_server_b',
            profile,
        });

        expect(resolvePortableMachineAdministrationTarget({
            target: { serverIdentityId: 'srv_server_b', machineId: 'machine-revoked' },
            activeServerId: 'device-local-server-a',
            activeMachines: [],
            machineListByServerId: { srv_server_b: [revoked] },
        })).toEqual(expect.objectContaining({
            kind: 'resolved',
            machine: revoked,
        }));
    });
});
