import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import { collectPromptRegistrySkillDirectories, resolvePromptRegistrySourceRoot } from './gitSkillRepository';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn(() => '') }));

describe('prompt registry background git commands', () => {
  it('lists tracked skills without creating a Windows console', () => {
    expect(collectPromptRegistrySkillDirectories('/registry')).toEqual([]);
    expect(vi.mocked(execFileSync).mock.calls[0]?.[2]?.windowsHide).toBe(true);
  });
});

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
