import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createTempDirSync, removeTempDirSync } from '../../src/testkit/fs/tempDir';
import {
  assertBundledPluginPackageCorrespondence,
  compareBundledPluginPackageTrees,
} from './bundledPluginPackageCorrespondence.mjs';

function writeRuntimeFile(packageDir: string, relativePath: string, bytes: string): void {
  const path = resolve(packageDir, ...relativePath.split('/'));
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, bytes, 'utf8');
}

describe('bundled plugin package correspondence', () => {
  it('includes relocated executable bytes in default package correspondence', () => {
    const root = createTempDirSync('happier-relocated-correspondence-');
    try {
      const sourceDir = resolve(root, 'source');
      const packageDir = resolve(root, 'prepared');
      writeRuntimeFile(sourceDir, '.happier-plugin-build/daemon.js', 'export const value = true;');
      writeRuntimeFile(packageDir, '.happier-plugin-build/daemon.js', 'export const value = false;');
      expect(compareBundledPluginPackageTrees({ packageName: 'fixture', sourceDir, packageDir }).mismatched)
        .toEqual([expect.objectContaining({ relativePath: '.happier-plugin-build/daemon.js' })]);
    } finally { removeTempDirSync(root); }
  });
  it('rejects missing and truncated prepared runtime bytes with digest evidence', () => {
    const root = createTempDirSync('happier-plugin-package-correspondence-');
    const sourceDir = resolve(root, 'source');
    const packageDir = resolve(root, 'prepared');
    try {
      writeRuntimeFile(sourceDir, '.happier-plugin/daemon.js', 'export const daemon = "complete";\n');
      writeRuntimeFile(sourceDir, '.happier-plugin/chunk.js', 'export const chunk = true;\n');
      writeRuntimeFile(packageDir, '.happier-plugin/daemon.js', 'export const daemon =');

      expect(() => assertBundledPluginPackageCorrespondence({
        packageName: '@happier-dev/plugins-grok',
        sourceDir,
        packageDir,
        runtimeRoots: ['.happier-plugin'],
      })).toThrow(/missing: \.happier-plugin\/chunk\.js[\s\S]*mismatched: \.happier-plugin\/daemon\.js[\s\S]*sha256:/u);
    } finally {
      removeTempDirSync(root);
    }
  });

  it('can bind only the publisher-owned daemon tree for live last-green admission', () => {
    const root = createTempDirSync('happier-plugin-daemon-correspondence-');
    const sourceDir = resolve(root, 'source');
    const packageDir = resolve(root, 'prepared');
    try {
      writeRuntimeFile(sourceDir, '.happier-plugin/daemon.js', 'export const daemon = true;\n');
      writeRuntimeFile(packageDir, '.happier-plugin/daemon.js', 'export const daemon = true;\n');
      writeRuntimeFile(sourceDir, 'dist/index.js', 'export const compile = "failed-current";\n');
      writeRuntimeFile(packageDir, 'dist/index.js', 'export const compile = "last-green";\n');

      const result = compareBundledPluginPackageTrees({
        packageName: '@happier-dev/plugins-grok',
        sourceDir,
        packageDir,
        runtimeRoots: ['.happier-plugin'],
      });

      expect(result).toMatchObject({ expectedFileCount: 1, matchedFileCount: 1 });
      expect(result.missing).toEqual([]);
      expect(result.mismatched).toEqual([]);
      expect(result.unexpected).toEqual([]);
    } finally {
      removeTempDirSync(root);
    }
  });
});
