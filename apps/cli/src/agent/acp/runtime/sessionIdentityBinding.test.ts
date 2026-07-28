import { describe, expect, it, vi } from 'vitest';

import { createDeferred } from '@/testkit/async/deferred';

import {
  AcpSessionIdentityBindingError,
  createAcpSessionIdentityBinding,
} from './sessionIdentityBinding';

describe('createAcpSessionIdentityBinding', () => {
  it('normalizes a create result and publishes it before resolving', async () => {
    const calls: string[] = [];
    const binding = createAcpSessionIdentityBinding({
      persistBound: async (event) => {
        calls.push(`persist:${event.generation}:${event.operation}:${event.vendorSessionId}`);
      },
    });

    const opened = await binding.open({
      intent: { kind: 'create' },
      openSession: async () => {
        calls.push('open');
        return { sessionId: ' vendor-1 ' };
      },
    });

    expect(opened.identity).toEqual({
      generation: 0,
      operation: 'create',
      vendorSessionId: 'vendor-1',
    });
    expect(calls).toEqual(['open', 'persist:0:create:vendor-1']);
  });

  it('shares the entire same-intent open and publication operation', async () => {
    const providerOpen = createDeferred<{ sessionId: string }>();
    const persist = createDeferred<void>();
    const openSession = vi.fn(() => providerOpen.promise);
    const persistBound = vi.fn(() => persist.promise);
    const binding = createAcpSessionIdentityBinding({ persistBound });

    const first = binding.open({ intent: { kind: 'resume', expectedVendorSessionId: ' resume-1 ' }, openSession });
    const second = binding.open({ intent: { kind: 'resume', expectedVendorSessionId: 'resume-1' }, openSession });
    expect(openSession).toHaveBeenCalledTimes(1);

    providerOpen.resolve({ sessionId: 'resume-1' });
    await Promise.resolve();
    expect(persistBound).toHaveBeenCalledTimes(1);

    persist.resolve(undefined);
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ identity: expect.objectContaining({ vendorSessionId: 'resume-1' }) }),
      expect.objectContaining({ identity: expect.objectContaining({ vendorSessionId: 'resume-1' }) }),
    ]);
  });

  it('rejects a competing intent without opening another provider session', async () => {
    const providerOpen = createDeferred<{ sessionId: string }>();
    const openSession = vi.fn(() => providerOpen.promise);
    const binding = createAcpSessionIdentityBinding({ persistBound: async () => {} });

    const first = binding.open({ intent: { kind: 'create' }, openSession });
    await expect(binding.open({
      intent: { kind: 'resume', expectedVendorSessionId: 'resume-1' },
      openSession,
    })).rejects.toMatchObject({ code: 'ACP_SESSION_IDENTITY_INTENT_CONFLICT' });
    expect(openSession).toHaveBeenCalledTimes(1);

    providerOpen.resolve({ sessionId: 'created-1' });
    await first;
  });

  it('rejects empty identities and an inexact resume result before persistence', async () => {
    const persistBound = vi.fn(async () => {});
    const emptyCreate = createAcpSessionIdentityBinding({ persistBound });
    await expect(emptyCreate.open({
      intent: { kind: 'create' },
      openSession: async () => ({ sessionId: '   ' }),
    })).rejects.toMatchObject({ code: 'ACP_SESSION_IDENTITY_EMPTY' });

    const mismatchedResume = createAcpSessionIdentityBinding({ persistBound });
    await expect(mismatchedResume.open({
      intent: { kind: 'resume', expectedVendorSessionId: 'expected-1' },
      openSession: async () => ({ sessionId: 'replacement-1' }),
    })).rejects.toMatchObject({ code: 'ACP_SESSION_IDENTITY_RESUME_MISMATCH' });
    expect(persistBound).not.toHaveBeenCalled();
  });

  it('rejects a whitespace resume intent before invoking the provider', async () => {
    const openSession = vi.fn(async () => ({ sessionId: 'unused' }));
    const binding = createAcpSessionIdentityBinding({ persistBound: async () => {} });

    await expect(binding.open({
      intent: { kind: 'resume', expectedVendorSessionId: '  ' },
      openSession,
    })).rejects.toMatchObject({ code: 'ACP_SESSION_IDENTITY_EMPTY_RESUME_INTENT' });
    expect(openSession).not.toHaveBeenCalled();
  });

  it('retries failed publication without opening the provider a second time', async () => {
    const openSession = vi.fn(async () => ({ sessionId: 'created-1' }));
    const persistBound = vi.fn()
      .mockRejectedValueOnce(new Error('metadata unavailable'))
      .mockResolvedValueOnce(undefined);
    const binding = createAcpSessionIdentityBinding({ persistBound });

    await expect(binding.open({ intent: { kind: 'create' }, openSession })).rejects.toThrow('metadata unavailable');
    await expect(binding.open({ intent: { kind: 'create' }, openSession })).resolves.toMatchObject({
      identity: { generation: 0, operation: 'create', vendorSessionId: 'created-1' },
    });

    expect(openSession).toHaveBeenCalledTimes(1);
    expect(persistBound).toHaveBeenCalledTimes(2);
  });

  it('requires reset before a different intent after a pre-bind provider failure', async () => {
    const binding = createAcpSessionIdentityBinding({ persistBound: async () => {} });
    await expect(binding.open({
      intent: { kind: 'resume', expectedVendorSessionId: 'missing-1' },
      openSession: async () => { throw new Error('not found'); },
    })).rejects.toThrow('not found');

    await expect(binding.open({
      intent: { kind: 'create' },
      openSession: async () => ({ sessionId: 'created-1' }),
    })).rejects.toMatchObject({ code: 'ACP_SESSION_IDENTITY_RESET_REQUIRED' });

    await binding.reset();
    await expect(binding.open({
      intent: { kind: 'create' },
      openSession: async () => ({ sessionId: 'created-1' }),
    })).resolves.toMatchObject({
      identity: { generation: 1, operation: 'create', vendorSessionId: 'created-1' },
    });
  });

  it('fences a late provider completion after reset before it can bind or publish', async () => {
    const providerOpen = createDeferred<{ sessionId: string }>();
    const persistBound = vi.fn(async () => {});
    const binding = createAcpSessionIdentityBinding({ persistBound });
    const opening = binding.open({ intent: { kind: 'create' }, openSession: () => providerOpen.promise });

    const resetting = binding.reset();
    providerOpen.resolve({ sessionId: 'stale-1' });

    await expect(opening).rejects.toMatchObject({ code: 'ACP_SESSION_IDENTITY_STALE_GENERATION' });
    await resetting;
    expect(binding.getBound()).toBeNull();
    expect(persistBound).not.toHaveBeenCalled();
  });

  it('waits for an already-started publication during reset and rejects its stale completion', async () => {
    const persist = createDeferred<void>();
    const binding = createAcpSessionIdentityBinding({ persistBound: () => persist.promise });
    const opening = binding.open({
      intent: { kind: 'create' },
      openSession: async () => ({ sessionId: 'created-1' }),
    });
    await Promise.resolve();

    let resetSettled = false;
    const resetting = binding.reset().then(() => { resetSettled = true; });
    await Promise.resolve();
    expect(resetSettled).toBe(false);

    persist.resolve(undefined);
    await expect(opening).rejects.toBeInstanceOf(AcpSessionIdentityBindingError);
    await resetting;
    expect(binding.getBound()).toBeNull();
  });

  it('treats the same intent as idempotent after successful publication', async () => {
    const openSession = vi.fn(async () => ({ sessionId: 'created-1' }));
    const persistBound = vi.fn(async () => {});
    const binding = createAcpSessionIdentityBinding({ persistBound });

    const first = await binding.open({ intent: { kind: 'create' }, openSession });
    const second = await binding.open({ intent: { kind: 'create' }, openSession });

    expect(second.identity).toEqual(first.identity);
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(persistBound).toHaveBeenCalledTimes(1);
  });
});
