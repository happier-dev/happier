import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createTempDirSync } from '../src/testkit/fs/tempDir';
import { finalizeDist } from './finalizeDist.mjs';

describe('finalizeDist', () => {
  it('writes a build manifest into staged dist before atomically promoting it', () => {
    const packageRoot = createTempDirSync('happier-cli-finalize-dist-');
    try {
      const stagingDir = join(packageRoot, 'dist.staging.123');
      const distDir = join(packageRoot, 'dist');
      mkdirSync(stagingDir, { recursive: true });
      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(stagingDir, 'index.mjs'), "import './chunk.mjs';\nexport const next = true;\n", 'utf8');
      writeFileSync(join(stagingDir, 'chunk.mjs'), 'export const chunk = true;\n', 'utf8');
      writeFileSync(join(distDir, 'index.mjs'), 'export const previous = true;\n', 'utf8');

      const result = finalizeDist({ packageRoot, stagingDir });

      expect(result.distDir).toBe(distDir);
      expect(existsSync(stagingDir)).toBe(false);
      expect(readFileSync(join(distDir, 'index.mjs'), 'utf8')).toContain('next = true');
      const manifest = JSON.parse(readFileSync(join(distDir, '.build-manifest.json'), 'utf8'));
      expect(manifest).toEqual({
        fingerprint: expect.stringMatching(/^[a-f0-9]{16}$/),
        builtAt: expect.any(String),
        fileCount: 2,
        toolVersion: expect.any(String),
      });
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('leaves the previous dist in place when staged imports are incomplete', () => {
    const packageRoot = createTempDirSync('happier-cli-finalize-dist-incomplete-');
    try {
      const stagingDir = join(packageRoot, 'dist.staging.456');
      const distDir = join(packageRoot, 'dist');
      mkdirSync(stagingDir, { recursive: true });
      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(stagingDir, 'index.mjs'), "import './missing.mjs';\n", 'utf8');
      writeFileSync(join(distDir, 'index.mjs'), 'export const previous = true;\n', 'utf8');

      expect(() => finalizeDist({ packageRoot, stagingDir })).toThrow(/incomplete/);

      expect(readFileSync(join(distDir, 'index.mjs'), 'utf8')).toBe('export const previous = true;\n');
      expect(existsSync(join(distDir, '.build-manifest.json'))).toBe(false);
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  it('does not promote staged output when dist changed after the build started', () => {
    const packageRoot = createTempDirSync('happier-cli-finalize-dist-current-guard-');
    try {
      const stagingDir = join(packageRoot, 'dist.staging.789');
      const distDir = join(packageRoot, 'dist');
      mkdirSync(stagingDir, { recursive: true });
      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(stagingDir, 'index.mjs'), 'export const stale = true;\n', 'utf8');
      writeFileSync(join(distDir, 'index.mjs'), 'export const newer = true;\n', 'utf8');
      writeFileSync(
        join(distDir, '.build-manifest.json'),
        `${JSON.stringify({
          fingerprint: '2222222222222222',
          builtAt: '2026-07-09T12:00:00.000Z',
          fileCount: 1,
          toolVersion: '1',
        })}\n`,
        'utf8',
      );

      expect(() =>
        finalizeDist({
          packageRoot,
          stagingDir,
          expectedCurrentFingerprint: '1111111111111111',
        }),
      ).toThrow(/changed while this build was running/);

      expect(readFileSync(join(distDir, 'index.mjs'), 'utf8')).toBe('export const newer = true;\n');
      const manifest = JSON.parse(readFileSync(join(distDir, '.build-manifest.json'), 'utf8'));
      expect(manifest.fingerprint).toBe('2222222222222222');
    } finally {
      rmSync(packageRoot, { recursive: true, force: true });
    }
  });
});
