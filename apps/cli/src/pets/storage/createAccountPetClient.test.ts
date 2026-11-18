import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import tweetnacl from 'tweetnacl';

import { PET_ANIMATION_ROWS_V1, PET_ATLAS_V1 } from '@happier-dev/protocol';
import { buildAccountPetCreateRequestV1 } from '@happier-dev/protocol/pets/importActionV1';
import { admitAccountPetEncryptedCreateRequestV1 } from '@happier-dev/protocol/pets/accountPetEncryptionV1';

import { createAccountPetViaActiveServer } from './createAccountPetClient';

const plainPetResponse = {
  ok: true,
  pet: {
    accountPetId: 'pet_account_1',
    packageFormat: 'codex-compatible-atlas-v1',
    manifest: { id: 'blink', displayName: 'Blink', description: 'Happier companion pet', spritesheetPath: 'spritesheet.png' },
    spritesheetAssetRef: { assetId: 'asset_1', mediaType: 'image/png', digest: 'sha256:asset', sizeBytes: 8 },
    digest: 'sha256:package',
    sizeBytes: 8,
    createdAt: 1,
    updatedAt: 1,
    origin: { kind: 'manualImport' },
  },
};

const plainRequest = {
  manifest: { id: 'blink', displayName: 'Blink', description: 'Happier companion pet', spritesheetPath: 'spritesheet.png' },
  spritesheet: { mediaType: 'image/png', encoding: 'base64', data: 'iVBORw0KGgo=', sizeBytes: 8, digest: 'sha256:asset' },
  origin: { kind: 'manualImport' },
} as const;

/** The Home boundary: the mode read and the pets endpoint answer by path. */
function homeFetcher(mode: 'plain' | 'e2ee', answerCreate: (body: unknown) => Response,
  requests: Array<Readonly<{ url: string; init: RequestInit }>> = []) {
  return async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    if (url.endsWith('/v1/account/encryption')) return new Response(JSON.stringify({ mode, updatedAt: 1 }), { status: 200 });
    return answerCreate(JSON.parse(String(init.body)));
  };
}

async function createAtlasPng(): Promise<Buffer> {
  const raw = Buffer.alloc(PET_ATLAS_V1.width * PET_ATLAS_V1.height * 4);
  for (const row of PET_ANIMATION_ROWS_V1) {
    for (let frame = 0; frame < row.frames; frame += 1) {
      const offset = ((row.row * PET_ATLAS_V1.cellHeight + 104) * PET_ATLAS_V1.width + frame * PET_ATLAS_V1.cellWidth + 96) * 4;
      raw[offset + 3] = 255;
    }
  }
  return await sharp(raw, { raw: { width: PET_ATLAS_V1.width, height: PET_ATLAS_V1.height, channels: 4 } }).png().toBuffer();
}

describe('createAccountPetViaActiveServer', () => {
  it('posts canonical account pet imports to the active server with stored credentials', async () => {
    const requests: Array<Readonly<{ url: string; init: RequestInit }>> = [];
    const result = await createAccountPetViaActiveServer(plainRequest, {
      serverUrl: 'https://happier.example.test/',
      readCredentials: async () => ({ token: 'token-1', encryption: null }),
      fetcher: homeFetcher('plain', () => new Response(JSON.stringify(plainPetResponse), { status: 200 }), requests),
    });

    expect(result).toMatchObject({ ok: true, pet: { accountPetId: 'pet_account_1' } });
    const create = requests.find(request => request.url === 'https://happier.example.test/v1/account/pets');
    expect(create?.init.headers).toMatchObject({ Authorization: 'Bearer token-1', 'Content-Type': 'application/json' });
    expect(JSON.parse(String(create?.init.body))).toMatchObject({ manifest: { id: 'blink' }, spritesheet: { encoding: 'base64' } });
  });

  it('validates and seals the package for an E2EE Account and returns the opened entry', async () => {
    const machineKey = new Uint8Array(32).fill(4);
    const spritesheet = await createAtlasPng();
    let posted: unknown;
    const result = await createAccountPetViaActiveServer(buildAccountPetCreateRequestV1({
      manifest: { id: 'tide', displayName: 'Tide', description: 'Happier companion pet', spritesheetPath: 'spritesheet.png' },
      mediaType: 'image/png', spritesheetBytes: spritesheet, origin: { kind: 'manualImport' },
    }), {
      serverUrl: 'https://happier.example.test',
      readCredentials: async () => ({ token: 'token-1', encryption: {
        type: 'dataKey', machineKey, publicKey: tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey,
      } }),
      fetcher: homeFetcher('e2ee', body => {
        posted = body;
        const admitted = admitAccountPetEncryptedCreateRequestV1(body);
        if (!admitted) return new Response(JSON.stringify({ ok: false, errorCode: 'invalid_request', error: 'invalid_request' }), { status: 400 });
        return new Response(JSON.stringify({ ok: true, pet: {
          accountPetId: 'pet-1', packageFormat: 'codex-compatible-atlas-v1', content: admitted.content,
          spritesheetAssetRef: { assetId: 'asset-1', digest: admitted.spritesheetDigest, sizeBytes: admitted.spritesheetCiphertext.byteLength },
          digest: 'sha256:ciphertext', sizeBytes: 1, createdAt: 1, updatedAt: 1,
        } }), { status: 201 });
      }),
    });

    expect(JSON.stringify(posted)).not.toContain('Tide');
    expect(result).toMatchObject({ ok: true, pet: { accountPetId: 'pet-1', manifest: { displayName: 'Tide' },
      opaqueBounds: { x: 96, y: 104, width: 1, height: 1 } } });
  });

  it('refuses an invalid package for an E2EE Account before uploading anything', async () => {
    const machineKey = new Uint8Array(32).fill(4);
    const requests: Array<Readonly<{ url: string; init: RequestInit }>> = [];
    const result = await createAccountPetViaActiveServer(plainRequest, {
      serverUrl: 'https://happier.example.test',
      readCredentials: async () => ({ token: 'token-1', encryption: {
        type: 'dataKey', machineKey, publicKey: tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey,
      } }),
      fetcher: homeFetcher('e2ee', () => new Response('{}', { status: 500 }), requests),
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'invalid_request' });
    expect(requests.map(request => request.url)).toEqual(['https://happier.example.test/v1/account/encryption']);
  });

  it('preserves the conservative plaintext-required account import error code', async () => {
    const result = await createAccountPetViaActiveServer(plainRequest, {
      serverUrl: 'https://happier.example.test/',
      readCredentials: async () => ({ token: 'token-1', encryption: null }),
      fetcher: homeFetcher('plain', () => new Response(JSON.stringify({
        ok: false,
        errorCode: 'custom_pet_sync_requires_plaintext',
        error: 'custom_pet_sync_requires_plaintext',
      }), { status: 400 })),
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'custom_pet_sync_requires_plaintext',
      error: 'custom_pet_sync_requires_plaintext',
    });
  });
});
