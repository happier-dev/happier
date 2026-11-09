import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Home's HTTP transport is the boundary; the typed decision is the unit under test.
const fetchSpy = vi.hoisted(() => vi.fn<(path: string, init?: RequestInit) => Promise<Response>>());
vi.mock('@/sync/http/client', () => ({ serverFetch: fetchSpy }));

import { requestLocalServicePublicPreviewAdmission } from './admission';

function reply(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('requestLocalServicePublicPreviewAdmission', () => {
    beforeEach(() => fetchSpy.mockReset());

    it('asks the Home once for the exposure and returns its one-use URL', async () => {
        fetchSpy.mockResolvedValueOnce(reply(200, { protocolVersion: 1, admissionUrl: 'https://p-1.preview.example.test/v1/local-services/public/p%201?publicToken=x', expiresAt: 5 }));
        await expect(requestLocalServicePublicPreviewAdmission('p 1')).resolves.toEqual({ kind: 'admitted',
            admissionUrl: 'https://p-1.preview.example.test/v1/local-services/public/p%201?publicToken=x' });
        expect(fetchSpy).toHaveBeenCalledWith('/v1/local-services/public-admission/p%201', { method: 'POST' });
    });

    it.each([
        ['not_in_audience', 'no_access'], ['not_people_share', 'no_access'],
        ['revoked', 'ended'], ['expired', 'ended'], ['exposure_not_found', 'ended'],
        ['service_unavailable', 'unavailable'],
    ] as const)('shows %s as %s', async (reasonCode, kind) => {
        fetchSpy.mockResolvedValueOnce(reply(403, { error: 'public_preview_admission_denied', reasonCode }));
        await expect(requestLocalServicePublicPreviewAdmission('p')).resolves.toEqual({ kind });
    });

    it('treats an unreachable or unreadable Home as unavailable', async () => {
        fetchSpy.mockRejectedValueOnce(new Error('offline'));
        await expect(requestLocalServicePublicPreviewAdmission('p')).resolves.toEqual({ kind: 'unavailable' });
        fetchSpy.mockResolvedValueOnce(reply(500, { error: 'internal' }));
        await expect(requestLocalServicePublicPreviewAdmission('p')).resolves.toEqual({ kind: 'unavailable' });
    });
});
