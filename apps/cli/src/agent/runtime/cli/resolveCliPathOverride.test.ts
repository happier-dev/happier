import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveCliPathOverride } from './resolveCliPathOverride';

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
const originalEnv = { ...process.env };

describe('resolveCliPathOverride', () => {
  const tempDirs = new Set<string>();

  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
    process.env = { ...originalEnv };
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  it('expands ~ and normalizes Windows override paths to the matching .cmd shim', () => {
    if (!originalPlatformDescriptor) {
      throw new Error('Expected process.platform to be configurable for this test');
    }
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });

    const root = mkdtempSync(join(tmpdir(), 'happier-cli-path-override-home-'));
    tempDirs.add(root);
    const binDir = join(root, 'home', 'bin');
    mkdirSync(binDir, { recursive: true });
    const cmdShimPath = join(binDir, 'claude.cmd');
    writeFileSync(cmdShimPath, '@echo off\r\necho ok\r\n', 'utf8');

    process.env.HOME = join(root, 'home');
    process.env.HAPPIER_CLAUDE_PATH = '~/bin/claude';

    expect(resolveCliPathOverride({ agentId: 'claude' })?.toLowerCase()).toBe(cmdShimPath.toLowerCase());
  });

  it('resolves command-only Windows override values via PATH', () => {
    if (!originalPlatformDescriptor) {
      throw new Error('Expected process.platform to be configurable for this test');
    }
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });

    const root = mkdtempSync(join(tmpdir(), 'happier-cli-path-override-path-'));
    tempDirs.add(root);
    const binDir = join(root, 'bin');
    mkdirSync(binDir, { recursive: true });
    const cmdShimPath = join(binDir, 'codex.cmd');
    writeFileSync(cmdShimPath, '@echo off\r\necho ok\r\n', 'utf8');

    process.env.PATH = binDir;
    process.env.PATHEXT = '.CMD;.EXE';
    process.env.HAPPIER_CODEX_PATH = 'codex';

    expect(resolveCliPathOverride({ agentId: 'codex' })?.toLowerCase()).toBe(cmdShimPath.toLowerCase());
  });
});
