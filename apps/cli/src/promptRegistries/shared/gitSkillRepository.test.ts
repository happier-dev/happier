import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolvePromptRegistrySourceRoot } from './gitSkillRepository';

describe('resolvePromptRegistrySourceRoot', () => {
  it('rejects sibling paths that only share the clone path prefix', () => {
    const parent = mkdtempSync(join(tmpdir(), 'happier-prompt-registry-root-'));
    const cloneDirectory = join(parent, 'clone');
    const siblingDirectory = join(parent, 'clone-escape');

    mkdirSync(cloneDirectory, { recursive: true });
    mkdirSync(siblingDirectory, { recursive: true });

    try {
      expect(() => resolvePromptRegistrySourceRoot(
        cloneDirectory,
        `../${basename(siblingDirectory)}`,
      )).toThrow(/within the cloned repository/i);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
