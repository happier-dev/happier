import { afterEach, describe, expect, it } from 'vitest';

import { reloadConfiguration } from '@/configuration';

const originalEnv = {
  HAPPIER_PUBLIC_SERVER_URL: process.env.HAPPIER_PUBLIC_SERVER_URL,
  HAPPIER_SERVER_URL: process.env.HAPPIER_SERVER_URL,
  HAPPIER_LOCAL_SERVER_URL: process.env.HAPPIER_LOCAL_SERVER_URL,
};

afterEach(() => {
  if (originalEnv.HAPPIER_PUBLIC_SERVER_URL === undefined) {
    delete process.env.HAPPIER_PUBLIC_SERVER_URL;
  } else {
    process.env.HAPPIER_PUBLIC_SERVER_URL = originalEnv.HAPPIER_PUBLIC_SERVER_URL;
  }
  if (originalEnv.HAPPIER_SERVER_URL === undefined) {
    delete process.env.HAPPIER_SERVER_URL;
  } else {
    process.env.HAPPIER_SERVER_URL = originalEnv.HAPPIER_SERVER_URL;
  }
  if (originalEnv.HAPPIER_LOCAL_SERVER_URL === undefined) {
    delete process.env.HAPPIER_LOCAL_SERVER_URL;
  } else {
    process.env.HAPPIER_LOCAL_SERVER_URL = originalEnv.HAPPIER_LOCAL_SERVER_URL;
  }
  reloadConfiguration();
});

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

  it('defaults account pet uploads to the configured api server URL', async () => {
    process.env.HAPPIER_PUBLIC_SERVER_URL = 'https://app.example.test';
    process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
    delete process.env.HAPPIER_LOCAL_SERVER_URL;
    reloadConfiguration();

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
    expect(requests[0]?.url).toBe('https://api.example.test/v1/account/pets');
  });
});
