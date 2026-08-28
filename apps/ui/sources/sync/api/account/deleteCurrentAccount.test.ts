import { beforeEach, describe, expect, it, vi } from 'vitest';
const serverFetch = vi.hoisted(() => vi.fn());
vi.mock('@/sync/http/client', () => ({ serverFetch }));
import { deleteCurrentAccount } from './deleteCurrentAccount';
describe('deleteCurrentAccount', () => {
  beforeEach(() => serverFetch.mockReset());
  it('sends exact confirmation and accepts only typed success', async () => {
    serverFetch.mockResolvedValue(new Response(JSON.stringify({ status: 'deleted' }), { status: 200 }));
    await expect(deleteCurrentAccount({ token: 'signed' })).resolves.toEqual({ status: 'deleted' });
    expect(serverFetch).toHaveBeenCalledWith('/v1/auth/account/delete', expect.objectContaining({ body: JSON.stringify({ confirmation: 'DELETE' }) }), { includeAuth: false });
  });
  it('rejects PAT and malformed success responses', async () => {
    serverFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'present_user_required' }), { status: 403 }));
    await expect(deleteCurrentAccount({ token: 'pat' })).rejects.toThrow('present_user_required');
    serverFetch.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'pending' }), { status: 200 }));
    await expect(deleteCurrentAccount({ token: 'signed' })).rejects.toThrow('account_delete_invalid_response');
  });
});
