import { describe, expect, it } from 'vitest';

import {
  createOpaqueWhitePetSpritesheetPng,
  createPngHeaderOnlyPetAtlasBytes,
  createPngPetAtlasBytes,
} from '../testkit/petTestImages';

async function loadAtlasModule() {
  const modulePath = './validatePetAtlas';
  const mod = await import(modulePath).catch(() => null);
  expect(mod).not.toBeNull();
  if (!mod) throw new Error('expected validatePetAtlas module');
  return mod;
}

describe('validatePetAtlas', () => {
  it('accepts PNG atlases with the exact Codex-compatible dimensions', async () => {
    const mod = await loadAtlasModule();
    const result = await mod.validatePetAtlasBytes({
      bytes: createPngPetAtlasBytes(),
      filename: 'spritesheet.png',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected atlas to validate');
    expect(result.mediaType).toBe('image/png');
    expect(result.width).toBe(1536);
    expect(result.height).toBe(1872);
  });

  it('rejects wrong dimensions and unknown media types', async () => {
    const mod = await loadAtlasModule();

    const wrongSize = await mod.validatePetAtlasBytes({
      bytes: createPngPetAtlasBytes({ width: 192, height: 208 }),
      filename: 'spritesheet.png',
    });
    expect(wrongSize.ok).toBe(false);
    if (wrongSize.ok) throw new Error('expected wrong atlas size to be rejected');
    expect(wrongSize.issues.map((issue: { code: string }) => issue.code)).toContain('spritesheet_invalid_dimensions');

    const unknown = await mod.validatePetAtlasBytes({
      bytes: Buffer.from('not-an-image'),
      filename: 'spritesheet.gif',
    });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) throw new Error('expected unknown atlas to be rejected');
    expect(unknown.issues.map((issue: { code: string }) => issue.code)).toContain('spritesheet_invalid_media_type');
  });

  it('rejects obvious opaque backgrounds when strict decoder metadata reports them', async () => {
    const mod = await loadAtlasModule();

    const result = await mod.validatePetAtlasBytes({
      bytes: createPngPetAtlasBytes(),
      filename: 'spritesheet.png',
      strict: true,
      decoder: () => ({
        mediaType: 'image/png',
        width: 1536,
        height: 1872,
        hasOpaqueBackground: true,
      }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected strict atlas validation to reject opaque backgrounds');
    expect(result.issues.map((issue: { code: string }) => issue.code)).toContain('spritesheet_opaque_background');
  });

  it('rejects strict atlases when decoded pixel content is unavailable', async () => {
    const mod = await loadAtlasModule();

    const result = await mod.validatePetAtlasBytes({
      bytes: createPngPetAtlasBytes(),
      filename: 'spritesheet.png',
      strict: true,
      decoder: () => ({
        mediaType: 'image/png',
        width: 1536,
        height: 1872,
      }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected strict atlas validation to fail closed');
    expect(result.issues.map((issue: { code: string }) => issue.code)).toContain('spritesheet_opaque_background');
  });

  it('rejects header-only PNG atlases even when dimensions match', async () => {
    const mod = await loadAtlasModule();

    const result = await mod.validatePetAtlasBytes({
      bytes: createPngHeaderOnlyPetAtlasBytes(),
      filename: 'spritesheet.png',
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected truncated atlas to be rejected');
    expect(result.issues.map((issue: { code: string }) => issue.code)).toContain('spritesheet_invalid_media_type');
  });

  it('rejects strict PNG atlases with no alpha channel', async () => {
    const mod = await loadAtlasModule();

    const result = await mod.validatePetAtlasBytes({
      bytes: createPngPetAtlasBytes({ colorType: 2 }),
      filename: 'spritesheet.png',
      strict: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected opaque PNG atlas to be rejected');
    expect(result.issues.map((issue: { code: string }) => issue.code)).toContain('spritesheet_opaque_background');
  });

  it('rejects opaque PNG atlas pixels even when the image has an alpha channel', async () => {
    const mod = await loadAtlasModule();

    const result = await mod.validatePetAtlasBytes({
      bytes: createOpaqueWhitePetSpritesheetPng(),
      filename: 'spritesheet.png',
      strict: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected opaque PNG atlas pixels to be rejected');
    expect(result.issues.map((issue: { code: string }) => issue.code)).toContain('spritesheet_opaque_background');
  });

  it('honors an aborted validation signal before decoding atlas bytes', async () => {
    const mod = await loadAtlasModule();
    const controller = new AbortController();
    controller.abort();

    const result = await mod.validatePetAtlasBytes({
      bytes: createPngPetAtlasBytes(),
      filename: 'spritesheet.png',
      signal: controller.signal,
      decoder: () => {
        throw new Error('decoder should not run after abort');
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected aborted atlas validation to fail');
    expect(result.issues.map((issue: { code: string }) => issue.code)).toContain('internal_error');
  });
});
