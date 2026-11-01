import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HappyError } from '@/utils/errors/errors';
import { authAccountApprove, getAccountApproveErrorMessageKey } from './accountApprove';

const network = vi.hoisted(() => ({ request: vi.fn() }));

// The relay transport is the boundary; approval and error classification stay real.
vi.mock('@/sync/http/client', () => ({ serverFetch: network.request }));

describe('authAccountApprove', () => {
    beforeEach(() => {
        network.request.mockReset();
    });

    it('preserves a missing approval request as a distinct failure without exposing the response body', async () => {
        network.request.mockResolvedValue(new Response('private relay diagnostic', { status: 404 }));

        const error = await authAccountApprove('token', new Uint8Array(32), new Uint8Array(32)).catch((cause: unknown) => cause);

        expect(error).toBeInstanceOf(HappyError);
        expect(error).toMatchObject({ status: 404, code: 'account_link_request_not_found' });
        expect(getAccountApproveErrorMessageKey(error)).toBe('modals.deviceLinkRequestNotFound');
        expect(error).not.toHaveProperty('message', expect.stringContaining('private relay diagnostic'));
    });

    it('does not classify other relay failures as a missing request', async () => {
        network.request.mockResolvedValue(new Response(null, { status: 503 }));

        const error = await authAccountApprove('token', new Uint8Array(32), new Uint8Array(32)).catch((cause: unknown) => cause);

        expect(error).toBeInstanceOf(Error);
        expect(error).not.toHaveProperty('code', 'account_link_request_not_found');
        expect(getAccountApproveErrorMessageKey(error)).toBeNull();
    });

    it('keeps unrelated HTTP 404 failures on the caller\'s existing fallback', () => {
        const error = new HappyError('Credential preparation failed', false, { status: 404 });

        expect(getAccountApproveErrorMessageKey(error)).toBeNull();
    });
});
