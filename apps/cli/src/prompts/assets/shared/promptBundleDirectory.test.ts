import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { reloadConfiguration } from '@/configuration';

describe('promptBundleDirectory', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builds a prompt bundle body from a directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-prompt-bundle-'));
    tempDirs.push(root);

    mkdirSync(join(root, 'nested'), { recursive: true });
    writeFileSync(join(root, 'SKILL.md'), '# Skill\n', 'utf8');
    writeFileSync(join(root, 'nested', 'notes.txt'), 'note\n', 'utf8');

    const { buildPromptBundleBodyFromDirectory } = await import('./promptBundleDirectory');
    const body = buildPromptBundleBodyFromDirectory({ rootDirectory: root, preferredFirstPath: 'SKILL.md' });

    expect(body.v).toBe(1);
    expect(body.entries.map((entry) => entry.path)).toEqual(['SKILL.md', 'nested/notes.txt']);
    expect(body.entries.every((entry) => typeof entry.contentBase64 === 'string' && entry.contentBase64.length > 0)).toBe(true);
  });

  it('fails closed when the prompt bundle payload would exceed the configured transfer size limit', async () => {
    const previous = process.env.HAPPIER_PROMPT_TRANSFER_JSON_MAX_BYTES;
    process.env.HAPPIER_PROMPT_TRANSFER_JSON_MAX_BYTES = '64';
    reloadConfiguration();

    try {
      const root = mkdtempSync(join(tmpdir(), 'happier-prompt-bundle-too-large-'));
      tempDirs.push(root);

      // 128 bytes raw -> 172 bytes base64, which will exceed the 64 byte transfer ceiling.
      writeFileSync(join(root, 'SKILL.md'), 'a'.repeat(128), 'utf8');

      const { buildPromptBundleBodyFromDirectory } = await import('./promptBundleDirectory');
      expect(() => buildPromptBundleBodyFromDirectory({ rootDirectory: root })).toThrow('Prompt transfer payload exceeds size limit');
    } finally {
      if (previous === undefined) {
        delete process.env.HAPPIER_PROMPT_TRANSFER_JSON_MAX_BYTES;
      } else {
        process.env.HAPPIER_PROMPT_TRANSFER_JSON_MAX_BYTES = previous;
      }
      reloadConfiguration();
    }
  });
});
