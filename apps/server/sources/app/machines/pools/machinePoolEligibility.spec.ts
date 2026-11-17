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
