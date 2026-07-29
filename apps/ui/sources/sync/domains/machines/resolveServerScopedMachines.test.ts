import { beforeEach, describe, expect, it, vi } from 'vitest';

const areServerProfileIdentifiersEquivalentMock = vi.hoisted(() =>
    vi.fn((left: string | null | undefined, right: string | null | undefined) => String(left ?? '').trim() === String(right ?? '').trim())
);

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    areServerProfileIdentifiersEquivalent: (
        left: string | null | undefined,
        right: string | null | undefined,
    ) => areServerProfileIdentifiersEquivalentMock(left, right),
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
});
