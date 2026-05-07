import { describe, expect, it } from 'vitest';

describe('pet protocol contract', () => {
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
  });

  it('declares every V1 built-in pet id shared by protocol consumers', async () => {
    const modulePath = './index.js';
    const pets = await import(modulePath).catch(() => null);

    expect(pets).not.toBeNull();
    if (!pets) throw new Error('expected pets protocol module');

    expect(pets.BUILT_IN_PET_IDS_V1).toEqual(['blink', 'fury', 'milo', 'oli', 'titi']);
  });

  it('uses the canonical pet sync media type list across account-library contracts', async () => {
    const modulePath = './index.js';
    const pets = await import(modulePath).catch(() => null);

    expect(pets).not.toBeNull();
    if (!pets) throw new Error('expected pets protocol module');

    expect(pets.PetAssetMediaTypeV1Schema.options).toEqual([...pets.PET_SYNC_SUPPORTED_MEDIA_TYPES_V1]);
  });

  it('derives canonical spritesheet asset formats from a single protocol source of truth', async () => {
    const modulePath = './index.js';
    const pets = await import(modulePath).catch(() => null);

    expect(pets).not.toBeNull();
    if (!pets) throw new Error('expected pets protocol module');

    expect(pets.PET_CANONICAL_SPRITESHEET_ASSET_FORMATS_V1).toEqual([
      { extension: 'png', mediaType: 'image/png', spritesheetPath: 'spritesheet.png' },
      { extension: 'webp', mediaType: 'image/webp', spritesheetPath: 'spritesheet.webp' },
    ]);

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

  it('rejects unknown manifest keys and non-canonical spritesheet paths', async () => {
    const modulePath = './index.js';
    const pets = await import(modulePath).catch(() => null);

    expect(pets).not.toBeNull();
    if (!pets) throw new Error('expected pets protocol module');

    expect(pets.PetPackageManifestV1Schema.safeParse({
      id: 'blink',
      displayName: 'Blink',
      description: 'Happier companion pet',
      spritesheetPath: 'nested/spritesheet.webp',
    }).success).toBe(false);

    expect(pets.PetPackageManifestV1Schema.safeParse({
      id: 'blink',
      displayName: 'Blink',
      description: 'Happier companion pet',
      spritesheetPath: 'spritesheet.webp',
      script: 'postinstall.sh',
    }).success).toBe(false);
  });

  it('keeps daemon discovery DTOs sanitized for UI-facing payloads', async () => {
    const modulePath = './index.js';
    const pets = await import(modulePath).catch(() => null);

    expect(pets).not.toBeNull();
    if (!pets) throw new Error('expected pets protocol module');

    const parsed = pets.DiscoveredPetPackageV1Schema.parse({
      sourceKey: 'pet:0123456789abcdef0123456789abcdef',
      kind: 'detectedCodexHome',
      petId: 'blink',
      displayName: 'Blink',
      description: 'Happier companion pet',
      originLabel: 'Codex pets',
      packageFormat: 'codex-compatible-atlas-v1',
      manifest: {
        id: 'blink',
        displayName: 'Blink',
        description: 'Happier companion pet',
        spritesheetPath: 'spritesheet.webp',
      },
      previewHandle: {
        kind: 'daemonSourceKey',
        sourceKey: 'pet:0123456789abcdef0123456789abcdef',
      },
      mediaType: 'image/webp',
      digest: 'sha256:package',
      sizeBytes: 128,
    });

    expect(JSON.stringify(parsed)).not.toContain('packagePath');
    expect(JSON.stringify(parsed)).not.toContain('spritesheetPath":"/');
    expect(pets.DiscoveredPetPackageV1Schema.safeParse({
      ...parsed,
      mediaType: 'image/png',
    }).success).toBe(false);
    expect(pets.DiscoveredPetPackageV1Schema.safeParse({
      ...parsed,
      packagePath: '/tmp/codex-home/pets/blink',
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

    expect(pets.DaemonPetImportLocalPackageRequestV1Schema.safeParse({
      packagePath: '/tmp/codex-home/pets/blink',
    }).success).toBe(false);

    expect(pets.DaemonPetImportAccountPackageRequestV1Schema.safeParse({
      packagePath: '/tmp/codex-home/pets/blink',
      petsSyncEnabled: true,
    }).success).toBe(false);

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

    expect('DaemonPetReadAssetRequestV1Schema' in pets).toBe(false);

    expect(pets.DaemonPetValidatePackageResponseV1Schema.parse({
      ok: false,
      errorCode: 'feature_disabled',
      error: 'pets.companion is disabled.',
    })).toMatchObject({
      ok: false,
      errorCode: 'feature_disabled',
    });

    expect(pets.DaemonPetValidatePackageResponseV1Schema.parse({
      ok: false,
      errorCode: 'rate_limited',
      error: 'Pet validation is rate limited.',
    })).toMatchObject({
      ok: false,
      errorCode: 'rate_limited',
    });

    expect(pets.DaemonPetImportLocalPackageResponseV1Schema.safeParse({
      importedPet: {
        sourceKey: 'source:abc',
        petId: 'milo',
        displayName: 'Milo',
        digest: 'sha256:package',
        sizeBytes: 3,
        source: {
          kind: 'happierManagedLocal',
          packagePath: '/tmp/happier/pets/imports/milo',
          sourceKey: 'source:abc',
        },
        manifest: {
          id: 'milo',
          displayName: 'Milo',
          description: 'Happier companion pet',
          spritesheetPath: 'spritesheet.webp',
        },
      },
    }).success).toBe(false);

    expect(pets.PetPackageValidationResultV1Schema.safeParse({
      ok: true,
      packageFormat: 'codex-compatible-atlas-v1',
      manifest: {
        id: 'milo',
        displayName: 'Milo',
        description: 'Happier companion pet',
        spritesheetPath: 'spritesheet.webp',
      },
      spritesheetPath: '/tmp/milo/spritesheet.webp',
      mediaType: 'image/png',
      width: 1536,
      height: 1872,
      digest: 'sha256:package',
      sizeBytes: 3,
    }).success).toBe(false);

    expect(pets.ImportedLocalPetPackageV1Schema.safeParse({
      sourceKey: 'source:abc',
      kind: 'happierManagedLocal',
      petId: 'milo',
      displayName: 'Milo',
      description: 'Happier companion pet',
      originLabel: 'Managed local',
      digest: 'sha256:package',
      sizeBytes: 3,
      mediaType: 'image/png',
      previewHandle: {
        kind: 'daemonSourceKey',
        sourceKey: 'source:abc',
      },
      manifest: {
        id: 'milo',
        displayName: 'Milo',
        description: 'Happier companion pet',
        spritesheetPath: 'spritesheet.webp',
      },
    }).success).toBe(false);

  });

  it('parses daemon local pet import quota errors', async () => {
    const modulePath = './index.js';
    const pets = await import(modulePath).catch(() => null);

    expect(pets).not.toBeNull();
    if (!pets) throw new Error('expected pets protocol module');

    expect(pets.DaemonPetImportLocalPackageResponseV1Schema.parse({
      ok: false,
      errorCode: 'quota_exceeded',
      error: 'Managed local pet quota exceeded.',
    })).toMatchObject({
      ok: false,
      errorCode: 'quota_exceeded',
    });
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
  });
});
