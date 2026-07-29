import { describe, expect, it, vi } from 'vitest';

const request = {
    requestId: 'request_1',
    target: { kind: 'inventory_entry' as const, inventoryEntryId: 'entry_1', machineId: 'machine_1' },
    action: 'copy_url' as const,
    force: false,
};

const result = {
    v: 1 as const,
    requestId: 'request_2',
    action: 'copy_url' as const,
    status: 'succeeded' as const,
    auditEvents: [{
        v: 1 as const,
        eventId: 'request_2:0:succeeded',
        requestId: 'request_2',
        machineId: 'machine_1',
        action: 'copy_url' as const,
        result: 'succeeded' as const,
        recordedAt: 1_000,
    }],
};

describe('local service actions HTTP client', () => {
    it('fails closed when the action response does not match the requested action target', async () => {
        const executeRequest = vi.fn(async () => new Response(JSON.stringify({ ok: true, result }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }));
        const { executeLocalServiceActionViaRequest } = await import('./api');

        await expect(executeLocalServiceActionViaRequest({
            request,
            executeRequest,
        })).resolves.toEqual({ ok: false, reason: 'invalid_response' });
    });
});
