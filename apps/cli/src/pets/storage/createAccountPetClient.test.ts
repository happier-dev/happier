import { describe, expect, it } from 'vitest';

describe('createAccountPetViaActiveServer', () => {
  it('posts canonical account pet imports to the active server with stored credentials', async () => {
    const requests: Array<Readonly<{ url: string; init: RequestInit }>> = [];
    const mod = await import('./createAccountPetClient').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) throw new Error('expected account pet client module');

    const result = await mod.createAccountPetViaActiveServer({
      manifest: {
        id: 'blink',
        displayName: 'Blink',
        description: 'Happier companion pet',
        spritesheetPath: 'spritesheet.png',
      },
      spritesheet: {
        mediaType: 'image/png',
        encoding: 'base64',
        data: 'iVBORw0KGgo=',
        sizeBytes: 8,
        digest: 'sha256:asset',
      },
      origin: { kind: 'manualImport' },
    }, {
      serverUrl: 'https://happier.example.test/',
      readCredentials: async () => ({
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array([1]) },
      }),
      fetcher: async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        return new Response(JSON.stringify({
          ok: true,
          pet: {
            accountPetId: 'pet_account_1',
            packageFormat: 'codex-compatible-atlas-v1',
            manifest: {
              id: 'blink',
              displayName: 'Blink',
              description: 'Happier companion pet',
              spritesheetPath: 'spritesheet.png',
            },
            spritesheetAssetRef: {
              assetId: 'asset_1',
              mediaType: 'image/png',
              digest: 'sha256:asset',
              sizeBytes: 8,
            },
            digest: 'sha256:package',
            sizeBytes: 8,
            createdAt: 1,
            updatedAt: 1,
            origin: { kind: 'manualImport' },
          },
        }), { status: 200 });
      },
    });

    expect(result).toMatchObject({ ok: true, pet: { accountPetId: 'pet_account_1' } });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://happier.example.test/v1/account/pets');
    expect(requests[0]?.init.headers).toMatchObject({
      Authorization: 'Bearer token-1',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(requests[0]?.init.body))).toMatchObject({
      manifest: { id: 'blink' },
      spritesheet: { encoding: 'base64' },
    });
  });

  it('preserves the conservative plaintext-required account import error code', async () => {
    const mod = await import('./createAccountPetClient').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) throw new Error('expected account pet client module');

    const result = await mod.createAccountPetViaActiveServer({
      manifest: {
        id: 'blink',
        displayName: 'Blink',
        description: 'Happier companion pet',
        spritesheetPath: 'spritesheet.png',
      },
      spritesheet: {
        mediaType: 'image/png',
        encoding: 'base64',
        data: 'iVBORw0KGgo=',
        sizeBytes: 8,
        digest: 'sha256:asset',
      },
      origin: { kind: 'manualImport' },
    }, {
      serverUrl: 'https://happier.example.test/',
      readCredentials: async () => ({
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array([1]) },
      }),
      fetcher: async () => new Response(JSON.stringify({
        ok: false,
        errorCode: 'custom_pet_sync_requires_plaintext',
        error: 'custom_pet_sync_requires_plaintext',
      }), { status: 400 }),
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'custom_pet_sync_requires_plaintext',
      error: 'custom_pet_sync_requires_plaintext',
    });
  });
});
