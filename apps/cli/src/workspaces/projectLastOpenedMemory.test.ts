import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProjectLastOpenedMemoryKeyV1 } from '@happier-dev/protocol/account/authoringMemory';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { readProjectLastOpenedMemoryMap } from './projectLastOpenedMemory';

const credentials = { token: 't', encryption: null };
const anchor = { serverId: 'home:a', projectKey: 'project/p' };
const key = buildProjectLastOpenedMemoryKeyV1(anchor);

describe('CLI Project last-opened memory', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads one Account list with separate qualified Home rankings and no writes', async () => {
    const otherKey = buildProjectLastOpenedMemoryKeyV1({ ...anchor, serverId: 'home:b' });
    const get = vi.spyOn(axios, 'get').mockResolvedValueOnce({ status: 200, data: { mode: 'plain', updatedAt: 1 } })
      .mockResolvedValueOnce({ status: 200, data: { rows: [
        { key, revision: 1, content: { t: 'plain', v: 10 } },
        { key: otherKey, revision: 2, content: { t: 'plain', v: 20 } },
        { key: 'lastUsedProfile', revision: 3, content: { t: 'plain', v: 'profile' } },
        { key: buildProjectLastOpenedMemoryKeyV1({ ...anchor, projectKey: 'deleted' }), revision: 4, content: null },
      ] } });
    const post = vi.spyOn(axios, 'post');
    expect(await readProjectLastOpenedMemoryMap({ credentials })).toEqual(new Map([[key, 10], [otherKey, 20]]));
    expect(get.mock.calls.map(([url]) => String(url))).toHaveLength(2);
    expect(post).not.toHaveBeenCalled();
  });

  it('does not mistake unusable E2EE material for an empty memory list', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({ status: 200, data: { mode: 'e2ee', updatedAt: 1 } })
      .mockResolvedValueOnce({ status: 200, data: { rows: [] } });
    await expect(readProjectLastOpenedMemoryMap({ credentials: { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(31) } } }))
      .rejects.toMatchObject({ code: 'ACCOUNT_SETTINGS_ENCRYPTION_MATERIAL_UNAVAILABLE' });
  });

  it('fails closed on invalid stored values, mode mismatch and encrypted Project identity rebinding', async () => {
    const secret = new Uint8Array(32).fill(7);
    const cipher = sealAccountScopedBlobCiphertext({ kind: 'authoring_memory', material: { type: 'legacy', secret },
      payload: { key: buildProjectLastOpenedMemoryKeyV1({ ...anchor, serverId: 'other-home' }), value: 10 },
      randomBytes: length => new Uint8Array(length).fill(8) });
    const get = vi.spyOn(axios, 'get');
    for (const [mode, content] of [
      ['plain', { t: 'plain', v: -1 }],
      ['plain', { t: 'encrypted', c: cipher }],
      ['e2ee', { t: 'encrypted', c: cipher }],
    ] as const) {
      get.mockResolvedValueOnce({ status: 200, data: { mode, updatedAt: 1 } })
        .mockResolvedValueOnce({ status: 200, data: { rows: [{ key, revision: 1, content }] } });
      await expect(readProjectLastOpenedMemoryMap({ credentials: { token: 't', encryption: { type: 'legacy', secret } } })).rejects.toThrow();
    }
  });
});
