import { describe, expect, it } from 'vitest';
import { createRegistryHostV1 } from './registryHostV1.js';
import { BUILT_IN_REGISTRY_SOURCES_V1 } from './registrySourcesV1.js';
import { AccountPetOriginV1Schema } from '../pets/accountLibrary.js';
import { RegistryFetchResponseV1Schema } from './registryRpcV1.js';
import type { RegistryHttpV1 } from './formats/registryFormatAdapterV1.js';

const codexPet = { id: 'winter', displayName: 'Winter', description: 'A white cat', ownerName: 'KOOKOO',
  spritesheetUrl: 'https://codex-pets.net/assets/winter/spritesheet.webp', spriteVersionNumber: 1, ignored: 'external' };
const dexPet = { slug: 'boba', displayName: 'Boba', description: 'A companion', submittedBy: { name: 'railly' },
  spritesheetPath: 'https://assets.petdex.dev/boba/sprite.webp', spriteVersionNumber: 1 };
const unused = async (): Promise<never> => { throw new Error('Unexpected transport'); };

describe('registry pets through the shared host', () => {
  it('uses the existing unavailable transport result on web when the source has no browser CORS contract', async () => {
    let directReads = 0;
    const host = createRegistryHostV1({ host: 'web', readSources: async () => BUILT_IN_REGISTRY_SOURCES_V1,
      http: { getText: unused, getBytes: unused, getJson: async () => {
        directReads++;
        return { ok: true, fetchedAt: 1, value: { pets: [], page: 1, total: 0, totalPages: 0 } };
      } },
    });
    expect(await host.fetchRequest({ op: 'list', kind: 'pet', sourceId: 'builtin:codex-pets' }))
      .toMatchObject({ op: 'error', status: { state: 'needs_machine' } });
    expect(directReads).toBe(0);
    await expect(host.readRegistryPet({ sourceId: 'builtin:codex-pets', itemId: 'winter' }))
      .rejects.toMatchObject({ status: { state: 'needs_machine' } });
  });
  it('lists both sources with server paging, credits and safe sheet metadata without a Machine', async () => {
    const requests: string[] = [];
    const http: RegistryHttpV1 = { getText: unused, getBytes: unused, getJson: async url => {
      requests.push(url);
      return { ok: true, fetchedAt: 1, value: url.includes('codex-pets')
        ? { pets: [codexPet], page: 1, pageSize: 30, total: 31, totalPages: 2 }
        : { pets: [dexPet], nextCursor: 24, total: 25 } };
    } };
    const host = createRegistryHostV1({ host: 'native', http, readSources: async () => BUILT_IN_REGISTRY_SOURCES_V1 });
    const first = await host.fetchRequest({ op: 'list', sourceId: 'builtin:codex-pets', kind: 'pet', query: 'cat' });
    expect(first).toMatchObject({ op: 'list', page: { nextCursor: '2', total: 31,
      items: [{ kind: 'pet', itemId: 'winter', publisher: { name: 'KOOKOO' }, petMetadata: { spritesheetUrl: codexPet.spritesheetUrl } }] } });
    const second = await host.fetchRequest({ op: 'list', sourceId: 'builtin:petdex', kind: 'pet', cursor: '24', query: 'boba' });
    expect(second).toMatchObject({ op: 'list', page: { nextCursor: '24', items: [{ publisher: { name: 'railly' } }] } });
    expect(requests).toHaveLength(2);
    expect(new URL(requests[0]!).searchParams.get('q')).toBe('cat');
    expect(new URL(requests[1]!).searchParams.get('cursor')).toBe('24');
  });

  it('downloads only the selected sheet through admitted HTTP and stores ids only', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const reads: string[] = [];
    const http: RegistryHttpV1 = { getText: unused, getJson: async url => {
      reads.push(url);
      return { ok: true, fetchedAt: 1, value: { pet: codexPet } };
    }, getBytes: async url => { reads.push(url); return { ok: true, fetchedAt: 1, value: bytes }; } };
    const host = createRegistryHostV1({ host: 'native', http, readSources: async () => BUILT_IN_REGISTRY_SOURCES_V1 });
    const acquired = await host.readRegistryPet({ sourceId: 'builtin:codex-pets', itemId: 'winter' });
    expect(acquired).toEqual({ manifest: { id: 'winter', displayName: 'Winter', description: 'A white cat', spritesheetPath: 'spritesheet.webp' },
      spritesheetBytes: bytes, mediaType: 'image/webp', origin: { kind: 'registry', sourceId: 'builtin:codex-pets', itemId: 'winter' } });
    expect(reads).toEqual(['https://codex-pets.net/api/pets/winter', codexPet.spritesheetUrl]);
    expect(AccountPetOriginV1Schema.parse(acquired.origin)).toEqual(acquired.origin);
  });

  it('resolves a petdex selection from its public manifest and petjson, ignoring its inaccurate version label', async () => {
    const http: RegistryHttpV1 = { getText: unused, getJson: async url => ({ ok: true, fetchedAt: 2, value: url.endsWith('/api/manifest')
      ? { pets: [{ slug: 'boba', displayName: 'Boba', submittedBy: 'railly', spritesheetUrl: dexPet.spritesheetPath,
        petJsonUrl: 'https://assets.petdex.dev/boba/petjson.json', spriteVersionNumber: 1 }] }
      : { id: 'Boba Cat', displayName: 'Boba', description: 'A companion', spritesheetPath: 'sprite.webp', kind: 'animal' } }),
    getBytes: async () => ({ ok: true, fetchedAt: 2, value: new Uint8Array([4]) }) };
    const host = createRegistryHostV1({ host: 'native', http, readSources: async () => BUILT_IN_REGISTRY_SOURCES_V1 });
    expect(await host.readRegistryPet({ sourceId: 'builtin:petdex', itemId: 'boba' })).toMatchObject({
      manifest: { id: 'Boba Cat', description: 'A companion', spritesheetPath: 'spritesheet.webp' }, mediaType: 'image/webp',
      origin: { kind: 'registry', sourceId: 'builtin:petdex', itemId: 'boba' } });
  });

  it('preserves selected spritesheet bytes through the existing JSON daemon carrier', async () => {
    const builtIn = BUILT_IN_REGISTRY_SOURCES_V1.find(source => source.id === 'builtin:codex-pets');
    if (!builtIn || 'packageContent' in builtIn) throw new Error('Expected public pet source');
    const sources = [{ ...builtIn, token: { secretRef: 'private-source' } }];
    const bytes = new Uint8Array([0, 127, 128, 255]);
    const node = createRegistryHostV1({ host: 'node', readSources: async () => sources, http: {
      getText: unused, getJson: async () => ({ ok: true, fetchedAt: 1, value: { pet: codexPet } }),
      getBytes: async () => ({ ok: true, fetchedAt: 1, value: bytes }),
    } });
    let daemonReads = 0;
    const web = createRegistryHostV1({ host: 'web', readSources: async () => sources,
      http: { getJson: unused, getText: unused, getBytes: unused },
      daemonFetch: async request => {
        daemonReads++;
        // JSON transport is the real system boundary; protocol parsing remains real.
        return RegistryFetchResponseV1Schema.parse(JSON.parse(JSON.stringify(await node.fetchRequest(request))));
      },
    });
    expect((await web.readRegistryPet({ sourceId: builtIn.id, itemId: 'winter' })).spritesheetBytes).toEqual(bytes);
    expect(daemonReads).toBe(1);
  });

  it('rejects untrusted sheet URLs and propagates download failures', async () => {
    const http: RegistryHttpV1 = { getText: unused, getBytes: unused,
      getJson: async () => ({ ok: true, fetchedAt: 1, value: { pets: [{ ...codexPet, spritesheetUrl: 'javascript:alert(1)' }], page: 1, pageSize: 30, total: 1, totalPages: 1 } }) };
    const host = createRegistryHostV1({ host: 'native', http, readSources: async () => BUILT_IN_REGISTRY_SOURCES_V1 });
    expect(await host.fetchRequest({ op: 'list', sourceId: 'builtin:codex-pets', kind: 'pet' })).toMatchObject({ op: 'error', status: { state: 'invalid_source' } });
    const failed = createRegistryHostV1({ host: 'native', readSources: async () => BUILT_IN_REGISTRY_SOURCES_V1,
      http: { ...http, getJson: async () => ({ ok: true, fetchedAt: 1, value: { pet: codexPet } }),
        getBytes: async () => ({ ok: false, status: { state: 'rate_limited', retryAt: 12 } }) } });
    await expect(failed.readRegistryPet({ sourceId: 'builtin:codex-pets', itemId: 'winter' })).rejects.toMatchObject({ status: { state: 'rate_limited', retryAt: 12 } });
  });
});
