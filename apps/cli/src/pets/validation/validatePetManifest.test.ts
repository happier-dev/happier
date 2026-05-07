import { describe, expect, it } from 'vitest';

async function loadValidationModule() {
  const modulePath = './validatePetManifest';
  const mod = await import(modulePath).catch(() => null);
  expect(mod).not.toBeNull();
  if (!mod) throw new Error('expected validatePetManifest module');
  return mod;
}

describe('validatePetManifest', () => {
  it('accepts a bounded Codex-compatible manifest', async () => {
    const mod = await loadValidationModule();
    const result = mod.validatePetManifestBytes(Buffer.from(JSON.stringify({
      id: 'blink',
      displayName: 'Blink',
      description: 'Happier companion pet',
      spritesheetPath: 'spritesheet.webp',
    })));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected manifest to validate');
    expect(result.manifest.id).toBe('blink');
  });

  it('rejects unsafe spritesheet paths', async () => {
    const mod = await loadValidationModule();

    for (const spritesheetPath of ['../spritesheet.webp', '/tmp/spritesheet.webp', 'https://example.test/pet.webp', 'nested/../../pet.png', 'nested/spritesheet.webp']) {
      const result = mod.validatePetManifestBytes(Buffer.from(JSON.stringify({
        id: 'blink',
        displayName: 'Blink',
        description: 'Happier companion pet',
        spritesheetPath,
      })));

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error(`expected ${spritesheetPath} to be rejected`);
      expect(result.issues.map((issue: { code: string }) => issue.code)).toContain('spritesheet_path_unsafe');
    }
  });

  it('rejects unknown executable or transport manifest keys', async () => {
    const mod = await loadValidationModule();

    const result = mod.validatePetManifestBytes(Buffer.from(JSON.stringify({
      id: 'blink',
      displayName: 'Blink',
      description: 'Happier companion pet',
      spritesheetPath: 'spritesheet.webp',
      remoteUrl: 'https://example.test/spritesheet.webp',
    })));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected unknown manifest key to be rejected');
    expect(result.issues.map((issue: { code: string }) => issue.code)).toContain('manifest_invalid_shape');
  });
});
