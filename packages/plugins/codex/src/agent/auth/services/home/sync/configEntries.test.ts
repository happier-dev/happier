import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveCodexConfigEntryNames } from './configEntries.js';

describe('Codex connected-service home sync config entries', () => {
  it('expands current Codex skill directories instead of linking the whole skills root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-config-entries-'));
    try {
      const codexHome = join(root, 'codex-home');
      await mkdir(join(codexHome, 'skills', '.system'), { recursive: true });
      await mkdir(join(codexHome, 'skills', 'reviewer'), { recursive: true });

      const entries = await resolveCodexConfigEntryNames(codexHome);

      expect(entries).toEqual(expect.arrayContaining([
        'config.toml',
        'skills/.system',
        'skills/reviewer',
      ]));
      expect(entries).not.toContain('skills');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips skill expansion when the Codex skills directory is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-config-entries-missing-'));
    try {
      const codexHome = join(root, 'codex-home');
      await mkdir(codexHome, { recursive: true });

      const entries = await resolveCodexConfigEntryNames(codexHome);

      expect(entries).toContain('config.toml');
      expect(entries.some((entry) => entry.startsWith('skills/'))).toBe(false);
      expect(entries).not.toContain('skills');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
