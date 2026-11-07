import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDbMocks, installDbModuleMock } from '@/app/api/testkit/dbMocks';
import type { Tx } from '@/storage/inTx';

describe('Machine Pool member admission projection', () => {
    const mocks = createDbMocks({ machine: ['findMany'] });
    beforeEach(() => {
        mocks.reset();
        // Persistence is the boundary; eligibility and lifecycle policy stay real.
        installDbModuleMock({ db: mocks.db });
    });
    afterEach(() => {
        vi.doUnmock('@/storage/db');
        vi.resetModules();
    });

    it('admits owned offline Machines and explains refusals without disclosing foreign existence', async () => {
        mocks.db.machine.findMany.mockResolvedValue([
            { id: 'owned-offline', kind: 'persistent', revokedAt: null, replacedByMachineId: null },
            { id: 'temporary', kind: 'ephemeral_session_runner', revokedAt: null, replacedByMachineId: null },
            { id: 'revoked', kind: 'persistent', revokedAt: new Date(1), replacedByMachineId: null },
            { id: 'replaced', kind: 'persistent', revokedAt: null, replacedByMachineId: 'owned-offline' },
        ]);
        const { getMachinePoolMemberEligibility, validateMachinePoolMembersInTx } = await import('./machinePoolMemberAdmission');
        const machineIds = ['owned-offline', 'foreign', 'missing', 'temporary', 'revoked', 'replaced'];
        expect(await getMachinePoolMemberEligibility({ accountId: 'owner', machineIds })).toEqual([
            { machineId: 'owned-offline', eligible: true },
            { machineId: 'foreign', eligible: false, reason: 'not_owned_or_missing' },
            { machineId: 'missing', eligible: false, reason: 'not_owned_or_missing' },
            { machineId: 'temporary', eligible: false, reason: 'temporary' },
            { machineId: 'revoked', eligible: false, reason: 'revoked' },
            { machineId: 'replaced', eligible: false, reason: 'replaced' },
        ]);
        // The owner constrains the persistence read, so even a supplied foreign id cannot disclose it.
        expect(mocks.db.machine.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { accountId: 'owner', id: { in: machineIds } },
        }));
        // The canonical DB testkit is the transaction boundary fixture.
        const tx = mocks.db as unknown as Tx;
        expect(await validateMachinePoolMembersInTx({ tx, accountId: 'owner', members: machineIds.map(machineId => ({ machineId, priorityTier: 0, enabled: true })) }))
            .toEqual(['foreign', 'missing', 'temporary', 'revoked', 'replaced']);
    });

    it('keeps saved retired references editable but refuses to re-enable them', async () => {
        mocks.db.machine.findMany.mockResolvedValue([
            { id: 'retired', kind: 'persistent', revokedAt: new Date(1), replacedByMachineId: null },
        ]);
        const { validateMachinePoolMembersInTx } = await import('./machinePoolMemberAdmission');
        // The canonical DB testkit is the transaction boundary fixture.
        const tx = mocks.db as unknown as Tx;
        const params = { tx, accountId: 'owner', members: [{ machineId: 'retired', priorityTier: 2, enabled: true }] };
        expect(await validateMachinePoolMembersInTx({ ...params, current: { members: [{ machineId: 'retired', enabled: true }] } })).toEqual([]);
        expect(await validateMachinePoolMembersInTx({ ...params, current: { members: [{ machineId: 'retired', enabled: false }] } })).toEqual(['retired']);
        expect(await validateMachinePoolMembersInTx({ ...params, members: [{ ...params.members[0]!, enabled: false }], current: { members: [{ machineId: 'retired', enabled: false }] } })).toEqual([]);
    });
});
