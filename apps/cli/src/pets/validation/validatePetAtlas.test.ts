import { describe, expect, it } from 'vitest';

import { createOpaqueWhitePetSpritesheetPng, createTransparentPetSpritesheetPng } from '../testkit/petPngFixture.testkit';

function pngHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

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
      bytes: pngHeader(1536, 1872),
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
      bytes: pngHeader(192, 208),
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
      bytes: pngHeader(1536, 1872),
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

  it('rejects opaque PNG atlas pixels during strict validation without a custom decoder', async () => {
    const mod = await loadAtlasModule();

    const result = await mod.validatePetAtlasBytes({
      bytes: createOpaqueWhitePetSpritesheetPng(),
      filename: 'spritesheet.png',
      strict: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected strict atlas validation to reject opaque pixels');
    expect(result.issues.map((issue: { code: string }) => issue.code)).toContain('spritesheet_opaque_background');
  });

  it('accepts transparent PNG atlas pixels during strict validation', async () => {
    const mod = await loadAtlasModule();

    const result = await mod.validatePetAtlasBytes({
      bytes: createTransparentPetSpritesheetPng(),
      filename: 'spritesheet.png',
      strict: true,
    });

    expect(result.ok).toBe(true);
  });
});
