import { describe, expect, it } from 'vitest';

describe('pet protocol contract', () => {
  it('inspects atlas RGBA pixels without importing image decoders', async () => {
    const modulePath = './index.js';
    const pets = await import(modulePath).catch(() => null);

    expect(pets).not.toBeNull();
    if (!pets) throw new Error('expected pets protocol module');
    expect(typeof pets.inspectPetAtlasRgbaPixelsV1).toBe('function');

    const atlas = pets.PET_ATLAS_V1;
    const data = new Uint8Array(atlas.width * atlas.height * 4);
    for (const row of pets.PET_ANIMATION_ROWS_V1 as Array<{ row: number; frames: number }>) {
      for (let frame = 0; frame < row.frames; frame += 1) {
        const x = frame * atlas.cellWidth + Math.floor(atlas.cellWidth / 2);
        const y = row.row * atlas.cellHeight + Math.floor(atlas.cellHeight / 2);
        const offset = (y * atlas.width + x) * 4;
        data[offset] = 24;
        data[offset + 1] = 120;
        data[offset + 2] = 220;
        data[offset + 3] = 255;
      }
    }

    expect(pets.inspectPetAtlasRgbaPixelsV1({
      data,
      width: atlas.width,
      height: atlas.height,
      channels: 4,
    })).toEqual({
      hasOpaqueBackground: false,
      hasTransparentBackground: true,
      hasVisibleUsedCells: true,
      hasTransparentUnusedCells: true,
    });

    const unusedFrameX = 6 * atlas.cellWidth + Math.floor(atlas.cellWidth / 2);
    const unusedFrameY = Math.floor(atlas.cellHeight / 2);
    data[(unusedFrameY * atlas.width + unusedFrameX) * 4 + 3] = 255;
    expect(pets.inspectPetAtlasRgbaPixelsV1({
      data,
      width: atlas.width,
      height: atlas.height,
      channels: 4,
    })).toMatchObject({
      hasOpaqueBackground: true,
      hasTransparentBackground: false,
      hasTransparentUnusedCells: false,
    });
  });

  it('defines the Codex-compatible atlas constants and row timings', async () => {
    const modulePath = './index.js';
    const pets = await import(modulePath).catch(() => null);

    expect(pets).not.toBeNull();
    if (!pets) throw new Error('expected pets protocol module');

    expect(pets.PET_ATLAS_V1).toEqual({
      packageFormat: 'codex-compatible-atlas-v1',
      columns: 8,
      rows: 9,
      cellWidth: 192,
      cellHeight: 208,
      width: 1536,
      height: 1872,
    });
    expect(pets.PET_ANIMATION_ROWS_V1.map((row: { state: string }) => row.state)).toEqual([
      'idle',
      'running-right',
      'running-left',
      'waving',
      'jumping',
      'failed',
      'waiting',
      'running',
      'review',
    ]);
    expect(pets.PET_ANIMATION_ROWS_V1[0].durationsMs).toEqual([280, 110, 110, 140, 140, 320]);
    expect(pets.BUILT_IN_PET_IDS_V1).toEqual(['blink']);
    expect(pets.PET_SYNC_SUPPORTED_MEDIA_TYPES_V1).toEqual(['image/webp', 'image/png']);
    expect(pets.PET_DAEMON_RPC_DEBOUNCE_LIMITS_V1).toMatchObject({
      discoverPackagesMinIntervalMs: expect.any(Number),
      validatePackageMinIntervalMs: expect.any(Number),
      importPackageMinIntervalMs: expect.any(Number),
      forgetLocalPackageMinIntervalMs: expect.any(Number),
      readPreviewAssetMinIntervalMs: expect.any(Number),
    });
  });

  it('derives canonical spritesheet asset formats from a single protocol source of truth', async () => {
    const modulePath = './index.js';
    const pets = await import(modulePath).catch(() => null);

    expect(pets).not.toBeNull();
    if (!pets) throw new Error('expected pets protocol module');

    expect(pets.PET_CANONICAL_SPRITESHEET_ASSET_FORMATS_V1).toEqual([
      { extension: 'webp', mediaType: 'image/webp', spritesheetPath: 'spritesheet.webp' },
      { extension: 'png', mediaType: 'image/png', spritesheetPath: 'spritesheet.png' },
    ]);
    expect(pets.PET_SYNC_SUPPORTED_MEDIA_TYPES_V1).toEqual(pets.PET_CANONICAL_SPRITESHEET_MEDIA_TYPES_V1);
    expect(pets.PetAssetMediaTypeV1Schema.options).toEqual([...pets.PET_CANONICAL_SPRITESHEET_MEDIA_TYPES_V1]);

    expect(pets.PetCanonicalSpritesheetAssetV1Schema.safeParse({
      spritesheetPath: 'spritesheet.webp',
      mediaType: 'image/webp',
    }).success).toBe(true);
    expect(pets.PetCanonicalSpritesheetAssetV1Schema.safeParse({
      spritesheetPath: 'spritesheet.webp',
      mediaType: 'image/png',
    }).success).toBe(false);
  });

  it('parses Codex-compatible manifests and pet sources', async () => {
    const modulePath = './index.js';
    const pets = await import(modulePath).catch(() => null);

    expect(pets).not.toBeNull();
    if (!pets) throw new Error('expected pets protocol module');

    const manifest = pets.PetPackageManifestV1Schema.parse({
      id: 'blink',
      displayName: 'Blink',
      description: 'Happier companion pet',
      spritesheetPath: 'spritesheet.webp',
    });
    expect(manifest.spritesheetPath).toBe('spritesheet.webp');

    expect(pets.PetPackageSourceV1Schema.parse({
      kind: 'detectedCodexHome',
      homeKind: 'connectedService',
      homePath: '/tmp/codex-home',
      packagePath: '/tmp/codex-home/pets/blink',
      sourceKey: 'detected:abc',
    })).toMatchObject({
      kind: 'detectedCodexHome',
      homeKind: 'connectedService',
      sourceKey: 'detected:abc',
    });

    expect(pets.PetPackageSelectionV1Schema.parse({
      source: { kind: 'builtIn', petId: 'blink' },
      selectedAtMs: 1,
    })).toEqual({
      source: { kind: 'builtIn', petId: 'blink' },
      selectedAtMs: 1,
    });
  });

  it('accepts only canonical spritesheet manifest paths', async () => {
    const modulePath = './index.js';
    const pets = await import(modulePath).catch(() => null);

    expect(pets).not.toBeNull();
    if (!pets) throw new Error('expected pets protocol module');

    expect(pets.PetPackageManifestV1Schema.safeParse({
      id: 'blink',
      displayName: 'Blink',
      description: 'Happier companion pet',
      spritesheetPath: 'spritesheet.png',
    }).success).toBe(true);

    expect(pets.PetPackageManifestV1Schema.safeParse({
      id: 'blink',
      displayName: 'Blink',
      description: 'Happier companion pet',
      spritesheetPath: 'nested/spritesheet.webp',
    }).success).toBe(false);
  });

  it('keeps account pet metadata separate from spritesheet bytes', async () => {
    const modulePath = './index.js';
    const pets = await import(modulePath).catch(() => null);

    expect(pets).not.toBeNull();
    if (!pets) throw new Error('expected pets protocol module');

    const parsed = pets.AccountPetLibraryEntryV1Schema.parse({
      accountPetId: 'pet_account_1',
      packageFormat: 'codex-compatible-atlas-v1',
      manifest: {
        id: 'blink',
        displayName: 'Blink',
        description: 'Happier companion pet',
        spritesheetPath: 'spritesheet.webp',
      },
      spritesheetAssetRef: {
        assetId: 'asset_1',
        mediaType: 'image/webp',
        digest: 'sha256:abc',
        sizeBytes: 120,
      },
      digest: 'sha256:package',
      sizeBytes: 240,
      createdAt: 1,
      updatedAt: 1,
      origin: { kind: 'manualImport' },
    });

    expect(parsed.spritesheetAssetRef).toMatchObject({
      assetId: 'asset_1',
      mediaType: 'image/webp',
    });
    expect(JSON.stringify(parsed)).not.toContain('base64');

    expect(pets.AccountPetLibraryEntryV1Schema.safeParse({
      ...parsed,
      spritesheetAssetRef: {
        ...parsed.spritesheetAssetRef,
        mediaType: 'image/png',
      },
    }).success).toBe(false);

    expect(pets.AccountPetCreateRequestV1Schema.safeParse({
      manifest: parsed.manifest,
      spritesheet: {
        mediaType: 'image/png',
        encoding: 'base64',
        data: 'YWJj',
        sizeBytes: 3,
        digest: 'sha256:abc',
      },
      origin: { kind: 'manualImport' },
    }).success).toBe(false);
  });

  it('defines account pet delete and change-tracking metadata without asset bytes', async () => {
    const modulePath = './index.js';
    const pets = await import(modulePath).catch(() => null);

    expect(pets).not.toBeNull();
    if (!pets) throw new Error('expected pets protocol module');

    expect(pets.AccountPetDeleteRequestV1Schema.parse({
      accountPetId: 'pet_account_1',
    })).toEqual({
      accountPetId: 'pet_account_1',
    });

    expect(pets.AccountPetDeleteResponseV1Schema.parse({
      ok: true,
      accountPetId: 'pet_account_1',
      deletedAt: 123,
    })).toMatchObject({
      ok: true,
      accountPetId: 'pet_account_1',
    });

    const hint = pets.AccountPetChangeHintV1Schema.parse({
      domain: 'accountPet',
      action: 'delete',
      accountPetId: 'pet_account_1',
      changedAt: 123,
    });

    expect(hint.action).toBe('delete');
    expect(JSON.stringify(hint)).not.toContain('base64');
    expect(JSON.stringify(hint)).not.toContain('spritesheet');
  });

  it('parses daemon pet RPC contracts', async () => {
    const modulePath = './index.js';
    const pets = await import(modulePath).catch(() => null);

    expect(pets).not.toBeNull();
    if (!pets) throw new Error('expected pets protocol module');

    expect(pets.PET_DAEMON_RPC_METHODS).toMatchObject({
      DISCOVER_PACKAGES: 'pets.discoverPackages',
      VALIDATE_PACKAGE: 'pets.validatePackage',
      IMPORT_LOCAL_PACKAGE: 'pets.importLocalPackage',
      IMPORT_ACCOUNT_PACKAGE: 'pets.importAccountPackage',
      FORGET_LOCAL_PACKAGE: 'pets.forgetLocalPackage',
      READ_PREVIEW_ASSET: 'pets.readPreviewAsset',
    });

    expect(pets.DaemonPetImportLocalPackageRequestV1Schema.parse({
      packagePath: '/tmp/codex-home/pets/blink',
    })).toMatchObject({
      packagePath: '/tmp/codex-home/pets/blink',
    });

    expect(pets.DaemonPetImportAccountPackageRequestV1Schema.parse({
      packagePath: '/tmp/codex-home/pets/blink',
      petsSyncEnabled: true,
    })).toMatchObject({
      packagePath: '/tmp/codex-home/pets/blink',
      petsSyncEnabled: true,
    });

    expect(pets.DaemonPetForgetLocalPackageRequestV1Schema.parse({
      sourceKey: 'pet:0123456789abcdef0123456789abcdef',
    })).toMatchObject({
      sourceKey: 'pet:0123456789abcdef0123456789abcdef',
    });

    expect(pets.DaemonPetForgetLocalPackageResponseV1Schema.parse({
      ok: true,
      sourceKey: 'pet:0123456789abcdef0123456789abcdef',
    })).toMatchObject({
      ok: true,
      sourceKey: 'pet:0123456789abcdef0123456789abcdef',
    });

    expect(pets.DaemonPetImportLocalPackageResponseV1Schema.parse({
      ok: false,
      errorCode: 'quota_exceeded',
      error: 'quota_exceeded',
    })).toMatchObject({
      ok: false,
      errorCode: 'quota_exceeded',
    });

    expect(pets.DaemonPetImportResponseV1Schema.parse({
      ok: false,
      errorCode: 'quota_exceeded',
      error: 'quota_exceeded',
    })).toMatchObject({
      ok: false,
      errorCode: 'quota_exceeded',
    });

    expect(pets.DaemonPetReadPreviewAssetResponseV1Schema.parse({
      sourceKey: 'source:abc',
      mediaType: 'image/webp',
      dataBase64: 'YWJj',
      sizeBytes: 3,
      digest: 'sha256:abc',
    })).toMatchObject({
      sourceKey: 'source:abc',
      mediaType: 'image/webp',
      sizeBytes: 3,
    });

    const discoveredPet = {
      sourceKey: 'pet:0123456789abcdef0123456789abcdef',
      petId: 'blink',
      displayName: 'Blink',
      packageFormat: 'codex-compatible-atlas-v1',
      manifest: {
        id: 'blink',
        displayName: 'Blink',
        description: 'Happier companion pet',
        spritesheetPath: 'spritesheet.webp',
      },
      source: {
        kind: 'detectedCodexHome',
        homeKind: 'connectedService',
        homePath: '/tmp/codex-home',
        packagePath: '/tmp/codex-home/pets/blink',
        sourceKey: 'detected:abc',
      },
      packagePath: '/tmp/codex-home/pets/blink',
      spritesheetPath: '/tmp/codex-home/pets/blink/spritesheet.webp',
      mediaType: 'image/webp',
      digest: 'sha256:package',
      sizeBytes: 128,
    };

    expect(pets.DiscoveredPetPackageV1Schema.safeParse(discoveredPet).success).toBe(true);
    expect(pets.DiscoveredPetPackageV1Schema.safeParse({
      ...discoveredPet,
      mediaType: 'image/png',
    }).success).toBe(false);

    expect(pets.PetPackageValidationResultV1Schema.safeParse({
      ok: true,
      packageFormat: 'codex-compatible-atlas-v1',
      manifest: discoveredPet.manifest,
      spritesheetPath: discoveredPet.spritesheetPath,
      mediaType: 'image/png',
      width: 1536,
      height: 1872,
      digest: 'sha256:package',
      sizeBytes: 128,
    }).success).toBe(false);

    expect(pets.DaemonPetReadPreviewAssetRequestV1Schema.parse({
      sourceKey: 'source:abc',
    })).toMatchObject({
      sourceKey: 'source:abc',
    });

    expect(pets.DaemonPetReadPreviewAssetRequestV1Schema.safeParse({
      source: {
        kind: 'detectedCodexHome',
        homeKind: 'user',
        homePath: '/tmp/codex-home',
        packagePath: '/tmp/codex-home/pets/blink',
        sourceKey: 'source:abc',
      },
    }).success).toBe(false);

    for (const schema of [
      pets.DaemonPetDiscoverResponseV1Schema,
      pets.DaemonPetValidatePackageResponseV1Schema,
      pets.DaemonPetImportLocalPackageResponseV1Schema,
      pets.DaemonPetForgetLocalPackageResponseV1Schema,
      pets.DaemonPetImportResponseV1Schema,
      pets.DaemonPetReadPreviewAssetResponseV1Schema,
    ]) {
      expect(schema.parse({
        ok: false,
        errorCode: 'feature_disabled',
        error: 'feature disabled',
      })).toMatchObject({
        ok: false,
        errorCode: 'feature_disabled',
      });
      expect(schema.parse({
        ok: false,
        errorCode: 'rate_limited',
        error: 'rate limited',
      })).toMatchObject({
        ok: false,
        errorCode: 'rate_limited',
      });
    }

    expect('DaemonPetReadAssetRequestV1Schema' in pets).toBe(false);
  });

  it('parses conservative account custom-pet sync policy errors', async () => {
    const modulePath = './index.js';
    const pets = await import(modulePath).catch(() => null);

    expect(pets).not.toBeNull();
    if (!pets) throw new Error('expected pets protocol module');

    expect(pets.AccountPetCreateResponseV1Schema.parse({
      ok: false,
      errorCode: 'custom_pet_sync_requires_plaintext',
      error: 'custom_pet_sync_requires_plaintext',
    })).toMatchObject({
      ok: false,
      errorCode: 'custom_pet_sync_requires_plaintext',
    });

    expect(pets.DaemonPetImportResponseV1Schema.parse({
      ok: false,
      errorCode: 'custom_pet_sync_requires_plaintext',
      error: 'custom_pet_sync_requires_plaintext',
    })).toMatchObject({
      ok: false,
      errorCode: 'custom_pet_sync_requires_plaintext',
    });
    expect(pets.AccountPetCreateResponseV1Schema.safeParse({
      ok: false,
      errorCode: 'custom_pet_sync_unavailable',
      error: 'custom_pet_sync_unavailable',
    }).success).toBe(false);

    expect(pets.AccountPetListResponseV1Schema.parse({
      ok: false,
      errorCode: 'custom_pet_sync_unavailable',
      error: 'custom_pet_sync_unavailable',
    })).toEqual({
      ok: false,
      errorCode: 'custom_pet_sync_unavailable',
      error: 'custom_pet_sync_unavailable',
    });

    expect(pets.AccountPetAssetReadResponseV1Schema.parse({
      ok: false,
      errorCode: 'custom_pet_sync_unavailable',
      error: 'custom_pet_sync_unavailable',
    })).toEqual({
      ok: false,
      errorCode: 'custom_pet_sync_unavailable',
      error: 'custom_pet_sync_unavailable',
    });
  });
});
