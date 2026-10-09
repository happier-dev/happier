import { beforeEach, describe, expect, it, vi } from 'vitest';
const serverFetch = vi.hoisted(() => vi.fn());
vi.mock('@/sync/http/client', () => ({ serverFetch }));
import { deleteCurrentAccount } from './deleteCurrentAccount';
import { createManagedResourceDependencyFixture } from '@/dev/testkit/fixtures/managedResourceDependencyFixtures';
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
  it('preserves cleanup pending as a typed refusal without reporting deletion', async () => {
    serverFetch.mockResolvedValue(new Response(JSON.stringify({ error: 'account_erasure_transition_cleanup_pending' }), { status: 409 }));
    await expect(deleteCurrentAccount({ token: 'signed' })).rejects.toMatchObject({
      code: 'account_erasure_transition_cleanup_pending',
      status: 409,
    });
  });
  it('retains the strict safe resource review on refusal, then sends only explicitly reviewed manual expectations', async () => {
    const resource = createManagedResourceDependencyFixture();
    serverFetch.mockResolvedValueOnce(Response.json({ error: 'account_erasure_managed_resources_review_required', resources: [resource] }, { status: 409 }));
    await expect(deleteCurrentAccount({ token: 'signed' })).rejects.toMatchObject({
      code: 'account_erasure_managed_resources_review_required', status: 409, resources: [resource],
    });
    const disposition = { managedId: resource.managedId, expectedIntentRevision: resource.intentRevision,
      expectedAllocation: resource.allocation, expectedResource: resource.resource,
      expectedNativeOperationRef: resource.nativeOperationRef, expectedRecovery: resource.recovery, responsibility: 'manual' } as const;
    serverFetch.mockResolvedValueOnce(Response.json({ status: 'deleted' }));
    await expect(deleteCurrentAccount({ token: 'signed' }, { managedResourceDispositions: [disposition] })).resolves.toEqual({ status: 'deleted' });
    expect(serverFetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ confirmation: 'DELETE', managedResourceDispositions: [disposition] }));
  });
  it('does not expose malformed resource review bytes as an actionable dependency', async () => {
    const resource = createManagedResourceDependencyFixture();
    serverFetch.mockResolvedValueOnce(Response.json({ error: 'account_erasure_managed_resources_review_required',
      resources: [{ ...resource, credential: 'must-not-be-disclosed' }] }, { status: 409 }));
    const rejected = deleteCurrentAccount({ token: 'signed' });
    await expect(rejected).rejects.toMatchObject({ code: 'account_delete_failed' });
    await expect(rejected).rejects.not.toHaveProperty('resources');
  });
});
