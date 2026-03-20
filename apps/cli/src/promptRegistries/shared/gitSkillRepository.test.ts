import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
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

  it('rejects escaping relative paths even when the outside target does not exist', () => {
    const parent = mkdtempSync(join(tmpdir(), 'happier-prompt-registry-root-'));
    const cloneDirectory = join(parent, 'clone');

    mkdirSync(cloneDirectory, { recursive: true });

    try {
      expect(() => resolvePromptRegistrySourceRoot(
        cloneDirectory,
        '../outside',
      )).toThrow(/within the cloned repository/i);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('rejects symlinked subdirectories that resolve outside the clone root', () => {
    const parent = mkdtempSync(join(tmpdir(), 'happier-prompt-registry-root-'));
    const cloneDirectory = join(parent, 'clone');
    const outsideParent = mkdtempSync(join(tmpdir(), 'happier-prompt-registry-outside-'));
    const outsideDirectory = join(outsideParent, 'outside');

    mkdirSync(cloneDirectory, { recursive: true });
    mkdirSync(outsideDirectory, { recursive: true });
    symlinkSync(outsideDirectory, join(cloneDirectory, 'escape'));

    try {
      expect(() => resolvePromptRegistrySourceRoot(cloneDirectory, 'escape')).toThrow(/within the cloned repository/i);
    } finally {
      rmSync(parent, { recursive: true, force: true });
      rmSync(outsideParent, { recursive: true, force: true });
    }
  });
});
