import { describe, expect, it, vi } from 'vitest';
import type { ServerFetch } from '@/sync/http/client';
import { createManagedMachineActionClient } from './managedMachineActions';

describe('managed Machine public Action transport', () => {
    it('preserves access refusal and missing identity distinctly from unavailable transport', async () => {
        const request = vi.fn<ServerFetch>(async () => Response.json({ code: 'permission_denied' }, { status: 403 }));
        const client = createManagedMachineActionClient({ request });
        await expect(client.execute('machines.managed.get', { homeId: 'home', managedId: 'managed' }))
            .rejects.toMatchObject({ code: 'permission_denied', status: 403 });
        request.mockResolvedValueOnce(Response.json({ code: 'managed_not_found' }, { status: 404 }));
        await expect(client.execute('machines.managed.get', { homeId: 'home', managedId: 'managed' }))
            .rejects.toMatchObject({ code: 'managed_not_found' });
        request.mockResolvedValueOnce(Response.json({ error: 'not_found' }, { status: 404 }));
        await expect(client.execute('machines.managed.list', { homeId: 'home' }))
            .rejects.toMatchObject({ code: 'unsupported_action' });
        request.mockResolvedValueOnce(new Response('<html>Not found</html>', { status: 404 }));
        await expect(client.execute('machines.managed.list', { homeId: 'home' }))
            .rejects.toMatchObject({ code: 'unsupported_action' });
    });
    it('sends setup skip through the existing Home row mutation endpoint', async () => {
        const request = vi.fn<ServerFetch>(async () => Response.json({ code: 'intent_changed' }, { status: 409 }));
        const client = createManagedMachineActionClient({ request });
        await expect(client.execute('machines.managed.setup.skip', { homeId: 'home', managedId: 'managed', expectedIntentRevision: 4 }))
            .rejects.toMatchObject({ code: 'intent_changed', status: 409 });
        expect(request.mock.calls[0]?.[0]).toBe('/v1/machines/managed/actions/setup.skip');
    });
    it('rejects forged or malformed fields without disclosing protected payloads', async () => {
        const request = vi.fn<ServerFetch>(async () => Response.json({ machines: [], secret: 'private material' }));
        const client = createManagedMachineActionClient({ request });
        await expect(client.execute('machines.managed.list', { homeId: 'home', ...{ custodianAccountId: 'forged' } })).rejects.toThrow();
        expect(request).not.toHaveBeenCalled();
        await expect(client.execute('machines.managed.list', { homeId: 'home' }))
            .rejects.toMatchObject({ code: 'managed_response_invalid' });
    });
});
