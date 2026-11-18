import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

import { inspectPetAtlasRgbaPixelsV1 } from './atlasPixelInspection.js';
import { PET_ANIMATION_ROWS_V1, PET_ATLAS_V1, PET_ATLAS_V2 } from './constants.js';
import { buildAccountPetCreateRequestV1 } from './importActionV1.js';
import {
  computeAccountPetPackageDigestV1,
  findMatchingAccountPetV1,
} from './portablePetV1.js';
import {
  validateAccountPetCreateRequestV1,
  type PetAtlasInspectorV1,
} from './accountPetCreateValidation.js';
import {
  ACCOUNT_PET_ENCRYPTED_LIMITS_V1,
  admitAccountPetEncryptedCreateRequestV1,
  openAccountPetSpritesheetV1,
  openAccountPetStoredEntryForModeV1,
  sealAccountPetPackageV1,
} from './accountPetEncryptionV1.js';
import {
  AccountPetListResponseV1Schema,
  type AccountPetEncryptedLibraryEntryV1,
} from './accountLibrary.js';
import type { AccountScopedCryptoMaterial } from '../crypto/accountScopedCipher.js';

// The decoder boundary supplies pixels. These chunks supply the real PNG header.
function pngWithDimensions(width: number, height: number): Uint8Array {
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 0, 0, 0, 0, 0, 8, 6, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 73, 68, 65, 84, 0, 0, 0, 0,
    0, 0, 0, 0, 73, 69, 78, 68, 0, 0, 0, 0,
  ]);
  const header = new DataView(png.buffer);
  header.setUint32(16, width);
  header.setUint32(20, height);
  return png;
}
const PNG = pngWithDimensions(PET_ATLAS_V1.width, PET_ATLAS_V1.height);
const material: AccountScopedCryptoMaterial = {
  type: 'dataKey',
  machineKey: new Uint8Array(32).fill(7),
};
const otherMaterial: AccountScopedCryptoMaterial = {
  type: 'dataKey',
  machineKey: new Uint8Array(32).fill(9),
};
const random = (length: number) => new Uint8Array(randomBytes(length));

/** Image decoding is the platform boundary; pixel facts come from the real protocol inspector. */
const inspectValidAtlas: PetAtlasInspectorV1 = async () => {
  const { width, height } = PET_ATLAS_V1;
  const data = new Uint8Array(width * height * 4);
  for (const row of PET_ANIMATION_ROWS_V1) {
    for (let frame = 0; frame < row.frames; frame++)
      data[((row.row * 208 + 104) * width + frame * 192 + 96) * 4 + 3] = 255;
  }
  return {
    width,
    height,
    hasAlpha: true,
    ...inspectPetAtlasRgbaPixelsV1({ data, width, height, channels: 4 }),
  };
};

function packageRequest(spritesheetBytes = PNG) {
  return buildAccountPetCreateRequestV1({
    manifest: {
      id: 'tide',
      displayName: 'Tide',
      description: 'A pet.',
      spritesheetPath: 'spritesheet.png',
    },
    mediaType: 'image/png',
    spritesheetBytes,
    origin: { kind: 'registry', sourceId: 'petdex', itemId: 'tide' },
  });
}

async function sealedRequest() {
  const validated = await validateAccountPetCreateRequestV1(packageRequest(), {
    inspectAtlas: inspectValidAtlas,
  });
  if (!validated.ok) throw new Error(validated.reason);
  const sealed = sealAccountPetPackageV1({
    validated,
    material,
    randomBytes: random,
  });
  if (!sealed.ok) throw new Error(sealed.reason);
  return sealed.request;
}

function servedEntry(
  request: Awaited<ReturnType<typeof sealedRequest>>,
): AccountPetEncryptedLibraryEntryV1 {
  return {
    accountPetId: 'pet-1',
    packageFormat: 'codex-compatible-atlas-v1',
    content: request.content,
    spritesheetAssetRef: {
      assetId: 'asset-1',
      digest: request.spritesheet.digest,
      sizeBytes: request.spritesheet.sizeBytes,
    },
    digest: 'sha256:ciphertext',
    sizeBytes: request.spritesheet.sizeBytes + request.content.c.length,
    createdAt: 1,
    updatedAt: 2,
  };
}

