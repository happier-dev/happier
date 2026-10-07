import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';
import { readAuthoringMemoryLastUsedProfile } from './readAuthoringMemoryLastUsedProfile';

describe('CLI authoring-memory profile read', () => {
  afterEach(() => vi.restoreAllMocks());
  it('imports a shipped Settings profile before the UI has bootstrapped, then retires only that exact key', async () => {
    let memory: unknown = null;
    let settings: Record<string, unknown> = { lastUsedProfile: 'legacy-profile', futureSetting: { keep: true } };
    let version = 3;
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (String(url).endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: settings }, version } };
      return { status: 200, data: memory ?? { status: 'absent' } };
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, input) => {
      const body = input as Record<string, unknown>;
      if (String(url).endsWith('/authoring-memory/lastUsedProfile')) {
        expect(body.expectedRevision).toBe('absent');
        memory = { status: 'present', revision: 1, content: body.content };
        return { status: 200, data: { status: 'updated', revision: 1, cursor: 1 } };
      }
      expect(body.expectedVersion).toBe(version);
      const content = body.content as { t: 'plain'; v: Record<string, unknown> };
      settings = content.v;
      version += 1;
      return { status: 200, data: { success: true, version } };
    });
    expect(await readAuthoringMemoryLastUsedProfile({ token: 't', encryption: null })).toBe('legacy-profile');
    expect(settings).toEqual({ futureSetting: { keep: true } });
    expect(await readAuthoringMemoryLastUsedProfile({ token: 't', encryption: null })).toBe('legacy-profile');
  });

  it('reads plain memory with a token-only Account and keeps retired Settings out of the read', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({ status: 200, data: { mode: 'plain', updatedAt: 1 } })
      .mockResolvedValueOnce({ status: 200, data: { status: 'present', revision: 2, content: { t: 'plain', v: 'profile-a' } } })
      .mockResolvedValueOnce({ status: 200, data: { content: null, version: 1 } });
    expect(await readAuthoringMemoryLastUsedProfile({ token: 't', encryption: null })).toBe('profile-a');
  });
  it('authenticates encrypted row identity and rejects a transplanted sibling payload', async () => {
    const secret = new Uint8Array(32).fill(7);
    const seal = (key: string) => sealAccountScopedBlobCiphertext({ kind: 'authoring_memory', material: { type: 'legacy', secret },
      payload: { key, value: 'profile-a', futurePayloadField: true }, randomBytes: (length) => new Uint8Array(length).fill(8) });
    const get = vi.spyOn(axios, 'get');
    get.mockResolvedValueOnce({ status: 200, data: { mode: 'e2ee', updatedAt: 1 } })
      .mockResolvedValueOnce({ status: 200, data: { status: 'present', revision: 1, content: { t: 'encrypted', c: seal('lastUsedProfile') } } })
      .mockResolvedValueOnce({ status: 200, data: { content: null, version: 1 } });
    expect(await readAuthoringMemoryLastUsedProfile({ token: 't', encryption: { type: 'legacy', secret } })).toBe('profile-a');
    get.mockResolvedValueOnce({ status: 200, data: { mode: 'e2ee', updatedAt: 1 } })
      .mockResolvedValueOnce({ status: 200, data: { status: 'present', revision: 1, content: { t: 'encrypted', c: seal('recentMachinePaths') } } });
    await expect(readAuthoringMemoryLastUsedProfile({ token: 't', encryption: { type: 'legacy', secret } })).rejects.toMatchObject({ code: 'authoring_memory_unavailable' });
  });
  it('imports E2EE legacy memory into a key-bound encrypted row before retiring its Settings source', async () => {
    const secret = new Uint8Array(32).fill(7);
    const material = { type: 'legacy' as const, secret };
    const secretSibling = { _isSecretValue: true, value: 'unrelated-legacy-secret' };
    let settings = sealAccountScopedBlobCiphertext({ kind: 'account_settings', material,
      payload: { lastUsedProfile: 'encrypted-profile', keep: true, secretSibling }, randomBytes: (length) => new Uint8Array(length).fill(8) });
    let memory: unknown = null;
    let version = 1;
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
      if (String(url).endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'encrypted', c: settings }, version } };
      return { status: 200, data: memory ?? { status: 'absent' } };
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, input) => {
      const body = input as { content: { t: 'encrypted'; c: string }; expectedVersion?: number; expectedRevision?: string };
      expect(body.content.t).toBe('encrypted');
      if (String(url).endsWith('/authoring-memory/lastUsedProfile')) {
        expect(openAccountScopedBlobCiphertext({ kind: 'authoring_memory', material, ciphertext: body.content.c })?.value)
          .toEqual({ key: 'lastUsedProfile', value: 'encrypted-profile' });
        memory = { status: 'present', revision: 1, content: body.content };
        return { status: 200, data: { status: 'updated', revision: 1, cursor: 1 } };
      }
      expect(body.expectedVersion).toBe(version);
      settings = body.content.c;
      version += 1;
      return { status: 200, data: { success: true, version } };
    });
    expect(await readAuthoringMemoryLastUsedProfile({ token: 't', encryption: { type: 'legacy', secret } })).toBe('encrypted-profile');
    expect(openAccountScopedBlobCiphertext({ kind: 'account_settings', material, ciphertext: settings })?.value).toEqual({ keep: true, secretSibling });
  });
  it('does not reinterpret a mode mismatch or missing E2EE material as absent memory', async () => {
    const post = vi.spyOn(axios, 'post');
    const get = vi.spyOn(axios, 'get');
    get.mockResolvedValueOnce({ status: 200, data: { mode: 'e2ee', updatedAt: 1 } })
      .mockResolvedValueOnce({ status: 200, data: { status: 'present', revision: 1, content: { t: 'plain', v: 'profile-a' } } });
    await expect(readAuthoringMemoryLastUsedProfile({ token: 't', encryption: null })).rejects.toThrow();
    expect(post).not.toHaveBeenCalled();
  });
});
