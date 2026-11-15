import { describe, expect, it, vi } from 'vitest';

import { createMachinePoolActionClient, MachinePoolActionError } from './machinePoolActions';
import { MachinePoolPrivateLabelStoredV1Schema, MachinePoolPrivateViewV1Schema } from '@happier-dev/protocol/machines/pools/v1';

const POOL_ID = '00000000-0000-4000-8000-000000000001';

describe('machinePoolActions', () => {
    it('uses the canonical family endpoint and validates the response', async () => {
        const request = vi.fn(async () => new Response(JSON.stringify({ pools: [] }), { status: 200 }));
        const client = createMachinePoolActionClient({ request });

        await expect(client.execute('machines.pools.list', {}, { serverId: 'home-a' })).resolves.toEqual({ pools: [] });
        expect(request).toHaveBeenCalledWith('/v1/machines/pools/list', expect.objectContaining({
            method: 'POST',
            body: '{}',
        }), { includeAuth: true, recoveryRead: 'unbounded' });
    });

    it('preserves the structured conflict result for editor recovery', async () => {
        const current = MachinePoolPrivateViewV1Schema.parse({
            pool: { id: POOL_ID, name: { kind: 'available', label: { content: { t: 'plain', v: 'Current' }, recipientEnvelope: null } }, description: null, revision: 2, createdAt: 1, updatedAt: 2, members: [] },
            availability: { state: 'known', connectedCount: 0, enabledCount: 0 },
        });
        const request = vi.fn(async () => new Response(JSON.stringify({ code: 'pool_changed', current }), { status: 409 }));
        const client = createMachinePoolActionClient({ request });

        const failure = await client.execute('machines.pools.update', {
            poolId: POOL_ID,
            expectedRevision: 1,
            name: MachinePoolPrivateLabelStoredV1Schema.parse({ content: { t: 'plain', v: 'Local' }, recipients: [] }),
            members: [],
        }, { serverId: 'home-a' }).catch((error) => error);

        expect(failure).toBeInstanceOf(MachinePoolActionError);
        expect(failure).toMatchObject({ status: 409, detail: { code: 'pool_changed', current } });
    });
});