describe('E2EE Account pet packages', () => {
  it('admits v1 and v2 atlases and refuses oversized dimensions before raster decoding', async () => {
    for (const { width, height } of [PET_ATLAS_V1, PET_ATLAS_V2]) {
      await expect(validateAccountPetCreateRequestV1(packageRequest(pngWithDimensions(width, height)), {
        inspectAtlas: async () => ({ width, height, hasAlpha: true }),
      })).resolves.toMatchObject({ ok: true });
    }
    const inspectAtlas = vi.fn(inspectValidAtlas);
    await expect(validateAccountPetCreateRequestV1(packageRequest(pngWithDimensions(16_384, 16_384)), {
      inspectAtlas,
    })).resolves.toMatchObject({ ok: false, reason: 'atlas_contract' });
    expect(inspectAtlas).not.toHaveBeenCalled();
  });

  it('seals only ciphertext toward the Home and reopens the owner entry and spritesheet', async () => {
    const request = await sealedRequest();
    expect(JSON.stringify(request)).not.toContain('Tide');
    expect(JSON.stringify(request)).not.toContain('petdex');

    const admitted = admitAccountPetEncryptedCreateRequestV1(request);
    expect(admitted?.spritesheetDigest).toBe(request.spritesheet.digest);

    const entry = servedEntry(request);
    expect(
      AccountPetListResponseV1Schema.parse({ ok: true, pets: [entry] }).ok,
    ).toBe(true);
    const opened = openAccountPetStoredEntryForModeV1(entry, {
      mode: 'e2ee',
      material,
    });
    expect(opened).toMatchObject({
      accountPetId: 'pet-1',
      manifest: { displayName: 'Tide' },
      origin: { kind: 'registry', sourceId: 'petdex', itemId: 'tide' },
      spritesheetAssetRef: {
        assetId: 'asset-1',
        mediaType: 'image/png',
        sizeBytes: PNG.byteLength,
      },
      digest: computeAccountPetPackageDigestV1(packageRequest().manifest, PNG),
      opaqueBounds: { x: 96, y: 104, width: 1, height: 1 },
    });
    // Registry-origin and package-digest reuse decide against the opened library.
    expect(
      findMatchingAccountPetV1([opened!], {
        kind: 'registry',
        sourceId: 'petdex',
        itemId: 'tide',
      }),
    ).toBe(opened);
    expect(
      findMatchingAccountPetV1([opened!], {
        kind: 'digest',
        digest: opened!.digest,
      }),
    ).toBe(opened);

    const bytes = openAccountPetSpritesheetV1({
      ciphertext: admitted!.spritesheetCiphertext,
      material,
      expected: {
        mediaType: 'image/png',
        digest: opened!.spritesheetAssetRef.digest,
      },
    });
    expect(bytes && Array.from(bytes)).toEqual(Array.from(PNG));
  });

  it('fails closed on another key, a mode mismatch and a substituted spritesheet', async () => {
    const request = await sealedRequest();
    const entry = servedEntry(request);
    expect(
      openAccountPetStoredEntryForModeV1(entry, {
        mode: 'e2ee',
        material: otherMaterial,
      }),
    ).toBeNull();
    expect(
      openAccountPetStoredEntryForModeV1(entry, { mode: 'plain' }),
    ).toBeNull();
    const plainEntry = {
      ...openAccountPetStoredEntryForModeV1(entry, { mode: 'e2ee', material })!,
    };
    expect(
      openAccountPetStoredEntryForModeV1(plainEntry, {
        mode: 'e2ee',
        material,
      }),
    ).toBeNull();

    const admitted = admitAccountPetEncryptedCreateRequestV1(request)!;
    expect(
      openAccountPetSpritesheetV1({
        ciphertext: admitted.spritesheetCiphertext,
        material,
        expected: { mediaType: 'image/png', digest: 'sha256:other' },
      }),
    ).toBeNull();
    expect(
      openAccountPetSpritesheetV1({
        ciphertext: admitted.spritesheetCiphertext,
        material: otherMaterial,
        expected: {
          mediaType: 'image/png',
          digest: plainEntry.spritesheetAssetRef.digest,
        },
      }),
    ).toBeNull();
  });

  it('admits only sealed pet ciphertext within the derived bounds', async () => {
    const request = await sealedRequest();
    expect(
      admitAccountPetEncryptedCreateRequestV1(packageRequest()),
    ).toBeNull();
    expect(
      admitAccountPetEncryptedCreateRequestV1({
        ...request,
        content: { t: 'plain', v: {} },
      }),
    ).toBeNull();
    // Swapped domains: the spritesheet ciphertext is not admissible as metadata.
    expect(
      admitAccountPetEncryptedCreateRequestV1({
        ...request,
        content: { t: 'encrypted', c: request.spritesheet.data },
      }),
    ).toBeNull();
    expect(
      admitAccountPetEncryptedCreateRequestV1({
        ...request,
        spritesheet: { ...request.spritesheet, digest: 'sha256:x' },
      }),
    ).toBeNull();
    expect(
      admitAccountPetEncryptedCreateRequestV1({
        ...request,
        spritesheet: {
          ...request.spritesheet,
          sizeBytes:
            ACCOUNT_PET_ENCRYPTED_LIMITS_V1.maxSpritesheetCiphertextBytes + 1,
        },
      }),
    ).toBeNull();
  });
});
