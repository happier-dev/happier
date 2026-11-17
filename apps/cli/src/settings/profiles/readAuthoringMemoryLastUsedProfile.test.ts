import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';
import { clearAuthoringMemoryLastUsedProfileIfEqual, readAuthoringMemoryLastUsedProfile } from './readAuthoringMemoryLastUsedProfile';

describe('CLI authoring-memory profile read', () => {
  afterEach(() => vi.restoreAllMocks());
  // Plan F R-NO-INTERMEDIATE: current memory never imports or retires Settings.
  it.each(['absent', 'deleted'] as const)('returns null for %s memory without reading or mutating Settings', async (status) => {
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (String(url).endsWith('/authoring-memory/lastUsedProfile')) return { status: 200, data: status === 'absent' ? { status } : { status, revision: 2 } };
      throw new Error('unexpected_settings_read');
    });
    const post = vi.spyOn(axios, 'post');
    expect(await readAuthoringMemoryLastUsedProfile({ token: 't', encryption: null })).toBeNull();
    expect(get.mock.calls.map(([url]) => String(url))).toHaveLength(2);
    expect(post).not.toHaveBeenCalled();
  });

  it('reads plain memory with a token-only Account and keeps retired Settings out of the read', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({ status: 200, data: { mode: 'plain', updatedAt: 1 } })
      .mockResolvedValueOnce({ status: 200, data: { status: 'present', revision: 2, content: { t: 'plain', v: 'profile-a' } } });
    expect(await readAuthoringMemoryLastUsedProfile({ token: 't', encryption: null })).toBe('profile-a');
  });
  it('authenticates encrypted row identity and rejects a transplanted sibling payload', async () => {
    const secret = new Uint8Array(32).fill(7);
    const seal = (key: string) => sealAccountScopedBlobCiphertext({ kind: 'authoring_memory', material: { type: 'legacy', secret },
      payload: { key, value: 'profile-a', futurePayloadField: true }, randomBytes: (length) => new Uint8Array(length).fill(8) });
    const get = vi.spyOn(axios, 'get');
    get.mockResolvedValueOnce({ status: 200, data: { mode: 'e2ee', updatedAt: 1 } })
      .mockResolvedValueOnce({ status: 200, data: { status: 'present', revision: 1, content: { t: 'encrypted', c: seal('lastUsedProfile') } } });
    expect(await readAuthoringMemoryLastUsedProfile({ token: 't', encryption: { type: 'legacy', secret } })).toBe('profile-a');
    get.mockResolvedValueOnce({ status: 200, data: { mode: 'e2ee', updatedAt: 1 } })
      .mockResolvedValueOnce({ status: 200, data: { status: 'present', revision: 1, content: { t: 'encrypted', c: seal('recentMachinePaths') } } });
    await expect(readAuthoringMemoryLastUsedProfile({ token: 't', encryption: { type: 'legacy', secret } })).rejects.toMatchObject({ code: 'authoring_memory_unavailable' });
  });
  it('does not reinterpret a mode mismatch or missing E2EE material as absent memory', async () => {
    const post = vi.spyOn(axios, 'post');
    const get = vi.spyOn(axios, 'get');
    get.mockResolvedValueOnce({ status: 200, data: { mode: 'e2ee', updatedAt: 1 } })
      .mockResolvedValueOnce({ status: 200, data: { status: 'present', revision: 1, content: { t: 'plain', v: 'profile-a' } } });
    await expect(readAuthoringMemoryLastUsedProfile({ token: 't', encryption: null })).rejects.toThrow();
    expect(post).not.toHaveBeenCalled();
  });
  it('refuses unavailable E2EE material even when the memory is absent', async () => {
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
      return { status: 200, data: { status: 'absent' } };
    });
    const post = vi.spyOn(axios, 'post');
    await expect(readAuthoringMemoryLastUsedProfile({ token: 't', encryption: null })).rejects.toThrow();
    expect(post).not.toHaveBeenCalled();
  });
  it.each(['plain', 'e2ee'] as const)('clears matching current %s memory without a Settings write', async (mode) => {
    const secret = new Uint8Array(32).fill(7);
    const credentials = mode === 'plain' ? { token: 't', encryption: null } : { token: 't', encryption: { type: 'legacy' as const, secret } };
    const content = mode === 'plain' ? { t: 'plain', v: 'profile-a' } : { t: 'encrypted', c: sealAccountScopedBlobCiphertext({
      kind: 'authoring_memory', material: { type: 'legacy', secret }, payload: { key: 'lastUsedProfile', value: 'profile-a' },
      randomBytes: length => new Uint8Array(length).fill(8),
    }) };
    vi.spyOn(axios, 'get').mockResolvedValueOnce({ status: 200, data: { mode, updatedAt: 1 } })
      .mockResolvedValueOnce({ status: 200, data: { status: 'present', revision: 2, content } });
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { status: 'updated', revision: 3, cursor: 3 } });
    await clearAuthoringMemoryLastUsedProfileIfEqual(credentials, 'profile-a');
    expect(post).toHaveBeenCalledTimes(1);
    expect(String(post.mock.calls[0]?.[0])).toContain('/authoring-memory/lastUsedProfile');
    expect(post.mock.calls[0]?.[1]).toMatchObject({ expectedRevision: 2, content: { t: mode === 'plain' ? 'plain' : 'encrypted' } });
    const body = post.mock.calls[0]?.[1] as { content: { t: 'plain'; v: unknown } | { t: 'encrypted'; c: string } };
    expect(body.content.t === 'plain' ? body.content.v : openAccountScopedBlobCiphertext({
      kind: 'authoring_memory', material: { type: 'legacy', secret }, ciphertext: body.content.c,
    })?.value).toEqual(mode === 'plain' ? null : { key: 'lastUsedProfile', value: null });
  });
  it('does not clear a tombstone or a newer Profile choice', async () => {
    const get = vi.spyOn(axios, 'get');
    const post = vi.spyOn(axios, 'post');
    for (const row of [
      { status: 'deleted', revision: 2 },
      { status: 'present', revision: 3, content: { t: 'plain', v: 'newer-profile' } },
    ]) {
      get.mockResolvedValueOnce({ status: 200, data: { mode: 'plain', updatedAt: 1 } })
        .mockResolvedValueOnce({ status: 200, data: row });
      await clearAuthoringMemoryLastUsedProfileIfEqual({ token: 't', encryption: null }, 'old-profile');
    }
    expect(post).not.toHaveBeenCalled();
  });
});
